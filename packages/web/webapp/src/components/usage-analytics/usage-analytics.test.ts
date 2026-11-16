import { afterEach, describe, expect, it, vi } from "vitest";
import { api, parseUsageAnalytics } from "../../api";
import { usageAnalyticsFixture } from "../../test/usage-analytics-fixtures";
import { browserCostWire } from "../../../../src/cost-wire";
import { parseSettingsParam } from "../../settings-navigation";
import { displayTimeZone, formatAnalyticsCost, knownSpend, MIN_LONG_GAP_MS, quotaPaths } from "./usage-chart-geometry";

afterEach(() => vi.unstubAllGlobals());
describe("analytics client and geometry", () => {
  it("parses the partial wire contract and rejects transcript/identity fields and unbounded data", () => {
    const { data } = usageAnalyticsFixture(true);
    expect(parseUsageAnalytics(browserCostWire(data)).total).toMatchObject({ costUsd: null, costPartial: true });
    expect(() => parseUsageAnalytics({ ...data, accountId: "fictional-private" })).toThrow();
    expect(() => parseUsageAnalytics({ ...data, buckets: [{ ...data.buckets[0], prompt: "fictional private text" }] })).toThrow();
    expect(() => parseUsageAnalytics({ ...data, buckets: Array(170).fill(data.buckets[0]) })).toThrow();
    expect(() => parseUsageAnalytics({ ...data, total: { costUsd: -1 } })).toThrow();
  });
  it("reads history and analytics with claimed origin and never fetches a live snapshot", async () => {
    const fixture = usageAnalyticsFixture();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === "DELETE" ? {} : url.includes("provider-usage") ? fixture.history : fixture.data));
    vi.stubGlobal("fetch", fetch);
    const range = { from: fixture.data.from, to: fixture.data.to, bucket: "hour" as const, timeZone: "UTC" };
    await api.usageAnalytics("fictional-agent", range); await api.providerUsageHistory("fictional-agent", range); await api.clearProviderUsageHistory("fictional-agent");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => url.includes("usage-analytics") || url.includes("provider-usage/history"))).toBe(true);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Mono-Agent-Web-Origin": window.location.origin });
    await expect(api.usageAnalytics("other-agent", range)).rejects.toThrow("Invalid usage analytics source");
  });
  it("breaks connectors at account changes and reset windows, never synthesizing points", () => {
    const { history } = usageAnalyticsFixture(); const provider = history.providers[0]!;
    const withBoundary = quotaPaths(provider, "weekly", history);
    const withoutBoundary = quotaPaths({ ...provider, accountChanges: [] }, "weekly", history);
    expect(withBoundary.solid.split("M").length).toBe(withoutBoundary.solid.split("M").length - 1);
    expect(withBoundary.uncertain).toBe("");
    expect(withBoundary.dots).toBe(withoutBoundary.dots);
    expect(quotaPaths(provider, "session", history).solid.split("M").length).toBeLessThan(withBoundary.solid.split("M").length);
  });
  it("reserves dotted connectors for known gaps exceeding twice typical or six hours", () => {
    const { history } = usageAnalyticsFixture();
    const provider = history.providers[0]!;
    const sample = provider.samples[0]!;
    const from = Date.parse(history.from);
    const withHours = (hours: number[]) => ({
      ...provider,
      accountChanges: [],
      samples: hours.map(hour => ({
        ...sample,
        fetchedAt: new Date(from + hour * 3_600_000).toISOString(),
        observedThrough: new Date(from + hour * 3_600_000).toISOString(),
      })),
    });
    const ordinary = quotaPaths(withHours([0, 1, 2, 3, 13]), "weekly", history);
    expect(ordinary.gapThresholdMs).toBe(MIN_LONG_GAP_MS);
    expect(ordinary.solid.match(/M/g)).toHaveLength(3);
    expect(ordinary.uncertain.match(/M/g)).toHaveLength(1);
    const slower = quotaPaths(withHours([0, 4, 8, 12, 23]), "weekly", history);
    expect(slower.gapThresholdMs).toBe(8 * 3_600_000);
    expect(slower.uncertain.match(/M/g)).toHaveLength(1);

    // Daily compression endpoints have intermediate checks; reduction is not a missing-check claim.
    const compressed = withHours([0, 12]);
    compressed.samples = compressed.samples.map(point => ({
      ...point, observations: 10, maxGapMs: 300_000,
    }));
    expect(quotaPaths(compressed, "weekly", history).uncertain).toBe("");
    expect(quotaPaths({ ...withHours([0, 12]), downsampled: true }, "weekly", history).uncertain).toBe("");
  });
  it("never invents a known zero price and keeps fictional totals/rankings reconciled", () => {
    expect(knownSpend({ costUsd: null })).toBeNull();
    expect(formatAnalyticsCost({ costUsd: null })).toBe("unknown");
    expect(knownSpend({ costUsd: 0 })).toBe(0);
    expect(formatAnalyticsCost({ costUsd: 0 })).toBe("$0.00");
    for (const partial of [false, true]) {
      const { data } = usageAnalyticsFixture(partial);
      const known = (rows: Array<{ costUsd?: number | null; knownCostUsd?: number }>) => rows.reduce((n, row) => n + (knownSpend(row) ?? 0), 0);
      expect(known(data.buckets.map(b => b.total))).toBeCloseTo(knownSpend(data.total)!, 8);
      expect(known(data.buckets.flatMap(b => [...b.models]))).toBeCloseTo(knownSpend(data.total)!, 8);
      expect(known(data.topConversations.map(c => c.usage))).toBeCloseTo(knownSpend(data.total)!, 8);
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        expect(data.topConversations.reduce((n, c) => n + c.usage.tokens![key], 0)).toBe(data.total.tokens![key]);
      }
      expect(data.topProjects[0]?.usage).toEqual(data.total);
    }
  });
  it("recognizes the existing settings handoff for analytics", () => {
    expect(parseSettingsParam("https://console.invalid/?agent=fictional&settings=usage")).toBe("usage");
    expect(displayTimeZone({ bucket: "hour", timeZone: "UTC" }, "Europe/Berlin")).toBe("Europe/Berlin");
    expect(displayTimeZone({ bucket: "day", timeZone: "UTC" }, "Europe/Berlin")).toBe("UTC");
  });
});
