import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { performWebSearch } from "../../agent/tools/web-search.js";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import { createWebToolController, __resetSharedSearchCacheForTests } from "../../agent/tools/web-controller.js";
import { createWebSearchRunState } from "../../agent/tools/web-search-state.js";
import { __resetWebSearchThrottleForTests } from "../../agent/tools/web-search-providers/shared.js";
import { HOUND_ENGINES, houndEngineRequest, parseHoundEngine, mergeHoundResults } from "../../agent/tools/hound-local/engines.js";
import { assertHoundRobots } from "../../agent/tools/hound-local/robots.js";
import { houndRequest } from "../../agent/tools/hound-local/network.js";
import { inspectHoundWeb } from "../../agent/tools/hound-local/config.js";

const target = "https://example.com/evidence";
const prose = "Mono agent native Hound research evidence. ".repeat(10);
const html = `<html><head><title>Mono agent evidence</title></head><body><main><p>${prose}</p><a href="/citation">Citation</a></main></body></html>`;
const robots = "User-agent: *\nAllow: /\n";
function context(allow = () => true) { return { workspace: process.cwd(), sandbox: { ...passthroughSandbox, networkAllowsUrl: allow } }; }
function response(text, status = 200) { return new Response(text, { status, headers: { "content-type": "text/html; charset=utf-8" } }); }
function engineHtml(name, url = target) {
  if (name === "duckduckgo") return `<div class="result"><h2><a class="result__a" href="${url}">Mono agent evidence</a></h2><p class="result__snippet">Mono agent native evidence</p></div>`;
  if (name === "brave") return `<div data-type="web"><a href="${url}"><div class="title">Mono agent evidence</div></a><div class="snippet"><div class="content">Independent native research evidence</div></div></div>`;
  return `<ul class="results"><li><h2><a href="${url}">Mono agent evidence</a></h2><p class="s">Independent index evidence</p></li></ul>`;
}
function searchFetch() {
  return vi.fn(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/robots.txt") return response(robots);
    const engine = HOUND_ENGINES.find((item) => item.origin === parsed.origin);
    if (!engine) throw new Error("Unexpected destination");
    return response(engineHtml(engine.name));
  });
}
function searchOptions(overrides = {}) { return { ctx: context(), searchConfig: { backend: "hound" }, fetchImpl: searchFetch(), ...overrides }; }
beforeEach(() => { __resetWebSearchThrottleForTests({ minSpacingMs: 0 }); __resetSharedSearchCacheForTests(); });

