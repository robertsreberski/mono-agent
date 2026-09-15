import { describe, expect, it, vi } from "vitest";
import { PROVIDER_USAGE_SCHEMA, parseProviderUsageSnapshot, type ProviderUsageId } from "@mono-agent/agent-contracts";
import { createProviderAuthObservationTracker } from "../provider-auth-observations.js";
import { mapProviderUsage } from "../provider-usage-mappers.js";
import { createProviderUsageService, PROVIDER_USAGE_CACHE_MS } from "../provider-usage.js";
const NOW = Date.parse("2026-09-14T12:00:00Z");
const RESET = "2026-09-15T12:00:00.000Z";
// Synthetic fixtures shaped like the researched responses; identifiers are canaries, never real data.
const codex = { plan_type: "pro", email: "DROP_EMAIL", account_id: "DROP_ACCOUNT", user_id: "DROP_USER", rate_limit: { primary_window: { used_percent: 48, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86400 }, secondary_window: null }, credits: { balance: 100 }, additional_rate_limits: [{ name: "spark" }] };
const claude = { five_hour: { utilization: 38, resets_at: RESET }, seven_day: { utilization: 30 }, seven_day_sonnet: { utilization: 99 }, extra_usage: {}, limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 31, resets_at: RESET }] };
const go = { usage: { rolling: { percent: 0, status: "ok", resetsAt: RESET }, weekly: { percent: 1, resetsAt: RESET }, monthly: { percent: 17, resetsAt: RESET } } };
const bodies = { anthropic: claude, "openai-codex": codex, "opencode-go": go };
function fixture(provider: ProviderUsageId = "anthropic") {
  let time = NOW;
  let credential: Record<string, unknown> | undefined = provider === "opencode-go" ? { type: "api_key", key: "fixture-key" } : { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: NOW + 86_400_000, ...(provider === "openai-codex" ? { accountId: "fixture-account" } : {}) };
  const resolver = Object.assign(vi.fn(async () => { credential = { ...credential, access: "fixture-new" }; return "fixture-new"; }), { readCredential: vi.fn(async (id: string) => id === provider ? credential : undefined) });
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json(bodies[provider]));
  const tracker = createProviderAuthObservationTracker(() => time);
  const outcomes = { generation: tracker.generation, recordAccountSuccess: vi.fn(tracker.recordAccountSuccess), recordAccountFailure: vi.fn(tracker.recordAccountFailure) };
  const service = createProviderUsageService({ resolver: resolver as never, fetch: fetch as never, now: () => time, outcomes });
  return { service, resolver, fetch, tracker, outcomes, setCredential: (value: typeof credential) => { credential = value; }, advance: (ms = PROVIDER_USAGE_CACHE_MS) => { time += ms; } };
}
async function settle() { for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); }

