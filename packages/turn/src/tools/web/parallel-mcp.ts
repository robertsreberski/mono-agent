// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseRetryAfter } from "./search-providers/shared.js";

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const sessions = new WeakMap();

/** Ephemeral run identity, shared by search/fetch; never part of cache keys. */
export function parallelSessionId(ctx: any, state: any): any {
  if (typeof ctx?.runId === "string" && ctx.runId) return `mono-${digest(ctx.runId)}`;
  if (!sessions.has(state)) sessions.set(state, `mono-${digest(randomUUID())}`);
  return sessions.get(state);
}
function digest(value: any) { return createHash("sha256").update(value).digest("hex"); }

function parallelCredential(config: any) {
  if (config?.apiKeyEnv === undefined) return undefined;
  const name = config.apiKeyEnv;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !process.env[name]?.trim()) {
    throw Object.assign(new Error("Parallel apiKeyEnv names a missing or invalid credential variable."), { code: "invalid_parallel_config" });
  }
  return process.env[name].trim();
}

/** Only a digest of the current credential may influence an in-memory key. */
export function parallelCacheIdentity(config: any): any {
  if (config?.apiKeyEnv === undefined) return config;
  const value = process.env[config.apiKeyEnv];
  return { apiKeyEnv: config.apiKeyEnv, credentialDigest: value ? digest(value.trim()) : "missing" };
}

/**
 * One bounded MCP connection per attempt, without OAuth or reconnect retries.
 * Every HTTP response is streamed through one cumulative decoded-byte ceiling.
 * Neither SDK messages nor provider bodies are copied into failure metadata.
 * @param {string | null} tool null means tools/list readiness, never a query.
 * @param {any} args
 * @param {{config?: any, sandbox: any, policy: any, signal?: AbortSignal, fetchImpl?: typeof fetch, maxBytes?: number}} options
 */
