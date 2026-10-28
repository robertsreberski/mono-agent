import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentUpkeepAccounting } from "@mono-agent/contracts";
import { createJsonlRunRecorder, listRecordedRuns, mapRunToSession, NoopRunRecorder, readRecordedRun, withUpkeepAccounting } from "../index.js";
import type { RunSummary, RuntimeEventLike } from "../types.js";
import { exportUpkeepAccounting } from "../upkeep-accounting.js";
import { inclusiveRecordedCost } from "../upkeep-totals.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const dispatch: AgentUpkeepAccounting = { version: 1, usageIncluded: false, operationId: "op", databaseId: "db", incarnation: "inc", runId: "origin", conversationId: "fictional", logicalConversationId: "logical", recorderNamespace: "/home/example", model: "fictional:extractor", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null };
const result: AgentUpkeepAccounting = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, outputTokens: 2, costUsd: 0.2 };
const inference = { usage: { input_tokens: 10, cache_read_tokens: 20, cache_creation_tokens: 3, output_tokens: 5 }, cost: { cumulativeUsd: 0.1 } };
const summary: RunSummary = { runId: "origin", conversationId: "fictional", status: "succeeded", durationMs: 0, eventCount: 0, artifactPaths: [], ...inference };
const opts = { instanceLabel: "fictional" };
it("deduplicates phases and mixed cache categories without changing inference fields", () => {
  const session = mapRunToSession({ ...summary, upkeepAccounting: [dispatch, result] }, [{ type: "continuity_upkeep", accounting: result }, { type: "continuity_upkeep_dispatch", accounting: dispatch }], opts);
  expect(session.totals.cost).toBeCloseTo(0.3);
  expect(session.totals).toMatchObject({ tokIn: 13, tokOut: 7, tokCache: 32, tokCacheRead: 24, tokCacheWrite: 8, tokInputTotal: 45 });
  expect(session.totals.cacheHitRatio).toBeCloseTo(24 / 45);
  expect(session.totals.tokensPartial).toBeUndefined(); expect(summary.usage).toEqual(inference.usage);
});
it.each([dispatch, { ...result, inputTokens: null, costUsd: null }])("retains known subtotals and suppresses complete input metrics for missing usage", a => {
  const session = mapRunToSession({ ...summary, upkeepAccounting: [a] }, [], opts);
  expect(session.totals).toMatchObject({ cost: null, knownCostUsd: 0.1, tokensPartial: true, tokIn: 10 });
  expect(session.totals.cacheHitRatio).toBeUndefined(); expect(session.totals.tokInputTotal).toBeUndefined();
  expect(a.inputTokens).toBeNull();
});
it("keeps known cost even when inference cost is partial, and explicit non-invocation is measured zero", () => {
  const partial = inclusiveRecordedCost({ cost: { cumulativeUsd: null, knownCostUsd: 0.1 } }, [result]);
  expect(partial.totalUsd).toBeNull(); expect(partial.knownCostUsd).toBeCloseTo(0.3); expect(partial.partial).toBe(true);
  const none: AgentUpkeepAccounting = { ...result, invocation: "not_invoked", outcome: "skipped", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  expect(inclusiveRecordedCost(summary, [dispatch, none])).toEqual({ totalUsd: 0.1, knownCostUsd: 0.1, partial: false });
});
it.each([
  [undefined, { tokIn: 0, tokOut: 0, tokCache: 0 }],
  [{ input_tokens: 10, output_tokens: 5 }, { tokIn: 10, tokOut: 5, tokCache: 0 }],
  [{ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }, { tokIn: 0, tokOut: 0, tokCache: 0, tokCacheRead: 2, tokCacheWrite: 3, tokInputTotal: 15, cacheHitRatio: 2 / 15 }],
  [{ input_tokens: -2, output_tokens: 1.5, cache_read_tokens: -4, cache_creation_tokens: 2.5 }, { tokIn: -2, tokOut: 1.5, tokCache: -1.5, tokCacheWrite: 2.5 }],
  [{ input_tokens: "[redacted]", output_tokens: null, cache_read_tokens: 0 }, { tokIn: 0, tokOut: 0, tokCache: 0, tokCacheRead: 0 }],
  [inference.usage, { tokIn: 10, tokOut: 5, tokCache: 23, tokCacheRead: 20, tokCacheWrite: 3, tokInputTotal: 33, cacheHitRatio: 20 / 33 }],
])("preserves main's complete no-upkeep totals shape for %j", (usage, tokens) => {
  const expected = { asst: 0, tcalls: 0, think: 0, ...tokens, cost: 0.1, steps: 0 };
  const actual = mapRunToSession({ ...summary, usage }, [], opts).totals;
  expect(actual).toEqual(expected); expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
});
it.each(["failed", "cancelled"] as const)("retains host receipts independently of an injected recorder (%s)", async status => {
  const recorder = withUpkeepAccounting(new NoopRunRecorder({ runId: "origin", conversationId: "fictional" }), "origin", "fictional");
  recorder.onEvent({ type: "continuity_upkeep_dispatch", accounting: dispatch });
  recorder.onEvent({ type: "continuity_upkeep", accounting: result });
  recorder.onEvent({ type: "continuity_upkeep_dispatch", accounting: dispatch });
  const value = status === "failed" ? await recorder.fail(new Error("fictional failure")) : await recorder.finish({ ...inference, cancelled: true });
  expect(value.upkeepAccounting).toEqual([result]); expect(value.status).toBe(status);
  expect(value.inclusiveCost?.knownCostUsd).toBeCloseTo(status === "failed" ? 0.2 : 0.3);
  expect(await recorder.finish({})).toBe(value);
});
it("never attributes another run's receipt to the current answer", async () => {
  const recorder = withUpkeepAccounting(new NoopRunRecorder({ runId: "new", conversationId: "fictional" }), "new", "fictional");
  recorder.onEvent({ type: "continuity_upkeep", accounting: result });
  expect((await recorder.finish(inference)).upkeepAccounting).toBeUndefined();
});
it("persists dispatch before failed settlement; late companions refine both list and detail exactly once", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "upkeep-inclusive-")); roots.push(artifactDir);
  const namespace = await realpath(artifactDir);
  const d = { ...dispatch, recorderNamespace: namespace }, r = { ...result, recorderNamespace: namespace };
  const recorder = createJsonlRunRecorder({ artifactDir, runId: "origin", conversationId: "fictional" });
  await recorder.start!(); recorder.onEvent({ type: "continuity_upkeep_dispatch", accounting: d });
  const failed = await recorder.fail(new Error("fictional failure after dispatch"));
  expect(failed.upkeepAccounting).toEqual([d]); expect(failed.inclusiveCost).toEqual({ totalUsd: null, knownCostUsd: 0, partial: true });
  const disk = JSON.parse(await readFile(join(artifactDir, "origin.summary.json"), "utf8")); expect(disk.upkeepAccounting).toEqual([d]);
  await exportUpkeepAccounting(r); await exportUpkeepAccounting(d);
  const detail = await readRecordedRun({ artifactDir, maxEventsPerRun: 1 }, "origin");
  const listed = (await listRecordedRuns({ artifactDir, maxEventsPerRun: 1 })).runs[0]!;
  expect(detail?.upkeepAccounting).toEqual([r]); expect(detail?.summary.inclusiveCost).toEqual({ totalUsd: null, knownCostUsd: 0.2, partial: true });
  expect(listed.inclusiveCost).toEqual(detail?.summary.inclusiveCost);
  expect(mapRunToSession({ ...detail!.summary, artifactPaths: [] }, [], opts).totals).toMatchObject({ cost: null, knownCostUsd: 0.2, tokensPartial: true });
});
it("snapshots event receipts into a successful inference-only summary, including a late dispatch duplicate", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "upkeep-summary-")); roots.push(artifactDir);
  const recorder = createJsonlRunRecorder({ artifactDir, runId: "origin", conversationId: "fictional" });
  recorder.onEvent({ type: "continuity_upkeep", accounting: result }); recorder.onEvent({ type: "continuity_upkeep_dispatch", accounting: dispatch });
  const done = await recorder.finish(inference);
  expect(done.upkeepAccounting).toEqual([result]); expect(done.inclusiveCost?.totalUsd).toBeCloseTo(0.3); expect(done.cost).toEqual(inference.cost);
});