describe("subscription core mappers", () => {
  it("classifies a weekly-only Codex primary by duration and drops all identifiers/extras", () => {
    const result = mapProviderUsage("openai-codex", codex, new Headers(), NOW);
    expect(result).toEqual({ plan: "Pro 20x", windows: [{ kind: "weekly", label: "Weekly", usedPercent: 48, resetsAt: RESET, periodMs: 604800000 }] });
    expect(JSON.stringify(result)).not.toMatch(/DROP|spark|credits/);
  });
  it("uses slot fallback only for unknown durations, headers and relative resets", () => {
    expect(mapProviderUsage("openai-codex", { plan_type: "self_serve_business_prolite", rate_limit: {
      primary_window: { limit_window_seconds: 7, reset_after_seconds: 86400 }, secondary_window: { used_percent: 102 },
    } }, new Headers({ "x-codex-primary-used-percent": "2.5" }), NOW)).toEqual({ plan: "Business Premium", windows: [
      { kind: "session", label: "Session", usedPercent: 2.5, resetsAt: RESET, periodMs: 18000000 },
      { kind: "weekly", label: "Weekly", usedPercent: 100, periodMs: 604800000 },
    ] });
  });
  it.each([["prolite", "Pro 5x"], ["plus", "Plus"], ["business_team", "Business Team"]])("maps plan %s", (raw, plan) => {
    expect(mapProviderUsage("openai-codex", { ...codex, plan_type: raw }, new Headers(), NOW).plan).toBe(plan);
  });
  it("maps Claude's exact Fable scope only, without plan or Sonnet", () => {
    const mapped = mapProviderUsage("anthropic", claude, new Headers(), NOW);
    expect(mapped.windows.map((w) => [w.label, w.usedPercent])).toEqual([["Session", 38], ["Weekly", 30], ["Fable", 31]]);
    expect(mapped.plan).toBeUndefined();
  });
  it("maps zero Go utilization as zero and nominal month without inventing a reset", () => {
    const mapped = mapProviderUsage("opencode-go", go, new Headers(), NOW);
    expect(mapped.plan).toBe("Go");
    expect(mapped.windows.map((w) => w.usedPercent)).toEqual([0, 1, 17]);
    expect(mapped.windows[2]).toMatchObject({ periodMs: 2592000000, resetsAt: RESET });
  });
  it("clamps negative values and rejects empty/unrecognized/malformed bodies", () => {
    expect(mapProviderUsage("anthropic", { five_hour: { utilization: -1 } }, new Headers(), NOW).windows[0]?.usedPercent).toBe(0);
    for (const body of [null, {}, { five_hour: { utilization: "45" } }]) expect(() => mapProviderUsage("anthropic", body, new Headers(), NOW)).toThrow();
  });
});

