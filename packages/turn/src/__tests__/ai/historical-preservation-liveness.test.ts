import { estimateContextTokens as estimateProviderContext } from "@earendil-works/pi-ai/utils/estimate";
import { summaryRequestOptions } from "../../execution/pi/compaction/summary-policy.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "../../engine/session-store.js";
import { createRunDriver } from "../../engine/run-driver.js";
import { resolveRetainedSummaryAdmission } from "../../engine/retained-summary.js";
import { estimateTokens, prepareCompaction } from "../../engine/compaction-kit/compaction.js";
import { checkNativeInheritedPrefix } from "../../execution/pi/handoff-producer.js";
import { projectContext, projectInheritedContext } from "../../engine/request-projection.js";
import { createMidRunCompaction } from "../../execution/pi/compaction/mid-run-compaction.js";
import { createCompactionUsage, manualCompactionAccounting } from "../../telemetry/compaction-usage.js";
import { tryCompact, runReactiveCompaction } from "../../execution/pi/compaction/compaction-driver.js";

const tuple = "- Permit; m1; pending; no approval.";
const history = `## Historical events and corrections\n${tuple}\n## Pending items\n- None`;
const answer = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

async function fixture(summary = history, inherited = false, admitted = false) {
  const inheritedProjection = { messages: [{ role: "user", content: "Fictional inherited prefix.", timestamp: 1 }], coverage: { version: 1, sources: [{ journalId: "frozen", sourceTipId: "tip", sourceSeq: 7, sourceDigest: "3".repeat(64) }] } };
  const root = await mkdtemp(join(tmpdir(), "historical-liveness-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const raw = await repo.create({ cwd: "/fictional", ...(inherited ? { hostAuthority: { version: 1, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" }, assertOwned: async () => {} } : {}) });
  let candidate: any, access: any, seed: string | undefined;
  if (admitted) {
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const binding = { version: 1, logicalConversationId: "fictional-owner", conversationId: "fictional-bucket", recordId: "record", generationId: "generation",
      sha256: hash(summary), retainedBytes: Buffer.byteLength(summary), sourceEpoch: "source", sourceRevision: 1,
      publication: { journalId: "source-journal", operationId: "source-cut", sourceDigest: hash("coverage"), summaryDigest: hash(summary) } };
    const entry = `Generated summary evidence id="record" sha256="${hash(summary)}": ${JSON.stringify(summary)}\n`;
    seed = await raw.appendMessage({ role: "user", content: entry, timestamp: 1 });
    candidate = { binding, selection: { recordId: binding.recordId, generationId: binding.generationId, sha256: binding.sha256,
      retainedBytes: binding.retainedBytes, packSha256: hash(entry), entry: { startByte: 0, endByte: Buffer.byteLength(entry), sha256: hash(entry) } } };
    access = { destination: { logicalConversationId: "fictional-owner", conversationId: "fictional-bucket", epoch: "destination", handleId: raw.metadata.id },
      assertCurrent: async () => {}, resolve: async () => ({ text: summary }) };
  } else await raw.appendCompaction({ summary, tokensBefore: 10000, retainedTail: [], details: { readFiles: [], modifiedFiles: [] } });
  const faux = fauxProvider({ models: [{ id: "liveness", contextWindow: 100000, maxTokens: 10000 }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional run continued.")])]);
  const model = faux.getModel();
  const completeSimple = vi.fn(async (..._args: any[]): Promise<any> => answer("Legacy lossy summary."));
  const driver = createRunDriver(raw, { model, models, systemPrompt: "Fictional rules.", tools: [], ...(access ? { retainedSummaryAccess: access } : {}), ...(inherited ? { inheritedProjection } : {}) });
  if (admitted) {
    await driver.beginTurn("fictional-admission", "host", { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", handleId: raw.metadata.id, turnId: "fictional-admission", baseRevision: 0 });
    await driver.admitRetainedSummary(candidate, seed!); await driver.endTurn("completed");
  }
  const session = { getEntries: () => raw.getEntries(), buildContext: async () => inherited ? projectInheritedContext(await raw.getEntries(), inheritedProjection) : projectContext(await raw.getEntries()) };
  const harness = { models: { completeSimple }, compactionFailureKey: root, getModel: () => model, waitForIdle: () => driver.waitForIdle(),
    setCompactionSettings: (settings: any) => driver.setCompactionSettings(settings),
    setMidRunCompactionArmed: (armed: boolean) => driver.setMidRunCompactionArmed(armed), subscribe: (listener: any) => driver.subscribe(listener),
    on: (_type: string, handler: any) => driver.hooks.on("before_compaction", handler), compact: () => driver.compact(), prompt: vi.fn((text: string) => driver.prompt(text)) };
  const events: any[] = [], warnings: any[] = [];
  const policy = { enabled: true, summaryMaxTokens: 1000, keepRecentTokens: 1000, compactionMinSavingsTokens: 0, effort: "none", failureCooldownMs: 900000 };
  const compact = (trigger: string) => tryCompact(harness, { trigger, onEvent: (event: any) => events.push(event), runtimeWarnings: warnings, session, policy });
  const grow = async () => { for (let i = 0; i < 2; i++) await raw.appendMessage({ role: "user", content: "Fictional context. ".repeat(2000), timestamp: 2 }); };
  return { root, raw, session, harness, driver, faux, completeSimple, events, warnings, policy, compact, grow, access,
    close: async () => { await driver.close(); await raw.close(); await repo.close(); await rm(root, { recursive: true, force: true }); } };
}

it("a real journal/driver refusal never suppresses reactive overflow: bypass, commit, and continue the run", async () => {
  const f = await fixture();
  try {
    await f.grow();
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.events.at(-1)).toMatchObject({ status: "skipped", reason: "protected_tuples_missing" });
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    const before = await f.raw.getEntries();
    expect(before.filter((entry: any) => entry.type === "compaction")).toHaveLength(1);
    const runState = { session: f.session, sessionBaselineCount: 0, compaction: { policy: f.policy, diagnostics: {}, applied: false, compactedThisRun: false, reactiveAttempted: false } };
    const result = await runReactiveCompaction(runState, { harness: f.harness, runtime: { model: { contextWindow: 100000 } }, resolved: { reference: "faux:liveness" }, options: {},
      promptText: "Continue fictional work.", reference: "faux:liveness", onEvent: (event: any) => f.events.push(event), runtimeWarnings: f.warnings,
      state: { stopReason: "error" }, runError: new Error("context length exceeded"), captureState: async () => ({ stopReason: "stop" }) });
    expect(result.runError).toBeNull();
    expect(f.completeSimple).toHaveBeenCalledTimes(2); // one refused attempt + one legacy-count recovery request
    expect(f.harness.prompt).toHaveBeenCalledTimes(1);
    expect(f.warnings).toContainEqual(expect.objectContaining({ warning_kind: "historical_preservation_bypassed", reason: "protected_tuples_missing" }));
    expect(f.events.some(event => event.reason === "recent_identical_failure")).toBe(false);
    expect((await f.raw.getEntries()).filter((entry: any) => entry.type === "compaction")).toHaveLength(2);
    expect(JSON.stringify(await f.session.buildContext())).toContain("Fictional run continued.");
  } finally { await f.close(); }
});

it("monotone protected growth in real driver cuts reaches unfits and bypasses instead of dead-ending", async () => {
  const f = await fixture();
  try {
    let current = history;
    f.completeSimple.mockImplementation(async (_model?: any, context?: any) => {
      const protectedInput = JSON.stringify(context).includes("<protected-historical-tuples>");
      current = protectedInput ? current.replace("\n## Pending items", `\n- New event ${f.completeSimple.mock.calls.length}; ${"fictional detail ".repeat(20)}; pending.\n## Pending items`) : "Legacy compacted history.";
      return answer(current);
    });
    const sizes: number[] = [];
    for (let cut = 0; cut < 20; cut++) {
      await f.grow();
      const calls = f.completeSimple.mock.calls.length;
      expect((await f.compact("proactive")).applied).toBe(true);
      expect(f.completeSimple).toHaveBeenCalledTimes(calls + 1);
      const preservation = f.events.at(-1).accounting.preservation;
      sizes.push(preservation.protectedBytes);
      if (preservation.bypassReason) break;
    }
    expect(f.warnings).toContainEqual(expect.objectContaining({ warning_kind: "historical_preservation_bypassed", reason: "protected_history_unfits" }));
    expect(sizes.length).toBeGreaterThan(3);
    expect(sizes.every((size, index) => index === 0 || size > sizes[index - 1]!)).toBe(true);
    expect(JSON.stringify(await f.session.buildContext())).toContain("Legacy compacted history.");
  } finally { await f.close(); }
});

it.each(["manual", "reactive_overflow"])("%s reuses oversized protected output without another summary request", async trigger => {
  const f = await fixture();
  try {
    await f.grow();
    f.completeSimple.mockImplementation(async () => answer(history + "\n" + "Fictional prose. ".repeat(400)));
    expect((await f.compact(trigger)).applied).toBe(true);
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    expect(f.warnings).toContainEqual(expect.objectContaining({ warning_kind: "historical_preservation_bypassed", reason: "summary_budget_exceeded" }));
  } finally { await f.close(); }
});

it("idle proactive pays once per growth step, but changed protected history permits another attempt", async () => {
  const f = await fixture();
  try {
    await f.grow();
    for (let attempt = 0; attempt < 3; attempt++) expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1).reason).toBe("preservation_growth_required");
    await f.grow();
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    await f.raw.appendCompaction({ summary: history.replace(tuple, `${tuple} Changed event.`), tokensBefore: 10000,
      retainedTail: (await f.session.buildContext()).messages?.filter((message: any) => ["user", "assistant"].includes(message.role)), details: { readFiles: [], modifiedFiles: [] } });
    await f.raw.appendMessage({ role: "user", content: "Fictional changed summary delta.", timestamp: 3 });
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(3);
  } finally { await f.close(); }
});
it.each(["", "(none)", "- (none)", "None", "- None"])("healthy zero-tuple section %s adds no warning/accounting key", async placeholder => {
  const f = await fixture(`## Historical events and corrections\n${placeholder}\n## Pending items\n- None`);
  try {
    await f.grow();
    expect((await f.compact("proactive")).applied).toBe(true);
    expect(f.warnings).toEqual([]);
    expect(f.completeSimple.mock.calls[0]![2].maxTokens).toBe(1000);
    expect(f.events.at(-1).accounting).not.toHaveProperty("preservation");
  } finally { await f.close(); }
});
it.each(["manual", "reactive_overflow"].flatMap(trigger => [false, true].map(split => ({ trigger, split }))))("protected truncation bypasses in $trigger split=$split with at most one extra request", async ({ trigger, split }) => {
  const f = await fixture();
  try {
    await f.grow();
    if (split) await f.raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fictional suffix. ".repeat(2000) }], timestamp: 3 });
    f.completeSimple.mockImplementation(async () => f.completeSimple.mock.calls.length === 1 ? { ...answer(history), stopReason: "length" } : answer(history));
    expect((await f.compact(trigger)).applied).toBe(true);
    expect(f.completeSimple).toHaveBeenCalledTimes(split ? 3 : 2);
    expect(f.events.at(-1).accounting.requests[0]).toMatchObject({ reason: "output_truncated", providerInvoked: true });
    expect(f.warnings).toContainEqual(expect.objectContaining({ warning_kind: "historical_preservation_bypassed", reason: "output_truncated" }));
  } finally { await f.close(); }
});
it("a protected length refusal is not cached as a failed provider request before reactive recovery", async () => {
  const f = await fixture();
  try {
    await f.grow();
    f.completeSimple.mockResolvedValueOnce({ ...answer(history), stopReason: "length" });
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.events.at(-1).reason).toBe("output_truncated");
    expect((await f.compact("reactive_overflow")).applied).toBe(true);
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    expect(f.events.some(event => event.reason === "recent_identical_failure")).toBe(false);
  } finally { await f.close(); }
});
it.each([false, true])("ready inherited-prefix admission bypasses its actual proactive preservation veto, truncated=%s", async truncated => {
  expect(await checkNativeInheritedPrefix([{ role: "user", content: "Fictional inherited prefix.", timestamp: 1 }], { maxTokens: 10000, contextWindow: 100000, reasoning: false }, { summaryMaxTokens: 1000 })).toEqual({ status: "ready" });
  const f = await fixture(history, true);
  try {
    await f.grow();
    if (truncated) f.completeSimple.mockResolvedValueOnce({ ...answer(history), stopReason: "length" });
    expect((await f.compact("proactive")).applied).toBe(true);
    expect(f.completeSimple).toHaveBeenCalledTimes(truncated ? 2 : 1);
    expect(f.warnings).toContainEqual(expect.objectContaining({ warning_kind: "historical_preservation_bypassed", reason: truncated ? "output_truncated" : "protected_tuples_missing" }));
    const checkpoint = (await f.raw.getEntries()).filter((entry: any) => entry.type === "compaction").at(-1);
    expect(checkpoint.checkpoint.inheritedCoverage.sources[0].journalId).toBe("frozen");
  } finally { await f.close(); }
});
it("a changed split prefix cannot repay an idle refusal below the shared growth threshold", async () => {
  const f = await fixture();
  try {
    await f.grow();
    expect((await f.compact("proactive")).applied).toBe(false);
    await f.raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }], timestamp: 3 });
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1).reason).toBe("preservation_growth_required");
    await f.compact("proactive");
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});
it("successful manual recovery clears the idle refusal baseline even with unchanged protected tuples", async () => {
  const f = await fixture();
  try {
    await f.grow();
    await f.compact("proactive");
    f.completeSimple.mockResolvedValueOnce(answer(history));
    expect((await f.compact("manual")).applied).toBe(true);
    await f.raw.appendMessage({ role: "user", content: "x".repeat(8000), timestamp: 3 });
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(3);
    expect(f.events.at(-1).reason).toBe("protected_tuples_missing");
  } finally { await f.close(); }
});

