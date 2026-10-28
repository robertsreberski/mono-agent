import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentUpkeepAccounting } from "@mono-agent/contracts";
import { createJsonlRunRecorder, listRecordedRuns, mapRunToSession, NoopRunRecorder, readRecordedRun, withUpkeepAccounting } from "../index.js";
import type { RunSummary } from "../types.js";
import { exportUpkeepAccounting } from "../upkeep-accounting.js";
import { inclusiveRecordedCost } from "../upkeep-totals.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
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
it("marks incomplete inference counters partial without silently extending zero coercion", () => {
  expect(mapRunToSession({ ...summary, usage: { input_tokens: 10, output_tokens: 5 } }, [], opts).totals).toMatchObject({ tokIn: 10, tokOut: 5, tokCache: 0, tokensPartial: true });
  const totals = mapRunToSession({ ...summary, usage: undefined }, [], opts).totals;
  expect(totals).toMatchObject({ tokIn: 0, tokOut: 0, tokensPartial: true }); expect(totals.cacheHitRatio).toBeUndefined();
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
  const d = { ...dispatch, recorderNamespace: artifactDir }, r = { ...result, recorderNamespace: artifactDir };
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
