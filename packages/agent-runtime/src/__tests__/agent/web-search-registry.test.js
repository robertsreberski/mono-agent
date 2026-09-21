import { afterEach, describe, expect, it, vi } from "vitest";
import { performWebSearch, __resetWebSearchThrottleForTests } from "../../agent/tools/web-search.js";
import { registerSearchProvider, webSearchProviders } from "../../agent/tools/web-search-providers/registry.js";
import { claimWebSearchRequest } from "../../agent/tools/web-search-state.js";
import { createToolContext } from "../../agent/tools/shared/tool-context.js";

const ctx = createToolContext();

const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); __resetWebSearchThrottleForTests(); });
function register(name, search, overrides = {}) {
  cleanup.push(registerSearchProvider({
    name, configure: () => ({ value: {} }), eligibility: () => true,
    admission: () => ({ kind: name, key: name, processPolicy: "endpoint" }),
    networkTargets: () => ["https://example.com"], batchesQueries: false,
    filterSupport: { language: "advisory", timeRange: "advisory", country: "unsupported" }, search,
    ...overrides,
  }));
}
describe("source-level search registry", () => {
  it("declares a domains filter mechanism for every registered provider", () => {
    expect(webSearchProviders.size).toBeGreaterThan(0);
    for (const provider of webSearchProviders.values()) {
      expect(["operator", "unverified"]).toContain(provider.filterSupport.domains);
    }
    // Parallel honours site: inside search_queries server-side (verified live);
    // Ollama documents only a raw query string, so its support stays unverified.
    expect(webSearchProviders.get("parallel")?.filterSupport.domains).toBe("operator");
    expect(webSearchProviders.get("ollama")?.filterSupport.domains).toBe("unverified");
  });  it("executes a newly registered provider without editing the chain", async () => {
    register("fake", (query, options) => {
      claimWebSearchRequest(options.searchState, "fake", options.callClaims);
      return { ok: true, backend: "fake", results: [{ url: "https://example.com", title: query, snippet: "evidence", backend: "fake" }] };
    });
    const result = await performWebSearch({ query: "registry evidence" }, { ctx, searchConfig: { backend: "fake" } });
    expect(result.outcome).toMatchObject({ status: "ok", backend: "fake", requestsThisCall: 1 });
  });
  it("falls through a failing registered provider to a virtual group", async () => {
    register("fake-fail", () => ({ ok: false, backend: "fake-fail", retryable: true, message: "Unavailable" }));
    const fetchImpl = vi.fn(async () => new Response('<div class="result"><a class="result__a" href="https://example.com">Registry evidence</a></div>'));
    const result = await performWebSearch({ query: "registry evidence" }, { ctx, searchConfig: { backend: ["fake-fail", "keyless"] }, fetchImpl });
    expect(result.outcome).toMatchObject({ status: "ok", backend: "duckduckgo", attemptedBackends: ["fake-fail", "keyless"], fallbackUsed: true });
  });

  it("centrally rejects a declared unsupported country before admission, search, or budget", async () => {
    const admission = vi.fn(() => ({ kind: "fake-countryless", key: "fake-countryless", processPolicy: "endpoint" }));
    const search = vi.fn();
    register("fake-countryless", search, { admission });
    const result = await performWebSearch({ query: "registry evidence", country: "PL" }, {
      ctx, searchConfig: { backend: "fake-countryless" },
    });
    expect(result).toMatchObject({ error: true, outcome: {
      code: "unsupported_country_filter", requestsUsed: 0, requestsThisCall: 0, dispatchesUsed: 0,
      providerAttempts: [{ backend: "fake-countryless", code: "unsupported_country_filter", requests: 0 }],
    } });
    expect(admission).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("advances from a registered country-unsupported provider to a capable provider", async () => {
    const admission = vi.fn();
    const search = vi.fn();
    register("fake-countryless-chain", search, { admission });
    const fetchImpl = vi.fn(async () => new Response('<div class="result"><a class="result__a" href="https://example.com">Registry evidence</a></div>'));
    const result = await performWebSearch({ query: "registry evidence", country: "PL" }, {
      ctx, searchConfig: { backend: ["fake-countryless-chain", "duckduckgo"] }, fetchImpl,
    });
    expect(result.outcome).toMatchObject({
      status: "ok", backend: "duckduckgo", requestsUsed: 1, dispatchesUsed: 1,
      providerAttempts: [{ backend: "fake-countryless-chain", code: "unsupported_country_filter", requests: 0 }],
    });
    expect(admission).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("kl")).toBe("pl-pl");
  });
});