it("never calls corrupt accounting a complete zero-cost contribution", async () => {
  const recorder = withUpkeepAccounting(new NoopRunRecorder({ runId: "origin", conversationId: "fictional" }), "origin", "fictional");
  recorder.onEvent({ type: "continuity_upkeep", accounting: { ...result, inputTokens: -1 } });
  const done = await recorder.finish(inference);
  expect(done.upkeepAccountingPartial).toBe(true);
  expect(done.inclusiveCost).toEqual({ totalUsd: null, knownCostUsd: 0.1, partial: true });
  const totals = mapRunToSession(done, [], opts).totals;
  expect(totals).toMatchObject({ cost: null, knownCostUsd: 0.1, tokensPartial: true });
  expect(totals.cacheHitRatio).toBeUndefined(); expect(totals.tokInputTotal).toBeUndefined();
});

it("normalizes legacy namespace aliases before merging session sources", () => {
  const session = mapRunToSession({ ...summary, upkeepAccounting: [result] }, [{ type: "continuity_upkeep", accounting: { ...result, recorderNamespace: "/home/example/." } }], opts);
  expect(session.totals.cost).toBeCloseTo(0.3); expect(session.totals.tokensPartial).toBeUndefined();
});
it("adds host accounting without executing injected summary or cost getters", async () => {
  let reads = 0;
  const raw = { ...summary, get cost() { reads++; return { cumulativeUsd: 9 }; } };
  const recorder = withUpkeepAccounting({ onEvent() {}, finish: async () => raw, fail: async () => raw }, "origin", "fictional");
  recorder.onEvent({ type: "continuity_upkeep", accounting: result });
  const done = await recorder.finish({});
  expect(reads).toBe(0); expect(done.inclusiveCost).toEqual({ totalUsd: null, knownCostUsd: 0.2, partial: true });
  expect(Object.getOwnPropertyDescriptor(done, "cost")?.get).toBeDefined();
  const nested = { ...summary, cost: { get cumulativeUsd() { reads++; return 9; } } };
  const second = withUpkeepAccounting({ onEvent() {}, finish: async () => nested, fail: async () => nested }, "origin", "fictional");
  second.onEvent({ type: "continuity_upkeep", accounting: result });
  expect((await second.finish({})).inclusiveCost).toEqual({ totalUsd: null, knownCostUsd: 0.2, partial: true }); expect(reads).toBe(0);
});