it.each(["manual", "reactive_overflow"])("%s retries only a truncated split prefix with legacy caps", async trigger => {
  const f = await fixture();
  try {
    await f.grow();
    await f.raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fictional suffix. ".repeat(2000) }], timestamp: 3 });
    f.completeSimple.mockImplementation(async () => f.completeSimple.mock.calls.length === 2 ? { ...answer(history), stopReason: "length" } : answer(history));
    expect((await f.compact(trigger)).applied).toBe(true);
    expect(f.completeSimple).toHaveBeenCalledTimes(3);
    expect(f.completeSimple.mock.calls[2]![2].maxTokens).toBeGreaterThan(f.completeSimple.mock.calls[1]![2].maxTokens);
    expect(JSON.stringify(f.completeSimple.mock.calls[2]![1])).not.toContain("<protected-historical-tuples>");
    expect(f.events.at(-1).accounting.requests[1]).toMatchObject({ reason: "output_truncated", providerInvoked: true });
  } finally { await f.close(); }
});
it("legacy truncation after the single extra retry fails normally without looping", async () => {
  const f = await fixture();
  try {
    await f.grow();
    f.completeSimple.mockResolvedValue({ ...answer(history), stopReason: "length" });
    expect((await f.compact("manual")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    expect(f.completeSimple.mock.calls[1]![2].maxTokens).toBe(1000);
    expect(JSON.stringify(f.completeSimple.mock.calls[1]![1])).not.toContain("<protected-historical-tuples>");
    expect(f.events.at(-1).status).toBe("failed");
    expect((await f.compact("reactive_overflow")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    expect(f.events.at(-1).reason).toBe("recent_identical_failure");
  } finally { await f.close(); }
});

it("shares a single paid refusal across idle, threshold checkpoints and new run controllers until real transcript growth", async () => {
  const f = await fixture();
  const runState = { session: f.session, sessionBaselineCount: 0, compaction: { policy: { ...f.policy, contextWindow: 100000, triggerTokens: 10000 },
    diagnostics: { context_fixed_overhead_tokens: 10000, context_user_message_tokens: 0 }, applied: false, compactedThisRun: false, reactiveAttempted: false } };
  const arm = () => createMidRunCompaction(runState, { harness: f.harness, options: {}, reference: "faux:liveness", onEvent: (event: any) => f.events.push(event), runtimeWarnings: f.warnings });
  let controller = arm();
  try {
    f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText("Fictional continuation.")])));
    await f.grow();
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    expect(await controller.arm()).toBe(true);
    const unchanged = await f.driver.prompt("Continue fictional work.");
    expect(unchanged.status).toBe("completed");
    expect(f.events.at(-1)).toMatchObject({ reason: "preservation_growth_required", accounting: { midRun: true } });
    expect(f.completeSimple).toHaveBeenCalledTimes(1); // fixed overhead is not new transcript growth
    await controller.disarm();
    controller = arm(); // a fresh turn/controller cannot repay the idle refusal
    expect(await controller.arm()).toBe(true);
    await f.driver.prompt("Continue unchanged fictional work.");
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    await f.raw.appendMessage({ role: "user", content: "Fictional growth. ".repeat(4000), timestamp: 4 });
    await f.driver.prompt("Continue after meaningful growth.");
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    expect(f.events.at(-1)).toMatchObject({ reason: "protected_tuples_missing", accounting: { midRun: true, splitTurn: false } });
    await controller.disarm();
    await f.compact("proactive"); // threshold refusal also suppresses the next idle check
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    expect(f.events.at(-1).reason).toBe("preservation_growth_required");
    expect((await f.raw.getEntries()).filter((entry: any) => entry.type === "compaction")).toHaveLength(1);
  } finally { await controller.disarm(); await f.close(); }
});
it("bounds split-cut refusals across idle and advancing mid-run tool steps by shared transcript growth", async () => {
  const f = await fixture();
  const runState = { session: f.session, sessionBaselineCount: 0, compaction: { policy: { ...f.policy, contextWindow: 100000, triggerTokens: 10000 },
    diagnostics: { context_fixed_overhead_tokens: 0, context_user_message_tokens: 0 }, applied: false, compactedThisRun: false, reactiveAttempted: false } };
  const cuts: { tokens: number; prefix: string; firstKeptId: string; splitTurn: boolean }[] = [];
  // Observe the real driver's cuts before the controller, without replacing its
  // preparation/dispatch path. A moving cut must not reset the paid baseline.
  const unobserve = f.driver.hooks.on("before_compaction", (event: any) => {
    const prepared = prepareCompaction(event.branchEntries, { keepRecentTokens: f.policy.keepRecentTokens }).value;
    const context = projectContext(event.branchEntries).messages!;
    cuts.push({ tokens: context.reduce((sum: number, message: any) => sum + estimateTokens(message), 0),
      prefix: JSON.stringify(prepared.turnPrefixMessages), splitTurn: prepared.isSplitTurn,
      firstKeptId: event.branchEntries.find((entry: any) => entry.type === "message" && entry.message === prepared.retainedTail[0])?.id });
  });
  const controller = createMidRunCompaction(runState, { harness: f.harness, options: {}, reference: "faux:liveness",
    onEvent: (event: any) => f.events.push(event), runtimeWarnings: f.warnings });
  const observed: { calls: number; tokens: number }[] = [];
  const step = vi.fn(async () => ({ content: [{ type: "text", text: "Fictional step completed." }] }));
  f.driver.setTools([{ name: "FictionalStep", description: "Fictional bounded step", parameters: { type: "object", properties: {} }, execute: step }]);
  try {
    await f.grow();
    await f.raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "a".repeat(6000) }], timestamp: 3 });
    await f.raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "b".repeat(2400) }], timestamp: 4 });
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.events.at(-1)).toMatchObject({ reason: "protected_tuples_missing", accounting: { splitTurn: true } });
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    const baseline = cuts[0]!.tokens, growth = Math.max(8192, Math.ceil(baseline * 0.1));
    expect(growth).toBe(8192);
    f.faux.setResponses(Array.from({ length: 8 }, (_, index) => () => {
      observed.push({ calls: f.completeSimple.mock.calls.length, tokens: cuts.at(-1)!.tokens });
      return index === 7 ? fauxAssistantMessage([fauxText("Fictional run completed.")])
        : fauxAssistantMessage([fauxText("c".repeat(5600)), fauxToolCall("FictionalStep", {}, { id: `fictional-step-${index}` })]);
    }));
    expect(await controller.arm()).toBe(true);
    // This pending prompt shifts the idle cut to the next assistant while both
    // remain split. Subsequent tool rounds each move it further by >1,000 tokens.
    expect((await f.driver.prompt("p".repeat(2000))).status).toBe("completed");
    expect(step).toHaveBeenCalledTimes(7);
    expect(observed).toHaveLength(8);
    expect(cuts).toHaveLength(9); // idle + initial request + seven tool-round checkpoints
    expect(cuts.every(cut => cut.splitTurn)).toBe(true);
    expect(new Set(cuts.map(cut => cut.firstKeptId)).size).toBe(cuts.length);
    expect(cuts.every(cut => typeof cut.firstKeptId === "string")).toBe(true);
    expect(new Set(cuts.map(cut => cut.prefix)).size).toBe(cuts.length);
    expect(observed.map(row => row.calls)).toEqual([1, 1, 1, 1, 1, 1, 2, 2]);
    for (const row of observed.slice(0, 6)) expect(row.tokens - baseline).toBeLessThan(growth);
    for (let index = 1; index < observed.length; index++) {
      const added = observed[index]!.tokens - observed[index - 1]!.tokens;
      expect(added).toBeGreaterThan(1000);
      expect(added).toBeLessThan(growth);
    }
    expect(observed[6]!.tokens - baseline).toBeGreaterThanOrEqual(growth);
    expect(observed[7]!.tokens - observed[6]!.tokens).toBeLessThan(Math.max(8192, Math.ceil(observed[6]!.tokens * 0.1)));
    expect(f.events.filter(event => event.reason === "protected_tuples_missing")).toHaveLength(2);
    expect(f.events.filter(event => event.accounting?.midRun && event.status === "skipped").every(event => event.accounting.splitTurn)).toBe(true);
    await controller.disarm();
    await f.compact("proactive"); // growth-paid threshold refusal also gates idle, despite a changed prefix
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    expect(f.events.at(-1).reason).toBe("preservation_growth_required");
    expect((await f.raw.getEntries()).filter((entry: any) => entry.type === "compaction")).toHaveLength(1);
  } finally { await controller.disarm(); unobserve(); await f.close(); }
});
it("zero-tuple legacy truncation remains a cached provider failure", async () => {
  const f = await fixture("## Goal\nFictional continuation without historical tuples.");
  try {
    await f.grow();
    f.completeSimple.mockResolvedValue({ ...answer("Legacy partial output"), stopReason: "length" });
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.events.at(-1)).toMatchObject({ status: "failed", accounting: { requests: [expect.objectContaining({ reason: "output_truncated" })] } });
    expect((await f.compact("reactive_overflow")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1).reason).toBe("recent_identical_failure");
  } finally { await f.close(); }
});
it("keeps partial native usage defined across durable reload without inventing a complete bill", async () => {
  const f = await fixture();
  try {
    await f.grow();
    f.completeSimple.mockResolvedValueOnce({ ...answer(history), stopReason: "length", usage: undefined }).mockResolvedValue(answer(history));
    expect((await f.compact("manual")).applied).toBe(true);
    const native = (await f.raw.getEntries()).filter((entry: any) => entry.type === "compaction").at(-1);
    expect(native.usage).toMatchObject({ input: 1, output: 1, totalTokens: 2, partial: true, cost: { total: 0 } });
    const collector = createCompactionUsage(); collector.observe(f.events.at(-1));
    expect(collector.slice()).toMatchObject({ input_tokens: 1, output_tokens: 1, cost_usd: null, cost_partial: true, known_cost_usd: 0 });
    expect(manualCompactionAccounting(collector.slice())).toMatchObject({ usageIncluded: false, requests: [{ costUsd: null }, { costUsd: 0 }] });
    await f.raw.sync();
    const metadata = f.raw.metadata;
    await f.driver.close(); await f.raw.close();
    const reopenedRepo = new JsonlSessionRepo({ sessionsRoot: f.root }), reopened = await reopenedRepo.open(metadata);
    try {
      const entries = await reopened.getEntries();
      expect(entries.filter((entry: any) => entry.type === "compaction").at(-1).usage).toEqual(native.usage);
      const projected = projectContext(entries).messages!;
      expect(JSON.stringify(projected)).toContain("Permit; m1; pending; no approval.");
      expect(projected.filter((message: any) => message.role === "compactionSummary").every((message: any) => message.usage === undefined)).toBe(true);
    } finally { await reopened.close(); await reopenedRepo.close(); }
  } finally { await f.close(); }
});

