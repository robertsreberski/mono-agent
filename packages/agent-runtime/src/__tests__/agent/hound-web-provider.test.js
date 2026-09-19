import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { performWebSearch, __resetWebSearchThrottleForTests } from "../../agent/tools/web-search.js";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import { createWebToolController, __resetSharedSearchCacheForTests } from "../../agent/tools/web-controller.js";
import { createWebSearchRunState } from "../../agent/tools/web-search-state.js";
import { inspectHoundWeb, houndFailure, houndRemoteAllowedByPolicy, HOUND_FETCH_TOOL, HOUND_SEARCH_TOOL } from "../../agent/tools/hound-mcp.js";
import { parseHoundSearch } from "../../agent/tools/web-search-providers/hound.js";
import { createFakeSandbox, testSandboxPolicy } from "../helpers/fake-sandbox.js";

// Fixture shapes mirror Hound 12.4.1 model_dump() output: SearchResponseModel
// for search, ResponseModel for fetch. The adapter is validated against these
// shapes, not a live Hound server.
const search = JSON.parse(readFileSync(new URL("./fixtures/hound-search.json", import.meta.url)));
const fetchDoc = JSON.parse(readFileSync(new URL("./fixtures/hound-fetch.json", import.meta.url)));
const ENDPOINT = "http://127.0.0.1:8765/mcp";
const target = fetchDoc.url;
const sandbox = { networkAllowsUrl: () => true, mergePolicies: (_a, b) => b };
const ctx = { sandbox, runId: "private-run-identifier" };

