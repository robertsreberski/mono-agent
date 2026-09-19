// @ts-check
import { callHoundMcp, houndFailure, houndRemoteAllowedByPolicy, houndStructuredContent, validateHoundEndpoint, HOUND_FETCH_CONTENT_CHARS, HOUND_FETCH_TOOL } from "./hound-mcp.js";
import { guardedSearch, collapseWhitespace } from "./web-search-providers/shared.js";
import { assertNoWebAccessInterstitial } from "./web-access-interstitial.js";
import { markdownToText, MAX_WEB_FETCH_LINKS, MAX_WEB_FETCH_LINK_TEXT_CHARS } from "./web-document-extractor.js";

export const HOUND_FETCH_TIMEOUT_MS = 25_000;

/**
 * HTTP-only Hound fetch parameters rejected before any invocation. Hound has
 * no raw-byte mode, accepts no caller headers, and never renders locally, so
 * those requests fail here instead of reaching the remote server. Remote
 * include_links IS supported and normalized below as untrusted evidence.
 * Mono focus stays a local post-extraction view and is never forwarded.
 */
export function unsupportedHoundFetchOption(params) {
  if (params.format === "raw") return "format:raw";
  if (params.headers != null && Object.keys(params.headers).length) return "headers";
  if (["auto", "always"].includes(params.render)) return `render:${params.render}`;
  return undefined;
}

export async function fetchHoundDocument(url, params, options) {
  const started = Date.now();
  const endpoint = options.endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    return { ok: false, backend: "hound", code: "invalid_hound_config", message: "Hound endpoint is not configured.", retryable: false };
  }
  // The loopback endpoint and target gates below are not sufficient: the
  // server fetches and follows redirects internally. A restricted host policy
  // fails here, before coordinator admission and before any MCP dispatch.
  if (!houndRemoteAllowedByPolicy(options.policy)) {
    return { ok: false, backend: "hound", code: "network_denied", message: "Network access denied by sandbox policy.", retryable: false };
  }
  if (![url.href, endpoint].every((target) => options.sandbox.networkAllowsUrl(options.policy, target))) {
    return { ok: false, backend: "hound", code: "network_denied", message: "Network access denied by sandbox policy.", retryable: false };
  }
  try {
    return await guardedSearch("hound", endpoint, { ...options, admission: { processPolicy: "endpoint" } }, async () => {
      try {
        const response = await callHoundMcp(endpoint, HOUND_FETCH_TOOL, houndFetchArgs(url, params), options);
        return normalizeHoundFetchResponse(response, url, params, options, started);
      } catch (error) { return houndFailure(error, options.signal); }
    });
  } catch (error) { return houndFailure(error, options.signal); }
}

function houndFetchArgs(url, params) {
  return {
    url: url.href,
    extraction_type: params.format === "text" ? "text" : "markdown",
    // Acquisition always spans the full finite document ceiling, independent
    // of the viewer's output budget: the controller strips max_output_chars
    // (and focus, links, slices) from the acquisition key, so a narrow first
    // view must never shrink what later views, focus filters, and the shared
    // cache can see. The fixed ceiling keeps transport bytes bounded.
    max_content_chars: HOUND_FETCH_CONTENT_CHARS,
    // Inside the host call bound: the MCP call timeout aborts first, so the
    // server reports its own timeout instead of surfacing a transport abort.
    timeout: HOUND_FETCH_TIMEOUT_MS,
    // Fresh extraction every time: never serve the server's shared SQLite cache,
    // whose entries outlive the host run and carry other callers' windows.
    cache_ttl: 0,
    // Pin the HTTP tier at the schema location the dispatcher promotes. This
    // requests HTTP-only behavior; it cannot govern server internals, which is
    // why the response provenance is validated before presentation below.
    force_fetcher: "http",
    options: {
      // Server default is False (and bypassable server-side); always request it.
      respect_robots: true,
      // Remote links are always acquired bounded and normalized below; the
      // presentation layer decides whether the caller asked to see them.
      include_links: true,
    },
  };
}