it.each([false, true])("authenticated cold predecessor reaches ordinary/split protection before budgeting (split=%s)", async split => {
  const f = await fixture(history, false, true);
  try {
    await f.grow();
    if (split) await f.raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fictional suffix. ".repeat(2000) }], timestamp: 3 });
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.events.at(-1)).toMatchObject({ reason: "protected_tuples_missing", accounting: { splitTurn: split, preservation: { protectedTupleCount: 1 } } });
    expect(JSON.stringify(f.completeSimple.mock.calls[0]![1])).toContain("<previous-summary>");
    expect(JSON.stringify(f.completeSimple.mock.calls[0]![1])).toContain("<protected-historical-tuples>");
    expect((await f.raw.getEntries()).filter((entry: any) => entry.type === "compaction")).toHaveLength(0);
    await f.grow(); f.completeSimple.mockResolvedValue(answer(history));
    expect((await f.compact("proactive")).applied).toBe(true);
    const cut = (await f.raw.getEntries()).filter((entry: any) => entry.type === "compaction").at(-1);
    expect(cut.checkpoint.retainedSummaryCoverage.admissionId).toBe(f.raw.validator.retainedSummaryAdmission.id);
  } finally { await f.close(); }
});
it.each(["manual", "reactive_overflow"])("authenticated cold predecessor preserves %s liveness bypass", async trigger => {
  const f = await fixture(history, false, true);
  try {
    await f.grow();
    expect((await f.compact(trigger)).applied).toBe(true);
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    expect(f.warnings).toContainEqual(expect.objectContaining({ warning_kind: "historical_preservation_bypassed", reason: "protected_tuples_missing" }));
  } finally { await f.close(); }
});
it("shares active admission's paid refusal across the real idle and threshold hooks", async () => {
  const f = await fixture(history, false, true);
  const state = { session: f.session, sessionBaselineCount: 0, compaction: { policy: { ...f.policy, contextWindow: 100000, triggerTokens: 10000 },
    diagnostics: { context_fixed_overhead_tokens: 10000, context_user_message_tokens: 0 }, applied: false, compactedThisRun: false, reactiveAttempted: false } };
  const controller = createMidRunCompaction(state, { harness: f.harness, options: {}, reference: "faux:liveness", onEvent: (event: any) => f.events.push(event), runtimeWarnings: f.warnings });
  try {
    await f.grow(); expect((await f.compact("proactive")).applied).toBe(false); expect(f.completeSimple).toHaveBeenCalledTimes(1);
    expect(await controller.arm()).toBe(true);
    expect((await f.driver.prompt("Continue fictional work.")).status).toBe("completed");
    expect(f.completeSimple).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toMatchObject({ reason: "preservation_growth_required", accounting: { midRun: true } });
    expect((await f.raw.getEntries()).some((entry: any) => entry.type === "compaction")).toBe(false);
  } finally { await controller.disarm(); await f.close(); }
});

