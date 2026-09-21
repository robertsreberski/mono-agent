import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { performWebSearch } from "../../agent/tools/web-search.js";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import { registerSearchProvider } from "../../agent/tools/web-search-providers/registry.js";
import { claimWebSearchRequest } from "../../agent/tools/web-search-state.js";
import { createWebToolController, __resetSharedSearchCacheForTests } from "../../agent/tools/web-controller.js";
import { createWebSearchRunState } from "../../agent/tools/web-search-state.js";
import { __resetWebSearchThrottleForTests } from "../../agent/tools/web-search-providers/shared.js";
import { LOCAL_ENGINES, localEngineRequest, parseLocalEngine, mergeLocalResults } from "../../agent/tools/local/engines.js";
import { assertLocalRobots } from "../../agent/tools/local/robots.js";
import { localRequest } from "../../agent/tools/local/network.js";
import { inspectLocalWeb } from "../../agent/tools/local/config.js";

const target = "https://example.com/evidence";
const prose = "Mono agent native local research evidence. ".repeat(10);
const html = `<html><head><title>Mono agent evidence</title></head><body><main><p>${prose}</p><a href="/citation">Citation</a></main></body></html>`;
const robots = "User-agent: *\nAllow: /\n";
function context(allow = () => true) { return { workspace: process.cwd(), sandbox: { ...passthroughSandbox, networkAllowsUrl: allow } }; }
function response(text, status = 200) { return new Response(text, { status, headers: { "content-type": "text/html; charset=utf-8" } }); }
function engineHtml(name, url = target) {
  if (name === "duckduckgo") return `<div class="result"><h2><a class="result__a" href="${url}">Mono agent evidence</a></h2><p class="result__snippet">Mono agent native evidence</p></div>`;
  throw new Error(`Unsupported test engine ${name}`);
}
function searchFetch() {
  return vi.fn(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/robots.txt") return response(robots);
    const engine = LOCAL_ENGINES.find((item) => item.origin === parsed.origin);
    if (!engine) throw new Error("Unexpected destination");
    return response(engineHtml(engine.name));
  });
}
function searchOptions(overrides = {}) { return { ctx: context(), searchConfig: { backend: "local" }, fetchImpl: searchFetch(), ...overrides }; }
beforeEach(() => { __resetWebSearchThrottleForTests({ minSpacingMs: 0 }); __resetSharedSearchCacheForTests(); });

