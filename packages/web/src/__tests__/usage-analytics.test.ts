import { describe, expect, it } from "vitest";
import { aggregateUsageAnalytics, type UsageAnalyticsMessage } from "../usage-analytics.js";
import { messageUsageRollup, projectMessageUsage, type CostTelemetryPart, type MessageUsageRollup } from "../message-cost.js";
import { sumThreadUsage, sumUsageSlices } from "../thread-usage.js";

const query = { from: "2026-10-24T00:00:00.000Z", to: "2026-10-27T00:00:00.000Z", bucket: "day" as const, timeZone: "Europe/Berlin" };
const tokens = (input: number) => ({ input, output: 2, cacheRead: 3, cacheWrite: 4 });
const dispatch = { version: 1, usageIncluded: false, operationId: "fictional-operation", runId: "fictional-run", conversationId: "fictional-conversation", model: "fictional:extractor", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null } as const;
const result = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 11, cacheReadTokens: 12, cacheWriteTokens: 13, outputTokens: 14, costUsd: 0.25 } as const;
const upkeep = (accounting: unknown): CostTelemetryPart => ({ type: "telemetry", event: "runtime_telemetry", data: { kind: "continuity_upkeep", data: { accounting } } });
const observed = (cost: number | null = 1, model = "fictional:answer"): CostTelemetryPart => ({ type: "telemetry", event: "usage_update", data: { model, cumulativeUsd: cost, tokens: tokens(100) } });
function row(parts: readonly CostTelemetryPart[], overrides: Partial<UsageAnalyticsMessage> = {}): UsageAnalyticsMessage {
  const rollup = messageUsageRollup({ parts });
  return { threadId: "garden", title: "Fictional garden notes", projectId: "seeds", projectName: "Seed catalog", archived: false,
    at: "2026-10-24T23:30:00.000Z", role: "assistant", running: false, rollup, projectUsage: projectMessageUsage(parts, rollup), ...overrides };
}
const known = (s: { costUsd?: number | null; knownCostUsd?: number }) => s.costUsd ?? s.knownCostUsd ?? 0;

