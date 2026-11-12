import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "../../engine/session-store.js";
import { createRunDriver } from "../../engine/run-driver.js";
import { checkNativeInheritedPrefix } from "../../execution/pi/handoff-producer.js";
import { projectContext, projectInheritedContext } from "../../engine/request-projection.js";
import { tryCompact, runReactiveCompaction } from "../../execution/pi/compaction/compaction-driver.js";

const tuple = "- Permit; m1; pending; no approval.";
const history = `## Historical events and corrections\n${tuple}\n## Pending items\n- None`;
const answer = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

async function fixture(summary = history, inherited = false) {
  const inheritedProjection = { messages: [{ role: "user", content: "Fictional inherited prefix.", timestamp: 1 }], coverage: { version: 1, sources: [{ journalId: "frozen", sourceTipId: "tip", sourceSeq: 7, sourceDigest: "3".repeat(64) }] } };
  const root = await mkdtemp(join(tmpdir(), "historical-liveness-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const raw = await repo.create({ cwd: "/fictional", ...(inherited ? { hostAuthority: { version: 1, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" }, assertOwned: async () => {} } : {}) });
  await raw.appendCompaction({ summary, tokensBefore: 10000, retainedTail: [], details: { readFiles: [], modifiedFiles: [] } });
  const faux = fauxProvider({ models: [{ id: "liveness", contextWindow: 100000, maxTokens: 10000 }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional run continued.")])]);
  const model = faux.getModel();
  const completeSimple = vi.fn(async (..._args: any[]) => answer("Legacy lossy summary."));
  const driver = createRunDriver(raw, { model, models, systemPrompt: "Fictional rules.", tools: [], ...(inherited ? { inheritedProjection } : {}) });
  const session = { getEntries: () => raw.getEntries(), buildContext: async () => inherited ? projectInheritedContext(await raw.getEntries(), inheritedProjection) : projectContext(await raw.getEntries()) };
  const harness = { models: { completeSimple }, compactionFailureKey: root, getModel: () => model, waitForIdle: () => driver.waitForIdle(),
    setCompactionSettings: (settings: any) => driver.setCompactionSettings(settings),
    on: (_type: string, handler: any) => driver.hooks.on("before_compaction", handler), compact: () => driver.compact(), prompt: vi.fn((text: string) => driver.prompt(text)) };
  const events: any[] = [], warnings: any[] = [];
  const policy = { enabled: true, summaryMaxTokens: 1000, keepRecentTokens: 1000, compactionMinSavingsTokens: 0, effort: "none", failureCooldownMs: 900000 };
  const compact = (trigger: string) => tryCompact(harness, { trigger, onEvent: (event: any) => events.push(event), runtimeWarnings: warnings, session, policy });
  const grow = async () => { for (let i = 0; i < 2; i++) await raw.appendMessage({ role: "user", content: "Fictional context. ".repeat(2000), timestamp: 2 }); };
  return { raw, session, harness, driver, completeSimple, events, warnings, policy, compact, grow,
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
it("a changed split prefix permits an idle retry below the normal growth threshold", async () => {
  const f = await fixture();
  try {
    await f.grow();
    expect((await f.compact("proactive")).applied).toBe(false);
    await f.raw.appendMessage({ role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }], timestamp: 3 });
    expect((await f.compact("proactive")).applied).toBe(false);
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
    await f.compact("proactive");
    expect(f.completeSimple).toHaveBeenCalledTimes(2);
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
  } finally { await f.close(); }
});
