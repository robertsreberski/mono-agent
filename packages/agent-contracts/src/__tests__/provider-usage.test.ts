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