describe("retained usage analytics", () => {
  it("reconciles each category/cost with canonical thread totals across DST days and UTC hours", () => {
    const sync = { type: "subagent", attribution: { executed: { model: "fictional:child" } }, costUsd: 0.3, usage: tokens(20) };
    const detached = { type: "process-job", job: { subagentProgress: { route: { executed: { model: "other:worker" } }, costUsd: 0.4, usage: tokens(10) } } };
    const rows = [row([observed(), sync, upkeep(dispatch)]), row([observed(), upkeep(result)], { at: "2026-10-25T23:30:00.000Z" }),
      row([observed(0.5), detached], { threadId: "cron", archived: true }), row([observed(null), { ...observed(null), data: { model: "legacy-model", cumulativeUsd: null, knownCostUsd: 0.2, tokens: tokens(30) } }], { threadId: "partial", projectId: null, running: true })];
    const expected = sumUsageSlices([sumThreadUsage(rows.slice(0, 2).map(r => r.rollup)).total, sumThreadUsage([rows[2]!.rollup]).total, sumThreadUsage([rows[3]!.rollup]).total]);
    for (const range of [query, { ...query, timeZone: "UTC" }, { ...query, bucket: "hour" as const }]) {
      const analytics = aggregateUsageAnalytics("fictional-agent", range, rows, query.to);
      expect(analytics.total).toEqual(expected);
      expect(sumUsageSlices(analytics.buckets.map(b => b.total))).toEqual(expected);
      const models = analytics.buckets.flatMap(b => b.models);
      expect(known(sumUsageSlices(models))).toBeCloseTo(known(expected));
      expect(sumUsageSlices(models).tokens).toEqual(expected.tokens);
      expect(analytics.coverage).toMatchObject({ containsRunningUsage: true, costPartial: true });
      expect(models.find(m => m.model === "legacy-model")?.provider).toBeNull();
    }
    const day = aggregateUsageAnalytics("fictional-agent", query, rows, query.to);
    const fall = day.buckets.find(b => b.start === "2026-10-24T22:00:00.000Z")!;
    expect(Date.parse(fall.end) - Date.parse(fall.start)).toBe(25 * 3_600_000);
    expect(fall.models.find(m => m.model === "fictional:extractor")?.costUsd).toBe(0.25); // result retained at first evidence's bucket
    expect(day.buckets.find(b => b.start === "2026-10-25T23:00:00.000Z")?.models.some(m => m.model === "fictional:extractor")).toBe(false);
    expect(day.topProjects[0]?.usage.costUsd).toBeCloseTo(3.15);
    expect(day.topProjects[0]?.projectSummaryUsage.costUsd).toBeNull(); // dispatch remains unknown in historical per-message project basis
    expect(JSON.stringify(day)).not.toMatch(/fictional-operation|fictional-run|accounting|parts_json/);
  });
  it("preserves included compaction and synchronous token attribution, while detached work is independent", () => {
    const rollup: MessageUsageRollup = { main: { model: "fictional:parent", tokens: tokens(100), costUsd: 2 },
      subagents: [{ detached: false, model: "fictional:child", tokens: tokens(20), costUsd: 0.5 }, { detached: true, model: "other:worker", tokens: tokens(10), costUsd: 0.25 }],
      compaction: { tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1, requests: 1, requestsWithUsage: 1 },
      compactionByModel: [{ model: "fictional:summary", tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1 }] };
    const analytics = aggregateUsageAnalytics("fictional-agent", query, [row([], { rollup })], query.to);
    expect(analytics.total.costUsd).toBe(2.25); expect(analytics.total.tokens?.input).toBe(110);
    const models = analytics.buckets.flatMap(b => b.models);
    expect(models.find(m => m.model === "fictional:child")?.tokens).toBeUndefined();
    expect(models.find(m => m.model === "fictional:parent")?.tokens?.input).toBe(95);
    expect(sumUsageSlices(models).tokens).toEqual(analytics.total.tokens);
    expect(known(sumUsageSlices(models))).toBeCloseTo(2.25);
  });
  it("does not hide token-only models, measured zero or unknown providers", () => {
    const rows = [row([{ type: "telemetry", event: "usage_update", data: { model: "unqualified", tokens: tokens(25) } }]), row([observed(0)], { threadId: "free" })];
    const analytics = aggregateUsageAnalytics("fictional-agent", query, rows, query.to);
    expect(analytics.buckets.flatMap(b => b.models).find(m => m.model === "unqualified")).toMatchObject({ provider: null, tokens: tokens(25), costPartial: true });
    expect(analytics.topConversations.find(t => t.threadId === "free")?.usage.costUsd).toBe(0);
    expect(analytics.coverage.costPartial).toBe(true);
  });
  it("keeps top model grouping and rankings bounded without losing counters", () => {
    const rows = Array.from({ length: 35 }, (_, i) => row([observed(i / 100, `fictional:model-${i}`)], { threadId: `fictional-thread-${i}`, projectId: `fictional-project-${i}` }));
    const analytics = aggregateUsageAnalytics("fictional-agent", query, rows, query.to);
    const models = analytics.buckets.flatMap(b => b.models);
    expect(models).toHaveLength(21); expect(models.some(m => m.model === "Other models")).toBe(true);
    expect(known(sumUsageSlices(models))).toBeCloseTo(known(analytics.total));
    expect(sumUsageSlices(models).tokens).toEqual(analytics.total.tokens);
    expect(analytics.topConversations).toHaveLength(10); expect(analytics.topProjects).toHaveLength(10);
    expect(analytics.coverage.conversations).toBe(35);
  });
  it("zero-fills time slots without inventing observed zero prices and preserves pending/overflow flags", () => {
    const empty = aggregateUsageAnalytics("fictional-agent", query, [], query.to);
    expect(empty.total).toEqual({}); expect(empty.buckets.length).toBeGreaterThan(0); expect(empty.buckets.every(b => b.models.length === 0 && b.total.costUsd === undefined)).toBe(true);
    const huge = { main: { model: "fictional:large", costUsd: 1, tokens: { ...tokens(1), input: Number.MAX_SAFE_INTEGER } }, subagents: [] };
    const analytics = aggregateUsageAnalytics("fictional-agent", query, [row([], { rollup: huge }), row([], { rollup: huge })], query.to);
    expect(analytics.total.tokens?.input).toBe(Number.MAX_SAFE_INTEGER); expect(analytics.total.tokensPartial).toBe(true);
  });
});
