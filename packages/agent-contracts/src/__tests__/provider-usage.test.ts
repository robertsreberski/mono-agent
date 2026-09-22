import { describe, expect, it } from "vitest";
import { formatProviderUsageLead, parseProviderUsageSnapshot, projectProviderUsage, projectProviderUsageWindow, PROVIDER_USAGE_SCHEMA } from "../provider-usage.js";
const good = { schema: PROVIDER_USAGE_SCHEMA, providers: [{ providerId: "anthropic", label: "Claude", fetchedAt: "2026-09-14T12:00:00.000Z", stale: false, windows: [{ kind: "session", label: "Session", usedPercent: 38, periodMs: 18000000 }] }] };
describe("provider usage wire projection", () => {
  it("accepts valid snapshots and returns fresh copies", () => {
    expect(parseProviderUsageSnapshot(good)).toEqual(good);
    expect(parseProviderUsageSnapshot(good).providers).not.toBe(good.providers);
    expect(parseProviderUsageSnapshot({ schema: PROVIDER_USAGE_SCHEMA, providers: [] }).providers).toEqual([]);
  });
  it.each([
    { schema: "v0" }, { secret: "private" }, { providers: Array(4).fill(good.providers[0]) },
    { providers: [good.providers[0], good.providers[0]] },
  ])("rejects malformed envelopes", (patch) => expect(() => parseProviderUsageSnapshot({ ...good, ...patch })).toThrow());
  it.each([
    { providerId: "other" }, { label: "email" }, { plan: "Max" }, { account_id: "private" }, { access: "private" },
    { fetchedAt: "yesterday" }, { stale: "false" }, { error: { code: "auth_failed", message: "private token" } },
    { error: { code: "foreign", message: "anything" } },
  ])("rejects unsafe provider fields", (patch) => expect(() => parseProviderUsageSnapshot({ ...good, providers: [{ ...good.providers[0], ...patch }] })).toThrow());
  it.each([{ usedPercent: NaN }, { usedPercent: 101 }, { usedPercent: -1 }, { kind: "spark" }, { label: "Sonnet" }, { periodMs: 0 }, { resetsAt: "invalid" }, { user_id: "private" }])("rejects invalid windows", (patch) => {
    expect(() => parseProviderUsageSnapshot({ ...good, providers: [{ ...good.providers[0], windows: [{ ...good.providers[0]!.windows[0], ...patch }] }] })).toThrow();
  });
});

const copilot = { providerId: "github-copilot", label: "GitHub Copilot", plan: "Free", fetchedAt: "2026-09-15T12:00:00.000Z", stale: false,
  windows: [{ kind: "chat", label: "Chat", usedPercent: 25, periodMs: 2592000000 }, { kind: "completions", label: "Completions", usedPercent: 75, periodMs: 2592000000 }] };
describe("bounded Copilot projection", () => {
  it("accepts four providers and Copilot percent windows or plan-only", () => {
    const providers = [...good.providers, { ...good.providers[0], providerId: "openai-codex", label: "Codex" }, { ...good.providers[0], providerId: "opencode-go", label: "OpenCode Go" }, copilot];
    expect(parseProviderUsageSnapshot({ schema: PROVIDER_USAGE_SCHEMA, providers }).providers).toHaveLength(4);
    expect(() => parseProviderUsageSnapshot({ schema: PROVIDER_USAGE_SCHEMA, providers: [...providers, copilot] })).toThrow();
    expect(parseProviderUsageSnapshot({ ...good, providers: [{ ...copilot, windows: [] }] }).providers[0]?.plan).toBe("Free");
  });
  it.each(["credits", "chat", "completions"])("restricts %s windows to Copilot without relaxing existing providers", (kind) => {
    const window = { kind, label: kind[0]!.toUpperCase() + kind.slice(1), usedPercent: 0, periodMs: 2592000000 };
    expect(() => parseProviderUsageSnapshot({ ...good, providers: [{ ...copilot, windows: [window] }] })).not.toThrow();
    for (const provider of [good.providers[0], { ...copilot, providerId: "openai-codex", label: "Codex" }, { ...copilot, providerId: "opencode-go", label: "OpenCode Go" }]) {
      expect(() => parseProviderUsageSnapshot({ ...good, providers: [{ ...provider, windows: [window] }] })).toThrow();
    }
  });
  it.each([{ windows: good.providers[0]!.windows }, { plan: "x".repeat(65) }, { plan: "secret@example.com" }, { quota_snapshots: {} }, { token: "secret" }, { windows: [{ ...copilot.windows[0], usedPercent: 101 }] }, { windows: [...copilot.windows, ...copilot.windows] }])("rejects unsafe/extra/incorrect Copilot data", (patch) => {
    expect(() => parseProviderUsageSnapshot({ ...good, providers: [{ ...copilot, ...patch }] })).toThrow();
  });
});

