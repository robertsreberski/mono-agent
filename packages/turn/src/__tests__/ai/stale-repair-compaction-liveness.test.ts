import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "../../engine/session-store.js";
import { createRunDriver } from "../../engine/run-driver.js";
import { projectContext } from "../../engine/request-projection.js";
import { estimateTokens, prepareCompaction } from "../../engine/compaction-kit/compaction.js";
import { createMidRunCompaction } from "../../execution/pi/compaction/mid-run-compaction.js";
import { runProactiveCompaction } from "../../execution/pi/compaction/compaction-driver.js";

const tuple = "- Fictional permit; initial review; pending; no approval.";
const history = `## Historical events and corrections\n${tuple}\n## Pending items\n- None`;
const answer = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }],
  usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });

// Entirely offline: actual durable storage/reopen, run-driver and guarded hooks;
// only the provider's deterministic completion text is scripted.
it.each(["pre-turn", "threshold"])("a stale durable zero-call account preserves native protection through real %s compaction", async trigger => {
  const root = await mkdtemp(join(tmpdir(), "stale-repair-compaction-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  let raw = await repo.create({ cwd: "/fictional" });
  let driver: ReturnType<typeof createRunDriver> | undefined;
  try {
    await raw.beginTurn("interrupted-turn");
    await raw.openOperation("interrupted-operation", {});
    await raw.appendMessage({ role: "user", content: "Fictional interrupted request", timestamp: 1 });
    await raw.sync();
    const metadata = raw.metadata;
    await raw.close(); // leave a durable unfinished operation, not a synthetic repair
    raw = await repo.open(metadata);
    const repairs = await raw.getRepairEntries();
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ cause: "crashed", calls: [], draftLossPossible: true });
    expect(await raw.getOpenOperations()).toEqual([]);

    const faux = fauxProvider({ models: [{ id: "stale-repair", contextWindow: 100000, maxTokens: 10000 }], tokensPerSecond: 1000000 });
    const models = createModels(); models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage([fauxText("Fictional continuation.")])));
    driver = createRunDriver(raw, { models, model, systemPrompt: "Fictional rules.", tools: [] });
    expect((await driver.prompt("Resume fictional work without replaying effects.")).status).toBe("completed");
    await raw.appendCompaction({ summary: history, tokensBefore: 10000, retainedTail: [], details: { readFiles: [], modifiedFiles: [] } });
    await raw.sync();
    const checkpoint = (await raw.getEntries()).at(-1);
    const grow = async () => { for (let index = 0; index < 2; index++) await raw.appendMessage({ role: "user", content: "Fictional context growth. ".repeat(2200), timestamp: 2 }); };
    await grow();
    const draft = { role: "assistant", stopReason: "error", content: [{ type: "text", text: "Fictional failed draft. ".repeat(100) }], timestamp: 3 };
    await raw.appendMessage(draft);
    const entries = await raw.getEntries();
    expect(projectContext(entries, { mode: "compaction", repairs: await raw.getRepairEntries() }).entries).toBe(entries);
    expect(await raw.getRepairEntries()).toEqual(repairs); // durable accounts are not consumed

    const completeSimple = vi.fn(async (..._args: any[]): Promise<any> => answer("Lossy fictional summary."));
    const session = { getEntries: () => raw.getEntries(), buildContext: async () => projectContext(await raw.getEntries(), { repairs: await raw.getRepairEntries() }) };
    const harness = { models: { completeSimple }, compactionFailureKey: root, getModel: () => model,
      waitForIdle: () => driver!.waitForIdle(), setCompactionSettings: (settings: any) => driver!.setCompactionSettings(settings),
      setMidRunCompactionArmed: (armed: boolean) => driver!.setMidRunCompactionArmed(armed), subscribe: (listener: any) => driver!.subscribe(listener),
      on: (_type: string, handler: any) => driver!.hooks.on("before_compaction", handler), compact: () => driver!.compact() };
    const events: any[] = [], warnings: any[] = [], recorded: any[] = [], observations: any[] = [];
    const policy = { enabled: true, contextWindow: 100000, triggerTokens: 10000, summaryMaxTokens: 1000, keepRecentTokens: 1000,
      compactionMinSavingsTokens: 0, effort: "none", failureCooldownMs: 900000, fixedOverheadEnabled: false };
    const runState = { session, sessionBaselineCount: 0, compaction: { policy, diagnostics: {}, applied: false, compactedThisRun: false, reactiveAttempted: false } };
    const options = { onCompactionRecorded: (event: any) => recorded.push(event) };
    const onEvent = (event: any) => events.push(event);
    driver.hooks.on("before_compaction", (event: any) => {
      const native = event.branchEntries;
      // This is the real production projection, before the guard receives it.
      expect(native.find((entry: any) => entry.id === checkpoint.id)).toEqual(checkpoint);
      const prepared = prepareCompaction(native, { keepRecentTokens: policy.keepRecentTokens }).value;
      expect(prepared.previousSummary).toBe(history);
      const midRun = projectContext(native, { includeFailed: true }).messages!;
      expect(midRun.some((value: any) => value.stopReason === "error")).toBe(true);
      const baseline = projectContext(native, { mode: "compaction" }).entries!;
      expect(baseline).toBe(native);
      expect(projectContext(baseline, { includeFailed: true }).messages).toEqual(midRun);
      observations.push({ reason: event.reason, previousSummary: prepared.previousSummary,
        tokens: midRun.reduce((sum: number, value: any) => sum + estimateTokens(value), 0) });
    });
    const attempt = async () => {
      if (trigger === "pre-turn") {
        await runProactiveCompaction(runState, { harness, options, systemPrompt: "Fictional rules.", tools: [],
          promptText: "Continue fictional work.", reference: "faux:stale-repair", onEvent, runtimeWarnings: warnings });
      } else {
        const controller = createMidRunCompaction(runState, { harness, options, reference: "faux:stale-repair", onEvent, runtimeWarnings: warnings });
        try {
          expect(await controller.arm()).toBe(true);
          expect((await driver!.prompt("Continue fictional work.")).status).toBe("completed");
          expect(controller.stats.evaluations).toBeGreaterThan(0); // actual engine threshold, not a direct hook call
        } finally { await controller.disarm(); }
      }
    };

    await attempt();
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ status: "skipped", reason: "protected_tuples_missing",
      accounting: { preservation: { protectedTupleCount: 1 } } });
    const input = JSON.stringify(completeSimple.mock.calls[0]![1]);
    expect(input).toContain("<protected-historical-tuples>");
    expect(input).toContain(tuple);
    expect((await raw.getEntries()).filter((entry: any) => entry.type === "compaction")).toHaveLength(1);
    await attempt(); // new threshold controller or repeated pre-turn cannot pay again unchanged
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(events.at(-1).reason).toBe("preservation_growth_required");
    expect(recorded).toEqual([]);

    await grow(); // exceed bounded-refusal growth requirement with real transcript bytes
    completeSimple.mockResolvedValue(answer(history));
    await attempt();
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ status: "succeeded", accounting: { preservation: { protectedTupleCount: 1 } } });
    expect(recorded).toHaveLength(1);
    expect(typeof recorded[0].first_kept_entry_id).toBe("string");
    expect(recorded[0].first_kept_entry_id).not.toMatch(/^derived:repair:/);
    expect(observations.length).toBeGreaterThanOrEqual(3);
    expect(observations.every(value => value.previousSummary === history && value.tokens >= policy.triggerTokens)).toBe(true);
    expect(observations.every(value => value.reason === (trigger === "threshold" ? "threshold" : "manual"))).toBe(true);
    expect(warnings.some(value => value.warning_kind === "historical_preservation_bypassed")).toBe(false);
    const committed = (await raw.getEntries()).filter((entry: any) => entry.type === "compaction");
    expect(committed).toHaveLength(2);
    expect(committed.at(-1).summary).toBe(history);
    await driver.close(); driver = undefined;
    await raw.close();
    raw = await repo.open(metadata);
    expect((await raw.getEntries()).filter((entry: any) => entry.type === "compaction").at(-1)).toEqual(committed.at(-1));
    expect(JSON.stringify(await session.buildContext())).toContain(tuple);
    expect(await raw.getRepairEntries()).toEqual(repairs);
  } finally {
    await driver?.close(); await raw.close(); await repo.close(); await rm(root, { recursive: true, force: true });
  }
});