function normalizeHoundFetchResponse(response, url, params, options, started) {
  const data = houndStructuredContent(response);
  if (!data || typeof data !== "object" || !Array.isArray(data.content)
    || data.content.some((part) => typeof part !== "string")) {
    throw new Error("Malformed Hound extraction response.");
  }
  // A robots refusal arrives as HTTP 403 with a dedicated error marker. Check
  // it before generic status mapping so the policy signal stays distinct and
  // terminal instead of masquerading as a retryable upstream error.
  if (typeof data.error === "string" && data.error.includes("robots_txt_disallowed")) {
    return { ok: false, backend: "hound", code: "robots_denied", message: "Hound refused the URL per robots.txt.", retryable: false };
  }
  if (typeof data.status === "number" && (data.status < 200 || data.status >= 400)) {
    const status = data.status;
    return {
      ok: false, backend: "hound", code: `http_${status}`, statusCode: status,
      message: `Hound extraction HTTP ${status}.`, retryable: status === 429 || status >= 500,
      ...(status === 429 ? { rateLimited: true, retryAfterMs: 60_000 } : {}),
    };
  }
  // Fail before presentation when the provenance required by this subset is
  // incompatible or missing. This refuses to present the evidence; it cannot
  // undo server work that already happened, and is never described as
  // preventing it.
  if (data.fetcher_used !== "http") {
    return { ok: false, backend: "hound", code: "unsupported_fetch_tier", message: "Hound did not use the HTTP-only tier.", retryable: false };
  }
  if (data.source !== "live") {
    return { ok: false, backend: "hound", code: "non_live_source", message: "Hound did not return live source content.", retryable: false };
  }
  if (typeof data.error === "string" && data.error.trim()) {
    throw new Error("Hound extraction failed.");
  }
  if (data.content_ok === false) {
    return { ok: false, backend: "hound", code: "unusable_content", message: "Hound returned no usable page content.", retryable: false };
  }
  // Server chunks are contiguous slices of one text; rejoin without separators.
  const markdown = data.content.join("");
  if (!markdown.trim()) throw new Error("Hound returned no readable content.");
  let finalUrl = url.href;
  if (typeof data.url === "string" && data.url) {
    try {
      const parsed = new URL(data.url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("Hound returned an unsupported final URL.");
      }
      finalUrl = parsed.href;
    } catch {
      throw new Error("Hound returned an invalid final URL.");
    }
  }
  // Post-hoc policy gate on presentation only: the fetch already happened
  // server-side. Refusing here keeps policy-denied origins out of evidence.
  if (!options.sandbox.networkAllowsUrl(options.policy, finalUrl)) {
    return { ok: false, backend: "hound", code: "network_denied", message: "Network access denied by sandbox policy.", retryable: false };
  }
  assertNoWebAccessInterstitial({ url: finalUrl, text: markdown });
  const body = params.format === "text" ? markdownToText(markdown) : markdown;
  const remoteTruncated = data.is_truncated === true;
  const totalExtracted = Number.isSafeInteger(data.total_extracted_chars) ? data.total_extracted_chars : markdown.length;
  // Links are always acquired bounded and normalized; formatWebFetchDocument
  // decides whether the caller's view includes them.
  const links = normalizeHoundLinks(data.links, finalUrl);
  const metadataParts = ["Hound remote HTTP-only extraction; provider-supplied content."];
  if (remoteTruncated) {
    // Truthful cut marker with no recovery promise: content past the remote
    // cut was never acquired, so focus filters and continuations operate on
    // this prefix only — including honest no-match.
    metadataParts.push(`Remote source truncated after ${totalExtracted} extracted characters; only the first ${markdown.length} are shown.`);
  }
  const outcome = {
    status: "ok", code: "ok", backend: "hound", retryable: false, attempts: 1,
    cacheHit: false, durationMs: Date.now() - started, bytes: Buffer.byteLength(body, "utf8"),
    truncated: false, rendered: false, extractionStage: "hound-http",
    remoteTruncated, totalExtractedChars: totalExtracted,
  };
  return {
    ok: true,
    document: {
      body, finalUrl,
      ...(links === undefined ? {} : { links }),
      metadata: metadataParts.join(" "),
      outcome,
    },
  };
}

/**
 * Flatten Hound's classified link envelope to the local {url, text,
 * provenance} shape as untrusted evidence: citations first, then external,
 * then navigation, deduplicated and capped at the local link budget. Only
 * http(s) URLs without credentials survive.
 */
function normalizeHoundLinks(links, finalUrl) {
  if (!links || typeof links !== "object") return undefined;
  const groups = [
    ...(Array.isArray(links.citations) ? links.citations.map((entry) => ({ entry, provenance: "main-content" })) : []),
    ...(Array.isArray(links.external) ? links.external.map((entry) => ({ entry, provenance: "page" })) : []),
    ...(Array.isArray(links.navigation) ? links.navigation.map((entry) => ({ entry, provenance: "page" })) : []),
  ];
  const seen = new Set();
  const normalized = [];
  for (const { entry, provenance } of groups) {
    if (normalized.length >= MAX_WEB_FETCH_LINKS) break;
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string") continue;
    let href;
    try {
      const parsed = new URL(entry.url, finalUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      href = parsed.href;
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    normalized.push({
      url: href,
      text: collapseWhitespace(entry.text).slice(0, MAX_WEB_FETCH_LINK_TEXT_CHARS),
      provenance,
    });
  }
  return normalized;
}
