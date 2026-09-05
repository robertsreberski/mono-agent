import { withWebDeadline, coordinatedWebRequest, webRequestFailure } from "./web-request.js";
// @ts-check

import { passthroughSandbox } from "../sandbox-seam.js";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";
import { renderWithAgentBrowser } from "./web-browser-render.js";
import { contentKind, decodeWebBytes, extractWebDocument, markdownToText, shouldAutoRender } from "./web-document-extractor.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_DECODED_BYTES = 20 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 5_000;
const DEFAULT_FETCH_RETRY_DELAYS_MS = [1_000, 2_000];
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "range",
  "user-agent",
]);
const TRANSIENT_STATUS = new Set([408, 425, 429]);

class WebFetchError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?: boolean, statusCode?: number, retryAfterMs?: number}} [options]
   */
  constructor(code, message, { retryable = false, statusCode, retryAfterMs } = {}) {
    super(message);
    this.name = "WebFetchError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Compatibility wrapper for direct callers.
 *
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number, format?: string, render?: string, start_line?: number, max_lines?: number}} params
 * @param {{documentOnly?: boolean, coordinator?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, signal?: AbortSignal, retryDelaysMs?: number[], fetchConfig?: any, fetchImpl?: typeof fetch, browserRenderer?: typeof renderWithAgentBrowser, namespace?: string, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} [options]
 */
export async function webFetchToolImpl(params, options = {}) {
  return (await performWebFetch(params, options)).text;
}

/**
 * Fetch and locally extract one public URL.
 *
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number, format?: string, render?: string, start_line?: number, max_lines?: number}} params
 * @param {{documentOnly?: boolean, coordinator?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, signal?: AbortSignal, retryDelaysMs?: number[], fetchConfig?: any, fetchImpl?: typeof fetch, browserRenderer?: typeof renderWithAgentBrowser, namespace?: string, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} [options]
 */
export async function performWebFetch(params, options = {}) {
  const started = Date.now();
  try {
    return await withWebDeadline(options.signal, 45_000, async (signal) => {
      const result = await performFetch(params, { ...options, signal });
      if (signal.aborted && !result.error) return failure("Error: WebFetch was aborted or exceeded its deadline.", signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted", started);
      return result;
    });
  } catch (error) {
    const normalized = webRequestFailure(error, "http", options.signal);
    return failure(`Error: ${normalized.message}`, normalized.code, started, { retryAfterMs: normalized.retryAfterMs });
  }
}

/**
 * Fetch and locally extract one public URL.
 *
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number, format?: string, render?: string, start_line?: number, max_lines?: number}} params
 * @param {{documentOnly?: boolean, coordinator?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, signal?: AbortSignal, retryDelaysMs?: number[], fetchConfig?: any, fetchImpl?: typeof fetch, browserRenderer?: typeof renderWithAgentBrowser, namespace?: string, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} [options]
 */
async function performFetch(
  {
    url,
    headers = {},
    max_output_chars,
    format = "markdown",
    render,
    start_line, max_lines,
  },
  {
    coordinator,
    documentOnly = false,
    sandboxPolicy,
    sandboxEngine,
    ctx,
    signal,
    retryDelaysMs = DEFAULT_FETCH_RETRY_DELAYS_MS,
    fetchConfig,
    fetchImpl = globalThis.fetch,
    browserRenderer = renderWithAgentBrowser,
    namespace,
    registerCleanup,
  } = {},
) {
  const startedAt = Date.now();
  if ((start_line !== undefined && (!Number.isSafeInteger(start_line) || start_line < 1))
    || (max_lines !== undefined && (!Number.isSafeInteger(max_lines) || max_lines < 1 || max_lines > 10_000))) {
    return failure("Error: start_line must be positive; max_lines must be between 1 and 10000.", "invalid_range", startedAt);
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    return failure("Error: Invalid URL", "invalid_url", startedAt);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return failure("Error: WebFetch only supports http(s) URLs.", "unsupported_protocol", startedAt);
  }
  if (parsed.username || parsed.password) {
    return failure("Error: WebFetch URL credentials are not allowed.", "url_credentials_rejected", startedAt);
  }
  const requestHeaders = normalizeRequestHeaders(headers);
  if (requestHeaders.error) {
    return failure(`Error: ${requestHeaders.error}`, "header_rejected", startedAt);
  }
  const outputFormat = ["markdown", "text", "raw"].includes(format) ? format : null;
  if (!outputFormat) {
    return failure("Error: WebFetch format must be markdown, text, or raw.", "invalid_format", startedAt);
  }
  const fetchSettings = normalizeFetchConfig(fetchConfig);
  if (fetchSettings.error) {
    return failure(`Error: ${fetchSettings.error}`, "invalid_fetch_config", startedAt);
  }
  if (render !== undefined && !["never", "auto", "always"].includes(render)) {
    return failure("Error: WebFetch render must be never, auto, or always.", "invalid_render_mode", startedAt);
  }
  // Config is the capability ceiling: the default `never` must make browser
  // rendering impossible, even when untrusted model input asks for `always`.
  const requestedRender = fetchSettings.render === "never"
    ? "never"
    : (render ?? "auto");
  if (outputFormat === "raw" && requestedRender !== "never") {
    return failure("Error: WebFetch format raw requires render=never.", "invalid_render_format", startedAt);
  }

  const maxChars = positiveInteger(max_output_chars, DEFAULT_MAX_TOOL_OUTPUT_CHARS);
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  if (requestedRender === "always") {
    if (!sandbox.networkAllowsUrl(policy, parsed.href)) {
      return failure("Error: Network access denied by sandbox policy.", "network_denied", startedAt, {
        backend: "agent-browser", browserRecommended: true, renderReason: "explicit",
      });
    }
    try {
      const renderedResult = await coordinatedWebRequest(coordinator, "fetch", parsed.origin, signal, async () => ({
        ok: true,
        rendered: await browserRenderer(parsed.href, {
          browserCommand: fetchSettings.browserCommand,
          namespace,
          sandboxPolicy: policy,
          sandboxEngine,
          ctx: resolvedCtx,
          signal,
          registerCleanup,
        }),
      }));
      const rendered = normalizeBrowserResult(renderedResult.rendered, parsed.href);
      const renderedBody = outputFormat === "text" ? markdownToText(rendered.text) : rendered.text;
      const document = {
        body: renderedBody,
        finalUrl: rendered.finalUrl,
        outcome: {
          status: "ok", code: "ok", retryable: false, attempts: 1,
          backend: "agent-browser", cacheHit: false, durationMs: Date.now() - startedAt,
          bytes: Buffer.byteLength(rendered.text, "utf8"), queueWaitMs: renderedResult.coordinationWaitMs,
          backendDurationMs: renderedResult.backendDurationMs, truncated: renderedBody.length > maxChars,
          redirectCount: 0, rendered: true, renderFailed: false, browserRecommended: false,
          renderReason: "explicit", contentKind: "html", extractionStage: "browser", parserFailureCount: 0,
          parserFailures: [],
        },
      };
      return documentOnly ? { text: "", error: false, outcome: document.outcome, document }
        : formatWebFetchDocument(document, { start_line, max_lines, max_output_chars: maxChars }, resolvedCtx);
    } catch (error) {
      const code = ["access_challenge", "authentication_required", "network_denied"].includes(error?.code)
        ? error.code : "browser_render_failed";
      return failure(`Error rendering URL: ${error?.message || String(error)}`, code, startedAt, {
        attempts: 1, backend: "agent-browser", rendered: false, renderFailed: true,
        browserRecommended: code === "browser_render_failed", renderReason: "explicit",
      });
    }
  }
  const delays = Array.isArray(retryDelaysMs)
    ? retryDelaysMs.slice(0, 2).map((value) => Math.max(0, Number(value) || 0))
    : [];
  let attempts = 0;
  let response;
  let finalUrl = parsed.href;
  let redirectCount = 0;
  let responseBytes = 0;
  let queueWaitMs = 0;
  let backendDurationMs = 0;
  let bytes;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    attempts += 1;
    try {
      const fetched = await fetchFollowingRedirects(parsed, {
        coordinator,
        headers: requestHeaders.headers,
        sandbox,
        policy,
        signal,
        fetchImpl,
      });
      queueWaitMs += fetched.queueWaitMs;
      backendDurationMs += fetched.backendDurationMs;
      response = fetched.response;
      finalUrl = fetched.url;
      redirectCount = fetched.redirects;
      if (isTransientResponse(response) && attempt < delays.length) {
        const delay = retryDelayForResponse(response, delays[attempt]);
        try { await response.body?.cancel(); } catch { /* best effort */ }
        await waitForRetry(delay, signal);
        continue;
      }
      bytes = fetched.bytes;
      responseBytes = bytes.byteLength;
      break;
    } catch (error) {
      if (signal?.aborted) {
        return failure("Error fetching URL: request aborted", signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted", startedAt, {
          attempts,
          retryable: false,
        });
      }
      const normalized = normalizeFetchError(error);
      if (normalized.retryable && attempt < delays.length) {
        response = undefined;
        bytes = undefined;
        try {
          await waitForRetry(delays[attempt], signal);
        } catch (retryError) {
          const retryFailure = normalizeFetchError(retryError);
          return failure(`Error fetching URL: ${retryFailure.message}`, retryFailure.code, startedAt, {
            attempts,
            retryable: false,
          });
        }
        continue;
      }
      const errorText = normalized.code === "network_denied"
        ? `Error: ${normalized.message}`
        : `Error fetching URL: ${normalized.message}`;
      return failure(errorText, normalized.code, startedAt, {
        attempts,
        retryable: normalized.retryable,
        statusCode: normalized.statusCode ?? response?.status,
        retryAfterMs: normalized.retryAfterMs, queueWaitMs, backendDurationMs,
        browserRecommended: requestedRender === "auto"
          && !["network_denied", "redirect_network_denied", "aborted", "deadline_exceeded"].includes(normalized.code),
      });
    }
  }

  if (!response || bytes === undefined) {
    return failure("Error fetching URL: request failed", "request_failed", startedAt, { attempts });
  }

  const contentType = response.headers.get("content-type") || "";
  const responseKind = contentKind(contentType, bytes);
  if (!response.ok) {
    const preview = responseKind === "binary"
      ? "(binary response body omitted)"
      : safeDecodePreview(bytes, contentType, responseKind);
    const errorText = [
      `HTTP ${response.status}`,
      `[BEGIN UNTRUSTED WEB ERROR BODY source=${JSON.stringify(finalUrl)}]`,
      preview,
      "[END UNTRUSTED WEB ERROR BODY]",
    ].join("\n");
    return failure(errorText, `http_${response.status}`, startedAt, {
      attempts,
      retryable: response.status === 429 || response.status >= 500,
      statusCode: response.status,
      bytes: responseBytes,
      backend: "http",
      redirectCount,
      browserRecommended: requestedRender === "auto" && [406, 415].includes(response.status),
    });
  }
  if (responseKind === "binary") {
    return failure("Error: WebFetch does not return unsupported binary content.", "unsupported_content_type", startedAt, {
      attempts,
      statusCode: response.status,
      bytes: responseBytes,
      backend: "http",
      redirectCount,
    });
  }

  let extracted;
  let decoding;
  try {
    decoding = decodeWebBytes(bytes, contentType, responseKind);
    extracted = await extractWebDocument(bytes, {
      contentType,
      format: outputFormat,
      url: finalUrl,
    });
  } catch (error) {
    return failure(`Error extracting URL: ${error?.message || String(error)}`, error?.code || "extraction_failed", startedAt, {
      attempts,
      statusCode: response.status,
      bytes: responseBytes,
      backend: "http",
      redirectCount,
      browserRecommended: requestedRender === "auto" && responseKind === "html",
      contentKind: responseKind,
      ...(decoding === undefined ? {} : {
        charset: decoding.charset,
        charsetSource: decoding.charsetSource,
        hadDecodingReplacement: decoding.hadDecodingReplacement,
      }),
      ...(Array.isArray(error?.parserFailures) ? { parserFailures: error.parserFailures.slice(0, 3) } : {}),
    });
  }

  const shouldRender = responseKind === "html"
    && (
      requestedRender === "always"
      || (requestedRender === "auto" && shouldAutoRender(extracted.readableText, decodedText(bytes, contentType, responseKind)))
    );
  let backend = "http";
  let renderFailed = false;
  if (shouldRender) {
    try {
      const renderedResult = await coordinatedWebRequest(coordinator, "fetch", new URL(finalUrl).origin, signal, async () => ({ ok: true, rendered: await browserRenderer(finalUrl, {
        browserCommand: fetchSettings.browserCommand,
        namespace,
        sandboxPolicy,
        sandboxEngine,
        ctx: resolvedCtx,
        signal,
        registerCleanup,
      }) }));
      queueWaitMs += renderedResult.coordinationWaitMs;
      backendDurationMs += renderedResult.backendDurationMs;
      const rendered = normalizeBrowserResult(renderedResult.rendered, finalUrl);
      signal?.throwIfAborted();
      extracted = {
        body: outputFormat === "text" ? markdownToText(rendered.text) : rendered.text,
        readableText: markdownToText(rendered.text),
        title: extracted.title,
        charset: extracted.charset,
        charsetSource: extracted.charsetSource,
        hadDecodingReplacement: extracted.hadDecodingReplacement,
        extractionStage: "browser",
        parserFailureCount: extracted.parserFailureCount,
        parserFailures: extracted.parserFailures,
      };
      finalUrl = rendered.finalUrl;
      backend = "agent-browser";
    } catch (error) {
      if (signal?.aborted) return failure("Error: WebFetch rendering was aborted.", "aborted", startedAt);
      if (requestedRender === "always" || error?.code === "coordination_unavailable") {
        const code = ["access_challenge", "authentication_required", "network_denied"].includes(error?.code)
          ? error.code : "browser_render_failed";
        return failure(`Error rendering URL: ${error?.message || String(error)}`, code, startedAt, {
          attempts,
          statusCode: response.status,
          bytes: responseBytes,
          backend: "agent-browser",
          redirectCount,
        });
      }
      renderFailed = true;
    }
  }

  if (responseKind === "html" && backend === "http" && shouldAutoRender(extracted.readableText, decodedText(bytes, contentType, responseKind))) {
    return failure("Error: Page contains an unusable loading shell; no readable evidence was retrieved.", "unusable_content", startedAt, { backend, rendered: false, renderFailed, browserRecommended: true });
  }
  const body = extracted.body || "(no readable content)";
  const document = { body, finalUrl,
    outcome: {
      status: "ok",
      code: renderFailed ? "ok_static_render_failed" : "ok",
      retryable: false,
      attempts,
      backend,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      bytes: responseBytes,
      queueWaitMs, backendDurationMs,
      truncated: body.length > maxChars,
      statusCode: response.status,
      redirectCount,
      rendered: backend === "agent-browser",
      renderFailed,
      browserRecommended: renderFailed,
      ...(backend === "agent-browser" ? { renderReason: "sparse_html" } : {}),
      contentKind: responseKind,
      charset: extracted.charset,
      charsetSource: extracted.charsetSource,
      hadDecodingReplacement: extracted.hadDecodingReplacement,
      extractionStage: extracted.extractionStage,
      parserFailureCount: extracted.parserFailureCount ?? 0,
      parserFailures: extracted.parserFailures ?? [],
    },
    };
  return documentOnly ? { text: "", error: false, outcome: document.outcome, document }
    : formatWebFetchDocument(document, { start_line, max_lines, max_output_chars: maxChars }, resolvedCtx);
}