describe("native Hound search", () => {
  it("runs real local DOM adapters, not MCP, with one answer and six cold network dispatches", async () => {
    const options = searchOptions();
    const result = await performWebSearch({ query: "mono agent evidence" }, options);
    expect(result).toMatchObject({ error: false, outcome: { backend: "hound", status: "ok", requestsThisCall: 1, dispatchesUsed: 6, resultCount: 1 } });
    expect(options.fetchImpl).toHaveBeenCalledTimes(6);
    expect(JSON.parse(result.text).coverage.engineOutcomes).toEqual(HOUND_ENGINES.map(({ name }) => ({ engine: name, code: "ok" })));
    expect(options.fetchImpl.mock.calls.every(([url]) => !String(url).includes("/mcp"))).toBe(true);
  });
  it("owns both per-target policy and per-request host admission for partial allowlists", async () => {
    const acquire = vi.fn(async () => ({ complete: vi.fn(), waitMs: 0 }));
    const options = searchOptions({ ctx: context((_policy, url) => new URL(url).hostname === "html.duckduckgo.com"), coordinator: { acquire } });
    const result = await performWebSearch({ query: "mono agent evidence" }, options);
    expect(result).toMatchObject({ error: false, outcome: { status: "partial", requestsThisCall: 1, dispatchesUsed: 2 } });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls.every(([request]) => request.kind === "duckduckgo" && request.key === "duckduckgo")).toBe(true);
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.outcome.engineOutcomes.filter((entry) => entry.code === "network_denied")).toHaveLength(2);
  });
  it("denies all targets before admission, robots or request reservation", async () => {
    const acquire = vi.fn();
    const options = searchOptions({ ctx: context(() => false), coordinator: { acquire } });
    const result = await performWebSearch({ query: "mono agent" }, options);
    expect(result.outcome).toMatchObject({ code: "network_denied", requestsUsed: 0, dispatchesUsed: 0 });
    expect(acquire).not.toHaveBeenCalled(); expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps useful results partial when sibling dispatches exhaust the budget", async () => {
    const result = await performWebSearch({ query: "mono agent evidence" }, searchOptions({ searchConfig: { backend: "hound", maxRequestsPerRun: 1 } }));
    expect(result).toMatchObject({ error: false, outcome: { status: "partial", requestsUsed: 1, dispatchesUsed: 4, resultCount: 1, providerFailureCount: 0 } });
    expect(result.outcome.engineOutcomes.some((entry) => entry.code === "search_budget_exhausted")).toBe(true);
  });
  it("refunds only failed answered reservations, never robot or engine dispatches", async () => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname === "/robots.txt" ? robots : "<html>Changed layout</html>"));
    const result = await performWebSearch({ query: "mono agent evidence" }, searchOptions({ fetchImpl }));
    expect(result.outcome).toMatchObject({ code: "invalid_response", requestsUsed: 0, dispatchesUsed: 6 });
  });
  it("keeps aggregate budget exhaustion terminal without useful results", async () => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname === "/robots.txt" ? robots : "<html>Changed layout</html>"));
    const result = await performWebSearch({ query: "mono agent evidence" }, searchOptions({ fetchImpl, searchConfig: { backend: ["hound", "parallel"], maxRequestsPerRun: 1 } }));
    expect(result.outcome).toMatchObject({ code: "search_budget_exhausted", requestsUsed: 0, dispatchesUsed: 4 });
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("parallel"))).toBe(true);
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
  it.each([403, 429])("does not switch providers, alternate queries, or retry a robots refusal %i", async (status) => {
    const fetchImpl = vi.fn(async () => response("refused", status));
    const result = await performWebSearch({ query: "mono agent", alternate_queries: ["another"] }, searchOptions({ fetchImpl, searchConfig: { backend: ["hound", "parallel"] } }));
    expect(result.error).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.every(([url]) => new URL(url).pathname === "/robots.txt")).toBe(true);
  });
  it("retains refusal cooldowns across calls without dispatching or advancing the chain", async () => {
    const fetchImpl = vi.fn(async () => response("refused", 429));
    const options = searchOptions({ fetchImpl, searchConfig: { backend: ["hound", "parallel"] } });
    await performWebSearch({ query: "mono agent" }, options);
    const result = await performWebSearch({ query: "different mono agent query" }, options);
    expect(result.outcome).toMatchObject({ code: "rate_limited", requestsUsed: 0, dispatchesUsed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("marks unsupported time-filter engines explicitly and preserves provider filter metadata", async () => {
    const options = searchOptions();
    const result = await performWebSearch({ query: "mono agent evidence", time_range: "day" }, options);
    expect(result).toMatchObject({ error: false, outcome: { status: "partial", dispatchesUsed: 4 } });
    expect(result.outcome.engineOutcomes).toContainEqual({ engine: "mojeek", code: "unsupported_filter" });
    expect(options.fetchImpl.mock.calls.some(([url]) => String(url).includes("mojeek"))).toBe(false);
  });
  it("does not spend an answer for irrelevant partial results at the dispatch ceiling", async () => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname === "/robots.txt" ? robots : engineHtml("duckduckgo").replaceAll("Mono agent", "Different material").replaceAll("Mono", "Different")));
    const result = await performWebSearch({ query: "uniqueunmatchedterm", domains: ["example.com"] }, searchOptions({ fetchImpl, searchConfig: { backend: "hound", maxRequestsPerRun: 1 } }));
    expect(result.outcome).toMatchObject({ code: "search_budget_exhausted", requestsUsed: 0, dispatchesUsed: 4 });
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

describe("Hound engine algorithms and attribution adaptations", () => {
  it("ports request/date fields and parses the three reviewed layouts", () => {
    for (const engine of HOUND_ENGINES) expect(parseHoundEngine(engine, engineHtml(engine.name))).toHaveLength(1);
    const ddg = houndEngineRequest(HOUND_ENGINES[0], 'exact "query"', "day");
    expect(ddg.init.method).toBe("POST"); expect(ddg.init.body.get("q")).toBe('exact "query"'); expect(ddg.init.body.get("df")).toBe("d");
    expect(houndEngineRequest(HOUND_ENGINES[1], "query", "month").url).toContain("tf=pm");
  });
  it("dedupes GitHub repo case without folding file paths and merges consensus snippets", () => {
    const result = (url, engine, snippet) => ({ url, engine, title: "Mono agent", snippet });
    const lists = [[result("https://github.com/Owner/Repo/blob/MAIN/file", "duckduckgo", "first")], [result("https://github.com/owner/repo/blob/MAIN/file", "brave", "second"), result("https://github.com/owner/repo/blob/main/file", "brave", "different branch")]];
    const ranked = mergeHoundResults(lists);
    expect(ranked).toHaveLength(2); expect(ranked[0].snippet).toBe("first second");
    expect(mergeHoundResults(lists, { excludeDomains: ["github.com"] })).toEqual([]);
  });
  it("defers same-host excess and never drops candidates for diversity", () => {
    const list = ["https://example.com/1", "https://example.com/2", "https://example.com/3", "https://other.example/1"].map((url) => ({ url, title: "Mono", snippet: "", engine: "brave" }));
    expect(mergeHoundResults([list]).map((entry) => entry.url)).toEqual([list[0].url, list[1].url, list[3].url, list[2].url]);
  });
});

describe("Hound robots ownership", () => {
  function opts(fetchImpl, extra = {}) { return { sandbox: context().sandbox, fetchImpl, ...extra }; }
  it.each(["User-agent: *\nDisallow: /", "User-agent: *\nCrawl-delay: 0.1", "<html>Unknown gate</html>"])("fails closed for %s", async (text) => {
    const fetchImpl = vi.fn(async () => response(text));
    await expect(assertHoundRobots(target, opts(fetchImpl))).rejects.toMatchObject({ code: expect.stringMatching(/^robots_/) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("caches only completed decisions per owner/policy/UA and checks redirect path rules", async () => {
    const fetchImpl = vi.fn(async () => response("User-agent: *\nDisallow: /private\n"));
    const owner = {}; const options = opts(fetchImpl, { robotsOwner: owner });
    await assertHoundRobots(target, options);
    await expect(assertHoundRobots("https://example.com/private", options)).rejects.toMatchObject({ code: "robots_denied" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await assertHoundRobots(target, { ...options, userAgent: "different" });
    await assertHoundRobots(target, { ...options, policy: { mode: "off" } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("does not coalesce concurrent owners or leave shielded fetches", async () => {
    let calls = 0; let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const fetchImpl = async () => { calls += 1; await pending; return response(robots); };
    const one = assertHoundRobots(target, opts(fetchImpl, { robotsOwner: {} }));
    const two = assertHoundRobots(target, opts(fetchImpl, { robotsOwner: {} }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The ordinary endpoint guard serializes the same origin; it must not
    // share a decision or in-flight owner. Both owners eventually send.
    release(); await Promise.all([one, two]); expect(calls).toBe(2);
  });
  it("gates robots redirects before admission to the next origin", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://denied.example/robots.txt" } }));
    const acquire = vi.fn(async () => ({ complete: async () => {} }));
    await expect(assertHoundRobots(target, { ...opts(fetchImpl), sandbox: context((_p, url) => !String(url).includes("denied")).sandbox, coordinator: { acquire } })).rejects.toMatchObject({ code: "network_denied" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(acquire).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized streams and releases the reader", async () => {
    const cancelled = vi.fn();
    const fetchImpl = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); }, cancel: cancelled }));
    await expect(houndRequest(target, opts(fetchImpl), {}, 10)).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toHaveBeenCalled();
  });
});

describe("native Hound fetch and migration", () => {
  it("fetches and extracts locally, respects robots and supports raw/allowed headers", async () => {
    const fetchImpl = vi.fn(async (url) => new URL(url).pathname === "/robots.txt" ? response(robots) : response(html));
    const result = await performWebFetch({ url: target, include_links: true, headers: { "Accept-Language": "en" } }, { ctx: context(), fetchImpl, fetchConfig: { provider: "hound" } });
    expect(result).toMatchObject({ error: false, outcome: { backend: "hound", local: true } });
    expect(JSON.parse(result.text).links[0].url).toBe("https://example.com/citation"); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("supports raw HTTP data without weakening robots enforcement", async () => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname === "/robots.txt" ? robots : html));
    const result = await performWebFetch({ url: target, format: "raw", render: "never" }, { ctx: context(), fetchImpl, fetchConfig: { provider: "hound" } });
    expect(JSON.parse(result.text).content).toBe(html); expect(result.outcome.backend).toBe("hound");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 429])("stops on a source refusal %i without local/remote fallback", async (status) => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname === "/robots.txt" ? robots : "refused", new URL(url).pathname === "/robots.txt" ? 200 : status));
    const result = await performWebFetch({ url: target }, { ctx: context(), fetchImpl, fetchConfig: { provider: ["hound", "local", "parallel"] } });
    expect(result.error).toBe(true); expect(result.outcome.attemptedProviders).toEqual(["hound"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("rechecks robots on each source redirect and never falls back around disallow", async () => {
    const fetchImpl = vi.fn(async (url) => new URL(url).pathname === "/robots.txt" ? response("User-agent: *\nDisallow: /private\n") : new Response(null, { status: 302, headers: { location: "/private" } }));
    const result = await performWebFetch({ url: target }, { ctx: context(), fetchImpl, fetchConfig: { provider: ["hound", "local", "parallel"] } });
    expect(result.outcome).toMatchObject({ code: "robots_denied", attemptedProviders: ["hound"] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not repeat an equivalent local acquisition in the other provider name", async () => {
    const fetchImpl = vi.fn(async () => response("unavailable", 503));
    const result = await performWebFetch({ url: target }, { ctx: context(), fetchImpl, retryDelaysMs: [], fetchConfig: { provider: ["local", "hound"] } });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(result.outcome.attemptedProviders).toEqual(["local"]);
  });
  it.each(["auto", "always"])("refuses Hound browser rendering %s without invoking any transport", async (render) => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target, render }, { ctx: context(), fetchImpl, fetchConfig: { provider: "hound", render: "auto" } });
    expect(result.outcome.code).toBe("unsupported_parameter"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects legacy endpoints before network even when Hound is unselected", async () => {
    const fetchImpl = vi.fn(); const legacy = { endpoint: "http://user:secret@127.0.0.1/mcp" };
    const search = await performWebSearch({ query: "mono" }, searchOptions({ fetchImpl, searchConfig: { backend: "parallel", hound: legacy } }));
    const fetch = await performWebFetch({ url: target }, { ctx: context(), fetchImpl, fetchConfig: { hound: legacy } });
    expect(search.outcome.code).toBe("invalid_hound_config"); expect(fetch.outcome.code).toBe("invalid_fetch_config");
    expect(search.text + fetch.text).not.toContain("secret"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects newly present legacy config before a controller cache shortcut", async () => {
    const config = { backend: "hound" }; const fetchImpl = searchFetch();
    const controller = createWebToolController({ searchConfig: config, ctx: context(), fetchImpl });
    try {
      await controller.search({ query: "mono agent evidence" }); const count = fetchImpl.mock.calls.length;
      config.hound = { endpoint: "" };
      expect((await controller.search({ query: "mono agent evidence" })).outcome.code).toBe("invalid_hound_config");
      expect(fetchImpl).toHaveBeenCalledTimes(count);
    } finally { await controller.close(); }
  });
  it("readiness is local, never endpoint liveness", async () => {
    expect(await inspectHoundWeb()).toEqual({ ok: true, reason: "local_available" });
    expect(await inspectHoundWeb({ endpoint: "" })).toEqual({ ok: false, reason: "invalid_hound_config" });
  });
  it("uses native HTTP for robots, source redirects and extraction with awaited teardown", async () => {
    const paths = [];
    const server = createServer((request, reply) => {
      paths.push(request.url);
      if (request.url === "/robots.txt") { reply.end(robots); return; }
      if (request.url === "/start") { reply.writeHead(302, { location: "/article" }); reply.end(); return; }
      reply.writeHead(200, { "content-type": "text/html" }); reply.end(html);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const result = await performWebFetch({ url: `http://127.0.0.1:${server.address().port}/start` }, { ctx: context(), fetchConfig: { provider: "hound" } });
      expect(result).toMatchObject({ error: false, outcome: { backend: "hound", redirectCount: 1 } });
      expect(paths).toEqual(["/robots.txt", "/start", "/article"]);
    } finally { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
  });
});
