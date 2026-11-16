import type { ProviderUsageHistory } from "@mono-agent/contracts/provider-usage";
import type { WebUsageAnalytics, WebUsageSlice } from "../../../src/contracts";

/** Network-free, fictional values for stories, browser checks and screenshots. */
export function usageAnalyticsFixture(partial = false, stale = false): { data: WebUsageAnalytics; history: ProviderUsageHistory } {
  const from = Date.parse(stale ? "2020-04-15T00:00:00.000Z" : "2030-04-15T00:00:00.000Z"), to = from + 86_400_000;
  const iso = (at: number) => new Date(at).toISOString();
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const models = ["fictional:swift", "fictional:deep"].map((model, j) => ({ model, provider: "fictional", tokens: { input: 1000 + i * 50 + j * 200, output: 120 + j * 50, cacheRead: 600 + i * 10, cacheWrite: 80 },
      ...(partial && j === 1 ? { costUsd: null, knownCostUsd: (2 + i) / 100, costPartial: true as const } : { costUsd: (3 + i + j) / 100 }) }));
    return { start: iso(from + i * 3_600_000), end: iso(from + (i + 1) * 3_600_000), total: sum(models, partial), models };
  });
  const total = sum(buckets.map(b => b.total), partial);
  const garden = sum(buckets.map(bucket => bucket.models[0]!), false);
  const background = sum(buckets.map(bucket => bucket.models[1]!), partial);
  return {
    data: { schema: "mono-agent.usage-analytics.v1", sourceId: "fictional-agent", from: iso(from), to: iso(to), bucket: "hour", timeZone: "UTC", computedAt: iso(to), attribution: "message-created-at", scope: "retained-conversations", total, buckets,
      topConversations: [{ threadId: "fictional-garden", title: "Garden planning", usage: garden }, { threadId: "fictional-background", title: "Background catalog review", usage: background }],
      topProjects: [{ projectId: "fictional-project", name: "Seed catalog", usage: total, projectSummaryUsage: { costUsd: garden.costUsd! } }], unassignedUsage: {},
      coverage: { messages: 32, conversations: 2, projects: 1, containsRunningUsage: partial, tokensPartial: partial, costPartial: partial } },
    history: { schema: "mono-agent.provider-usage-history.v1", from: iso(from), to: iso(to), bucket: "hour", timeZone: "UTC", retentionDays: 90, storage: "ready", providers: (["openai-codex", "anthropic"] as const).map((providerId, providerIndex) => ({ providerId, label: providerId === "anthropic" ? "Claude" : "Codex", accountChanges: providerIndex === 0 ? [iso(from + 12 * 3_600_000)] : [], downsampled: false,
      samples: [1, 2, 5, 8, 12, 13, 18, 23].map((hour, i) => ({ fetchedAt: iso(from + hour * 3_600_000), observedThrough: iso(from + hour * 3_600_000), observations: 1, maxGapMs: 0, ...(providerId === "openai-codex" ? { plan: "Plus" } : {}), windows: [
        { kind: "session" as const, label: "Session" as const, usedPercent: [10, 30, 5, 45, 15, 50, 20, 60][i]!, periodMs: 18_000_000, resetsAt: iso(from + (Math.floor(hour / 5) + 1) * 18_000_000) },
        { kind: "weekly" as const, label: "Weekly" as const, usedPercent: [10, 12, 15, 20, 5, 8, 14, 21][i]! + providerIndex * 10, periodMs: 604_800_000, resetsAt: iso(to + 5 * 86_400_000) },
      ] })) })) },
  };
}
function sum(rows: readonly WebUsageSlice[], partial: boolean): WebUsageSlice {
  return { tokens: { input: rows.reduce((n, r) => n + (r.tokens?.input ?? 0), 0), output: rows.reduce((n, r) => n + (r.tokens?.output ?? 0), 0), cacheRead: rows.reduce((n, r) => n + (r.tokens?.cacheRead ?? 0), 0), cacheWrite: rows.reduce((n, r) => n + (r.tokens?.cacheWrite ?? 0), 0) },
    ...(partial ? { costUsd: null, knownCostUsd: rows.reduce((n, r) => n + (r.costUsd ?? r.knownCostUsd ?? 0), 0), costPartial: true, tokensPartial: true } : { costUsd: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0) }) };
}