it("commits the paid retained-only cut when steering queues input during generation, before and after coverage", async () => {
  const f = await fixture(history, false, true);
  try {
    await f.grow();
    await f.driver.beginTurn("fictional-steered", "synthetic", { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", handleId: f.raw.metadata.id, turnId: "fictional-steered", baseRevision: 1,
      reconciliation: { version: 1, purpose: "compaction", fenceDigest: "a".repeat(64), initialInputId: null } });
    f.completeSimple.mockImplementation(async () => {
      const before = { tip: f.raw.tip, seq: f.raw.seq };
      await f.driver.steer("Fictional queued input.", { inputId: `steer-${f.completeSimple.mock.calls.length}` });
      expect(f.raw.tip).toBe(before.tip); expect(f.raw.seq).toBeGreaterThan(before.seq);
      return answer(history);
    });
    for (let index = 0; index < 2; index++) {
      const attempt = await f.compact("proactive");
      expect(attempt.applied, JSON.stringify({ index, attempt, events: f.events, warnings: f.warnings })).toBe(true);
      expect((await f.raw.getEntries()).at(-1).checkpoint.retainedSummaryCoverage.admissionId).toBe(f.raw.validator.retainedSummaryAdmission.id);
      if (index === 0) await f.grow();
    }
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    expect([...f.raw.validator.inputs.values()].filter((input: any) => input.state === "queued")).toHaveLength(2);
    await f.driver.endTurn("completed", { text: null, error: null, failureKind: null, cancelled: false, stopReason: "compaction" });
  } finally { await f.close(); }
});

