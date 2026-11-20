import { afterEach, describe, expect, it, vi } from "vitest";
import { api, parseUsageAnalytics } from "../../api";
import { jitteredQuotaHistoryFixture, usageAnalyticsFixture } from "../../test/usage-analytics-fixtures";
import { browserCostWire } from "../../../../src/cost-wire";
import { parseSettingsParam } from "../../settings-navigation";
import { displayTimeZone, formatAnalyticsCost, knownSpend, MIN_LONG_GAP_MS, quotaPaths, xAt, yAt } from "./usage-chart-geometry";

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
  it("connects every window in the jittered fixture and coalesces reset markers by window", () => {
    const history = jitteredQuotaHistoryFixture();
    const claude = history.providers[0]!;
    for (const [kind, resetsInRange] of [["session", 10], ["weekly", 1], ["model", 1]] as const) {
      const paths = quotaPaths(claude, kind, history);
      expect(paths.solid).toContain("L");
      expect(paths.uncertain).toContain("V");
      expect(paths.dots.match(/h0/g)).toHaveLength(12);
      expect(paths.resets).toHaveLength(resetsInRange);
    }
    const session = quotaPaths(claude, "session", history);
    expect(session.resets[0]).toBe(Date.parse(claude.samples[1]!.windows[0]!.resetsAt!));
  });
  it.each([7, 17])("drops to zero at the reported reset and rises only from the next observed period at hour %i", hour => {
    const { history } = usageAnalyticsFixture();
    const provider = history.providers[0]!;
    const at = (h: number) => Date.parse(history.from) + h * 3_600_000;
    const [first, second] = provider.samples;
    const samples = [first!, {
      ...second!, fetchedAt: new Date(at(hour)).toISOString(),
      windows: [{ ...second!.windows[0]!, resetsAt: new Date(at(hour + 3)).toISOString() }],
    }];
    const paths = quotaPaths({ ...provider, accountChanges: [], samples }, "session", history);
    expect(paths.solid).toBe("");
    expect(paths.uncertain).toBe(
      `M${xAt(at(1), history)},${yAt(0.1)}H${xAt(at(5), history)}V${yAt(0)} `
      + `M${xAt(at(hour - 2), history)},${yAt(0)}L${xAt(at(hour), history)},${yAt(0.3)} `,
    );
    expect(paths.dots.match(/h0/g)).toHaveLength(2);
  });
  it("uses the last reported reset even when a later check omits timing, and never draws backwards", () => {
    const { history } = usageAnalyticsFixture();
    const provider = history.providers[0]!;
    const [first, second, third] = provider.samples;
    const { resetsAt, ...untimed } = second!.windows[0]!;
    const at = (hour: number) => Date.parse(history.from) + hour * 3_600_000;
    const samples = [first!, { ...second!, windows: [untimed] }, {
      ...third!, windows: [{ ...third!.windows[0]!, resetsAt: new Date(at(8)).toISOString() }],
    }];
    const paths = quotaPaths({ ...provider, accountChanges: [], samples }, "session", history);
    // The nominal new start is hour 3, but the previous observed period reset at hour 5.
    const resetX = xAt(at(5), history);
    expect(paths.uncertain).toBe(
      `M${xAt(at(2), history)},${yAt(0.3)}H${resetX}V${yAt(0)} `
      + `M${resetX},${yAt(0)}L${resetX},${yAt(0.05)} `,
    );
  });
  it("breaks both same-period lines and sawteeth at account changes", () => {
    const { history } = usageAnalyticsFixture();
    const provider = history.providers[0]!;
    const comparison = (kind: "weekly" | "session") => [quotaPaths(provider, kind, history),
      quotaPaths({ ...provider, accountChanges: [] }, kind, history)] as const;
    const [weekly, weeklyContinuous] = comparison("weekly");
    expect(weekly.solid.match(/L/g)!.length).toBe(weeklyContinuous.solid.match(/L/g)!.length - 1);
    expect(weekly.dots).toBe(weeklyContinuous.dots);
    const [session, sessionContinuous] = comparison("session");
    expect(session.uncertain.match(/V/g)!.length).toBe(sessionContinuous.uncertain.match(/V/g)!.length - 1);
    expect(session.dots).toBe(sessionContinuous.dots);
  });
  it("does not connect checks at the same instant as an account boundary", () => {
    const { history } = usageAnalyticsFixture();
    const provider = history.providers[0]!;
    const [first, second] = provider.samples;
    const samples = [first!, { ...second!, fetchedAt: first!.fetchedAt }];
    const paths = quotaPaths({ ...provider, samples, accountChanges: [first!.fetchedAt] }, "session", history);
    expect(paths.solid.match(/H/g)).toHaveLength(2);
    expect(paths.solid).not.toContain("L");
    expect(paths.uncertain).toBe("");
  });
  it("gives a sole in-range observation a clamped tick and a dot", () => {
    const { history } = usageAnalyticsFixture();
    const provider = history.providers[0]!;
    const samples = provider.samples.slice(0, 2);
    const paths = quotaPaths({ ...provider, samples }, "session", { ...history, from: samples[1]!.fetchedAt });
    expect(paths.solid).toBe(`M0,${yAt(0.3)}H9.6 `);
    expect(paths.dots).toBe(`M0,${yAt(0.3)}h0 `);
    expect(paths.uncertain).toBe("");
  });
  it("connects increasing untimed observations but does not invent a timestamp for an untimed reset", () => {
    const { history } = usageAnalyticsFixture();
    const provider = history.providers[0]!;
    const samples = provider.samples.slice(0, 3).map(sample => ({
      ...sample,
      windows: sample.windows.map(({ resetsAt, ...window }) => window),
    }));
    const paths = quotaPaths({ ...provider, samples }, "session", history);
    expect(paths.solid.match(/L/g)).toHaveLength(1);
    expect(paths.solid.match(/H/g)).toHaveLength(1);
    expect(paths.uncertain).toBe("");
    expect(paths.resets).toEqual([]);
  });
  it("reserves long-gap connectors for known gaps exceeding twice typical or six hours", () => {
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
      const rankedAmounts = data.topConversations.map(c => knownSpend(c.usage)!);
      expect(rankedAmounts).toEqual([...rankedAmounts].sort((a, b) => b - a));
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
