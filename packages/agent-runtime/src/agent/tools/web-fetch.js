import { fetchParallelDocument, unsupportedParallelFetchOption } from "./parallel-web-fetch.js";
import { localEndpointError } from "./local/config.js";
import { parallelSessionId } from "./parallel-mcp.js";
import { withWebDeadline, coordinatedWebRequest, webRequestFailure } from "./web-request.js";
// @ts-check

import { passthroughSandbox } from "../sandbox-seam.js";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./shared/constants.js";
import { writeToolArtifact } from "./shared/output-truncation.js";
import { requireToolContext, resolveSandboxPolicy } from "./shared/tool-context.js";
import { renderWithAgentBrowser } from "./web-browser-render.js";
import { contentKind, decodeWebBytes, extractHtmlLinks, extractWebDocument, markdownToText, shouldAutoRender } from "./web-document-extractor.js";
import { parseRetryAfter } from "./web-search-providers/shared.js";
import { assertNoWebAccessInterstitial, classifyWebAccessInterstitial } from "./web-access-interstitial.js";
import { applyFocusFilter, buildWebNextAction, formatActionableEnvelope, normalizeWebResearchOptions, webStatusForCode } from "./web-actionable.js";

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
const TRANSIENT_STATUS = new Set([408, 425]);

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
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number, format?: string, render?: string, start_line?: number, max_lines?: number, focus?: string, include_links?: boolean}} params
 * @param {{ctx: import("./shared/tool-context.js").ToolContext, documentOnly?: boolean, coordinator?: any, sandboxPolicy?: any, sandboxEngine?: any, signal?: AbortSignal, retryDelaysMs?: number[], fetchConfig?: any, fetchImpl?: typeof fetch, browserRenderer?: typeof renderWithAgentBrowser, namespace?: string, sessionId?: string, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} options
 */
export async function webFetchToolImpl(params, options) {
  return (await performWebFetch(params, options)).text;
}

/**
 * Fetch and locally extract one public URL.
 *
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number, format?: string, render?: string, start_line?: number, max_lines?: number, focus?: string, include_links?: boolean}} params
 * @param {{ctx: import("./shared/tool-context.js").ToolContext, documentOnly?: boolean, coordinator?: any, sandboxPolicy?: any, sandboxEngine?: any, signal?: AbortSignal, retryDelaysMs?: number[], fetchConfig?: any, fetchImpl?: typeof fetch, browserRenderer?: typeof renderWithAgentBrowser, namespace?: string, sessionId?: string, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} options
 */
export async function performWebFetch(params, options) {
  // Direct callers own their context: reject a missing one before any network work.
  const resolvedCtx = requireToolContext(options?.ctx);
  const resolvedOptions = { ...(options ?? {}), ctx: resolvedCtx };
  const started = Date.now();
  try {
    return await withWebDeadline(resolvedOptions.signal, 45_000, async (signal) => {
      const result = await performFetchChain(params, { ...resolvedOptions, signal });
      if (signal.aborted && !result.error) return failure("Error: WebFetch was aborted or exceeded its deadline.", signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted", started);
      return result;
    });
  } catch (error) {
    const normalized = webRequestFailure(error, "http", resolvedOptions.signal);
    return failure(`Error: ${normalized.message}`, normalized.code, started, { retryAfterMs: normalized.retryAfterMs });
  }
}

/**
 * Fetch and locally extract one public URL.
 *
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number, format?: string, render?: string, start_line?: number, max_lines?: number, focus?: string, include_links?: boolean}} params
 * @param {{documentOnly?: boolean, coordinator?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: import("./shared/tool-context.js").ToolContext, signal?: AbortSignal, retryDelaysMs?: number[], fetchConfig?: any, fetchImpl?: typeof fetch, browserRenderer?: typeof renderWithAgentBrowser, namespace?: string, sessionId?: string, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} [options]
 */
async function performFetch(
  {
    url,
    headers = {},
    max_output_chars,
    format: requestedFormat,
    render,
    start_line, max_lines,
    focus, include_links,
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
  const researchOptions = normalizeWebResearchOptions({ focus, include_links });
  if (researchOptions.error) {
    return failure(researchOptions.error.message, researchOptions.error.code, startedAt);
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
  const outputFormat = ["markdown", "text", "raw"].includes(requestedFormat ?? "markdown") ? (requestedFormat ?? "markdown") : null;
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
  const resolvedCtx = requireToolContext(ctx);
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
      assertNoWebAccessInterstitial({ url: rendered.finalUrl, text: rendered.text });
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
        : formatWebFetchDocument(document, { start_line, max_lines, max_output_chars: maxChars, format: requestedFormat, render, focus, include_links }, resolvedCtx);
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
      if (isTransientResponse(response, fetched.bytes, finalUrl) && attempt < delays.length) {
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
  let decodedForExtraction;
  if (responseKind !== "binary") {
    try {
      decodedForExtraction = decodeWebBytes(bytes, contentType, responseKind);
      assertNoWebAccessInterstitial({
        url: finalUrl,
        text: decodedForExtraction.text,
        statusCode: response.status,
      });
    } catch (error) {
      if (["access_challenge", "authentication_required"].includes(error?.code)) {
        return failure(`Error fetching URL: ${error.message}`, error.code, startedAt, {
          attempts,
          statusCode: response.status,
          bytes: responseBytes,
          backend: "http",
          redirectCount,
        });
      }
      // Unsupported encodings are still handled by the extraction path below,
      // where their decoding metadata and browser recommendation are retained.
      decodedForExtraction = undefined;
    }
  } else {
    try {
      assertNoWebAccessInterstitial({ url: finalUrl, statusCode: response.status });
    } catch (error) {
      return failure(`Error fetching URL: ${error.message}`, error.code, startedAt, {
        attempts,
        statusCode: response.status,
        bytes: responseBytes,
        backend: "http",
        redirectCount,
      });
    }
  }
  if (!response.ok) {
    const preview = responseKind === "binary"
      ? "(binary response body omitted)"
      : safeDecodePreview(bytes, contentType, responseKind);
    return failure(`HTTP ${response.status} for ${finalUrl}.`, `http_${response.status}`, startedAt, {
      attempts,
      retryable: response.status >= 500,
      ...(response.status === 429 ? { retryAfterMs: parseRetryAfter(response) } : {}),
      statusCode: response.status,
      bytes: responseBytes,
      backend: "http",
      redirectCount,
      browserRecommended: requestedRender === "auto" && [406, 415].includes(response.status),
      untrustedContent: preview,
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
    decoding = decodedForExtraction ?? decodeWebBytes(bytes, contentType, responseKind);
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

  try {
    assertNoWebAccessInterstitial({
      url: finalUrl,
      text: extracted.readableText,
      statusCode: response.status,
    });
  } catch (error) {
    return failure(`Error fetching URL: ${error.message}`, error.code, startedAt, {
      attempts,
      statusCode: response.status,
      bytes: responseBytes,
      backend: "http",
      redirectCount,
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
      assertNoWebAccessInterstitial({ url: rendered.finalUrl, text: rendered.text });
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
      const terminalCode = ["access_challenge", "authentication_required", "network_denied"].includes(error?.code)
        ? error.code : null;
      if (terminalCode || requestedRender === "always" || error?.code === "coordination_unavailable") {
        const code = terminalCode ?? "browser_render_failed";
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
  // Bounded citation/main-content links come from the already-downloaded static
  // HTML only: no extra request, same cache identity as the document. Rendered,
  // remote, raw, and non-HTML documents report the capability as unavailable
  // at format time instead of faking empty success.
  const links = responseKind === "html" && backend === "http" && decoding && outputFormat !== "raw"
    ? extractHtmlLinks(decoding.text, finalUrl)
    : undefined;
  const document = { body, finalUrl,
    ...(links === undefined ? {} : { links }),
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
    : formatWebFetchDocument(document, { start_line, max_lines, max_output_chars: maxChars, format: requestedFormat, render, focus, include_links }, resolvedCtx);
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

function isTransientResponse(response, bytes, url) {
  if (!TRANSIENT_STATUS.has(response.status) && response.status < 500) return false;
  // A 503 may be an access gate, not a transient service outage. Never retry
  // observed challenges even before the normal extraction/classification path.
  const contentType = response.headers.get("content-type") || "";
  let text = "";
  try { text = decodeWebBytes(bytes.subarray(0, 32 * 1024), contentType).text; } catch { /* normal decoding error follows */ }
  return !classifyWebAccessInterstitial({ url, text, statusCode: response.status });
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

function failure(summary, code, startedAt, extra = {}) {
  const { untrustedContent, ...telemetry } = extra;
  const status = webStatusForCode(code);
  const text = formatActionableEnvelope({
    tool: "WebFetch",
    status,
    code,
    summary,
    ...(untrustedContent === undefined ? {} : { content: untrustedContent, untrusted_fields: ["content"] }),
  });
  return {
    text,
    outcome: {
      status,
      code,
      retryable: false,
      attempts: 0,
      backend: "none",
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
      ...telemetry,
    },
    error: true,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function retryAfterMilliseconds(response) {
  return parseRetryAfter(response);
}

export function formatWebFetchDocument(document, params, ctx) {
  if ((params.start_line !== undefined && (!Number.isSafeInteger(params.start_line) || params.start_line < 1))
    || (params.max_lines !== undefined && (!Number.isSafeInteger(params.max_lines) || params.max_lines < 1 || params.max_lines > 10000))) {
    return failure("Error: Invalid WebFetch line range.", "invalid_range", Date.now());
  }
  const researchOptions = normalizeWebResearchOptions({ focus: params.focus, include_links: params.include_links });
  if (researchOptions.error) {
    return failure(researchOptions.error.message, researchOptions.error.code, Date.now());
  }
  const { body, finalUrl } = document;
  // Focus is a deterministic post-extraction view over the cached document:
  // filter first, then paginate the focused view so continuations stay in
  // focused coordinates while the focus string is preserved for the next call.
  const focusResult = researchOptions.focus ? applyFocusFilter(body, researchOptions.focus) : null;
  const focusedBody = focusResult ? focusResult.text : body;
  const focusNoMatch = focusResult !== null && focusResult.matchedBlocks === 0;
  const ranged = params.start_line !== undefined || params.max_lines !== undefined;
  const lines = focusNoMatch ? [] : focusedBody.split("\n");
  const totalLines = focusNoMatch ? 0 : (focusedBody ? lines.length : 0);
  const start = params.start_line ?? 1;
  const count = params.max_lines ?? 200;
  const selected = focusNoMatch ? "" : (ranged ? lines.slice(start - 1, start - 1 + count).join("\n") : focusedBody);
  const requestedBudget = Number(params.max_output_chars);
  const explicitBudget = Number.isFinite(requestedBudget) && requestedBudget > 0
    ? Math.floor(requestedBudget)
    : null;
  // Effective budget is always a plain JS character (UTF-16 code unit) count
  // on page content: the explicit caller cap, or the default tool-output cap.
  // Content carries only actual page characters; the truncation notice and any
  // saved-artifact path live in the summary, never as a marker in content.
  // The artifact is written at most once per call.
  const effectiveBudget = explicitBudget ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  let content;
  let truncationArtifact = null;
  if (focusNoMatch) {
    content = "";
  } else if (selected.length <= effectiveBudget) {
    content = selected;
  } else {
    content = selected.slice(0, effectiveBudget);
    truncationArtifact = writeToolArtifact("WebFetch", selected, ctx);
  }
  const contentTruncated = content !== selected;
  // Line coordinates derive from the actual shown page prefix: only complete
  // lines count, so a line cut mid-budget is resumed (not skipped) by the
  // continuation and never claimed as fully shown.
  const shownLines = focusNoMatch ? 0 : countCompleteLines(content, selected);
  const end = Math.min(lines.length, start - 1 + shownLines);
  const continuation = end < lines.length ? Math.max(start, end + 1) : null;
  const stalled = continuation !== null && continuation <= start && contentTruncated;
  const baseOutcome = document.outcome || {};
  // Any incomplete returned view classifies as partial, even when the
  // requested slice itself was satisfied: excerpts-only remote content, a
  // static fallback after render failure, a focus-filtered subset, lossy
  // character-budget capping, remaining lines beyond this page, or omitted
  // preceding lines when the view starts after line 1. A focus
  // with no matching blocks never pretends full success. Coverage (line
  // coordinates, truncation flag, focus block counts, link availability)
  // distinguishes the cause.
  const hasMoreLines = continuation !== null;
  const omittedPreceding = !focusNoMatch && ranged && start > 1 && totalLines > 0;
  const beyondEnd = !focusNoMatch && totalLines > 0 && start > totalLines;
  const truncatedView = selected.length > effectiveBudget || end < lines.length || omittedPreceding;
  const partialView = baseOutcome.excerptsOnly === true
    || baseOutcome.code === "ok_static_render_failed"
    || (focusResult !== null && focusResult.matchedBlocks < focusResult.totalBlocks)
    || contentTruncated
    || hasMoreLines
    || omittedPreceding;
  const status = partialView ? "partial" : (baseOutcome.status || "ok");
  const code = focusNoMatch ? "focus_no_match" : (baseOutcome.code || "ok");
  const summaryParts = [beyondEnd
    ? `Fetched ${finalUrl} (no lines shown; start_line ${start} is beyond the total ${totalLines} lines).`
    : `Fetched ${finalUrl} (lines ${totalLines === 0 ? 0 : start}-${end} of ${totalLines}).`];
  if (document.metadata) summaryParts.push(String(document.metadata));
  if (baseOutcome.excerptsOnly === true) summaryParts.push("Provider returned excerpts only; full content is unavailable.");
  if (baseOutcome.code === "ok_static_render_failed") summaryParts.push("Browser rendering failed; returning the static extraction.");
  if (focusResult !== null) {
    summaryParts.push(focusNoMatch
      ? `Focus ${JSON.stringify(researchOptions.focus)} matched 0 of ${focusResult.totalBlocks} blocks; no content shown.`
      : `Focus ${JSON.stringify(researchOptions.focus)} matched ${focusResult.matchedBlocks} of ${focusResult.totalBlocks} blocks.`);
  }
  const artifactTail = truncationArtifact
    ? `Full slice saved to: ${truncationArtifact.path}`
    : "Increase max_output_chars for the full slice.";
  if (stalled) {
    summaryParts.push(`The next line exceeds the output budget; repeating this range with the same budget cannot advance. ${artifactTail}`);
  } else if (contentTruncated) {
    summaryParts.push(`Output truncated to the character budget (showing ${content.length} of ${selected.length} characters). ${artifactTail}`);
  }
  if (continuation !== null && continuation > start) {
    summaryParts.push(`More lines remain after line ${end}; continue with start_line ${continuation}.`);
  }
  if (!focusNoMatch && contentTruncated
    && continuation !== null && continuation > start
    && content.length < selected.length && selected[content.length] !== "\n") {
    summaryParts.push(`Line ${continuation} is only partially shown; continue with start_line ${continuation} to reread it from its start.`);
  }
  // Bounded citation/main-content links reuse the static HTML extraction.
  // Any other source reports the missing capability explicitly.
  let links;
  let linksCoverage;
  if (researchOptions.includeLinks) {
    if (Array.isArray(document.links)) {
      links = document.links;
      linksCoverage = { available: true, count: links.length };
      summaryParts.push(links.length === 1 ? "1 page link listed." : `${links.length} page links listed.`);
    } else {
      linksCoverage = { available: false, reason: linksUnavailableReason(baseOutcome) };
      summaryParts.push(`Page links are unavailable (${linksCoverage.reason}).`);
    }
  }
  const next_actions = [];
  if (focusNoMatch) {
    const retry = buildWebNextAction("WebFetch",
      {
        url: finalUrl,
        ...(params.format !== undefined ? { format: params.format } : {}),
        ...(params.render !== undefined ? { render: params.render } : {}),
        ...(researchOptions.includeLinks ? { include_links: true } : {}),
      },
      "Re-read the page without focus; no blocks matched the focus string.");
    if (retry) next_actions.push(retry);
  } else if (continuation !== null && continuation > start) {
    const advance = buildWebNextAction("WebFetch",
      {
        url: finalUrl,
        start_line: continuation,
        max_lines: count,
        ...(params.format !== undefined ? { format: params.format } : {}),
        ...(params.render !== undefined ? { render: params.render } : {}),
        ...(researchOptions.focus !== undefined ? { focus: researchOptions.focus } : {}),
        ...(researchOptions.includeLinks ? { include_links: true } : {}),
      },
      `Read the next lines of this page (line ${continuation} on).`);
    if (advance) next_actions.push(advance);
  }
  const untrusted_fields = [
    ...(focusNoMatch ? [] : ["content"]),
    ...(links === undefined ? [] : ["links"]),
  ];
  const text = formatActionableEnvelope({
    tool: "WebFetch",
    status,
    code,
    summary: summaryParts.join(" "),
    source: { url: finalUrl },
    coverage: {
      startLine: start,
      endLine: end,
      totalLines,
      nextLine: continuation,
      truncated: truncatedView,
      ...(focusResult === null ? {} : {
        focus: {
          query: researchOptions.focus,
          matchedBlocks: focusResult.matchedBlocks,
          totalBlocks: focusResult.totalBlocks,
        },
      }),
      ...(linksCoverage === undefined ? {} : { links: linksCoverage }),
      ...(document.metadata ? { note: String(document.metadata) } : {}),
    },
    ...(focusNoMatch ? {} : { content }),
    ...(links === undefined ? {} : { links }),
    ...(untrusted_fields.length > 0 ? { untrusted_fields } : {}),
    ...(next_actions.length > 0 ? { next_actions } : {}),
  });
  return {
    text,
    outcome: { ...baseOutcome, status, code, truncated: truncatedView,
      startLine: start, endLine: end, totalLines, nextLine: continuation,
      bytes: Buffer.byteLength(text, "utf8"),
      ...(focusResult === null ? {} : {
        focusApplied: true,
        focusQuery: researchOptions.focus,
        focusMatchedBlocks: focusResult.matchedBlocks,
        focusTotalBlocks: focusResult.totalBlocks,
      }),
      ...(linksCoverage === undefined ? {} : { linksAvailable: linksCoverage.available }),
      ...(next_actions.length > 0 ? { next_actions } : {}),
    },
    error: false,
    document,
  };
}

/**
 * Count the lines of `whole` fully contained in `prefix`. A line counts only
 * when its complete text lies within the prefix, so a line cut mid-budget is
 * excluded and the continuation resumes at it instead of skipping it.
 *
 * @param {string} prefix
 * @param {string} whole
 */
function countCompleteLines(prefix, whole) {
  if (!prefix) return 0;
  if (prefix.length >= whole.length) return whole.split("\n").length;
  const parts = whole.split("\n");
  let pos = 0;
  let count = 0;
  for (const part of parts) {
    if (pos + part.length <= prefix.length) {
      count += 1;
      pos += part.length + 1;
    } else break;
  }
  return count;
}

function linksUnavailableReason(outcome) {
  if (outcome?.backend === "parallel") return "remote extraction does not provide page links";
  if (outcome?.rendered === true) return "browser rendering skips static link extraction";
  if (outcome?.extractionStage === "raw") return "raw format skips HTML link extraction";
  const kind = typeof outcome?.contentKind === "string" && outcome.contentKind ? outcome.contentKind : "this";
  return `links are only extracted from static HTML, not ${kind} content`;
}


async function performFetchChain(params, options) {
  const started = Date.now();
  const migration = localEndpointError(options.fetchConfig?.hound);
  if (migration) return failure(migration, "invalid_fetch_config", started);
  const selection = options.fetchConfig?.provider ?? "local";
  const names = Array.isArray(selection) ? selection : [selection];
  if (names.some((name) => name === "hound")) {
    return failure("Error: `tools.web.fetch.provider` value `hound` was renamed to `local`, which is not equivalent: `local` uses the standard fetch retry policy, performs no robots preflight, and honors the configured render mode instead of forcing document-only/render-never. Update the selection to `local` only if that posture is acceptable.", "invalid_fetch_config", started);
  }
  if (!names.length || new Set(names).size !== names.length || names.some((name) => !["local", "parallel"].includes(name))) {
    return failure("Error: Invalid WebFetch provider selection.", "invalid_fetch_config", started);
  }
  const parallelUnsupported = unsupportedParallelFetchOption(params);
  if (!names.includes("local") && names.every((name) => parallelUnsupported)) {
    return failure(`Error: Parallel WebFetch does not support ${parallelUnsupported}.`, "unsupported_parameter", started, { backend: "parallel", option: parallelUnsupported });
  }
  if (!names.includes("local") && options.fetchConfig?.render === "auto") {
    return failure('Error: fetch.render "auto" requires the local provider.', "invalid_fetch_config", started);
  }
  let result;
  const attemptedProviders = [];
  for (const name of names) {
    if (name === "parallel" && parallelUnsupported) continue;
    attemptedProviders.push(name);
    result = name === "local" ? await performFetch(params, options) : await performParallelFetch(params, options);
    if (!result.error || !fetchProviderMayAdvance(result.outcome)) break;
  }
  return { ...result, outcome: { ...result.outcome, attemptedProviders, fallbackUsed: attemptedProviders.length > 1 } };
}

// Never fall through validation, auth, sandbox, cancellation, coordination, or
// size/access/rate-limit failures. Only unusable content, ordinary HTTP errors,
// or retryable transport failures may disclose the same target to the next
// explicitly selected provider.
function fetchProviderMayAdvance(outcome) {
  return ["unusable_content", "backend_unavailable"].includes(outcome.code)
    || /^http_(?!401$|403$|407$|429$)\d{3}$/u.test(outcome.code)
    || (["request_failed", "timeout"].includes(outcome.code) && outcome.retryable);
}

async function performParallelFetch(params, options) {
  const started = Date.now();
  if ((params.start_line !== undefined && (!Number.isSafeInteger(params.start_line) || params.start_line < 1))
    || (params.max_lines !== undefined && (!Number.isSafeInteger(params.max_lines) || params.max_lines < 1 || params.max_lines > 10000))) {
    return failure("Error: Invalid WebFetch line range.", "invalid_range", started);
  }
  const researchOptions = normalizeWebResearchOptions({ focus: params.focus, include_links: params.include_links });
  if (researchOptions.error) {
    return failure(researchOptions.error.message, researchOptions.error.code, started);
  }
  let url;
  try { url = new URL(params.url); } catch { return failure("Error: Invalid URL", "invalid_url", started); }
  if (!["http:", "https:"].includes(url.protocol)) return failure("Error: WebFetch only supports http(s) URLs.", "unsupported_protocol", started);
  if (url.username || url.password) return failure("Error: WebFetch URL credentials are not allowed.", "url_credentials_rejected", started);
  if (params.format !== undefined && !["markdown", "text"].includes(params.format)) return failure("Error: Invalid WebFetch format.", "invalid_format", started);
  if (params.render !== undefined && params.render !== "never") return failure("Error: Invalid WebFetch render mode.", "invalid_render_mode", started);
  const ctx = requireToolContext(options.ctx);
  const sandbox = ctx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(ctx, options.sandboxPolicy);
  const result = await fetchParallelDocument(url, params, { ...options, config: options.fetchConfig?.parallel,
    ctx, sandbox, policy, sessionId: options.sessionId ?? parallelSessionId(ctx, ctx),
  });
  if (!result.ok) return failure(`Error: ${result.message}`, result.code, started, {
    backend: "parallel", retryable: result.retryable, statusCode: result.statusCode,
    retryAfterMs: result.retryAfterMs, rateLimited: result.rateLimited,
  });
  const document = result.document;
  document.outcome = { ...document.outcome, queueWaitMs: result.coordinationWaitMs, backendDurationMs: result.backendDurationMs };
  return options.documentOnly ? { text: "", error: false, document, outcome: document.outcome }
    : formatWebFetchDocument(document, params, ctx);
}
