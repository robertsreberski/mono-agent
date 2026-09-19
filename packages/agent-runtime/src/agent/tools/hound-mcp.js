// @ts-check
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseRetryAfter } from "./web-search-providers/shared.js";

/**
 * Bounded client for a user-managed Hound MCP endpoint (streamable HTTP).
 *
 * Pinned upstream compatibility: hound-mcp 12.4.1 at
 * dondai1234/master-fetch@86d1b1329c0eed6133f29e3effe6a40a29f9dcdc, whose
 * hand-written tools are `mcp_smart_search` and `mcp_smart_fetch`. Tool names
 * are asserted on every readiness probe; never assume them across versions.
 *
 * Trust boundary (explicit): the endpoint is operator-configured and trusted.
 * Per-call arguments request behavior and responses are validated, but neither
 * governs the remote server's internal redirects, retries, proxies, keys, or
 * downloads. Host policy gates the endpoint URL and the requested target URL;
 * it cannot gate hops the server follows internally.
 */
export const HOUND_SEARCH_TOOL = "mcp_smart_search";
export const HOUND_FETCH_TOOL = "mcp_smart_fetch";
export const HOUND_COMPATIBILITY = "hound-mcp 12.4.1 (dondai1234/master-fetch@86d1b13)";

const HOUND_CONNECT_TIMEOUT_MS = 15_000;
const HOUND_CALL_TIMEOUT_MS = 30_000;
const HOUND_SEARCH_MAX_BYTES = 2 * 1024 * 1024;
const HOUND_FETCH_MAX_BYTES = 4 * 1024 * 1024;
// A Hound fetch always acquires the full finite document ceiling; the view
// (line ranges, output budget, focus) applies locally afterwards. Bounding the
// acquisition keeps every cache entry, focus filter, and byte ceiling
// consistent no matter which view warms the cache first.
export const HOUND_FETCH_CONTENT_CHARS = 200_000;
const HOUND_LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * Strict endpoint validation, centralized for readiness, search, and fetch:
 * unauthenticated loopback HTTP with an explicit `/mcp` path. Anything else
 * (remote hosts, HTTPS, credentials, query, fragment, missing path) is
 * rejected before any connection. Returns the normalized endpoint or an
 * `{ error }` — never throws, so adapters can map it to their own codes.
 */
