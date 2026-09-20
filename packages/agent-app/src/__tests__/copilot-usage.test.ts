import { describe, expect, it, vi } from "vitest";
import { parseProviderUsageSnapshot } from "@mono-agent/agent-contracts";
import { mapProviderUsage } from "../provider-usage-mappers.js";
import { createProviderUsageService, PROVIDER_USAGE_CACHE_MS } from "../provider-usage.js";
const NOW = Date.parse("2026-09-15T12:00:00Z");
const paid = { copilot_plan: "individual", quota_reset_date: "2026-10-01", quota_snapshots: {
  premium_interactions: { entitlement: 1500, remaining: 869, percent_remaining: 57.9, credits_used: 630, overage_permitted: true, overage_count: 8 },
  chat: { entitlement: -1, remaining: -1 }, completions: { unlimited: true, percent_remaining: 100 },
}, email: "SECRET_EMAIL", token: "SECRET_TOKEN", organization: "SECRET_ORG" };
const free = { copilot_plan: "free", quota_snapshots: { premium_interactions: { entitlement: 0, percent_remaining: 100 }, chat: { entitlement: 50, remaining: 20 }, completions: { percent_remaining: 75 } } };
const map = (body: unknown) => mapProviderUsage("github-copilot", body, new Headers(), NOW);
describe("Copilot core mapper", () => {
  it("maps paid Credits, strips extras/identifiers and parses a UTC reset day", () => {
    const result = map(paid);
    expect(result).toEqual({ plan: "Individual", windows: [{ kind: "credits", label: "Credits", usedPercent: 42.1, periodMs: 2592000000, resetsAt: "2026-10-01T00:00:00.000Z" }] });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|overage|credits_used/);
  });
  it("maps free and legacy percentages without zero entitlement Credits", () => {
    expect(map(free)).toEqual({ plan: "Free", windows: [
      { kind: "chat", label: "Chat", usedPercent: 60, periodMs: 2592000000 },
      { kind: "completions", label: "Completions", usedPercent: 25, periodMs: 2592000000 },
    ] });
    expect(map({ copilot_plan: "free", limited_user_quotas: { chat: 20, completions: 1500 }, monthly_quotas: { chat: 50, completions: 2000 }, limited_user_reset_date: "2026-10-01" }).windows.map((w) => w.usedPercent)).toEqual([60, 25]);
    expect(map({ ...paid, limited_user_quotas: { chat: 20 }, monthly_quotas: { chat: 50 } }).windows).toHaveLength(1);
  });
  it.each([{ unlimited: true, percent_remaining: 100 }, { entitlement: -1, percent_remaining: 100 }, { remaining: -1, percent_remaining: 100 }, { entitlement: 0, percent_remaining: 100 }])("suppresses unlimited and placeholder buckets", (bucket) => {
    expect(() => map({ quota_snapshots: { chat: bucket } })).toThrow();
  });
  it("accepts only explicit token billing with a safe plan as a no-window result", () => {
    expect(map({ copilot_plan: "business", token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 0, credits_used: 30 } } })).toEqual({ plan: "Business", windows: [] });
    for (const body of [null, {}, [], { copilot_plan: "business" }, { copilot_plan: "business", token_based_billing: "true" }, { token_based_billing: true }]) expect(() => map(body)).toThrow();
  });
  it.each([{ percent_remaining: "12" }, { percent_remaining: NaN }, { percent_remaining: Infinity }, { remaining: "1", entitlement: 10 }, { entitlement: -2, percent_remaining: 10 }, { unlimited: "false", percent_remaining: 10 }])("rejects malformed core numbers", (bucket) => {
    expect(() => map({ quota_snapshots: { chat: bucket } })).toThrow();
  });
  it("clamps finite percentages and fallback counts, caps at three ordered windows", () => {
    const result = map({ quota_snapshots: { premium_interactions: { percent_remaining: -20 }, chat: { percent_remaining: 120 }, completions: { entitlement: 10, remaining: -2 }, extra: { percent_remaining: 2 } } });
    expect(result.windows.map((w) => [w.kind, w.usedPercent])).toEqual([["credits", 100], ["chat", 0], ["completions", 100]]);
  });
  it.each(["2026-02-30", "2026-13-01", "tomorrow", "09/20/2026", "2026-10-01T00:00:00", "x".repeat(36)])("omits unsafe resets", (reset) => {
    expect(map({ ...paid, quota_reset_date: reset }).windows[0]?.resetsAt).toBeUndefined();
  });
  it("accepts ISO offsets/fractions and fallback reset days", () => {
    expect(map({ ...paid, quota_reset_date: "2026-10-01T02:00:00.123+02:00" }).windows[0]?.resetsAt).toBe("2026-10-01T00:00:00.123Z");
    expect(map({ ...paid, quota_reset_date: "bad", limited_user_reset_date: "2028-02-29" }).windows[0]?.resetsAt).toBe("2028-02-29T00:00:00.000Z");
  });
  it.each(["secret@example.com", "x".repeat(65), "<script>", "", "\nsecret"])("omits unsafe plan labels", (plan) => {
    expect(map({ ...paid, copilot_plan: plan }).plan).toBeUndefined();
  });
  it("safely labels aliases and prototype-shaped plan names", () => {
    expect(map({ ...paid, copilot_plan: "individual_pro" }).plan).toBe("Individual Pro");
    expect(map({ ...paid, copilot_plan: "constructor" }).plan).toBe("Constructor");
  });
});