it("allows custom recorder terminal recovery after a rejected commit, retaining host receipts", async () => {
  let commits = 0, failures = 0;
  const inner = { onEvent() {}, finish: async () => summary,
    commitFinish: async () => { commits++; throw new Error("fictional commit rejection"); },
    fail: async () => { failures++; return { ...summary, status: "failed" as const }; } };
  const recorder = withUpkeepAccounting(inner, "origin", "fictional");
  recorder.onEvent({ type: "continuity_upkeep", accounting: result });
  await expect(recorder.commitFinish!({})).rejects.toThrow("fictional commit rejection");
  const recovered = await recorder.fail(new Error("fictional failure"));
  expect(commits).toBe(1); expect(failures).toBe(1); expect(recovered.status).toBe("failed");
  expect(recovered.upkeepAccounting).toEqual([result]); expect(await recorder.finish({})).toBe(recovered);
});
it("returns async custom onEvent rejection so existing await/catch boundaries still handle it", async () => {
  const error = new Error("fictional event rejection");
  const recorder = withUpkeepAccounting({ onEvent: async () => { throw error; }, finish: async () => summary, fail: async () => summary }, "origin", "fictional");
  let caught: unknown;
  try { await recorder.onEvent({ type: "continuity_upkeep", accounting: result }); } catch (value) { caught = value; }
  expect(caught).toBe(error); expect((await recorder.finish({})).upkeepAccounting).toEqual([result]);
});
it("merges real and symlinked namespace identities without making readers or sessions partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "upkeep-alias-")); roots.push(root);
  const artifactDir = join(root, "artifacts"), alias = join(root, "alias");
  await mkdir(artifactDir); await symlink(artifactDir, alias, process.platform === "win32" ? "junction" : "dir");
  const d = { ...dispatch, recorderNamespace: alias }, r = { ...result, recorderNamespace: artifactDir };
  const recorder = createJsonlRunRecorder({ artifactDir: alias, runId: "origin", conversationId: "fictional" });
  recorder.onEvent({ type: "continuity_upkeep_dispatch", accounting: d }); await recorder.finish(inference);
  await exportUpkeepAccounting(r);
  for (const dir of [alias, artifactDir]) {
    const detail = await readRecordedRun({ artifactDir: dir }, "origin");
    const listed = (await listRecordedRuns({ artifactDir: dir })).runs[0]!;
    expect(detail?.warnings).toEqual([]); expect(detail?.summary.upkeepAccountingPartial).toBeUndefined();
    expect(listed.inclusiveCost?.totalUsd).toBeCloseTo(0.3);
    expect(detail?.upkeepAccounting).toEqual([{ ...r, recorderNamespace: await realpath(artifactDir) }]);
    const totals = mapRunToSession({ ...detail!.summary, artifactPaths: [] }, detail!.events.map(event => event.payload as RuntimeEventLike), opts).totals;
    expect(totals.cost).toBeCloseTo(0.3); expect(totals.tokensPartial).toBeUndefined();
  }
});