// Speaks MCP JSON-RPC through the real SDK client with a stubbed HTTP layer,
// exactly like the Parallel provider tests. No Hound process runs here.
function transport(endpoint, result = { structuredContent: search }, customize, getStatus = 405) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    expect(String(url)).toBe(endpoint);
    expect(init.redirect).toBe("error");
    if (init.method === "GET") return new Response(null, { status: getStatus });
    const message = JSON.parse(init.body);
    if (message.method === "notifications/initialized") return new Response(new ReadableStream({
      async pull(controller) { await new Promise((resolve) => setTimeout(resolve, 1)); try { controller.close(); } catch { /* cancelled by SDK */ } },
    }), { status: 202 });
    let value;
    if (message.method === "initialize") value = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    else if (message.method === "tools/list") value = { tools: [HOUND_SEARCH_TOOL, HOUND_FETCH_TOOL].map((name) => ({ name, inputSchema: { type: "object" } })) };
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
function searchOptions(fetchImpl, extra = {}) {
  return { ctx, fetchImpl, searchConfig: { backend: "hound", hound: { endpoint: ENDPOINT } }, ...extra };
}
function fetchOptions(fetchImpl, extra = {}) {
  return { ctx, fetchImpl, fetchConfig: { provider: "hound", hound: { endpoint: ENDPOINT } }, ...extra };
}
beforeEach(() => { __resetWebSearchThrottleForTests({ minSpacingMs: 0 }); __resetSharedSearchCacheForTests(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Hound Search MCP", () => {
  it("sends one query with native filters in the options bag and parses results", async () => {
    const { fetchImpl, calls } = transport(ENDPOINT);
    const result = await performWebSearch(
      { query: "Hound MCP", limit: 7, language: "en", time_range: "year", domains: ["docs.example.com"], exclude_domains: ["forum.example.com"] },
      searchOptions(fetchImpl),
    );
    expect(result.outcome).toMatchObject({ status: "ok", backend: "hound", requestsThisCall: 1, dispatchesUsed: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "mcp_smart_search",
      arguments: {
        query: "Hound MCP (site:docs.example.com)",
        options: { max_results: 7, language: "en", freshness: "year", site: "docs.example.com", exclude_sites: ["forum.example.com"] },
      },
    });
    // The forum fixture lacks every query term, so host relevance keeps two.
    const payload = JSON.parse(result.text);
    expect(payload.results.map((entry) => entry.url)).toEqual([
      "https://docs.example.com/hound/smart-fetch",
      "https://docs.example.com/hound/endpoint",
    ]);
  });
  it("omits unmapped filters instead of inventing server options", async () => {
    const { fetchImpl, calls } = transport(ENDPOINT);
    await performWebSearch(
      { query: "Hound MCP", time_range: "hour", domains: ["a.example.com", "b.example.com"] },
      searchOptions(fetchImpl),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments.query).toBe("Hound MCP (site:a.example.com OR site:b.example.com)");
    expect(calls[0].arguments.options).toEqual({ max_results: 5 });
  });
  it("parses observed structured content, with JSON text fallback only", () => {
    expect(parseHoundSearch({ structuredContent: search })).toHaveLength(3);
    expect(parseHoundSearch({ content: [{ type: "text", text: JSON.stringify(search) }] })).toHaveLength(3);
    for (const response of [{ content: [] }, { structuredContent: {}, content: [{ type: "text", text: JSON.stringify(search) }] }, { structuredContent: { results: [{ url: "bad" }] } }]) {
      expect(() => parseHoundSearch(response)).toThrow();
    }
  });
  it("treats an empty set as a genuine answer and runs alternates sequentially (no batching)", async () => {
    const { fetchImpl, calls } = transport(ENDPOINT, (params) => ({
      structuredContent: params.arguments.query.startsWith("nothing") ? { ...search, results: [] } : search,
    }));
    const result = await performWebSearch({ query: "nothing", alternate_queries: ["Hound MCP"] }, searchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ status: "ok", backend: "hound", requestsThisCall: 2 });
    expect(calls).toHaveLength(2);
  });
  it.each([
    ["server error without results", { ...search, results: [], error: "sentinel-engines-down" }, "backend_unavailable"],
    ["malformed results", { results: null }, "backend_unavailable"],
    ["MCP error", { isError: true, content: [{ type: "text", text: "sentinel-tool-broken" }] }, "backend_unavailable"],
    ["MCP rate limit", { isError: true, content: [{ type: "text", text: "Rate limit exceeded sentinel" }] }, "rate_limited"],
  ])("refunds %s without leaking server text", async (_label, response, code) => {
    const { fetchImpl } = transport(ENDPOINT, response);
    const result = await performWebSearch({ query: "Hound MCP" }, searchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ code, requestsThisCall: 0 });
    expect(result.text).not.toContain("sentinel");
    expect(JSON.stringify(result.outcome)).not.toContain("sentinel");
  });
  it("keeps partial engine evidence: blocked engines with results still succeed", async () => {
    const { fetchImpl } = transport(ENDPOINT);
    const result = await performWebSearch({ query: "Hound MCP" }, searchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ status: "ok", backend: "hound" });
  });
  it("maps transport 429 to cooldown and never reconnects on the later call", async () => {
    const { fetchImpl } = transport(ENDPOINT, undefined, () => new Response("sentinel", { status: 429, headers: { "retry-after": "120" } }));
    const state = createWebSearchRunState({});
    const options = searchOptions(fetchImpl, { searchState: state });
    expect((await performWebSearch({ query: "Hound MCP" }, options)).outcome).toMatchObject({ code: "rate_limited", requestsThisCall: 0, retryAfterMs: 120000 });
    const count = fetchImpl.mock.calls.length;
    expect((await performWebSearch({ query: "Hound MCP again" }, options)).outcome.code).toBe("rate_limited");
    expect(fetchImpl).toHaveBeenCalledTimes(count);
  });
  it.each([["HTTP 429", "rate_limited"], ["HTTP 1429", "backend_unavailable"]])("classifies bounded status tokens %s without exposing them", (message, code) => {
    const result = houndFailure(new Error(`${message} private sentinel`));
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });
  it("gates the endpoint before connecting, and claims no budget on sandbox denial", async () => {
    const fetchImpl = vi.fn();
    const result = await performWebSearch({ query: "Hound MCP" }, searchOptions(fetchImpl, { ctx: { sandbox: { ...sandbox, networkAllowsUrl: () => false } } }));
    expect(result.outcome).toMatchObject({ code: "network_denied", dispatchesUsed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses an exhausted budget before opening the MCP connection", async () => {
    const state = createWebSearchRunState({ maxRequestsPerRun: 1 }); state.requestsUsed = 1;
    const fetchImpl = vi.fn();
    const result = await performWebSearch({ query: "Hound MCP" }, searchOptions(fetchImpl, { searchState: state }));
    expect(result.outcome.code).toBe("search_budget_exhausted"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires the endpoint when selected and rejects non-loopback shapes", async () => {
    const missing = vi.fn();
    expect((await performWebSearch({ query: "Hound MCP" }, { ctx, fetchImpl: missing, searchConfig: { backend: "hound" } })).outcome.code).toBe("invalid_search_config");
    expect(missing).not.toHaveBeenCalled();
    for (const endpoint of ["https://example.com/mcp", "http://127.0.0.1:8765", "http://127.0.0.1:8765/other"]) {
      const denied = vi.fn();
      expect((await performWebSearch({ query: "Hound MCP" }, { ctx, fetchImpl: denied, searchConfig: { backend: "hound", hound: { endpoint } } })).outcome.code).toBe("invalid_search_config");
      expect(denied).not.toHaveBeenCalled();
    }
  });
  it("refuses transport redirects before connecting logic runs", async () => {
    const { fetchImpl } = transport(ENDPOINT, undefined, () => new Response(null, { status: 307, headers: { location: "https://other.example" } }));
    expect((await performWebSearch({ query: "Hound MCP" }, searchOptions(fetchImpl))).outcome.code).toBe("backend_unavailable");
  });
  it("enforces cumulative streaming byte ceilings and closes SDK ownership", async () => {
    const closed = vi.spyOn(Client.prototype, "close");
    const transportClosed = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
    const { fetchImpl } = transport(ENDPOINT, undefined, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); } }), { headers: { "content-type": "application/json" } }));
    expect((await performWebSearch({ query: "Hound MCP" }, searchOptions(fetchImpl))).outcome).toMatchObject({ code: "response_too_large", requestsThisCall: 0 });
    expect(closed).toHaveBeenCalled(); expect(transportClosed).toHaveBeenCalled();
  });
  it("accepts bounded SSE tool responses through the real SDK parser", async () => {
    const { fetchImpl } = transport(ENDPOINT, undefined, (message) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [], structuredContent: search } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    expect((await performWebSearch({ query: "Hound MCP" }, searchOptions(fetchImpl))).outcome.code).toBe("ok");
  });
  it("propagates abort and closes a blocked transport", async () => {
    const controller = new AbortController();
    const closed = vi.spyOn(Client.prototype, "close");
    const { fetchImpl } = transport(ENDPOINT, undefined, async (_message, init) => {
      controller.abort();
      init.signal.throwIfAborted();
    });
    const result = await performWebSearch({ query: "Hound MCP" }, searchOptions(fetchImpl, { signal: controller.signal }));
    expect(result.outcome.code).toBe("aborted"); expect(closed).toHaveBeenCalled();
  });
  it("probes tools/list only, asserting both pinned tool names, with endpoint gating", async () => {
    const { fetchImpl, calls } = transport(ENDPOINT);
    expect(await inspectHoundWeb({ endpoint: ENDPOINT, sandbox, fetchImpl })).toEqual({ ok: true, reason: "tools_advertised" });
    expect(calls).toHaveLength(0);
    const denied = vi.fn();
    expect(await inspectHoundWeb({ endpoint: ENDPOINT, sandbox: { networkAllowsUrl: () => false }, fetchImpl: denied })).toEqual({ ok: false, reason: "network_denied" });
    expect(denied).not.toHaveBeenCalled();
  });
  it("reports tools_missing when a pinned tool is absent (no version assumption)", async () => {
    const { fetchImpl } = transport(ENDPOINT);
    const listTools = Client.prototype.listTools;
    vi.spyOn(Client.prototype, "listTools").mockImplementation(async function (...args) {
      const result = await listTools.apply(this, args);
      return { ...result, tools: result.tools.filter((tool) => tool.name !== "mcp_smart_fetch") };
    });
    expect(await inspectHoundWeb({ endpoint: ENDPOINT, sandbox, fetchImpl })).toEqual({ ok: false, reason: "tools_missing" });
  });
});

