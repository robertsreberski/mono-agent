import { describe, expect, it } from "vitest";
import { parseProviderUsageSnapshot, PROVIDER_USAGE_SCHEMA } from "../provider-usage.js";
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