it.each(["host", "jsonl"])("canonicalizes once at %s acceptance, not on ordinary recorder events", async kind => {
  const artifactDir = await mkdtemp(join(tmpdir(), "upkeep-namespace-cache-")); roots.push(artifactDir);
  const inner = new NoopRunRecorder({ runId: "origin", conversationId: "fictional" });
  const recorder = kind === "host" ? withUpkeepAccounting(inner, "origin", "fictional")
    : createJsonlRunRecorder({ artifactDir, runId: "origin", conversationId: "fictional" });
  const canonicalize = vi.spyOn(realpathSync, "native");
  recorder.onEvent({ type: "continuity_upkeep_dispatch", accounting: { ...dispatch, recorderNamespace: artifactDir } });
  const reads = canonicalize.mock.calls.length;
  expect(reads).toBe(1);
  for (let i = 0; i < 500; i++) recorder.onEvent({ type: "text_delta", text: "Fictional output." });
  recorder.onEvent({ type: "continuity_upkeep", accounting: { ...result, recorderNamespace: artifactDir } });
  const done = await recorder.finish(inference);
  expect(canonicalize).toHaveBeenCalledTimes(reads); expect(done.inclusiveCost?.totalUsd).toBeCloseTo(0.3);
});
it("keeps session mapping pure with already-accepted receipt namespaces", () => {
  const canonicalize = vi.spyOn(realpathSync, "native").mockImplementation(() => { throw new Error("mapper must not touch filesystem"); });
  const totals = mapRunToSession({ ...summary, upkeepAccounting: [result] }, [{ type: "continuity_upkeep_dispatch", accounting: dispatch }], opts).totals;
  expect(totals.cost).toBeCloseTo(0.3); expect(totals.tokensPartial).toBeUndefined(); expect(canonicalize).not.toHaveBeenCalled();
});
it.each(["fail", "cancel"])("forwards a waiting %s after pending custom commit rejects", async mode => {
  let reject!: (error: Error) => void;
  const commit = new Promise<RunSummary>((_resolve, rejectCommit) => { reject = rejectCommit; });
  const calls: string[] = [];
  const inner = { onEvent() {}, commitFinish: () => { calls.push("commit"); return commit; },
    finish: async () => { calls.push("cancel"); return { ...summary, status: "cancelled" as const }; },
    fail: async () => { calls.push("fail"); return { ...summary, status: "failed" as const }; } };
  const recorder = withUpkeepAccounting(inner, "origin", "fictional");
  recorder.onEvent({ type: "continuity_upkeep", accounting: result });
  const pending = recorder.commitFinish!({});
  const recover = () => mode === "fail" ? recorder.fail(new Error("fictional failure")) : recorder.finish({ cancelled: true });
  const first = recover(), second = recover();
  expect(calls).toEqual(["commit"]);
  reject(new Error("fictional delayed commit rejection"));
  await expect(pending).rejects.toThrow("fictional delayed commit rejection");
  const recovered = await first;
  expect(await second).toBe(recovered); expect(calls).toEqual(["commit", mode]);
  expect(recovered.status).toBe(mode === "fail" ? "failed" : "cancelled");
  expect(recovered.upkeepAccounting).toEqual([result]);
});


it.each([
  [{ status: "skipped", providerInvoked: false }, false],
  [{ status: "valid", providerInvoked: true }, true],
  [{ status: "uncertain", providerInvoked: false }, true],
] as const)("requires spend evidence before missing accounting makes recorder/session partial: %j", async (status, partial) => {
  const event = { type: "continuity_upkeep", ...status };
  const recorder = withUpkeepAccounting(new NoopRunRecorder({ runId: "origin", conversationId: "fictional" }), "origin", "fictional");
  recorder.onEvent(event);
  const done = await recorder.finish(inference);
  expect(done.upkeepAccountingPartial === true).toBe(partial);
  const totals = mapRunToSession(summary, [event], opts).totals;
  expect(totals.cost).toBe(partial ? null : 0.1);
  if (!partial) {
    expect(done.inclusiveCost).toBeUndefined();
    expect(totals).toEqual({ ...mapRunToSession(summary, [], opts).totals, steps: 1 });
  } else expect(done.inclusiveCost).toEqual({ totalUsd: null, knownCostUsd: 0.1, partial: true });
});
