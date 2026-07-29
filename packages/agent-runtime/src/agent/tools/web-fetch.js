// @ts-check

import { Readability } from "@mozilla/readability";
import { Defuddle as parseDefuddle } from "defuddle/node";
import { DOMParser, parseHTML } from "linkedom";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { passthroughSandbox } from "../sandbox-seam.js";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";
import { renderWithAgentBrowser } from "./web-browser-render.js";

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
   * @param {{retryable?: boolean, statusCode?: number}} [options]
   */
  constructor(code, message, { retryable = false, statusCode } = {}) {
    super(message);
    this.name = "WebFetchError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

/**
 * Compatibility wrapper for direct callers.
 *
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number, format?: string, render?: string}} params
 * @param {{sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, signal?: AbortSignal, retryDelaysMs?: number[], fetchConfig?: any, fetchImpl?: typeof fetch, browserRenderer?: typeof renderWithAgentBrowser, namespace?: string, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} [options]
 */
export async function webFetchToolImpl(params, options = {}) {
  return (await performWebFetch(params, options)).text;
}

/**
 * Fetch and locally extract one public URL.
 *
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number, format?: string, render?: string}} params
 * @param {{sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, signal?: AbortSignal, retryDelaysMs?: number[], fetchConfig?: any, fetchImpl?: typeof fetch, browserRenderer?: typeof renderWithAgentBrowser, namespace?: string, registerCleanup?: (cleanup: () => Promise<void>) => () => void}} [options]
 */
export async function performWebFetch(
  {
    url,
    headers = {},
    max_output_chars,
    format = "markdown",
    render,
  },
  {
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
  const delays = Array.isArray(retryDelaysMs)
    ? retryDelaysMs.slice(0, 2).map((value) => Math.max(0, Number(value) || 0))
    : [];
  let attempts = 0;
  let response;
  let finalUrl = parsed.href;
  let redirectCount = 0;
  let responseBytes = 0;
  let bytes;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    attempts += 1;
    try {
      const fetched = await fetchFollowingRedirects(parsed, {
        headers: requestHeaders.headers,
        sandbox,
        policy,
        signal,
        fetchImpl,
      });
      response = fetched.response;
      finalUrl = fetched.url;
      redirectCount = fetched.redirects;
      if (isTransientResponse(response) && attempt < delays.length) {
        const delay = retryDelayForResponse(response, delays[attempt]);
        try { await response.body?.cancel(); } catch { /* best effort */ }
        await waitForRetry(delay, signal);
        continue;
      }
      bytes = await readResponseBytes(response);
      responseBytes = bytes.byteLength;
      break;
    } catch (error) {
      if (signal?.aborted) {
        return failure("Error fetching URL: request aborted", "aborted", startedAt, {
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
      : decodeBytes(bytes, contentType).slice(0, 500);
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
  try {
    extracted = await extractResponse(bytes, {
      contentType,
      format: outputFormat,
      url: finalUrl,
    });
  } catch (error) {
    return failure(`Error extracting URL: ${error?.message || String(error)}`, "extraction_failed", startedAt, {
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
      || (requestedRender === "auto" && shouldAutoRender(extracted.readableText, decodeBytes(bytes, contentType)))
    );
  let backend = "http";
  let renderFailed = false;
  if (shouldRender) {
    try {
      const rendered = await browserRenderer(finalUrl, {
        browserCommand: fetchSettings.browserCommand,
        namespace,
        sandboxPolicy,
        sandboxEngine,
        ctx: resolvedCtx,
        signal,
        registerCleanup,
      });
      extracted = {
        body: outputFormat === "text" ? markdownToText(rendered) : rendered,
        readableText: markdownToText(rendered),
        title: extracted.title,
      };
      backend = "agent-browser";
    } catch (error) {
      if (requestedRender === "always") {
        return failure(`Error rendering URL: ${error?.message || String(error)}`, "browser_render_failed", startedAt, {
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

  const body = extracted.body || "(no readable content)";
  const capped = capChars(body, { label: "WebFetch", maxChars, ctx: resolvedCtx });
  const text = [
    `[BEGIN UNTRUSTED WEB CONTENT source=${JSON.stringify(finalUrl)}]`,
    capped,
    "[END UNTRUSTED WEB CONTENT]",
  ].join("\n");
  return {
    text,
    outcome: {
      status: "ok",
      code: renderFailed ? "ok_static_render_failed" : "ok",
      retryable: false,
      attempts,
      backend,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      bytes: responseBytes,
      truncated: body.length > maxChars,
      statusCode: response.status,
      redirectCount,
      rendered: backend === "agent-browser",
      renderFailed,
      contentKind: responseKind,
    },
    error: false,
  };
}

async function fetchFollowingRedirects(initialUrl, options) {
  let current = new URL(initialUrl.href);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!options.sandbox.networkAllowsUrl(options.policy, current.href)) {
      throw new WebFetchError(
        hop === 0 ? "network_denied" : "redirect_network_denied",
        hop === 0
          ? "Network access denied by sandbox policy."
          : "Network access denied by sandbox policy (redirect).",
      );
    }
    const response = await options.fetchImpl(current, {
      headers: options.headers,
      redirect: "manual",
      signal: requestSignal(options.signal),
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, url: current.href, redirects: hop };
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

async function extractResponse(bytes, { contentType, format, url }) {
  const kind = contentKind(contentType, bytes);
  const raw = decodeBytes(bytes, contentType);
  if (format === "raw") return { body: raw, readableText: raw, title: "" };
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(bytes);
    try {
      const extracted = await extractPdfText(pdf, { mergePages: true });
      const body = String(extracted.text || "").trim();
      return {
        body,
        readableText: body,
        title: "",
      };
    } finally {
      try { await /** @type {any} */ (pdf).destroy?.(); } catch { /* best effort */ }
    }
  }
  if (kind === "json") {
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      return { body: raw, readableText: raw, title: "" };
    }
    const pretty = JSON.stringify(parsed, null, 2);
    return {
      body: format === "markdown" ? `\`\`\`json\n${pretty}\n\`\`\`` : pretty,
      readableText: pretty,
      title: "",
    };
  }
  if (kind === "xml") {
    const body = extractXml(raw, format);
    return { body, readableText: markdownToText(body), title: "" };
  }
  if (kind === "html") {
    return extractHtml(raw, url, format);
  }
  return { body: raw.trim(), readableText: raw.trim(), title: "" };
}

async function extractHtml(html, url, format) {
  let title = "";
  let markdown = "";
  try {
    const { document } = parseHTML(html);
    const parsed = await parseDefuddle(/** @type {any} */ (document), url, {
      markdown: true,
      separateMarkdown: true,
      useAsync: false,
    });
    title = String(parsed.title || "").trim();
    markdown = String(parsed.contentMarkdown || parsed.content || "").trim();
  } catch { /* Readability fallback below */ }

  if (meaningfulCharacters(markdown) < 1) {
    try {
      const { document } = parseHTML(html);
      const article = new Readability(/** @type {any} */ (document)).parse();
      if (article) {
        title ||= String(article.title || "").trim();
        markdown = htmlToText(article.content || article.textContent || "");
      }
    } catch { /* final body-text fallback below */ }
  }

  if (meaningfulCharacters(markdown) < 1) {
    const { document } = parseHTML(html);
    title ||= collapseWhitespace(document.querySelector("title")?.textContent);
    markdown = collapseDocumentText(document.body?.textContent || "");
  }
  const readableText = markdownToText(markdown);
  if (format === "text") return { body: readableText, readableText, title };
  const body = title && !markdown.trimStart().startsWith(`# ${title}`)
    ? `# ${title}\n\n${markdown}`
    : markdown;
  return { body, readableText, title };
}

function extractXml(xml, format) {
  const document = new DOMParser().parseFromString(String(xml || ""), "text/xml");
  const entries = [...document.querySelectorAll("item, entry")].slice(0, 50);
  if (entries.length === 0) {
    return collapseDocumentText(document.documentElement?.textContent || xml);
  }
  const blocks = entries.map((entry) => {
    const title = collapseWhitespace(entry.querySelector("title")?.textContent) || "Untitled";
    const linkElement = entry.querySelector("link");
    const link = linkElement?.getAttribute("href") || collapseWhitespace(linkElement?.textContent);
    const description = collapseWhitespace(
      entry.querySelector("description, summary, content")?.textContent,
    );
    if (format === "text") return [title, link, description].filter(Boolean).join("\n");
    return [
      `## ${title}`,
      link ? `[${link}](${link})` : "",
      description,
    ].filter(Boolean).join("\n\n");
  });
  return blocks.join("\n\n");
}

function contentKind(contentType, bytes) {
  const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (mime === "application/pdf" || startsWithPdf(bytes)) return "pdf";
  if (mime.includes("json") || mime.endsWith("+json")) return "json";
  if (
    mime.includes("xml")
    || mime.includes("rss")
    || mime.includes("atom")
    || mime.endsWith("+xml")
  ) return "xml";
  if (mime.includes("html") || looksLikeHtml(bytes)) return "html";
  if (
    mime.startsWith("text/")
    || [
      "application/ecmascript",
      "application/graphql",
      "application/javascript",
      "application/rtf",
      "application/sql",
      "application/x-httpd-php",
      "application/x-yaml",
      "application/yaml",
    ].includes(mime)
  ) return "text";
  if (!mime && !looksBinary(bytes)) return "text";
  return "binary";
}

function startsWithPdf(bytes) {
  return Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-";
}

function looksLikeHtml(bytes) {
  return /^\s*(?:<!doctype html|<html|<head|<body)/iu.test(
    Buffer.from(bytes.subarray(0, 512)).toString("utf8"),
  );
}

function looksBinary(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 1_024));
  if (sample.byteLength === 0) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      controls += 1;
    }
  }
  return controls / sample.byteLength > 0.1;
}

function decodeBytes(bytes, contentType) {
  const match = String(contentType || "").match(/charset\s*=\s*["']?([^;"'\s]+)/iu);
  const charset = match?.[1] || "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
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

function shouldAutoRender(readableText, html) {
  if (meaningfulCharacters(readableText) >= 200) return false;
  const scriptCount = (html.match(/<script\b/giu) || []).length;
  const hasAppRoot = /<(?:div|main)[^>]+(?:id|class)=["'][^"']*(?:app|root|__next|nuxt|svelte)[^"']*["']/iu.test(html);
  const hasSpaAssets = /\b(?:webpack|__NEXT_DATA__|vite|hydration|data-reactroot)\b/iu.test(html);
  return scriptCount >= 2 && (hasAppRoot || hasSpaAssets);
}

function meaningfulCharacters(value) {
  return markdownToText(value).replace(/\s/gu, "").length;
}

function htmlToText(value) {
  try {
    const { document } = parseHTML(String(value || ""));
    return collapseDocumentText(document.body?.textContent || document.documentElement?.textContent || "");
  } catch {
    return collapseDocumentText(String(value || "").replace(/<[^>]+>/gu, " "));
  }
}

function markdownToText(value) {
  return collapseDocumentText(
    String(value || "")
      .replace(/```[\s\S]*?```/gu, (block) => block.replace(/^```[^\n]*\n?|```$/gu, ""))
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/^[#>*+-]+\s*/gmu, "")
      .replace(/[*_`~]/gu, ""),
  );
}

function collapseDocumentText(value) {
  return String(value || "")
    .replace(/\r/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
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
    { retryable: transient },
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