describe("shared provider usage cache and safe failures", () => {
  it.each(["anthropic", "openai-codex", "opencode-go"] as const)("gets %s once across concurrent callers, validates contract and request headers", async (provider) => {
    const f = fixture(provider);
    const [one, two] = await Promise.all([f.service.snapshot(), f.service.snapshot(provider)]);
    expect(one).toEqual(two);
    expect(parseProviderUsageSnapshot(one)).toEqual(one);
    expect(one.schema).toBe(PROVIDER_USAGE_SCHEMA);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer fixture-" + (provider === "opencode-go" ? "key" : "access") } });
    if (provider === "openai-codex") expect(f.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "ChatGPT-Account-Id": "fixture-account" });
    if (provider === "anthropic") expect(f.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.69", "Content-Type": "application/json" });
    await f.service.snapshot();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.resolver).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledExactlyOnceWith(provider, 0, new Date(NOW).toISOString());
    expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
    expect(f.tracker.get(provider)).toEqual({ accountVerifiedAt: new Date(NOW).toISOString() });
  });
  it("returns stale last-good immediately and coalesces its refresh", async () => {
    const f = fixture();
    await f.service.snapshot(); f.advance();
    let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const stale = await f.service.snapshot();
    expect(stale.providers[0]?.stale).toBe(true);
    await f.service.snapshot(); expect(f.fetch).toHaveBeenCalledTimes(2);
    finish(Response.json({ five_hour: { utilization: 50 } })); await settle();
    expect((await f.service.snapshot()).providers[0]).toMatchObject({ stale: false, windows: [{ usedPercent: 50 }] });
  });
  it.each(["900", "Mon, 14 Sep 2026 12:20:00 GMT"])("honors Retry-After %s and retains last-good", async (retry) => {
    const f = fixture(); await f.service.snapshot(); f.advance();
    f.fetch.mockResolvedValueOnce(new Response("NEVER_RETURN_BODY", { status: 429, headers: { "Retry-After": retry } }));
    await f.service.snapshot(); await settle();
    const error = await f.service.snapshot();
    expect(error.providers[0]).toMatchObject({ stale: true, error: { code: "rate_limited" }, windows: [{ usedPercent: 38 }, { usedPercent: 30 }, { usedPercent: 31 }] });
    f.advance(); await f.service.snapshot(); expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error)).not.toContain("NEVER_RETURN");
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes(1);
    expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
    f.advance(1_800_000); await f.service.snapshot(); await settle(); expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403])("refreshes one rejected OAuth token on %s then retries once", async (status) => {
    const f = fixture("openai-codex");
    f.fetch.mockResolvedValueOnce(new Response("secret", { status }));
    const result = await f.service.snapshot();
    expect(result.providers[0]?.error).toBeUndefined();
    expect(f.resolver).toHaveBeenCalledExactlyOnceWith("openai-codex", { rejectedAccessToken: "fixture-access", signal: expect.any(AbortSignal) });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes(1);
    expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
    await f.service.snapshot(); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("never loops on rejected OAuth credentials and keeps error cache", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => new Response("SECRET_BODY", { status: 403 }));
    expect((await f.service.snapshot()).providers[0]?.error?.code).toBe("auth_failed");
    await f.service.snapshot(); expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.resolver).toHaveBeenCalledTimes(1);
    expect(f.outcomes.recordAccountFailure).toHaveBeenCalledExactlyOnceWith("anthropic", 0, new Date(NOW).toISOString());
    expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled();
  });
  it.each([[401, {}, "auth_failed"], [403, { error: { type: "EntitlementError", message: "SECRET" } }, "not_entitled"], [403, {}, "auth_failed"], [500, {}, "unavailable"]])("classifies Go %s safely", async (status, body, code) => {
    const f = fixture("opencode-go"); f.fetch.mockResolvedValueOnce(Response.json(body, { status: status as number }));
    const snapshot = await f.service.snapshot();
    expect(snapshot.providers[0]?.error?.code).toBe(code); expect(f.resolver).not.toHaveBeenCalled(); expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountFailure).toHaveBeenCalledTimes(code === "auth_failed" ? 1 : 0);
  });
  it("invalidates removed/replaced credentials and omits unsupported types", async () => {
    const f = fixture(); await f.service.snapshot();
    f.setCredential(undefined); expect((await f.service.snapshot()).providers).toEqual([]);
    f.setCredential({ type: "api_key", key: "fixture" }); expect((await f.service.snapshot()).providers).toEqual([]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.setCredential({ type: "oauth", access: "replacement", expires: NOW + 100000 });
    await f.service.snapshot(); expect(f.fetch).toHaveBeenCalledTimes(2);
    f.service.stop(); expect((await f.service.snapshot()).providers).toEqual([]);
  });
  it("does not publish a response after credential removal", async () => {
    const f = fixture();
    let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.service.snapshot(); await settle();
    f.setCredential(undefined); finish(Response.json(claude));
    expect((await pending).providers).toEqual([]);
    expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
  });
  it("normalizes network, invalid JSON and oversized bodies without exception details", async () => {
    for (const failure of ["network", "json", "large"] as const) {
      const f = fixture();
      if (failure === "network") f.fetch.mockRejectedValueOnce(new Error("SECRET_TOKEN"));
      else f.fetch.mockResolvedValueOnce(new Response(failure === "large" ? "x".repeat(140000) : "SECRET_JSON"));
      const value = await f.service.snapshot();
      expect(value.providers[0]?.error?.code).toBe(failure === "network" ? "network_failed" : "invalid_response");
      expect(JSON.stringify(value)).not.toContain("SECRET");
      expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled();
      expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
    }
  });
  it.each([200, 401])("drops %s evidence when the same credential is persisted in flight", async (status) => {
    const f = fixture("opencode-go");
    let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.service.snapshot(); await settle();
    f.tracker.credentialPersisted("opencode-go");
    finish(Response.json(go, { status }));
    expect((await pending).providers).toHaveLength(1); // unchanged identity retains usage, not auth evidence
    expect(f.tracker.get("opencode-go")).toBeUndefined();
    const sink = status === 200 ? f.outcomes.recordAccountSuccess : f.outcomes.recordAccountFailure;
    expect(sink).toHaveBeenCalledExactlyOnceWith("opencode-go", 0, new Date(NOW).toISOString());
  });
  it.each([200, 401])("does not emit %s outcomes after credential replacement or shutdown", async (status) => {
    for (const stopped of [false, true]) {
      const f = fixture("opencode-go");
      let finish!: (response: Response) => void;
      f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const pending = f.service.snapshot(); await settle();
      if (stopped) f.service.stop();
      else f.setCredential({ type: "api_key", key: "fixture-replacement" });
      finish(Response.json(go, { status }));
      expect((await pending).providers).toEqual([]);
      expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled();
      expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
    }
  });
  it("manual refresh bypasses successful TTL, awaits new usage and records only account evidence", async () => {
    const f = fixture();
    const first = await f.service.snapshot();
    f.advance(1000);
    f.fetch.mockResolvedValueOnce(Response.json({ five_hour: { utilization: 61 } }));
    const next = await f.service.refresh();
    expect(next.providers[0]?.windows[0]?.usedPercent).toBe(61);
    expect(next.providers[0]?.fetchedAt).not.toBe(first.providers[0]?.fetchedAt);
    expect(next.providers[0]?.stale).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes(2);
    expect(await f.service.snapshot()).toEqual(next);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["cold", "fresh", "stale"])("coalesces manual refresh with concurrent %s reads", async (state) => {
    const f = fixture();
    if (state !== "cold") await f.service.snapshot();
    if (state === "stale") f.advance();
    let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const automatic = f.service.snapshot();
    const one = f.service.refresh();
    const two = f.service.refresh("anthropic");
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(state === "cold" ? 1 : 2);
    let completed = false;
    void one.then(() => { completed = true; });
    await settle(); expect(completed).toBe(false);
    finish(Response.json({ five_hour: { utilization: 62 } }));
    const [a, b] = await Promise.all([one, two]);
    expect(a).toEqual(b);
    expect(a.providers[0]?.windows[0]?.usedPercent).toBe(62);
    await automatic;
    expect(f.fetch).toHaveBeenCalledTimes(state === "cold" ? 1 : 2);
  });
  it.each([429, 500])("manual refresh preserves last-good and cannot bypass %s backoff", async (status) => {
    const f = fixture(); const first = await f.service.snapshot();
    f.advance(1000);
    f.fetch.mockResolvedValueOnce(new Response("SECRET", { status, headers: { "Retry-After": "1800" } }));
    const failed = await f.service.refresh();
    expect(failed.providers[0]).toMatchObject({ windows: first.providers[0]?.windows, fetchedAt: first.providers[0]?.fetchedAt, stale: true });
    expect(failed.providers[0]?.error?.code).toBe(status === 429 ? "rate_limited" : "unavailable");
    expect(await f.service.refresh()).toEqual(failed);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.advance(PROVIDER_USAGE_CACHE_MS);
    if (status === 429) { expect(await f.service.refresh()).toEqual(failed); expect(f.fetch).toHaveBeenCalledTimes(2); f.advance(1_500_000); }
    expect((await f.service.refresh()).providers[0]?.error).toBeUndefined();
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it("serializes manual refresh across credential rotation and drops the old account", async () => {
    const f = fixture("opencode-go"); await f.service.snapshot();
    let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const old = f.service.refresh(); await settle();
    f.setCredential({ type: "api_key", key: "rotated-fixture" });
    const rotated = f.service.refresh(); await settle();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    finish(Response.json(go));
    expect((await old).providers).toEqual([]);
    expect((await rotated).providers).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.outcomes.recordAccountSuccess).toHaveBeenCalledTimes(2);
  });
  it("bounds a request deadline", async () => {
    const f = fixture();
    const service = createProviderUsageService({ resolver: f.resolver as never, outcomes: f.outcomes, timeoutMs: 10, fetch: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("private")), { once: true })) });
    expect((await service.snapshot()).providers[0]?.error?.code).toBe("timeout");
    expect(f.outcomes.recordAccountSuccess).not.toHaveBeenCalled();
    expect(f.outcomes.recordAccountFailure).not.toHaveBeenCalled();
  });
});