function normalizeBrowserResult(value, requestedUrl) {
  if (typeof value === "string") return { text: value, finalUrl: requestedUrl };
  if (value && typeof value.text === "string" && typeof value.finalUrl === "string") return value;
  throw Object.assign(new Error("Browser renderer returned an invalid result."), { code: "browser_render_failed" });
}

async function fetchFollowingRedirects(initialUrl, options) {
  let current = new URL(initialUrl.href);
  let queueWaitMs = 0;
  let backendDurationMs = 0;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!options.sandbox.networkAllowsUrl(options.policy, current.href)) {
      throw new WebFetchError(
        hop === 0 ? "network_denied" : "redirect_network_denied",
        hop === 0
          ? "Network access denied by sandbox policy."
          : "Network access denied by sandbox policy (redirect).",
      );
    }
    const fetched = await coordinatedWebRequest(options.coordinator, "fetch", current.origin, options.signal, async () => {
      const response = await options.fetchImpl(current, {
        headers: options.headers, redirect: "manual", signal: requestSignal(options.signal),
      });
      const redirect = response.status >= 300 && response.status < 400 && response.headers.has("location");
      let bytes;
      if (redirect) { await response.body?.cancel(); bytes = new Uint8Array(); }
      else bytes = await readResponseBytes(response);
      return { response, bytes };
    }, ({ response }) => ({
      status: response.status === 429 ? "rate_limited" : response.status >= 500 ? "unavailable" : "ok",
      ...(response.status === 429 ? { retryAfterMs: retryAfterMilliseconds(response) } : {}),
    }));
    queueWaitMs += fetched.coordinationWaitMs;
    backendDurationMs += fetched.backendDurationMs;
    const { response, bytes } = fetched;
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, bytes, url: current.href, redirects: hop, queueWaitMs, backendDurationMs };
    }
    if (hop === MAX_REDIRECTS) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new WebFetchError("too_many_redirects", "Too many redirects.");
    }
    let next;
    try { next = new URL(location, current); } catch {
      throw new WebFetchError("invalid_redirect", "Invalid redirect URL.");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new WebFetchError("unsupported_redirect_protocol", "WebFetch only supports http(s) URLs.");
    }
    if (next.username || next.password) {
      throw new WebFetchError("redirect_credentials_rejected", "Redirect URL credentials are not allowed.");
    }
    try { await response.body?.cancel(); } catch { /* best effort */ }
    current = next;
  }
  throw new WebFetchError("too_many_redirects", "Too many redirects.");
}