it.each([false, true])("counts the seed quotation, previous summary and protected frames in provider headroom (split=%s)", async split => {
  const f = await fixture(history, false, true);
  try {
    await f.grow();
    if (split) await f.raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fictional suffix. ".repeat(2000) }], timestamp: 3 });
    await f.compact("proactive");
    const context = f.completeSimple.mock.calls[0]![1], prompt = context.messages[0].content[0].text;
    expect(prompt).toContain(JSON.stringify(history)); // Quoted copy in the actual seed pack.
    expect(prompt).toContain(`<previous-summary>\n${history}\n</previous-summary>`);
    expect(prompt).toContain("<protected-historical-tuples>");
    const input = estimateProviderContext(context).tokens;
    const recorded = f.events.at(-1).accounting.requests[0], minimum = recorded.minimumAnswerTokens;
    const model = { ...f.harness.getModel(), contextWindow: input + 4096 + minimum - 1, maxTokens: 10000 };
    const policy = (value: any) => summaryRequestOptions(model, value, { maxTokens: recorded.textTargetTokens }, "none", minimum);
    const full = policy(context);
    expect(full.metadata.availableProviderTokens).toBe(minimum - 1); expect(full.canDispatch).toBe(false);
    for (const remove of [JSON.stringify(history), `<previous-summary>\n${history}\n</previous-summary>\n\n`, /<protected-historical-tuples>[\s\S]*?<\/protected-historical-tuples>\s*/u]) {
      const reduced = structuredClone(context); reduced.messages[0].content[0].text = prompt.replace(remove, "");
      expect(estimateProviderContext(reduced).tokens).toBeLessThan(input);
      expect(policy(reduced).canDispatch).toBe(true);
    }
  } finally { await f.close(); }
});

