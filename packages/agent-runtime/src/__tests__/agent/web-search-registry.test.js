import { afterEach, describe, expect, it, vi } from "vitest";
import { performWebSearch, __resetWebSearchThrottleForTests } from "../../agent/tools/web-search.js";
import { registerSearchProvider } from "../../agent/tools/web-search-providers/registry.js";
import { claimWebSearchRequest } from "../../agent/tools/web-search-state.js";

const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); __resetWebSearchThrottleForTests(); });
function register(name, search) {
  cleanup.push(registerSearchProvider({
    name, configure: () => ({ value: {} }), eligibility: () => true,
    admission: () => ({ kind: name, key: name, processPolicy: "endpoint" }),
    networkTargets: () => ["https://example.com"], batchesQueries: false,
    filterSupport: { language: "advisory", timeRange: "advisory", country: "unsupported" }, search,
  }));
}
describe("source-level search registry", () => {
  it("executes a newly registered provider without editing the chain", async () => {
    register("fake", (query, options) => {
      claimWebSearchRequest(options.searchState, "fake", options.callClaims);
      return { ok: true, backend: "fake", results: [{ url: "https://example.com", title: query, snippet: "evidence", backend: "fake" }] };
    });
    const result = await performWebSearch({ query: "registry evidence" }, { searchConfig: { backend: "fake" } });
    expect(result.outcome).toMatchObject({ status: "ok", backend: "fake", requestsThisCall: 1 });
  });
  it("falls through a failing registered provider to a virtual group", async () => {
    register("fake-fail", () => ({ ok: false, backend: "fake-fail", retryable: true, message: "Unavailable" }));
    const fetchImpl = vi.fn(async () => new Response('<div class="result"><a class="result__a" href="https://example.com">Registry evidence</a></div>'));
    const result = await performWebSearch({ query: "registry evidence" }, { searchConfig: { backend: ["fake-fail", "keyless"] }, fetchImpl });
    expect(result.outcome).toMatchObject({ status: "ok", backend: "duckduckgo", attemptedBackends: ["fake-fail", "keyless"], fallbackUsed: true });
  });
});