export function validateHoundEndpoint(input) {
  let parsed;
  try {
    parsed = new URL(input ?? "");
  } catch {
    return { error: "Hound endpoint must be a valid loopback HTTP MCP URL with an explicit /mcp path." };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (parsed.protocol !== "http:"
    || !HOUND_LOOPBACK_HOSTS.includes(host)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error: "Hound endpoint must be an unauthenticated loopback HTTP URL." };
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  if (!parsed.pathname.endsWith("/mcp")) {
    return { error: "Hound endpoint must include the explicit /mcp path." };
  }
  return { endpoint: parsed.href.replace(/\/+$/u, "") };
}

/**
 * Actual Hound search/fetch fans out server-side to arbitrary public engines
 * and follows redirects internally, so passing the loopback endpoint gate is
 * NOT sufficient. Only unrestricted host policies authorize that remote
 * fanout: an absent policy, sandbox `off`, or network mode `all`. Every other
 * representation — `none`, `localhost`, `allowlist`, unknown modes, malformed
 * shapes — fails closed, matching the canonical network gate's fail-closed
 * posture for restricted policies. Readiness probes contact only the
 * configured endpoint and are exempt; adapters enforce this before quota
 * claims, coordinator admission, and any MCP dispatch.
 */
export function houndRemoteAllowedByPolicy(policy) {
  try {
    if (policy == null || policy.mode === "off") return true;
    return policy.network?.mode === "all";
  } catch {
    return false;
  }
}

/**
 * One bounded MCP connection per attempt, without reconnect retries.
 * Every HTTP response is streamed through one cumulative decoded-byte ceiling.
 * Neither SDK messages nor provider bodies are copied into failure metadata.
 * @param {string | null} tool null means tools/list readiness, never a query.
 */
export async function callHoundMcp(endpoint, tool, args, options) {
  const validated = validateHoundEndpoint(endpoint);
  if (validated.error) {
    throw Object.assign(new Error(validated.error), { code: "invalid_hound_config" });
  }
  const target = validated.endpoint;
  if (!options.sandbox.networkAllowsUrl(options.policy, target)) {
    throw Object.assign(new Error("Network access denied by sandbox policy."), { code: "network_denied" });
  }
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const ceiling = tool === HOUND_FETCH_TOOL ? HOUND_FETCH_MAX_BYTES : HOUND_SEARCH_MAX_BYTES;
  let bytes = 0;
  let transportError;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const boundedFetch = async (input, init = {}) => {
    signal.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    if (url !== target || !options.sandbox.networkAllowsUrl(options.policy, url)) {
      throw Object.assign(new Error("Network access denied by sandbox policy."), { code: "network_denied" });
    }
    const combined = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
    const response = await fetchImpl(input, { ...init, signal: combined, redirect: "error" });
    if (response.status === 429 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw Object.assign(new Error("Hound transport refused the request."), {
        code: response.status === 429 ? "rate_limited" : "backend_unavailable",
        retryAfterMs: parseRetryAfter(response),
      });
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let finished = false;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    combined.addEventListener("abort", cancel, { once: true });
    const body = new ReadableStream({
      async pull(controller) {
        try {
          combined.throwIfAborted();
          const next = await reader.read();
          if (finished) return; // SDK may cancel an empty 202 body during this read.
          combined.throwIfAborted();
          if (next.done) { finished = true; combined.removeEventListener("abort", cancel); controller.close(); return; }
          bytes += next.value.byteLength;
          if (bytes > ceiling) throw Object.assign(new Error("Hound response exceeded its byte ceiling."), { code: "response_too_large" });
          controller.enqueue(next.value);
        } catch (error) {
          if (finished) return;
          finished = true;
          // An optional GET can fail mid-read without invalidating the POST.
          // Only connection-wide limits or caller cancellation abort both.
          if (error?.code === "response_too_large" || options.signal?.aborted) {
            transportError = error;
            abort.abort(error);
          }
          combined.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      async cancel() { finished = true; combined.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const transport = new StreamableHTTPClientTransport(new URL(target), {
    fetch: boundedFetch,
    requestInit: { redirect: "error" },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: "mono-agent-web", version: "1.0.0" });
  // Auxiliary server-push GET streams are optional. Their SDK onerror events
  // must not abort an independent POST request. Request deadlines/signals bound
  // protocol failures; the byte limiter itself aborts on overflow.
  try {
    signal.throwIfAborted();
    await client.connect(transport, { signal, timeout: HOUND_CONNECT_TIMEOUT_MS });
    return tool === null ? await client.listTools({}, { signal, timeout: HOUND_CONNECT_TIMEOUT_MS })
      : await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: HOUND_CALL_TIMEOUT_MS, maxTotalTimeout: HOUND_CALL_TIMEOUT_MS });
  } catch (error) {
    throw transportError ?? error;
  } finally {
    abort.abort();
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

export function houndFailure(error, signal) {
  const aborted = signal?.aborted;
  const rateLimited = !aborted && (error?.code === "rate_limited" || error?.code === 429 || /rate.?limit|too many requests|quota exceeded|\b429\b/iu.test(error?.message ?? ""));
  const code = aborted ? (signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted")
    : rateLimited ? "rate_limited"
      : ["network_denied", "invalid_hound_config", "search_budget_exhausted", "response_too_large", "coordination_unavailable", "deadline_exceeded", "aborted", "access_challenge", "authentication_required"].includes(error?.code) ? error.code : "backend_unavailable";
  return {
    ok: false, backend: "hound", code, retryable: code === "backend_unavailable" || rateLimited,
    message: code === "network_denied" ? "Network access denied by sandbox policy." : `Hound request failed (${code}).`,
    ...(rateLimited ? { rateLimited: true, retryAfterMs: error?.retryAfterMs ?? 60_000 } : {}),
    ...(error?.reason === "dispatch_ceiling" ? { reason: "dispatch_ceiling" } : {}),
  };
}

/**
 * Use structuredContent preferentially; only a JSON text block is a fallback.
 * Returns the raw structured value; shape validation belongs to the adapters.
 */
export function houndStructuredContent(response) {
  if (response?.isError) {
    const text = response.content?.filter((entry) => entry.type === "text").map((entry) => entry.text).join(" ") ?? "";
    throw Object.assign(new Error(/rate.?limit|too many requests|quota exceeded|\b429\b/iu.test(text) ? "rate limited" : "Hound tool failed."), { code: "backend_unavailable" });
  }
  let value = response?.structuredContent;
  if (value === undefined) {
    const text = response?.content?.find((entry) => entry.type === "text" && typeof entry.text === "string");
    try { value = JSON.parse(text?.text); } catch { /* rejected below */ }
  }
  if (!value || typeof value !== "object") throw new Error("Malformed Hound response.");
  return value;
}

/** Bounded readiness only: initialize and tools/list, never a search query.
 * @param {{endpoint: string, sandbox: any, policy?: any, signal?: AbortSignal, fetchImpl?: typeof fetch}} options
 */
export async function inspectHoundWeb(options) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  try {
    const response = await callHoundMcp(options.endpoint, null, {}, { ...options, policy: options.policy, signal });
    const names = new Set(Array.isArray(response.tools) ? response.tools.map((tool) => tool.name) : []);
    return names.has(HOUND_SEARCH_TOOL) && names.has(HOUND_FETCH_TOOL)
      ? { ok: true, reason: "tools_advertised" } : { ok: false, reason: "tools_missing" };
  } catch (error) { return { ok: false, reason: houndFailure(error, signal).code }; }
}