it("applies a cut without retained coverage when source disappears after the summary, warning only once", async () => {
  const f = await fixture(history, false, true);
  try {
    await f.grow();
    const warnings: any[] = [], append = vi.spyOn(f.raw, "appendCompaction");
    f.driver.subscribe((event: any) => { if (event.code === "retained_summary_legacy_fallback") warnings.push(event); });
    const resolve = vi.fn(async (): Promise<{ text: string } | undefined> => ({ text: history }));
    f.access.resolve = resolve;
    f.completeSimple.mockImplementation(async () => {
      const result = answer(history); // Generation completed while the source was available.
      resolve.mockResolvedValue(undefined); // Purge before the driver's post-summary recheck/append.
      return result;
    });
    expect((await f.compact("manual")).applied).toBe(true);
    expect(f.completeSimple).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledOnce(); expect(append.mock.calls[0]![3]).toBeUndefined();
    const cuts = (await f.raw.getEntries()).filter((entry: any) => entry.type === "compaction");
    expect(cuts).toHaveLength(1); expect(cuts[0].checkpoint.retainedSummaryCoverage).toBeUndefined();
    expect(warnings).toHaveLength(1); expect(JSON.stringify(warnings)).not.toContain(history);
    const warn = vi.fn();
    expect(await resolveRetainedSummaryAdmission(f.raw, f.access, warn)).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(2); expect(warn).not.toHaveBeenCalled(); expect(warnings).toHaveLength(1);
  } finally { await f.close(); }
});