export async function callParallelMcp(tool: string | null, args: any, options: { config?: any; sandbox: any; policy: any; signal?: AbortSignal; fetchImpl?: typeof fetch; maxBytes?: number }): Promise<{ [x: string]: unknown; tools: { inputSchema: { [x: string]: unknown; type: "object"; properties?: Record<string, object> | undefined; required?: string[] | undefined }; name: string; description?: string | undefined; outputSchema?: { [x: string]: unknown; type: "object"; properties?: Record<string, object> | undefined; required?: string[] | undefined } | undefined; annotations?: { title?: string | undefined; readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined; idempotentHint?: boolean | undefined; openWorldHint?: boolean | undefined } | undefined; execution?: { taskSupport?: "optional" | "required" | "forbidden" | undefined } | undefined; _meta?: Record<string, unknown> | undefined; icons?: { src: string; mimeType?: string | undefined; sizes?: string[] | undefined; theme?: "light" | "dark" | undefined }[] | undefined; title?: string | undefined }[]; _meta?: { [x: string]: unknown; progressToken?: string | number | undefined; "io.modelcontextprotocol/related-task"?: { taskId: string } | undefined } | undefined; nextCursor?: string | undefined } | { [x: string]: unknown; content: ({ type: "text"; text: string; annotations?: { audience?: ("user" | "assistant")[] | undefined; priority?: number | undefined; lastModified?: string | undefined } | undefined; _meta?: Record<string, unknown> | undefined } | { type: "image"; data: string; mimeType: string; annotations?: { audience?: ("user" | "assistant")[] | undefined; priority?: number | undefined; lastModified?: string | undefined } | undefined; _meta?: Record<string, unknown> | undefined } | { type: "audio"; data: string; mimeType: string; annotations?: { audience?: ("user" | "assistant")[] | undefined; priority?: number | undefined; lastModified?: string | undefined } | undefined; _meta?: Record<string, unknown> | undefined } | { type: "resource"; resource: { uri: string; text: string; mimeType?: string | undefined; _meta?: Record<string, unknown> | undefined } | { uri: string; blob: string; mimeType?: string | undefined; _meta?: Record<string, unknown> | undefined }; annotations?: { audience?: ("user" | "assistant")[] | undefined; priority?: number | undefined; lastModified?: string | undefined } | undefined; _meta?: Record<string, unknown> | undefined } | { uri: string; name: string; type: "resource_link"; description?: string | undefined; mimeType?: string | undefined; size?: number | undefined; annotations?: { audience?: ("user" | "assistant")[] | undefined; priority?: number | undefined; lastModified?: string | undefined } | undefined; _meta?: { [x: string]: unknown } | undefined; icons?: { src: string; mimeType?: string | undefined; sizes?: string[] | undefined; theme?: "light" | "dark" | undefined }[] | undefined; title?: string | undefined })[]; _meta?: { [x: string]: unknown; progressToken?: string | number | undefined; "io.modelcontextprotocol/related-task"?: { taskId: string } | undefined } | undefined; structuredContent?: Record<string, unknown> | undefined; isError?: boolean | undefined } | { [x: string]: unknown; toolResult: unknown; _meta?: { [x: string]: unknown; progressToken?: string | number | undefined; "io.modelcontextprotocol/related-task"?: { taskId: string } | undefined } | undefined }> {
  if (!options.sandbox.networkAllowsUrl(options.policy, PARALLEL_MCP_URL)) {
    throw Object.assign(new Error("Network access denied by sandbox policy."), { code: "network_denied" });
  }
  const apiKey = parallelCredential(options.config);
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const ceiling = options.maxBytes ?? (tool === "web_fetch" ? 20 : 2) * 1024 * 1024;
  let bytes = 0;
  let transportError;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const boundedFetch = async (input: any, init: any = {}) => {
    signal.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    if (url !== PARALLEL_MCP_URL || !options.sandbox.networkAllowsUrl(options.policy, url)) {
      throw Object.assign(new Error("Network access denied by sandbox policy."), { code: "network_denied" });
    }
    const combined = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
    const response = await fetchImpl(input, { ...init, signal: combined, redirect: "error" });
    if (response.status === 429 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw Object.assign(new Error("Parallel transport refused the request."), {
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
      async pull(controller: ReadableStreamDefaultController<Uint8Array>) {
        try {
          combined.throwIfAborted();
          const next = await reader.read();
          if (finished) return; // SDK may cancel an empty 202 body during this read.
          combined.throwIfAborted();
          if (next.done) { finished = true; combined.removeEventListener("abort", cancel); controller.close(); return; }
          bytes += next.value.byteLength;
          if (bytes > ceiling) throw Object.assign(new Error("Parallel response exceeded its byte ceiling."), { code: "response_too_large" });
          controller.enqueue(next.value);
        } catch (error: any) {
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
  const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_MCP_URL), {
    fetch: boundedFetch,
    requestInit: { ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}), redirect: "error" },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: "mono-agent-web", version: "1.0.0" });
  // Auxiliary server-push GET streams are optional. Their SDK onerror events
  // must not abort an independent POST request. Request deadlines/signals bound
  // protocol failures; the byte limiter itself aborts on overflow.
  try {
    signal.throwIfAborted();
    await client.connect(transport as Parameters<typeof client.connect>[0], { signal, timeout: 15_000 });
    return tool === null ? await client.listTools({}, { signal, timeout: 15_000 })
      : await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 30_000, maxTotalTimeout: 30_000 });
  } catch (error: any) {
    throw transportError ?? error;
  } finally {
    abort.abort();
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

export function parallelFailure(error: any, signal?: any): { reason?: string; rateLimited?: boolean; retryAfterMs?: any; ok: boolean; backend: string; code: any; retryable: boolean; message: string } {
  const aborted = signal?.aborted;
  const rateLimited = !aborted && (error?.code === "rate_limited" || error?.code === 429 || /rate.?limit|too many requests|quota exceeded|\b429\b/iu.test(error?.message ?? ""));
  const code = aborted ? (signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted")
    : rateLimited ? "rate_limited"
      : ["network_denied", "invalid_parallel_config", "search_budget_exhausted", "response_too_large", "coordination_unavailable", "deadline_exceeded", "aborted", "access_challenge", "authentication_required", "unusable_content"].includes(error?.code) ? error.code : "backend_unavailable";
  return {
    ok: false, backend: "parallel", code, retryable: code === "backend_unavailable" || rateLimited,
    message: code === "network_denied" ? "Network access denied by sandbox policy." : `Parallel request failed (${code}).`,
    ...(rateLimited ? { rateLimited: true, retryAfterMs: error?.retryAfterMs ?? 60_000 } : {}),
    ...(error?.reason === "dispatch_ceiling" ? { reason: "dispatch_ceiling" } : {}),
  };
}

/** Use structuredContent preferentially; only a JSON text block is a fallback. */
export function parallelStructuredContent(response: any): any {
  if (response?.isError) {
    const text = response.content?.filter((entry: any) => entry.type === "text").map((entry: any) => entry.text).join(" ") ?? "";
    throw Object.assign(new Error(/rate.?limit|too many requests|quota exceeded|\b429\b/iu.test(text) ? "rate limited" : "Parallel tool failed."), { code: "backend_unavailable" });
  }
  let value = response?.structuredContent;
  if (value === undefined) {
    const text = response?.content?.find((entry: any) => entry.type === "text" && typeof entry.text === "string");
    try { value = JSON.parse(text?.text); } catch { /* rejected below */ }
  }
  if (!value || typeof value !== "object" || !Array.isArray(value.results)) throw new Error("Malformed Parallel response.");
  return value;
}

/** Bounded readiness only: initialize and tools/list, never a search query.
 * @param {{config?: any, sandbox: any, policy?: any, signal?: AbortSignal, fetchImpl?: typeof fetch}} options
 */
export async function inspectParallelWeb(options: { config?: any; sandbox: any; policy?: any; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<{ ok: boolean; reason: any }> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  try {
    const response = await callParallelMcp(null, {}, { ...options, policy: options.policy, signal });
    const names = new Set(Array.isArray(response.tools) ? response.tools.map((tool: any) => tool.name) : []);
    return names.has("web_search") && names.has("web_fetch")
      ? { ok: true, reason: "tools_advertised" } : { ok: false, reason: "tools_missing" };
  } catch (error: any) { return { ok: false, reason: parallelFailure(error, signal).code }; }
}
