import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "../../engine/session-store.js";
import { createRunDriver } from "../../engine/run-driver.js";
import { projectContext } from "../../engine/request-projection.js";
import { tryCompact, runReactiveCompaction } from "../../execution/pi/compaction/compaction-driver.js";

const tuple = "- Permit; m1; pending; no approval.";
const history = `## Historical events and corrections\n${tuple}\n## Pending items\n- None`;
const answer = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

async function fixture(summary = history) {
  const root = await mkdtemp(join(tmpdir(), "historical-liveness-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const raw = await repo.create({ cwd: "/fictional" });
  await raw.appendCompaction({ summary, tokensBefore: 10000, retainedTail: [], details: { readFiles: [], modifiedFiles: [] } });
  const faux = fauxProvider({ models: [{ id: "liveness", contextWindow: 100000, maxTokens: 10000 }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional run continued.")])]);
  const model = faux.getModel();
  const completeSimple = vi.fn(async () => answer("Legacy lossy summary."));
  const driver = createRunDriver(raw, { model, models, systemPrompt: "Fictional rules.", tools: [] });
  const session = { getEntries: () => raw.getEntries(), buildContext: async () => projectContext(await raw.getEntries()) };
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