async function readResponseBytes(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DECODED_BYTES) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new WebFetchError("response_too_large", `response exceeded ${MAX_DECODED_BYTES} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const array = new Uint8Array(await response.arrayBuffer());
    if (array.byteLength > MAX_DECODED_BYTES) {
      throw new WebFetchError("response_too_large", `response exceeded ${MAX_DECODED_BYTES} bytes`);
    }
    return array;
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_DECODED_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw new WebFetchError("response_too_large", `response exceeded ${MAX_DECODED_BYTES} bytes`);
    }
    chunks.push(Buffer.from(next.value));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function decodedText(bytes, contentType, kind) {
  return decodeWebBytes(bytes, contentType, kind).text;
}

function safeDecodePreview(bytes, contentType, kind) {
  try { return decodedText(bytes, contentType, kind).slice(0, 500); }
  catch { return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, 500); }
}

function normalizeRequestHeaders(headers) {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return { error: "WebFetch headers must be an object." };
  }
  const normalized = {
    Accept: "text/markdown,text/html,application/xhtml+xml,application/json,application/pdf,text/plain;q=0.9,*/*;q=0.5",
    "User-Agent": "mono-agent-web/1",
  };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.trim().toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower)) {
      return { error: `WebFetch header is not allowed: ${name}` };
    }
    if (typeof value !== "string" || /[\r\n]/u.test(value)) {
      return { error: `WebFetch header value is invalid: ${name}` };
    }
    const canonical = lower.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join("-");
    normalized[canonical] = value;
  }
  return { headers: normalized };
}

function normalizeFetchConfig(input) {
  const render = input?.render ?? "never";
  if (!["never", "auto"].includes(render)) {
    return { error: "Configured web fetch render mode must be never or auto." };
  }
  const browserCommand = input?.browserCommand ?? "agent-browser";
  if (
    typeof browserCommand !== "string"
    || browserCommand.trim().length === 0
    || /[\u0000-\u001f\u007f]/u.test(browserCommand)
  ) {
    return { error: "Web browser command must be a direct executable name or path." };
  }
  return { render, browserCommand: browserCommand.trim() };
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isTransientResponse(response) {
  return TRANSIENT_STATUS.has(response.status) || response.status >= 500;
}

function retryDelayForResponse(response, fallback) {
  const value = response.headers.get("retry-after");
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1_000));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return fallback;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}

function waitForRetry(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      signal?.removeEventListener?.("abort", onAbort);
      resolvePromise();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      rejectPromise(new WebFetchError("aborted", "request aborted"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function normalizeFetchError(error) {
  if (error instanceof WebFetchError) return error;
  const code = error?.code ?? error?.cause?.code;
  const timedOut = error?.name === "TimeoutError";
  const aborted = error?.name === "AbortError";
  const transient = timedOut
    || aborted
    || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(code);
  return new WebFetchError(
    timedOut ? "timeout" : (aborted ? "aborted" : (code || "request_failed")),
    error?.message || String(error),
    { retryable: transient, retryAfterMs: error?.retryAfterMs },
  );
}

function failure(text, code, startedAt, extra = {}) {
  return {
    text,
    outcome: {
      status: "error",
      code,
      retryable: false,
      attempts: 0,
      backend: "none",
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
      ...extra,
    },
    error: true,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function retryAfterMilliseconds(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export function formatWebFetchDocument(document, params, ctx) {
  if ((params.start_line !== undefined && (!Number.isSafeInteger(params.start_line) || params.start_line < 1))
    || (params.max_lines !== undefined && (!Number.isSafeInteger(params.max_lines) || params.max_lines < 1 || params.max_lines > 10000))) {
    return failure("Error: Invalid WebFetch line range.", "invalid_range", Date.now());
  }
  const { body, finalUrl } = document;
  const ranged = params.start_line !== undefined || params.max_lines !== undefined;
  const lines = body.split("\n");
  const start = params.start_line ?? 1;
  const count = params.max_lines ?? 200;
  const selected = ranged ? lines.slice(start - 1, start - 1 + count).join("\n") : body;
  const maxChars = positiveInteger(params.max_output_chars, DEFAULT_MAX_TOOL_OUTPUT_CHARS);
  const capped = capChars(selected, { label: "WebFetch", maxChars, ctx });
  const shownLines = capped === selected ? (selected ? selected.split("\n").length : 0)
    : Math.max(0, capped.slice(0, capped.lastIndexOf("[truncated WebFetch output:")).split("\n").length - 1);
  const end = Math.min(lines.length, start - 1 + shownLines);
  const continuation = end < lines.length ? Math.max(start, end + 1) : null;
  const continuationHint = continuation === start && capped !== selected
    ? `The next line exceeds the output budget. Increase max_output_chars or read the saved output artifact; repeating this range with the same budget cannot advance.`
    : `Continue with WebFetch url=${JSON.stringify(finalUrl)} start_line=${continuation} max_lines=${count}.`;
  return {
    text: [`[BEGIN UNTRUSTED WEB CONTENT source=${JSON.stringify(finalUrl)}]`,
      ...(ranged || continuation ? [`[Lines ${start}-${end} of ${lines.length}.]`] : []),
      capped,
      ...(continuation ? [`[${continuationHint}]`] : []),
      "[END UNTRUSTED WEB CONTENT]"].join("\n"),
    outcome: { ...document.outcome, truncated: selected.length > maxChars || end < lines.length,
      startLine: start, endLine: end, totalLines: lines.length, nextLine: continuation },
    error: false,
    document,
  };
}