describe("Hound WebFetch", () => {
  it("sends HTTP-only arguments at the exact schema locations", async () => {
    const { fetchImpl, calls } = transport(ENDPOINT, { structuredContent: fetchDoc });
    const result = await performWebFetch({ url: target, format: "text" }, fetchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ status: "ok", code: "ok", backend: "hound", extractionStage: "hound-http" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "mcp_smart_fetch",
      arguments: {
        url: target,
        extraction_type: "text",
        max_content_chars: 200000,
        timeout: 25000,
        cache_ttl: 0,
        force_fetcher: "http",
        options: { respect_robots: true, include_links: true },
      },
    });
    const payload = JSON.parse(result.text);
    expect(payload).toMatchObject({ tool: "WebFetch", status: "ok" });
    expect(payload.content).toContain("HTTP-only extraction evidence");
    expect(payload.summary).toContain("Hound remote HTTP-only extraction");
  });
  it.each([{ format: "raw" }, { headers: { Accept: "text/plain" } }, { render: "auto" }, { render: "always" }])("rejects unsupported options before network: %j", async (params) => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target, ...params }, fetchOptions(fetchImpl));
    expect(result.outcome.code).toBe("unsupported_parameter"); expect(result.text).toContain(Object.keys(params)[0]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([target, ENDPOINT])("gates both target and endpoint: %s", async (denied) => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target }, { ctx: { sandbox: { ...sandbox, networkAllowsUrl: (_p, url) => url !== denied } }, fetchImpl, fetchConfig: { provider: "hound", hound: { endpoint: ENDPOINT } } });
    expect(result.outcome.code).toBe("network_denied"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires the endpoint before invocation", async () => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl, fetchConfig: { provider: "hound" } });
    expect(result.outcome.code).toBe("invalid_fetch_config"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("normalizes remote links as bounded untrusted evidence", async () => {
    const { fetchImpl } = transport(ENDPOINT, { structuredContent: fetchDoc });
    const result = await performWebFetch({ url: target, include_links: true }, fetchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ status: "ok", backend: "hound" });
    expect(result.document.links).toEqual([
      { url: "https://docs.example.com/hound/endpoint", text: "endpoint setup", provenance: "main-content" },
      { url: "https://example.com/outside", text: "outside", provenance: "page" },
      { url: "https://docs.example.com/", text: "docs home", provenance: "page" },
    ]);
    expect(JSON.parse(result.text).summary).toContain("3 page links listed.");
  });
  it("marks remote truncation honestly without auto-fetching the remainder", async () => {
    const { fetchImpl } = transport(ENDPOINT, { structuredContent: { ...fetchDoc, is_truncated: true, total_extracted_chars: 5000 } });
    const result = await performWebFetch({ url: target }, fetchOptions(fetchImpl));
    expect(result.outcome).toMatchObject({ status: "ok", backend: "hound", remoteTruncated: true });
    expect(result.text).toContain("Remote source truncated after 5000 extracted characters");
    expect(result.text).not.toContain("narrower focus");
  });
  it.each([
    ["stealth tier", { ...fetchDoc, fetcher_used: "stealthy", escalation_path: "http→stealthy" }, "unsupported_fetch_tier"],
    ["archive snapshot", { ...fetchDoc, source: "archive.org", archived_at: "2026-01-01" }, "non_live_source"],
    ["missing provenance", { ...fetchDoc, source: undefined }, "non_live_source"],
  ])("fails closed on %s instead of presenting the evidence", async (_label, data, code) => {
    const { fetchImpl } = transport(ENDPOINT, { structuredContent: data });
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl, fetchConfig: { provider: ["hound", "local"], hound: { endpoint: ENDPOINT } }, retryDelaysMs: [] });
    expect(result.outcome).toMatchObject({ code, backend: "hound", attemptedProviders: ["hound"] });
    expect(fetchImpl.mock.calls.some(([url]) => String(url) === target)).toBe(false);
  });
  it("treats a robots refusal as terminal, never falling back to local", async () => {
    const { fetchImpl } = transport(ENDPOINT, { structuredContent: { ...fetchDoc, status: 403, error: "robots_txt_disallowed" } });
    const seen = [];
    const routed = vi.fn((url, init) => { seen.push(String(url)); return fetchImpl(url, init); });
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl: routed, fetchConfig: { provider: ["hound", "local"], hound: { endpoint: ENDPOINT } }, retryDelaysMs: [] });
    expect(result.outcome).toMatchObject({ code: "robots_denied", backend: "hound", attemptedProviders: ["hound"] });
    expect(seen).not.toContain(target);
  });
  it("advances from unusable remote content to local in an explicit chain", async () => {
    const remote = transport(ENDPOINT, { structuredContent: { ...fetchDoc, content_ok: false } });
    const fetchImpl = vi.fn((url, init) => String(url) === ENDPOINT ? remote.fetchImpl(url, init) : Promise.resolve(new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } })));
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl, retryDelaysMs: [], fetchConfig: { provider: ["hound", "local"], hound: { endpoint: ENDPOINT } } });
    expect(result.outcome).toMatchObject({ code: "http_503", attemptedProviders: ["hound", "local"], fallbackUsed: true });
  });
  it("advances from remote HTTP errors to local in an explicit chain", async () => {
    const remote = transport(ENDPOINT, { structuredContent: { ...fetchDoc, status: 404, error: "not found" } });
    const fetchImpl = vi.fn((url, init) => String(url) === ENDPOINT ? remote.fetchImpl(url, init) : Promise.resolve(new Response("# Local evidence", { headers: { "content-type": "text/markdown" } })));
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl, retryDelaysMs: [], fetchConfig: { provider: ["hound", "local"], hound: { endpoint: ENDPOINT } } });
    expect(result.outcome).toMatchObject({ status: "ok", backend: "http", attemptedProviders: ["hound", "local"], fallbackUsed: true });
  });
  it("refuses to present a final URL the policy denies (post-hoc gate)", async () => {
    const denied = "https://denied.example/elsewhere";
    const gated = { ...sandbox, networkAllowsUrl: (_p, url) => url === ENDPOINT || url === target };
    const { fetchImpl } = transport(ENDPOINT, { structuredContent: { ...fetchDoc, url: denied } });
    const result = await performWebFetch({ url: target }, { ctx: { sandbox: gated }, fetchImpl, fetchConfig: { provider: "hound", hound: { endpoint: ENDPOINT } } });
    expect(result.outcome.code).toBe("network_denied"); expect(fetchImpl).toHaveBeenCalled();
  });
  it("uses local for incompatible options, even when Hound is first", async () => {
    const fetchImpl = vi.fn(async () => new Response("raw evidence", { headers: { "content-type": "text/plain" } }));
    const result = await performWebFetch({ url: target, format: "raw" }, { ctx, fetchImpl, fetchConfig: { provider: ["hound", "local"], hound: { endpoint: ENDPOINT } } });
    expect(result.outcome).toMatchObject({ status: "ok", backend: "http", attemptedProviders: ["local"] });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(target);
  });
  it("serves include_links through Hound when Parallel would refuse it", async () => {
    const { fetchImpl, calls } = transport(ENDPOINT, { structuredContent: fetchDoc });
    const result = await performWebFetch({ url: target, include_links: true }, { ctx, fetchImpl, fetchConfig: { provider: ["parallel", "hound"], hound: { endpoint: ENDPOINT } } });
    expect(result.outcome).toMatchObject({ status: "ok", backend: "hound", attemptedProviders: ["hound"] });
    expect(calls[0].arguments.options).toMatchObject({ respect_robots: true, include_links: true });
  });
  it("shares the controller across search and fetch without Hound sessions", async () => {
    const { fetchImpl, calls } = transport(ENDPOINT, (params) => ({ structuredContent: params.name === "mcp_smart_search" ? search : fetchDoc }));
    const controller = createWebToolController({ ctx: { sandbox }, fetchImpl, searchConfig: { backend: "hound", hound: { endpoint: ENDPOINT } }, fetchConfig: { provider: "hound", hound: { endpoint: ENDPOINT } } });
    await controller.search({ query: "Hound MCP" });
    await controller.fetch({ url: target });
    expect(calls.map((call) => call.name)).toEqual(["mcp_smart_search", "mcp_smart_fetch"]);
    await controller.close();
  });
  it("enforces the fetch transport ceiling", async () => {
    const { fetchImpl } = transport(ENDPOINT, undefined, () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }));
    const result = await performWebFetch({ url: target }, fetchOptions(fetchImpl));
    expect(result.outcome.code).toBe("response_too_large");
  });
  it("completes search and fetch over a real loopback MCP fixture server (no Hound process)", async () => {
    const seen = [];
    const makeServer = () => {
      const server = new Server({ name: "hound-fixture", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: HOUND_SEARCH_TOOL, inputSchema: { type: "object" } },
        { name: HOUND_FETCH_TOOL, inputSchema: { type: "object" } },
      ] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        seen.push(request.params);
        return request.params.name === HOUND_SEARCH_TOOL
          ? { content: [], structuredContent: search }
          : { content: [], structuredContent: fetchDoc };
      });
      return server;
    };
    // Each adapter call opens a fresh MCP connection, so the fixture keeps one
    // stateful transport per session, like the SDK server example.
    const sessions = new Map();
    const http = createServer((req, res) => {
      void (async () => {
        try {
          if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
          const sessionId = req.headers["mcp-session-id"];
          const entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
          if (entry) {
            await entry.transport.handleRequest(req, res);
            return;
          }
          const server = makeServer();
          const serverTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { sessions.set(id, { server, transport: serverTransport }); },
          });
          await server.connect(serverTransport);
          await serverTransport.handleRequest(req, res);
        } catch {
          try { res.writeHead(500).end(); } catch { /* already closed */ }
        }
      })();
    });
    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${String(http.address().port)}/mcp`;
    try {
      // Real sockets and the real global fetch; only the server side is canned.
      const result = await performWebSearch({ query: "Hound MCP" }, { ctx, searchConfig: { backend: "hound", hound: { endpoint } } });
      expect(result.outcome).toMatchObject({ status: "ok", backend: "hound", requestsThisCall: 1 });
      const fetched = await performWebFetch({ url: target }, { ctx, fetchConfig: { provider: "hound", hound: { endpoint } } });
      expect(fetched.outcome).toMatchObject({ status: "ok", backend: "hound" });
      expect(seen.map((call) => call.name)).toEqual([HOUND_SEARCH_TOOL, HOUND_FETCH_TOOL]);
      expect(seen[1]).toMatchObject({ arguments: { force_fetcher: "http", max_content_chars: 200000, options: { respect_robots: true, include_links: true } } });
    } finally {
      for (const { server, transport } of sessions.values()) {
        await server.close().catch(() => {});
        await transport.close().catch(() => {});
      }
      await new Promise((resolve) => http.close(resolve));
    }
  });
});

describe("Hound restricted host policies", () => {
  const nativeSandbox = createFakeSandbox();
  const nativeCtx = (network) => ({ sandbox: nativeSandbox, sandboxPolicy: testSandboxPolicy({ root: "/repo", network }), runId: "native-run" });
  // The loopback endpoint passes every per-URL gate below; only the fanout
  // check may refuse. A recording fetch proves no MCP bytes were dispatched.
  function recordingTransport(result) {
    const seen = [];
    const remote = transport(ENDPOINT, result ?? { structuredContent: search });
    const fetchImpl = vi.fn(async (url, init) => {
      seen.push(String(url));
      expect(String(url)).toBe(ENDPOINT);
      return remote.fetchImpl(url, init);
    });
    return { fetchImpl, seen, calls: remote.calls };
  }
  it.each([
    ["none", { mode: "none", allowlist: [] }],
    ["localhost", { mode: "localhost", allowlist: [] }],
    ["allowlist without the endpoint", { mode: "allowlist", allowlist: ["docs.example.com"] }],
  ])("refuses strict search under %s policy before quota and dispatch", async (_label, network) => {
    const { fetchImpl, seen } = recordingTransport();
    const state = createWebSearchRunState({});
    const result = await performWebSearch({ query: "Hound MCP" }, { ...searchOptions(fetchImpl), ctx: nativeCtx(network), searchState: state });
    expect(result.outcome).toMatchObject({ code: "network_denied", requestsThisCall: 0, dispatchesUsed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    expect(state.requestsUsed).toBe(0);
  });
  it("refuses search even when the endpoint itself is allowlisted (no escape via fanout)", async () => {
    const { fetchImpl, seen } = recordingTransport();
    const network = { mode: "allowlist", allowlist: ["127.0.0.1"] };
    const result = await performWebSearch({ query: "Hound MCP" }, { ...searchOptions(fetchImpl), ctx: nativeCtx(network) });
    expect(result.outcome).toMatchObject({ code: "network_denied", requestsThisCall: 0, dispatchesUsed: 0 });
    expect(seen).toHaveLength(0);
  });
  it("never falls back to Hound through a chain under a restricted policy", async () => {
    const remote = transport(ENDPOINT);
    const seen = [];
    const fetchImpl = vi.fn(async (url, init) => {
      seen.push(String(url));
      if (String(url) === ENDPOINT) return remote.fetchImpl(url, init);
      return new Response("no", { status: 500, headers: { "content-type": "text/plain" } });
    });
    const network = { mode: "localhost", allowlist: [] };
    const result = await performWebSearch({ query: "Hound MCP" }, {
      ctx: nativeCtx(network), fetchImpl, searchConfig: { backend: ["duckduckgo", "hound"], hound: { endpoint: ENDPOINT } },
    });
    expect(result.outcome.code).toBe("network_denied");
    expect(result.outcome.requestsThisCall).toBe(0);
    expect(seen).not.toContain(ENDPOINT);
  });
  it("refuses strict fetch under a localhost policy even for a loopback target", async () => {
    const loopback = "http://127.0.0.1:8080/page";
    const { fetchImpl, seen } = recordingTransport();
    const result = await performWebFetch({ url: loopback }, {
      ctx: nativeCtx({ mode: "localhost", allowlist: [] }), fetchImpl,
      fetchConfig: { provider: "hound", hound: { endpoint: ENDPOINT } },
    });
    expect(result.outcome).toMatchObject({ code: "network_denied", backend: "hound" });
    expect(seen).toHaveLength(0);
  });
  it("never falls back to Hound fetch through a chain under a restricted policy", async () => {
    const remote = transport(ENDPOINT);
    const seen = [];
    const shell = '<html><body><div id="root">Loading</div><script src="/one.js"></script><script src="/two.js"></script><script>window.__NEXT_DATA__={}</script></body></html>';
    const fetchImpl = vi.fn(async (url, init) => {
      seen.push(String(url));
      if (String(url) === ENDPOINT) return remote.fetchImpl(url, init);
      return new Response(shell, { headers: { "content-type": "text/html" } });
    });
    const result = await performWebFetch({ url: "http://127.0.0.1:8080/app" }, {
      ctx: nativeCtx({ mode: "localhost", allowlist: [] }), fetchImpl, retryDelaysMs: [],
      fetchConfig: { provider: ["local", "hound"], hound: { endpoint: ENDPOINT } },
    });
    expect(result.outcome).toMatchObject({ code: "network_denied", backend: "hound", attemptedProviders: ["local", "hound"] });
    expect(seen).not.toContain(ENDPOINT);
  });
  it("permits Hound under an explicit all-egress policy", async () => {
    const byTool = (params) => ({ structuredContent: params.name === HOUND_SEARCH_TOOL ? search : fetchDoc });
    const { fetchImpl, seen } = recordingTransport(byTool);
    const network = { mode: "all", allowlist: [] };
    const searchResult = await performWebSearch({ query: "Hound MCP" }, { ...searchOptions(fetchImpl), ctx: nativeCtx(network) });
    expect(searchResult.outcome).toMatchObject({ status: "ok", backend: "hound" });
    const fetchResult = await performWebFetch({ url: target }, {
      ctx: nativeCtx(network), fetchImpl, fetchConfig: { provider: "hound", hound: { endpoint: ENDPOINT } },
    });
    expect(fetchResult.outcome).toMatchObject({ status: "ok", backend: "hound" });
    expect(seen.length).toBeGreaterThan(0);
  });
  it("classifies policy representations for remote fanout without ambiguity", () => {
    expect(houndRemoteAllowedByPolicy(undefined)).toBe(true);
    expect(houndRemoteAllowedByPolicy({ mode: "off" })).toBe(true);
    expect(houndRemoteAllowedByPolicy({ mode: "off", network: { mode: "none", allowlist: [] } })).toBe(true);
    expect(houndRemoteAllowedByPolicy({ mode: "native", network: { mode: "all", allowlist: [] } })).toBe(true);
    for (const policy of [
      { mode: "native", network: { mode: "none", allowlist: [] } },
      { mode: "native", network: { mode: "localhost", allowlist: [] } },
      { mode: "native", network: { mode: "allowlist", allowlist: ["example.com"] } },
      { mode: "native", network: { mode: "allowlist", allowlist: ["127.0.0.1"] } },
      { mode: "native", network: { mode: "unexpected" } },
      { mode: "native" },
      {},
    ]) {
      expect(houndRemoteAllowedByPolicy(policy)).toBe(false);
    }
  });
});

describe("Hound endpoint strictness", () => {
  it.each([
    "https://127.0.0.1:8765/mcp",
    "http://example.com/mcp",
    "http://127.0.0.1:8765/mcp?token=abc",
    "http://127.0.0.1:8765/mcp#fragment",
    "http://user@127.0.0.1:8765/mcp",
    "http://127.0.0.1:8765/other",
    "http://127.0.0.1:8765",
  ])("refuses readiness for %s without connecting", async (endpoint) => {
    const fetchImpl = vi.fn();
    expect(await inspectHoundWeb({ endpoint, sandbox, fetchImpl })).toEqual({ ok: false, reason: "invalid_hound_config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    "https://127.0.0.1:8765/mcp",
    "http://example.com/mcp",
    "http://127.0.0.1:8765/mcp#fragment",
    "http://127.0.0.1:8765/other",
  ])("refuses fetch for %s before invocation", async (endpoint) => {
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url: target }, { ctx, fetchImpl, fetchConfig: { provider: "hound", hound: { endpoint } } });
    expect(result.outcome.code).toBe("invalid_fetch_config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Hound controller acquisition and views", () => {
  function houndController(fetchImpl, resultFn = () => ({ structuredContent: fetchDoc })) {
    const remote = transport(ENDPOINT, resultFn);
    const routed = vi.fn((url, init) => remote.fetchImpl(url, init));
    const controller = createWebToolController({
      ctx: { sandbox }, fetchImpl: fetchImpl ?? routed,
      searchConfig: { backend: "hound", hound: { endpoint: ENDPOINT } },
      fetchConfig: { provider: "hound", hound: { endpoint: ENDPOINT } },
    });
    return { controller, calls: remote.calls, fetchImpl: fetchImpl ?? routed };
  }
  it("serves links on a later view from the first acquisition (false then true)", async () => {
    const { controller, calls } = houndController();
    const plain = await controller.fetch({ url: target });
    expect(JSON.parse(plain.text).summary).not.toContain("page links listed");
    const linked = await controller.fetch({ url: target, include_links: true });
    expect(JSON.parse(linked.text).summary).toContain("3 page links listed.");
    expect(calls).toHaveLength(1);
    await controller.close();
  });
  it("applies late focus and a larger budget over the cached acquisition", async () => {
    const { controller, calls } = houndController();
    await controller.fetch({ url: target, max_output_chars: 40 });
    const focused = await controller.fetch({ url: target, focus: "Hound", max_output_chars: 200000 });
    // A focus-filtered subset is honestly partial; the full acquisition warmed
    // the cache once and both views shared it.
    expect(JSON.parse(focused.text)).toMatchObject({ tool: "WebFetch", status: "partial" });
    expect(JSON.parse(focused.text).content).toContain("Hound");
    expect(calls).toHaveLength(1);
    await controller.close();
  });
  it("reports honest no-match when focus misses a remotely truncated prefix", async () => {
    const { controller } = houndController(undefined, () => ({ structuredContent: { ...fetchDoc, is_truncated: true, total_extracted_chars: 5000 } }));
    const result = await controller.fetch({ url: target, focus: "nomatchstring" });
    expect(JSON.parse(result.text)).toMatchObject({ tool: "WebFetch", status: "partial", code: "focus_no_match" });
    expect(result.text).toContain("Remote source truncated after 5000 extracted characters");
    await controller.close();
  });
});