const weekMs = 604800000;
const weekReset = "2026-09-26T08:10:22.000Z";
const halfWeek = "2026-09-22T20:10:22.000Z";
const weekly = (usedPercent: number, fetchedAt: string = halfWeek, resetsAt?: string | null) => ({
  kind: "weekly" as const, label: "Weekly" as const, usedPercent, periodMs: weekMs,
  ...(resetsAt === null ? {} : { resetsAt: resetsAt ?? weekReset }),
});
describe("provider usage burn projection", () => {
  it("reports on-track burn below 1x pace without a run-out", () => {
    expect(projectProviderUsageWindow(weekly(25), halfWeek)).toEqual({ pace: 0.5, elapsedFraction: 0.5, severity: "ok", confidence: "normal" });
  });
  it("treats exactly 1.0 pace as on track with no run-out", () => {
    expect(projectProviderUsageWindow(weekly(50), halfWeek)).toEqual({ pace: 1, elapsedFraction: 0.5, severity: "ok", confidence: "normal" });
  });
  it("warns ahead at 1.2x with a run-out before reset", () => {
    const projection = projectProviderUsageWindow(weekly(60), halfWeek)!;
    expect(projection.pace).toBeCloseTo(1.2, 10);
    expect(projection.severity).toBe("ahead");
    expect(projection.confidence).toBe("normal");
    expect(Date.parse(projection.exhaustsAt!)).toBeGreaterThan(Date.parse(halfWeek));
    expect(Date.parse(projection.exhaustsAt!)).toBeLessThan(Date.parse(weekReset));
    expect(projection.leadMs).toBe(Date.parse(weekReset) - Date.parse(projection.exhaustsAt!));
  });
  it.each([75, 90])("flags %s%% at half the window as unsustainable", (usedPercent) => {
    const projection = projectProviderUsageWindow(weekly(usedPercent), halfWeek)!;
    expect(projection.severity).toBe("unsustainable");
    expect(Date.parse(projection.exhaustsAt!)).toBeLessThan(Date.parse(weekReset));
    expect(projection.leadMs).toBeGreaterThan(0);
  });
  it("omits the run-out and its lead together whenever nothing is projected", () => {
    for (const projection of [
      projectProviderUsageWindow(weekly(25), halfWeek)!,
      projectProviderUsageWindow(weekly(50), halfWeek)!,
      projectProviderUsageWindow(weekly(0), halfWeek)!,
      projectProviderUsageWindow(weekly(50, "2026-09-19T16:34:22.000Z"), "2026-09-19T16:34:22.000Z")!,
    ]) {
      expect(projection.exhaustsAt).toBeUndefined();
      expect(projection.leadMs).toBeUndefined();
    }
  });
  it.each([
    [0, "0m"], [-1000, "0m"], [12 * 60_000, "12m"], [61_000, "2m"], [60 * 60_000, "1h 0m"],
    [(5 * 60 + 20) * 60_000, "5h 20m"], [25 * 3_600_000, "1d 1h"], [(3 * 24 + 2) * 3_600_000, "3d 2h"],
  ])("formats lead %s ms as %s", (leadMs, text) => {
    expect(formatProviderUsageLead(leadMs)).toBe(text);
  });
  it("returns undefined without a reset", () => {
    expect(projectProviderUsageWindow(weekly(96, halfWeek, null), halfWeek)).toBeUndefined();
  });
  it("reports zero usage as still with no run-out", () => {
    expect(projectProviderUsageWindow(weekly(0), halfWeek)).toEqual({ pace: 0, elapsedFraction: 0.5, severity: "ok", confidence: "normal" });
  });
  it("clamps full usage to a run-out at the measurement", () => {
    const projection = projectProviderUsageWindow(weekly(100), halfWeek)!;
    expect(projection.severity).toBe("unsustainable");
    expect(Date.parse(projection.exhaustsAt!)).toBe(Date.parse(halfWeek));
  });
  it("forces ok without a run-out early in the window while still reporting pace", () => {
    // 5 % elapsed: one call extrapolates to 10x, which must not warn.
    const projection = projectProviderUsageWindow(weekly(50, "2026-09-19T16:34:22.000Z"), "2026-09-19T16:34:22.000Z")!;
    expect(projection.pace).toBeCloseTo(10, 10);
    expect(projection.elapsedFraction).toBeCloseTo(0.05, 10);
    expect(projection.confidence).toBe("low");
    expect(projection.severity).toBe("ok");
    expect(projection.exhaustsAt).toBeUndefined();
  });
  it.each([
    ["before the window starts", "2026-09-19T08:10:21.000Z"],
    ["after the reset", "2026-09-26T08:10:23.000Z"],
  ])("returns undefined for clock skew %s", (_, fetchedAt) => {
    expect(projectProviderUsageWindow(weekly(50, fetchedAt), fetchedAt)).toBeUndefined();
  });
  it.each([
    ["unparseable reset", { ...weekly(50), resetsAt: "not-a-date" }, halfWeek],
    ["unparseable anchor", weekly(50), "not-a-date"],
    ["non-positive period", { ...weekly(50), periodMs: 0 }, halfWeek],
  ])("returns undefined for %s", (_, window, fetchedAt) => {
    expect(projectProviderUsageWindow(window, fetchedAt)).toBeUndefined();
  });
  it("projects the Codex 96 % weekly read to run out before its reset", () => {
    const projection = projectProviderUsageWindow(weekly(96, "2026-09-22T09:35:00.000Z"), "2026-09-22T09:35:00.000Z")!;
    expect(projection.severity).toBe("unsustainable");
    expect(projection.confidence).toBe("normal");
    expect(projection.pace).toBeGreaterThan(1.5);
    expect(Date.parse(projection.exhaustsAt!)).toBeGreaterThan(Date.parse("2026-09-22T09:35:00.000Z"));
    expect(Date.parse(projection.exhaustsAt!)).toBeLessThan(Date.parse(weekReset));
  });
  it("maps one provider to per-window projections, omitting windows without one", () => {
    const projected = projectProviderUsage({ fetchedAt: halfWeek,
      windows: [weekly(96), { kind: "session", label: "Session", usedPercent: 10, periodMs: 18000000 }] });
    expect(projected.map((entry) => entry.kind)).toEqual(["weekly"]);
    expect(projected[0]?.projection.severity).toBe("unsustainable");
  });
});
