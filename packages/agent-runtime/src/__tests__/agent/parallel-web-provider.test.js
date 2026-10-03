import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { performWebSearch, __resetWebSearchThrottleForTests } from "../../agent/tools/web-search.js";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import { createWebToolController, __resetSharedSearchCacheForTests } from "../../agent/tools/web-controller.js";
import { createWebSearchRunState } from "../../agent/tools/web-search-state.js";
import { callParallelMcp, inspectParallelWeb, parallelFailure, parallelSessionId, PARALLEL_MCP_URL } from "../../agent/tools/parallel-mcp.js";
import { parseParallelSearch } from "../../agent/tools/web-search-providers/parallel.js";
const search = JSON.parse(readFileSync(new URL("./fixtures/parallel-search.json", import.meta.url)));
const extract = JSON.parse(readFileSync(new URL("./fixtures/parallel-fetch.json", import.meta.url)));
const target = extract.results[0].url;
const sandbox = { networkAllowsUrl: () => true, mergePolicies: (_a, b) => b };
const ctx = { sandbox, runId: "private-run-identifier" };
function transport(result = { structuredContent: search }, customize, getStatus = 405) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    expect(String(url)).toBe(PARALLEL_MCP_URL);
    expect(init.redirect).toBe("error");
    if (init.method === "GET") return new Response(null, { status: getStatus });
    const message = JSON.parse(init.body);
    if (message.method === "notifications/initialized") return new Response(new ReadableStream({
      async pull(controller) { await new Promise((resolve) => setTimeout(resolve, 1)); try { controller.close(); } catch { /* cancelled by SDK */ } },
    }), { status: 202 });
    let value;
    if (message.method === "initialize") value = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    else if (message.method === "tools/list") value = { tools: ["web_search", "web_fetch"].map((name) => ({ name, inputSchema: { type: "object" } })) };
    else {
      calls.push(message.params);
      const special = await customize?.(message, init);
      if (special) return special;
      value = { content: [], ...(typeof result === "function" ? result(message.params) : result) };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }), { headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
}
function searchOptions(fetchImpl, extra = {}) { return { ctx, fetchImpl, searchConfig: { backend: "parallel" }, ...extra }; }
beforeEach(() => { __resetWebSearchThrottleForTests({ minSpacingMs: 0 }); __resetSharedSearchCacheForTests(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Parallel Search MCP", () => {
  it("defaults to Parallel then local Ollama without probing keyless", async () => {
    const remote = transport({ isError: true, content: [{ type: "text", text: "Unavailable" }] });
    const fetchImpl = vi.fn((url, init) => String(url) === PARALLEL_MCP_URL ? remote.fetchImpl(url, init)
      : Promise.resolve(new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "Search MCP", content: "Search MCP evidence" }] }))));
    const result = await performWebSearch({ query: "Search MCP" }, { ctx, fetchImpl });
    expect(result.outcome).toMatchObject({ backend: "ollama", attemptedBackends: ["parallel", "ollama"], requestsThisCall: 1 });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toContain("http://127.0.0.1:11434/api/experimental/web_search");
    expect(fetchImpl.mock.calls.some(([url]) => /duckduckgo|startpage/.test(String(url)))).toBe(false);
  });
  it("parses observed structured content, with JSON text fallback only", () => {
    expect(parseParallelSearch({ structuredContent: search })).toHaveLength(10);
    expect(parseParallelSearch({ content: [{ type: "text", text: JSON.stringify(search) }] })).toHaveLength(10);
    for (const response of [{ content: [] }, { structuredContent: {}, content: [{ type: "text", text: JSON.stringify(search) }] }, { structuredContent: { search_id: "s", results: [{ url: "bad" }] } }]) {
      expect(() => parseParallelSearch(response)).toThrow();
    }
  });
  it("batches exact primary/alternates once, claims one answer, and hashes the run id", async () => {
    const { fetchImpl, calls } = transport();
    const result = await performWebSearch({ query: '"Search MCP"', alternate_queries: ["parallel MCP", "site:docs.parallel.ai MCP"], limit: 10, language: "en", country: "pl", time_range: "year" }, searchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ status: "ok", backend: "parallel", requestsThisCall: 1, dispatchesUsed: 1, filterSupport: { language: "advisory", country: "advisory", timeRange: "advisory" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments.search_queries).toEqual(['"Search MCP"', "parallel MCP", "site:docs.parallel.ai MCP"]);
    expect(calls[0].arguments.objective).toContain("Prefer search results localized for country PL.");
    expect(calls[0].arguments.session_id).toBe(`mono-${createHash("sha256").update(ctx.runId).digest("hex")}`);
    const searchPayload = JSON.parse(result.text);
    expect(searchPayload).toMatchObject({ tool: "WebSearch", status: "ok" });
    expect(searchPayload.results.length).toBeGreaterThan(0);
    expect(searchPayload.results.some((entry) => entry.published === "2025-07-14")).toBe(true);
  });
  it("declares operator domain support: site: reaches search_queries verbatim and is reported", async () => {
    const { fetchImpl, calls } = transport();
    const result = await performWebSearch({ query: "site:docs.parallel.ai Search MCP" }, searchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ status: "ok", backend: "parallel",
      filterSupport: { domains: "operator", language: "not_requested", country: "not_requested", timeRange: "not_requested" } });
    // The operator text is the enforcement mechanism over MCP: it must arrive
    // verbatim rather than being stripped, relaxed, or mapped elsewhere.
    expect(calls[0].arguments.search_queries).toEqual(["site:docs.parallel.ai Search MCP"]);
    expect(calls[0].arguments.objective).toContain("Prefer these domains: docs.parallel.ai.");
    const payload = JSON.parse(result.text);
    expect(payload.coverage.filterSupport.domains).toBe("operator");
    expect(payload.coverage.requestedFilters).toMatchObject({ domains: ["docs.parallel.ai"] });
    expect(payload.coverage.requestedFilters.note).toContain("site: operators");
  });
  it("reports domain constraints on the failure path instead of degrading silently", async () => {
    const { fetchImpl } = transport();
    const result = await performWebSearch({ query: "site:elsewhere.example Search MCP" }, searchOptions(fetchImpl));
    expect(result).toMatchObject({ error: true });
    const payload = JSON.parse(result.text);
    expect(payload.coverage.filterSupport).toMatchObject({ domains: "operator" });
    expect(payload.coverage.requestedFilters).toMatchObject({ domains: ["elsewhere.example"] });
  });
  it("counts a genuine empty answer once and never replays the batch for alternates", async () => {
    const { fetchImpl, calls } = transport({ structuredContent: { ...search, results: [] } });
    const result = await performWebSearch({ query: "nothing", alternate_queries: ["nothing else"] }, searchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ code: "no_results", requestsThisCall: 1 });
    expect(calls).toHaveLength(1);
  });
  it.each([
    ["malformed", { structuredContent: { results: null } }, "backend_unavailable"],
    ["MCP error", { isError: true, content: [{ type: "text", text: "private response sentinel" }] }, "backend_unavailable"],
    ["MCP HTTP 429", { isError: true, content: [{ type: "text", text: "HTTP 429 sentinel" }] }, "rate_limited"],
    ["MCP non-status 1429", { isError: true, content: [{ type: "text", text: "HTTP 1429 sentinel" }] }, "backend_unavailable"],
    ["MCP rate limit", { isError: true, content: [{ type: "text", text: "Rate limit exceeded sentinel" }] }, "rate_limited"],
  ])("refunds %s without leaking response material", async (_label, response, code) => {
    const { fetchImpl } = transport(response);
    const result = await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({
      status: code === "rate_limited" ? "blocked" : "error",
      code,
      requestsThisCall: 0,
      dispatchesUsed: 1,
    });
    expect(result.text).not.toContain("sentinel");
    expect(JSON.stringify(result.outcome)).not.toContain("sentinel");
  });
  it.each([true, false])("maps HTTP 429 to cooldown and refunds without reconnecting on a later call (transport=%s)", async (http) => {
    const { fetchImpl } = http
      ? transport(undefined, () => new Response("sentinel", { status: 429, headers: { "retry-after": "120" } }))
      : transport({ isError: true, content: [{ type: "text", text: "HTTP 429" }] });
    const state = createWebSearchRunState({});
    const options = searchOptions(fetchImpl, { searchState: state });
    expect((await performWebSearch({ query: "Search MCP" }, options)).outcome).toMatchObject({ code: "rate_limited", requestsThisCall: 0, retryAfterMs: http ? 120000 : 60000 });
    const count = fetchImpl.mock.calls.length;
    expect((await performWebSearch({ query: "Search MCP again" }, options)).outcome.code).toBe("rate_limited");
    expect(fetchImpl).toHaveBeenCalledTimes(count);
  });
  it.each([["HTTP 429", "rate_limited"], ["status (429)", "rate_limited"], ["HTTP 1429", "backend_unavailable"], ["HTTP 4290", "backend_unavailable"]])("classifies bounded status tokens without exposing %s", (message, code) => {
    const result = parallelFailure(new Error(`${message} private sentinel`));
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });
  it("gates the endpoint before connecting, and claims no budget on sandbox denial", async () => {
    const fetchImpl = vi.fn();
    const result = await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl, { ctx: { sandbox: { ...sandbox, networkAllowsUrl: () => false } } }));
    expect(result.outcome).toMatchObject({ code: "network_denied", dispatchesUsed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses an exhausted budget before opening the MCP connection", async () => {
    const state = createWebSearchRunState({ maxRequestsPerRun: 1 }); state.requestsUsed = 1;
    const fetchImpl = vi.fn();
    const result = await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl, { searchState: state }));
    expect(result.outcome.code).toBe("search_budget_exhausted"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects redirects and missing credentials before connecting", async () => {
    const { fetchImpl } = transport(undefined, () => new Response(null, { status: 307, headers: { location: "https://other.example" } }));
    expect((await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl))).outcome.code).toBe("backend_unavailable");
    const missing = vi.fn();
    const result = await performWebSearch({ query: "Search MCP" }, searchOptions(missing, { searchConfig: { backend: "parallel", parallel: { apiKeyEnv: "MISSING_TEST_PARALLEL_KEY" } } }));
    expect(result.outcome.code).toBe("invalid_parallel_config"); expect(missing).not.toHaveBeenCalled();
  });
  it("enforces cumulative streaming byte ceilings and closes SDK ownership", async () => {
    const closed = vi.spyOn(Client.prototype, "close");
    const transportClosed = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
    const { fetchImpl } = transport(undefined, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); } }), { headers: { "content-type": "application/json" } }));
    expect((await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl))).outcome).toMatchObject({ code: "response_too_large", requestsThisCall: 0 });
    expect(closed).toHaveBeenCalled(); expect(transportClosed).toHaveBeenCalled();
  });
  it.each([405, 404, 400, 403])("tolerates optional auxiliary GET HTTP %s while POST succeeds", async (status) => {
    const { fetchImpl } = transport(undefined, undefined, status);
    expect((await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl))).outcome.code).toBe("ok");
  });
  it("keeps the POST alive when an open auxiliary GET stream errors mid-read", async () => {
    const postStarted = Promise.withResolvers();
    const getFailed = Promise.withResolvers();
    const originalConnect = Client.prototype.connect;
    vi.spyOn(Client.prototype, "connect").mockImplementation(function (...args) {
      this.onerror = (error) => { if (error.message.includes("auxiliary read sentinel")) getFailed.resolve(); };
      return originalConnect.apply(this, args);
    });
    const remote = transport(undefined, async (_message, init) => {
      postStarted.resolve();
      await getFailed.promise;
      init.signal.throwIfAborted();
    });
    const fetchImpl = vi.fn((url, init) => init.method !== "GET" ? remote.fetchImpl(url, init)
      : Promise.resolve(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(": keepalive\n\n")); },
        async pull(controller) { await postStarted.promise; controller.error(new Error("auxiliary read sentinel")); },
      }), { headers: { "content-type": "text/event-stream" } })));
    const result = await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ code: "ok", backend: "parallel", requestsThisCall: 1 });
    expect(remote.calls).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === "GET")).toHaveLength(1);
  });
  it("accepts bounded SSE tool responses through the real SDK parser", async () => {
    const { fetchImpl } = transport(undefined, (message) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [], structuredContent: search } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    expect((await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl))).outcome.code).toBe("ok");
  });
  it("propagates abort and closes a blocked transport", async () => {
    const controller = new AbortController();
    const closed = vi.spyOn(Client.prototype, "close");
    const { fetchImpl } = transport(undefined, async (_message, init) => {
      controller.abort();
      init.signal.throwIfAborted();
    });
    const result = await performWebSearch({ query: "Search MCP" }, searchOptions(fetchImpl, { signal: controller.signal }));
    expect(result.outcome.code).toBe("aborted"); expect(closed).toHaveBeenCalled();
  });
  it("memoizes anonymous run sessions, but does not share across run states", () => {
    const a = {}, b = {};
    expect(parallelSessionId({}, a)).toBe(parallelSessionId({}, a));
    expect(parallelSessionId({}, a)).not.toBe(parallelSessionId({}, b));
    expect(parallelSessionId({}, a)).toMatch(/^mono-[a-f0-9]{64}$/);
  });
  it("probes tools/list only, with endpoint gating", async () => {
    const { fetchImpl, calls } = transport();
    expect(await inspectParallelWeb({ sandbox, fetchImpl })).toEqual({ ok: true, reason: "tools_advertised" });
    expect(calls).toHaveLength(0);
    const denied = vi.fn();
    expect(await inspectParallelWeb({ sandbox: { networkAllowsUrl: () => false }, fetchImpl: denied })).toEqual({ ok: false, reason: "network_denied" });
    expect(denied).not.toHaveBeenCalled();
  });
});

