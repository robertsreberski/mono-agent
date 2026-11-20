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
  const topConversations = [
    { threadId: "fictional-garden", title: "Garden planning", usage: garden },
    { threadId: "fictional-background", title: "Background catalog review", usage: background },
  ].sort((a, b) => (b.usage.costUsd ?? b.usage.knownCostUsd ?? -Infinity) - (a.usage.costUsd ?? a.usage.knownCostUsd ?? -Infinity));
  return {
    data: { schema: "mono-agent.usage-analytics.v1", sourceId: "fictional-agent", from: iso(from), to: iso(to), bucket: "hour", timeZone: "UTC", computedAt: iso(to), attribution: "message-created-at", scope: "retained-conversations", total, buckets,
      topConversations,
      topProjects: [{ projectId: "fictional-project", name: "Seed catalog", usage: total, projectSummaryUsage: { costUsd: garden.costUsd! } }], unassignedUsage: {},
      coverage: { messages: 32, conversations: 2, projects: 1, containsRunningUsage: partial, tokensPartial: partial, costPartial: partial } },
    history: { schema: "mono-agent.provider-usage-history.v1", from: iso(from), to: iso(to), bucket: "hour", timeZone: "UTC", retentionDays: 90, storage: "ready", providers: (["openai-codex", "anthropic"] as const).map((providerId, providerIndex) => ({ providerId, label: providerId === "anthropic" ? "Claude" : "Codex", accountChanges: providerIndex === 0 ? [iso(from + 12 * 3_600_000)] : [], downsampled: false,
      samples: [1, 2, 5, 8, 12, 13, 18, 23].map((hour, i) => ({ fetchedAt: iso(from + hour * 3_600_000), observedThrough: iso(from + hour * 3_600_000), observations: 1, maxGapMs: 0, ...(providerId === "openai-codex" ? { plan: "Plus" } : {}), windows: [
        { kind: "session" as const, label: "Session" as const, usedPercent: [10, 30, 5, 45, 15, 50, 20, 60][i]!, periodMs: 18_000_000, resetsAt: iso(from + (Math.floor(hour / 5) + 1) * 18_000_000) },
        { kind: "weekly" as const, label: "Weekly" as const, usedPercent: [10, 12, 15, 20, 5, 8, 14, 21][i]! + providerIndex * 10, periodMs: 604_800_000, resetsAt: iso(to + 5 * 86_400_000) },
      ] })) })) },
  };
}
/** Fictional sparse checks: Claude's reported reset times drift by milliseconds or seconds. */
export function jitteredQuotaHistoryFixture(): ProviderUsageHistory {
  const hourMs = 3_600_000;
  const from = Date.parse("2031-05-04T00:00:00.000Z");
  const at = (hour: number, jitterMs = 0) => new Date(from + hour * hourMs + jitterMs).toISOString();
  const hours = [2, 4, 8, 15.6, 22, 26, 31, 33, 43, 50.4, 57, 67];
  const jitter = [-1250, 462, 841, -673, 114, 2210, -110, 546, -1730, 841, 287, -423];
  return {
    schema: "mono-agent.provider-usage-history.v1", retentionDays: 90, storage: "ready",
    from: at(0), to: at(72), bucket: "day", timeZone: "UTC",
    providers: (["anthropic", "openai-codex"] as const).map(providerId => {
      const claude = providerId === "anthropic";
      return {
        providerId, label: claude ? "Claude" : "Codex", accountChanges: [], downsampled: false,
        samples: hours.map((hour, i) => {
          const reset = (hour: number) => at(hour, claude ? jitter[i]! : 0);
          const weeklyReset = claude ? 47 : 62;
          return {
            fetchedAt: at(hour), observedThrough: at(hour), observations: 1, maxGapMs: 0,
            ...(claude ? {} : { plan: "Plus" }),
            windows: [
              {
                kind: "session", label: "Session", periodMs: 5 * hourMs,
                usedPercent: (claude ? [22, 55, 63, 8, 36, 16, 24, 57, 78, 10, 41, 50]
                  : [18, 47, 72, 7, 33, 12, 19, 48, 55, 13, 46, 44])[i]!,
                resetsAt: reset((Math.floor(hour / 5) + 1) * 5),
              },
              {
                kind: "weekly", label: "Weekly", periodMs: 168 * hourMs,
                usedPercent: (claude ? [29, 33, 37, 42, 50, 55, 62, 66, 77, 5, 9, 17]
                  : [17, 23, 26, 31, 37, 44, 51, 54, 63, 71, 80, 10])[i]!,
                resetsAt: reset(hour < weeklyReset ? weeklyReset : weeklyReset + 168),
              },
              ...(claude ? [{
                kind: "model" as const, label: "Fable" as const, periodMs: 168 * hourMs,
                usedPercent: [8, 11, 16, 25, 31, 40, 45, 46, 54, 62, 68, 6][i]!,
                resetsAt: reset(hour < 61 ? 61 : 229),
              }] : []),
            ],
          };
        }),
      };
    }),
  };
}

function sum(rows: readonly WebUsageSlice[], partial: boolean): WebUsageSlice {
  return { tokens: { input: rows.reduce((n, r) => n + (r.tokens?.input ?? 0), 0), output: rows.reduce((n, r) => n + (r.tokens?.output ?? 0), 0), cacheRead: rows.reduce((n, r) => n + (r.tokens?.cacheRead ?? 0), 0), cacheWrite: rows.reduce((n, r) => n + (r.tokens?.cacheWrite ?? 0), 0) },
    ...(partial ? { costUsd: null, knownCostUsd: rows.reduce((n, r) => n + (r.costUsd ?? r.knownCostUsd ?? 0), 0), costPartial: true, tokensPartial: true } : { costUsd: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0) }) };
}