describe("native local search", () => {
  it("runs a real local DOM adapter, not MCP, with one answer and two cold network dispatches", async () => {
    const options = searchOptions();
    const result = await performWebSearch({ query: "mono agent evidence" }, options);
    expect(result).toMatchObject({ error: false, outcome: { backend: "local", status: "ok", requestsThisCall: 1, dispatchesUsed: 2, resultCount: 1 } });
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.text).coverage.engineOutcomes).toEqual([{ engine: "duckduckgo", code: "ok" }]);
    expect(JSON.parse(result.text).coverage).toMatchObject({ partialEngines: false, searchStopped: false });
    expect(options.fetchImpl.mock.calls.every(([url]) => !String(url).includes("/mcp"))).toBe(true);
  });
  it("owns both per-target policy and per-request host admission", async () => {
    const acquire = vi.fn(async () => ({ complete: vi.fn(), waitMs: 0 }));
    const options = searchOptions({ ctx: context((_policy, url) => new URL(url).hostname === "html.duckduckgo.com"), coordinator: { acquire } });
    const result = await performWebSearch({ query: "mono agent evidence" }, options);
    expect(result).toMatchObject({ error: false, outcome: { status: "ok", requestsThisCall: 1, dispatchesUsed: 2 } });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls.every(([request]) => request.kind === "duckduckgo" && request.key === "duckduckgo")).toBe(true);
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.outcome.engineOutcomes).toEqual([{ engine: "duckduckgo", code: "ok" }]);
  });
  it("denies all targets before admission, robots or request reservation", async () => {
    const acquire = vi.fn();
    const options = searchOptions({ ctx: context(() => false), coordinator: { acquire } });
    const result = await performWebSearch({ query: "mono agent" }, options);
    expect(result.outcome).toMatchObject({ code: "network_denied", requestsUsed: 0, dispatchesUsed: 0 });
    expect(acquire).not.toHaveBeenCalled(); expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it("refunds only failed answered reservations, never robot or engine dispatches", async () => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname === "/robots.txt" ? robots : "<html>Changed layout</html>"));
    const result = await performWebSearch({ query: "mono agent evidence" }, searchOptions({ fetchImpl }));
    expect(result.outcome).toMatchObject({ code: "invalid_response", requestsUsed: 0, dispatchesUsed: 2 });
  });
  it("keeps aggregate budget exhaustion terminal without useful results", async () => {
    const state = createWebSearchRunState({ maxRequestsPerRun: 1 }); state.requestsUsed = 1;
    const fetchImpl = vi.fn(async (url) => response(robots));
    const result = await performWebSearch({ query: "mono agent" }, searchOptions({ fetchImpl, searchState: state, searchConfig: { backend: ["local", "parallel"], maxRequestsPerRun: 1 } }));
    expect(result.outcome).toMatchObject({ code: "search_budget_exhausted", requestsUsed: 1, dispatchesUsed: 0 });
    expect(result.outcome.attemptedBackends).toEqual(["local"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("stops before all dispatch when the answered budget is already exhausted", async () => {
    const state = createWebSearchRunState({ maxRequestsPerRun: 1 }); state.requestsUsed = 1;
    const options = searchOptions({ searchState: state });
    const result = await performWebSearch({ query: "mono agent" }, options);
    expect(result.outcome.code).toBe("search_budget_exhausted"); expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it("distinguishes genuine empty results from changed layouts", async () => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname === "/robots.txt" ? robots : "<html><body>No results found</body></html>"));
    const result = await performWebSearch({ query: "none" }, searchOptions({ fetchImpl }));
    expect(result).toMatchObject({ error: false, outcome: { code: "no_results", requestsUsed: 1 } });
  });
  it("advances to the next backend when the local provider is throttled", async () => {
    const unregister = registerSearchProvider({
      name: "test-fallback", batchesQueries: false,
      filterSupport: { language: "advisory", timeRange: "advisory", country: "advisory" },
      configure: () => ({ value: {} }),
      eligibility: () => true,
      admission: () => ({ kind: "test-fallback", key: "test-fallback", processPolicy: "endpoint" }),
      networkTargets: () => [],
      search: async (query, options) => {
        claimWebSearchRequest(options.searchState, "test-fallback", options.callClaims);
        return { ok: true, backend: "test-fallback", actualQuery: query, results: [{ url: target, title: "Mono agent evidence from test fallback", snippet: "Mono agent native evidence", backend: "test-fallback" }] };
      },
    });
    try {
      const fetchImpl = vi.fn(async () => new Response("limited", { status: 429, headers: { "retry-after": "120" } }));
      const result = await performWebSearch({ query: "mono agent evidence" }, searchOptions({ fetchImpl, searchConfig: { backend: ["local", "test-fallback"] } }));
      expect(result).toMatchObject({ error: false, outcome: { backend: "test-fallback", status: "ok", resultCount: 1 } });
      expect(result.outcome.attemptedBackends).toEqual(["local", "test-fallback"]);
      expect(result.outcome.engineOutcomes).toEqual([{ engine: "duckduckgo", code: "rate_limited", retryAfterMs: 120_000 }]);
      expect(result.outcome.fallbackUsed).toBe(true);
    } finally { unregister(); }
  });
  it("still runs alternate queries after a terminal local refusal", async () => {
    const unregister = registerSearchProvider({
      name: "test-alternate", batchesQueries: false,
      filterSupport: { language: "advisory", timeRange: "advisory", country: "advisory" },
      configure: () => ({ value: {} }),
      eligibility: () => true,
      admission: () => ({ kind: "test-alternate", key: "test-alternate", processPolicy: "endpoint" }),
      networkTargets: () => [],
      search: async (query, options) => {
        claimWebSearchRequest(options.searchState, "test-alternate", options.callClaims);
        if (query === "mono agent") return { ok: true, backend: "test-alternate", actualQuery: query, results: [] };
        return { ok: true, backend: "test-alternate", actualQuery: query, results: [{ url: target, title: "Another mono agent evidence query from test alternate", snippet: "Another mono agent evidence snippet", backend: "test-alternate" }] };
      },
    });
    try {
      const fetchImpl = vi.fn(async () => response("refused", 403));
      const result = await performWebSearch({ query: "mono agent", alternate_queries: ["another evidence query"] }, searchOptions({ fetchImpl, searchConfig: { backend: ["local", "test-alternate"] } }));
      expect(result).toMatchObject({ error: false, outcome: { status: "ok", resultCount: 1 } });
      expect(result.outcome.attemptedBackends).toEqual(["local", "test-alternate"]);
      expect(result.outcome.actualQueries).toEqual(["mono agent", "another evidence query"]);
    } finally { unregister(); }
  });
  it("propagates aggregate Retry-After and defers the run without another send", async () => {
    const state = createWebSearchRunState({ maxRequestsPerRun: 4 });
    const fetchImpl = vi.fn(async () => new Response("limited", { status: 429, headers: { "retry-after": "120" } }));
    const options = searchOptions({ fetchImpl, searchState: state });
    const result = await performWebSearch({ query: "mono agent" }, options);
    expect(result.outcome).toMatchObject({ code: "rate_limited", rateLimited: true, retryAfterMs: 120_000, requestsUsed: 0, dispatchesUsed: 1, retryInRun: false });
    expect(state.deferredProviders.get("local").retryAtMs).toBeGreaterThan(Date.now() + 119_000);
    expect(JSON.parse(result.text).coverage).toMatchObject({ rateLimited: true, retryAfterMs: 120_000 });
    expect(JSON.parse(result.text).next_actions?.some((entry) => entry.tool === "WebSearch")).not.toBe(true);
    await performWebSearch({ query: "another query" }, options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("retains refusal cooldowns across calls without redispatching", async () => {
    const fetchImpl = vi.fn(async () => response("refused", 429));
    const options = searchOptions({ fetchImpl });
    await performWebSearch({ query: "mono agent" }, options);
    const result = await performWebSearch({ query: "different mono agent query" }, options);
    expect(result.outcome).toMatchObject({ code: "rate_limited", requestsUsed: 0, dispatchesUsed: 0, rateLimited: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("targets a supported country through DDG and preserves provider filter metadata", async () => {
    const options = searchOptions();
    const result = await performWebSearch({ query: "mono agent evidence", country: "pl", language: "en" }, options);
    expect(result).toMatchObject({ error: false, outcome: {
      status: "ok", dispatchesUsed: 2,
      filterSupport: { language: "advisory", country: "provider", timeRange: "not_requested" },
    } });
    expect(result.outcome.engineOutcomes).toEqual([
      { engine: "duckduckgo", code: "ok", countryRegion: "pl-pl" },
    ]);
    const searchCall = options.fetchImpl.mock.calls.find(([url]) => new URL(url).pathname === "/html/");
    expect(searchCall[1].body.get("l")).toBe("pl-pl");
    expect(searchCall[1].headers["Accept-Language"]).toBe("en");
    expect(JSON.parse(result.text).coverage.requestedFilters).toMatchObject({ country: "PL", language: "en" });
  });
  it("rejects a valid but unsupported local country before robots, admission, or budget", async () => {
    const options = searchOptions({ coordinator: { acquire: vi.fn() } });
    const result = await performWebSearch({ query: "mono agent evidence", country: "AD" }, options);
    expect(result).toMatchObject({ error: true, outcome: { code: "unsupported_country_filter", requestsUsed: 0, dispatchesUsed: 0 } });
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(options.coordinator.acquire).not.toHaveBeenCalled();
    expect(JSON.parse(result.text).coverage).toMatchObject({
      filterSupport: { country: "unsupported" }, requestedFilters: { country: "AD" },
    });
  });
  it("reports irrelevant results without spending the dispatch ceiling", async () => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname === "/robots.txt" ? robots : engineHtml("duckduckgo").replaceAll("Mono agent", "Different material").replaceAll("Mono", "Different")));
    const result = await performWebSearch({ query: "uniqueunmatchedterm", domains: ["example.com"] }, searchOptions({ fetchImpl, searchConfig: { backend: "local", maxRequestsPerRun: 1 } }));
    expect(result.outcome).toMatchObject({ code: "backend_unavailable", requestsUsed: 1, dispatchesUsed: 2 });
  });
  it("makes coordinator failure fatal and never dispatches uncoordinated", async () => {
    const options = searchOptions({ coordinator: { acquire: async () => { throw Object.assign(new Error("unsafe"), { code: "coordination_unavailable" }); } } });
    const result = await performWebSearch({ query: "mono agent" }, options);
    expect(result.outcome.code).toBe("coordination_unavailable"); expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it("cancels actual in-flight streams and refunds the failed aggregate", async () => {
    const abort = new AbortController(); let cancelled = 0;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start() { queueMicrotask(() => abort.abort()); }, cancel() { cancelled += 1; } })));
    const result = await performWebSearch({ query: "mono agent" }, searchOptions({ signal: abort.signal, fetchImpl }));
    expect(result.outcome).toMatchObject({ code: "aborted", requestsUsed: 0 }); expect(cancelled).toBeGreaterThan(0);
  });
});

describe("local engine algorithms and attribution adaptations", () => {
  it("preserves semantic query parameters and rejects only real credential-bearing engine wrappers", () => {
    for (const key of ["target", "u", "url", "uddg"]) {
      const ordinary = `https://example.com/go?${key}=/article`;
      expect(new URL(parseLocalEngine(LOCAL_ENGINES[0], engineHtml("duckduckgo", ordinary))[0].url).searchParams.get(key)).toBe("/article");
    }
    const wrapped = "https://duckduckgo.com/l/?uddg=" + encodeURIComponent("https://user:secret@example.com/article");
    expect(() => parseLocalEngine(LOCAL_ENGINES[0], engineHtml("duckduckgo", wrapped))).toThrow(/Unrecognized/);
    const valid = "https://duckduckgo.com/l/?uddg=" + encodeURIComponent("https://example.com/article");
    expect(parseLocalEngine(LOCAL_ENGINES[0], engineHtml("duckduckgo", valid))[0].url).toBe("https://example.com/article");
  });
  it("ports request/date fields, defaults DDG to no region, and parses the reviewed layout", () => {
    for (const engine of LOCAL_ENGINES) expect(parseLocalEngine(engine, engineHtml(engine.name))).toHaveLength(1);
    const ddg = localEngineRequest(LOCAL_ENGINES[0], 'exact "query"', "day");
    expect(ddg.init.method).toBe("POST"); expect(ddg.init.body.get("q")).toBe('exact "query"'); expect(ddg.init.body.get("df")).toBe("d");
    expect(ddg.init.body.get("l")).toBe("wt-wt");
  });
  it.each([
    ["PL", "en", "pl-pl"],
    ["GB", "pl", "uk-en"],
    ["US", "en", "us-en"],
    ["US", "es-MX", "ue-es"],
  ])("maps country %s and language %s to documented DDG region %s", (country, language, region) => {
    const request = localEngineRequest(LOCAL_ENGINES[0], "query", undefined, language, country);
    expect(request.init.body.get("l")).toBe(region);
    expect(request.init.headers["Accept-Language"]).toBe(language);
  });
  it("dedupes GitHub repo case without folding file paths and merges consensus snippets", () => {
    const result = (url, engine, snippet) => ({ url, engine, title: "Mono agent", snippet });
    const lists = [[result("https://github.com/Owner/Repo/blob/MAIN/file", "duckduckgo", "first")], [result("https://github.com/owner/repo/blob/MAIN/file", "brave", "second"), result("https://github.com/owner/repo/blob/main/file", "brave", "different branch")]];
    const ranked = mergeLocalResults(lists);
    expect(ranked).toHaveLength(2); expect(ranked[0].snippet).toBe("first second");
    expect(mergeLocalResults(lists, { excludeDomains: ["github.com"] })).toEqual([]);
  });
  it("defers same-host excess and never drops candidates for diversity", () => {
    const list = ["https://example.com/1", "https://example.com/2", "https://example.com/3", "https://other.example/1"].map((url) => ({ url, title: "Mono", snippet: "", engine: "brave" }));
    expect(mergeLocalResults([list]).map((entry) => entry.url)).toEqual([list[0].url, list[1].url, list[3].url, list[2].url]);
  });
});

describe("local robots ownership", () => {
  function opts(fetchImpl, extra = {}) { return { sandbox: context().sandbox, fetchImpl, ...extra }; }
  it.each(["User-agent: *\nDisallow: /", "User-agent: *\nCrawl-delay: 0.1", "<html>Unknown gate</html>"])("fails closed for %s", async (text) => {
    const fetchImpl = vi.fn(async () => response(text));
    await expect(assertLocalRobots(target, opts(fetchImpl))).rejects.toMatchObject({ code: expect.stringMatching(/^robots_/) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("caches only completed decisions per owner/policy/UA and checks redirect path rules", async () => {
    const fetchImpl = vi.fn(async () => response("User-agent: *\nDisallow: /private\n"));
    const owner = {}; const options = opts(fetchImpl, { robotsOwner: owner });
    await assertLocalRobots(target, options);
    await expect(assertLocalRobots("https://example.com/private", options)).rejects.toMatchObject({ code: "robots_denied" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await assertLocalRobots(target, { ...options, userAgent: "different" });
    await assertLocalRobots(target, { ...options, policy: { mode: "off" } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("does not coalesce concurrent owners or leave shielded fetches", async () => {
    let calls = 0; let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const fetchImpl = async () => { calls += 1; await pending; return response(robots); };
    const one = assertLocalRobots(target, opts(fetchImpl, { robotsOwner: {} }));
    const two = assertLocalRobots(target, opts(fetchImpl, { robotsOwner: {} }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The ordinary endpoint guard serializes the same origin; it must not
    // share a decision or in-flight owner. Both owners eventually send.
    release(); await Promise.all([one, two]); expect(calls).toBe(2);
  });
  it("gates robots redirects before admission to the next origin", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://denied.example/robots.txt" } }));
    const acquire = vi.fn(async () => ({ complete: async () => {} }));
    await expect(assertLocalRobots(target, { ...opts(fetchImpl), sandbox: context((_p, url) => !String(url).includes("denied")).sandbox, coordinator: { acquire } })).rejects.toMatchObject({ code: "network_denied" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(acquire).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized streams and releases the reader", async () => {
    const cancelled = vi.fn();
    const fetchImpl = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); }, cancel: cancelled }));
    await expect(localRequest(target, opts(fetchImpl), {}, 10)).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toHaveBeenCalled();
  });
});

describe("native local fetch and migration", () => {
  it("fetches and extracts locally with allowed headers and page links", async () => {
    const fetchImpl = vi.fn(async () => response(html));
    const result = await performWebFetch({ url: target, include_links: true, headers: { "Accept-Language": "en" } }, { ctx: context(), fetchImpl, fetchConfig: { provider: "local" } });
    expect(result).toMatchObject({ error: false, outcome: { backend: "http" } });
    expect(JSON.parse(result.text).links[0].url).toBe("https://example.com/citation"); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("supports raw HTTP data without a robots preflight", async () => {
    const fetchImpl = vi.fn(async () => response(html));
    const result = await performWebFetch({ url: target, format: "raw", render: "never" }, { ctx: context(), fetchImpl, fetchConfig: { provider: "local" } });
    expect(JSON.parse(result.text).content).toBe(html); expect(result.outcome.backend).toBe("http");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429])("stops on a source refusal %i without remote fallback", async (status) => {
    const fetchImpl = vi.fn(async () => response("refused", status));
    const result = await performWebFetch({ url: target }, { ctx: context(), fetchImpl, fetchConfig: { provider: ["local", "parallel"] } });
    expect(result.error).toBe(true); expect(result.outcome.attemptedProviders).toEqual(["local"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate provider names", async () => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target }, { ctx: context(), fetchImpl, fetchConfig: { provider: ["local", "local"] } });
    expect(result.outcome.code).toBe("invalid_fetch_config"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["auto", "always"])("refuses Parallel browser rendering %s without invoking any transport", async (render) => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target, render }, { ctx: context(), fetchImpl, fetchConfig: { provider: "parallel" } });
    expect(result.outcome.code).toBe("unsupported_parameter"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects legacy endpoints before network even when local is unselected", async () => {
    const fetchImpl = vi.fn(); const legacy = { endpoint: "http://user:secret@127.0.0.1/mcp" };
    const search = await performWebSearch({ query: "mono" }, searchOptions({ fetchImpl, searchConfig: { backend: "parallel", hound: legacy } }));
    const fetch = await performWebFetch({ url: target }, { ctx: context(), fetchImpl, fetchConfig: { hound: legacy } });
    expect(search.outcome.code).toBe("invalid_local_config"); expect(fetch.outcome.code).toBe("invalid_fetch_config");
    expect(search.text + fetch.text).not.toContain("secret"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects newly present legacy config before a controller cache shortcut", async () => {
    const config = { backend: "local" }; const fetchImpl = searchFetch();
    const controller = createWebToolController({ searchConfig: config, ctx: context(), fetchImpl });
    try {
      await controller.search({ query: "mono agent evidence" }); const count = fetchImpl.mock.calls.length;
      config.hound = { endpoint: "" };
      expect((await controller.search({ query: "mono agent evidence" })).outcome.code).toBe("invalid_local_config");
      expect(fetchImpl).toHaveBeenCalledTimes(count);
    } finally { await controller.close(); }
  });
  it("migrates a renamed search backend to local", async () => {
    const fetchImpl = vi.fn();
    const result = await performWebSearch({ query: "mono" }, searchOptions({ fetchImpl, searchConfig: { backend: "hound" } }));
    expect(result.error).toBe(true); expect(result.outcome.code).toBe("invalid_search_config");
    expect(result.text).toContain("was renamed to `local`");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("migrates a renamed fetch provider with its behavior delta", async () => {
    const fetchImpl = vi.fn(async () => response(html));
    for (const provider of ["hound", ["local", "hound"]]) {
      const result = await performWebFetch({ url: target }, { ctx: context(), fetchImpl, fetchConfig: { provider } });
      expect(result.error).toBe(true); expect(result.outcome.code).toBe("invalid_fetch_config");
      expect(result.text).toContain("was renamed to `local`");
      expect(result.text).toContain("no robots preflight");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("readiness is local, never endpoint liveness", async () => {
    expect(await inspectLocalWeb()).toEqual({ ok: true, reason: "local_available" });
    expect(await inspectLocalWeb({ endpoint: "" })).toEqual({ ok: false, reason: "invalid_local_config" });
  });
  it("uses native HTTP for source redirects and extraction with awaited teardown", async () => {
    const paths = [];
    const server = createServer((request, reply) => {
      paths.push(request.url);
      if (request.url === "/start") { reply.writeHead(302, { location: "/article" }); reply.end(); return; }
      reply.writeHead(200, { "content-type": "text/html" }); reply.end(html);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const result = await performWebFetch({ url: `http://127.0.0.1:${server.address().port}/start` }, { ctx: context(), fetchConfig: { provider: "local" } });
      expect(result).toMatchObject({ error: false, outcome: { backend: "http", redirectCount: 1 } });
      expect(paths).toEqual(["/start", "/article"]);
    } finally { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
  });
});