describe("Parallel WebFetch", () => {
  it.each([true, false])("prefers full content or explicitly marks excerpts (full=%s)", async (full) => {
    const data = { ...extract, results: [{ ...extract.results[0], full_content: full ? "# Complete\nFull content evidence" : null }] };
    const { fetchImpl, calls } = transport({ structuredContent: data });
    const result = await performWebFetch({ url: target, format: "text" }, { ctx, fetchImpl, fetchConfig: { provider: "parallel" } });
    expect(result.outcome).toMatchObject({
      status: full ? "ok" : "partial",
      backend: "parallel",
      excerptsOnly: !full,
    });
    const fetchPayload = JSON.parse(result.text);
    expect(fetchPayload).toMatchObject({ tool: "WebFetch", status: full ? "ok" : "partial" });
    expect(fetchPayload.content).toContain(full ? "Full content evidence" : "Search MCP");
    if (!full) expect(fetchPayload.summary).toContain("excerpts only");
    expect(result.text.includes("[excerpts only]")).toBe(!full);
    expect(calls[0].arguments).toMatchObject({ urls: [target], full_content: true });
  });
  it.each([{ format: "raw" }, { headers: { Accept: "text/plain" } }, { render: "auto" }, { render: "always" }, { include_links: true }])("rejects unsupported options before network: %j", async (params) => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target, ...params }, { ctx, fetchImpl, fetchConfig: { provider: "parallel" } });
    expect(result.outcome.code).toBe("unsupported_parameter"); expect(result.text).toContain(Object.keys(params)[0]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([target, PARALLEL_MCP_URL])("gates both target and endpoint: %s", async (denied) => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target }, { ctx: { sandbox: { ...sandbox, networkAllowsUrl: (_p, url) => url !== denied } }, fetchImpl, fetchConfig: { provider: "parallel" } });
    expect(result.outcome.code).toBe("network_denied"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("preserves extraction errors[] HTTP status without echoing error bodies", async () => {
    const { fetchImpl } = transport({ structuredContent: { ...extract, results: [], errors: [{ url: target, error_type: "http_error", http_status_code: 503, content: "private sentinel" }] } });
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl, fetchConfig: { provider: "parallel" } });
    expect(result.outcome).toMatchObject({ code: "http_503", statusCode: 503, retryable: true });
    expect(result.text).not.toContain("sentinel");
  });
  it.each(["unusable_content", "http_503"])("advances from local %s in an explicit chain", async (code) => {
    const remote = transport({ structuredContent: extract });
    const local = code === "unusable_content" ? '<html><body><div id="root">Loading</div><script src="/one.js"></script><script src="/two.js"></script><script>window.__NEXT_DATA__={}</script></body></html>' : "unavailable";
    const fetchImpl = vi.fn((url, init) => String(url) === PARALLEL_MCP_URL ? remote.fetchImpl(url, init) : Promise.resolve(new Response(local, { status: code === "http_503" ? 503 : 200, headers: { "content-type": "text/html" } })));
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl, retryDelaysMs: [], fetchConfig: { provider: ["local", "parallel"] } });
    // The shared fetch fixture carries excerpts only, so the rescued chain is
    // honestly partial rather than full success.
    expect(result.outcome).toMatchObject({ status: "partial", backend: "parallel", attemptedProviders: ["local", "parallel"], fallbackUsed: true });
    expect(JSON.parse(result.text)).toMatchObject({ tool: "WebFetch", status: "partial" });
  });
  it.each(["authentication_required", "network_denied", "aborted"])("never falls through terminal local %s", async (code) => {
    const signal = new AbortController();
    if (code === "aborted") signal.abort();
    const fetchImpl = vi.fn(async () => new Response("Authentication required. Sign in to continue.", { status: 401, headers: { "content-type": "text/plain" } }));
    const context = code === "network_denied" ? { sandbox: { ...sandbox, networkAllowsUrl: () => false } } : ctx;
    const result = await performWebFetch({ url: target }, { ctx: context, signal: signal.signal, fetchImpl, retryDelaysMs: [], fetchConfig: { provider: ["local", "parallel"] } });
    expect(result.outcome.code).toBe(code);
    expect(fetchImpl.mock.calls.some(([url]) => String(url) === PARALLEL_MCP_URL)).toBe(false);
  });
  it("uses local for incompatible options, even when Parallel is first", async () => {
    const fetchImpl = vi.fn(async () => new Response("raw evidence", { headers: { "content-type": "text/plain" } }));
    const result = await performWebFetch({ url: target, format: "raw" }, { ctx, fetchImpl, fetchConfig: { provider: ["parallel", "local"] } });
    expect(result.outcome).toMatchObject({ status: "ok", backend: "http", attemptedProviders: ["local"] });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(target);
  });
  it("shares a run session across search/fetch and fetch continuation, while key rotation invalidates caches", async () => {
    vi.stubEnv("TEST_PARALLEL_KEY", "first-secret");
    const { fetchImpl, calls } = transport((params) => ({ structuredContent: params.name === "web_search" ? search : extract }));
    const controller = createWebToolController({ ctx: { sandbox }, fetchImpl, searchConfig: { backend: "parallel", parallel: { apiKeyEnv: "TEST_PARALLEL_KEY" } }, fetchConfig: { provider: "parallel", parallel: { apiKeyEnv: "TEST_PARALLEL_KEY" } } });
    await controller.search({ query: "Search MCP" });
    await controller.fetch({ url: target, max_lines: 2 });
    await controller.fetch({ url: target, start_line: 3, max_lines: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0].arguments.session_id).toBe(calls[1].arguments.session_id);
    vi.stubEnv("TEST_PARALLEL_KEY", "second-secret");
    await controller.search({ query: "Search MCP" });
    await controller.fetch({ url: target });
    expect(calls).toHaveLength(4);
    await controller.close();
  });
  it("enforces the fetch transport ceiling", async () => {
    const { fetchImpl } = transport(undefined, () => new Response(new Uint8Array(20 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }));
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl, fetchConfig: { provider: "parallel" } });
    expect(result.outcome.code).toBe("response_too_large");
  });
});