function fixture(pi = false) {
  let time = NOW;
  let key: string | undefined = "SECRET_LOCAL";
  let credential: Record<string, unknown> | undefined = pi ? { type: "oauth", access: "SECRET_PI", refresh: "SECRET_REFRESH", expires: NOW + 100000 } : undefined;
  const local = vi.fn(async () => key);
  const resolver = Object.assign(vi.fn(async () => { credential = { ...credential, access: "SECRET_NEW", expires: time + 100000 }; return "SECRET_INFERENCE"; }), { readCredential: vi.fn(async (provider: string) => provider === "github-copilot" ? credential : undefined) });
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json(paid));
  const outcomes = { generation: () => 0, recordAccountSuccess: vi.fn(), recordAccountFailure: vi.fn() };
  const service = createProviderUsageService({ resolver: resolver as never, copilotCredential: local, fetch: fetch as never, now: () => time, outcomes });
  return { service, local, resolver, fetch, outcomes, setPi: (value: typeof credential) => { credential = value; }, setLocal: (value: typeof key) => { key = value; }, advance: () => { time += PROVIDER_USAGE_CACHE_MS; } };
}
describe("Copilot usage credentials, HTTP and retention", () => {
  it.each([false, true])("coalesces/caches %s Pi source and sends exact endpoint and headers", async (pi) => {
    const f = fixture(pi);
    const [one, two] = await Promise.all([f.service.snapshot(), f.service.snapshot("github-copilot")]);
    expect(one).toEqual(two); expect(parseProviderUsageSnapshot(one)).toEqual(one);
    expect(f.fetch).toHaveBeenCalledExactlyOnceWith("https://api.github.com/copilot_internal/user", expect.objectContaining({ method: "GET", redirect: "error", headers: {
      Authorization: `token SECRET_${pi ? "REFRESH" : "LOCAL"}`, Accept: "application/json", "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01",
    } }));
    await f.service.snapshot(); expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes(pi ? 1 : 0);
    if (pi) expect(f.local).not.toHaveBeenCalled();
    expect(JSON.stringify(one)).not.toMatch(/SECRET|usageSource|identity/);
  });
  it.each([NOW - 1, NOW + 100000])("uses the GitHub device token, not inference access, with expiry %s", async (expires) => {
    const f = fixture(true);
    f.setPi({ type: "oauth", access: "synthetic-inference", refresh: "synthetic-github", expires });
    const result = await f.service.snapshot("github-copilot");
    expect(result.providers[0]).toMatchObject({ plan: "Individual", windows: [{ usedPercent: 42.1 }], stale: false });
    expect(f.fetch).toHaveBeenCalledExactlyOnceWith("https://api.github.com/copilot_internal/user", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "token synthetic-github" }) }));
    expect(f.resolver).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledExactlyOnceWith("github-copilot", 0, new Date(NOW).toISOString());
    expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/SECRET|synthetic|usageSource|identity/);
  });
  it.each([401, 403])("never refreshes or retries Copilot rejection %s for OAuth, API key or local", async (status) => {
    for (const source of ["oauth", "api_key", "local"]) {
      const f = fixture(source !== "local");
      if (source === "api_key") f.setPi({ type: "api_key", key: "SECRET_PI_KEY" });
      if (source === "oauth") f.setPi({ type: "oauth", access: "SECRET_PI", refresh: "SECRET_REFRESH", expires: NOW - 1, usageSource: "local" });
      f.fetch.mockImplementation(async () => new Response("SECRET_VENDOR", { status }));
      const result = await f.service.snapshot("github-copilot");
      expect(result.providers[0]?.error?.code).toBe("auth_failed");
      expect(f.resolver).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: `token SECRET_${source === "oauth" ? "REFRESH" : source === "api_key" ? "PI_KEY" : "LOCAL"}` });
      expect(f.outcomes.recordAccountFailure).toHaveBeenCalledTimes(source === "local" ? 0 : 1);
      expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled();
      if (source !== "local") expect(f.local).not.toHaveBeenCalled();
      expect(await f.service.snapshot()).toEqual(result);
      expect(await f.service.refresh()).toEqual(result);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.outcomes.recordAccountFailure).toHaveBeenCalledTimes(source === "local" ? 0 : 1);
      f.advance(); await f.service.refresh(); expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.resolver).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/SECRET|usageSource|identity/);
    }
  });
  it.each([undefined, "", "   "])("omits Pi OAuth with missing/blank refresh (%#), never falls back", async (refresh) => {
    const f = fixture(true);
    f.setPi({ type: "oauth", access: "SECRET_INFERENCE", refresh, expires: NOW + 100000 });
    expect((await f.service.snapshot()).providers).toEqual([]);
    expect((await f.service.refresh()).providers).toEqual([]);
    expect(f.local).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.resolver).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled(); expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
  });
  it.each([undefined, "", " ", "github.com", " GitHub.COM ", "https://github.com", "https://GITHUB.COM:443/path", "github.com:443/path", "http://github.com/"])("accepts Pi-normalized github.com marker (%#)", async (enterpriseUrl) => {
    const f = fixture(true);
    f.setPi({ type: "oauth", refresh: "SECRET_REFRESH", enterpriseUrl }); // inference fields are irrelevant
    expect((await f.service.snapshot()).providers).toHaveLength(1);
    expect(f.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "token SECRET_REFRESH" });
    expect(f.local).not.toHaveBeenCalled(); expect(f.resolver).not.toHaveBeenCalled();
  });
  it.each(["company.ghe.com", "https://company.ghe.com/path", " company.ghe.com:443 ", "github.com.evil", "evilgithub.com", "https://github.com@evil.invalid", "github.com.", "https://", "not a host", "https://[", "mailto:github.com", "file:///github.com", null, 42, {}])("fails closed for enterprise/malformed marker (%#)", async (enterpriseUrl) => {
    const f = fixture(true);
    f.setPi({ type: "oauth", access: "SECRET_ENTERPRISE_ACCESS", refresh: "SECRET_ENTERPRISE_REFRESH", expires: NOW + 100000, enterpriseUrl });
    expect((await f.service.snapshot()).providers).toEqual([]);
    expect((await f.service.refresh()).providers).toEqual([]);
    expect(f.local).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.resolver).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled(); expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
  });
  it("keeps fresh cache across inference rotation, expiry, catalog and equivalent host markers", async () => {
    const f = fixture(true); const first = await f.service.snapshot();
    for (const changes of [{ access: "SECRET_ROTATED" }, { expires: NOW - 1 }, { availableModelIds: ["synthetic-model"] }, { access: undefined, expires: undefined }, { enterpriseUrl: " https://GITHUB.COM:443/path " }]) {
      f.setPi({ type: "oauth", access: "SECRET_PI", refresh: "SECRET_REFRESH", expires: NOW + 100000, ...changes });
      expect(await f.service.snapshot()).toEqual(first);
    }
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.resolver).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes(1);
  });
  it("retains and coalesces in-flight quota after inference-only rotation", async () => {
    const f = fixture(true); let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.service.snapshot(); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    f.setPi({ type: "oauth", access: "SECRET_ROTATED", refresh: "SECRET_REFRESH", expires: NOW - 1, availableModelIds: ["synthetic-model"], enterpriseUrl: " github.com " });
    const joined = f.service.snapshot(); const manual = f.service.refresh();
    finish(Response.json(paid));
    const result = await pending;
    expect(result.providers).toHaveLength(1); expect(await joined).toEqual(result); expect(await manual).toEqual(result);
    expect(await f.service.snapshot()).toEqual(result);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.resolver).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes(1);
  });
  it.each(["refresh", "missing-refresh", "blank-refresh", "host", "malformed-host", "removed", "type"])("fences fresh cache and in-flight Pi quota on %s change", async (change) => {
    for (const inFlight of [false, true]) {
      const f = fixture(true);
      // Same token as Pi, but local ownership must still not retain Pi data/evidence.
      f.setLocal("SECRET_REFRESH");
      let finish!: (response: Response) => void;
      if (inFlight) f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const pending = f.service.snapshot();
      if (inFlight) await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1)); else await pending;
      const changes = change === "refresh" ? { refresh: "SECRET_ROTATED" }
        : change === "missing-refresh" ? { refresh: undefined }
        : change === "blank-refresh" ? { refresh: " " }
        : change === "host" ? { enterpriseUrl: "enterprise.invalid" } : { enterpriseUrl: "https://" };
      f.setPi(change === "removed" ? undefined : change === "type" ? { type: "api_key", key: "SECRET_REFRESH" }
        : { type: "oauth", access: "SECRET_PI", refresh: "SECRET_REFRESH", expires: NOW + 100000, ...changes });
      if (inFlight) {
        finish(Response.json(paid)); expect((await pending).providers).toEqual([]);
        expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
      }
      const usable = ["refresh", "removed", "type"].includes(change);
      expect((await f.service.snapshot()).providers).toHaveLength(usable ? 1 : 0);
      expect(f.fetch).toHaveBeenCalledTimes(usable ? 2 : 1);
      expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes((inFlight ? 0 : 1) + (usable && change !== "removed" ? 1 : 0));
      expect(f.resolver).not.toHaveBeenCalled(); expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
      if (change !== "removed") expect(f.local).not.toHaveBeenCalled();
    }
  });
  it("keeps unusable Pi API-key ownership instead of choosing a local account", async () => {
    const f = fixture(); f.setPi({ type: "api_key", key: " " });
    expect((await f.service.snapshot()).providers).toEqual([]);
    expect(f.local).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not use a local account when Pi ownership cannot be read", async () => {
    const f = fixture(true);
    f.resolver.readCredential.mockRejectedValue(new Error("SECRET_READ_ERROR"));
    expect((await f.service.snapshot()).providers).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled(); expect(f.resolver).not.toHaveBeenCalled();
  });
  it.each(["local-rotation", "local-removal", "pi-precedence"])("fences in-flight %s without leaking old account or recording Pi proof", async (rotation) => {
    const f = fixture(); let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.service.snapshot(); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    if (rotation === "pi-precedence") f.setPi({ type: "api_key", key: "SECRET_LOCAL" }); // same token, different ownership
    else f.setLocal(rotation === "local-removal" ? undefined : "SECRET_ROTATED");
    finish(Response.json(paid)); expect((await pending).providers).toEqual([]);
    expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled();
    const next = await f.service.snapshot(); expect(next.providers).toHaveLength(rotation === "local-removal" ? 0 : 1);
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes(rotation === "pi-precedence" ? 1 : 0);
  });
  it("manual refresh bypasses success TTL but not Retry-After; retains stale last-good", async () => {
    const f = fixture(); const first = await f.service.snapshot();
    f.fetch.mockResolvedValueOnce(new Response("SECRET", { status: 429, headers: { "Retry-After": "900" } }));
    const failed = await f.service.refresh("github-copilot");
    expect(failed.providers[0]).toMatchObject({ windows: first.providers[0]?.windows, stale: true, error: { code: "rate_limited" } });
    f.advance(); expect(await f.service.refresh()).toEqual(failed); expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
  });
  it("keeps token-billing plan-only last-good stale on refresh failure", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(Response.json({ token_based_billing: true, copilot_plan: "business" }));
    await f.service.snapshot(); f.fetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect((await f.service.refresh()).providers[0]).toMatchObject({ plan: "Business", windows: [], stale: true, error: { code: "unavailable" } });
  });
});
