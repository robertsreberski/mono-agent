// @ts-check

import { parseHTML } from "linkedom";
import { passthroughSandbox } from "../sandbox-seam.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";

const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const RRF_K = 60;
const TRACKING_PARAMETERS = new Set([
  "dclid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "msclkid",
  "ref_src",
  "s_cid",
  "vero_conv",
  "vero_id",
]);

/**
 * Compatibility wrapper for direct callers.
 *
 * @param {{query: string, limit?: number, alternate_queries?: string[], domains?: string[], exclude_domains?: string[], language?: string, time_range?: string}} params
 * @param {{sandboxPolicy?: any, ctx?: any, signal?: AbortSignal, searchConfig?: any, fetchImpl?: typeof fetch}} [options]
 */
export async function webSearchToolImpl(params, options = {}) {
  return (await performWebSearch(params, options)).text;
}

/**
 * Search through an operator-owned SearXNG endpoint and/or the keyless HTML
 * fallback chain. Returns a structured internal outcome for the Pi bridge.
 *
 * @param {{query: string, limit?: number, alternate_queries?: string[], domains?: string[], exclude_domains?: string[], language?: string, time_range?: string}} params
 * @param {{sandboxPolicy?: any, ctx?: any, signal?: AbortSignal, searchConfig?: any, fetchImpl?: typeof fetch}} [options]
 */
export async function performWebSearch(
  {
    query,
    limit = 5,
    alternate_queries = [],
    domains = [],
    exclude_domains = [],
    language,
    time_range,
  },
  {
    sandboxPolicy,
    ctx,
    signal,
    searchConfig,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const startedAt = Date.now();
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  if (!normalizedQuery) {
    return failure("Error: WebSearch query must not be empty.", "invalid_query", startedAt);
  }
  const max = clampInteger(limit, 1, 10, 5);
  const includeDomains = normalizeDomains(domains);
  const excludeDomains = normalizeDomains(exclude_domains);
  const config = normalizeSearchConfig(searchConfig);
  if (config.error) return failure(`Error: ${config.error}`, "invalid_search_config", startedAt);

  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const initialQueries = uniqueStrings([normalizedQuery, ...alternate_queries], 4);
  /** @type {Array<Array<{title: string, url: string, snippet: string, backend: string}>>} */
  const rankedLists = [];
  const providerFailures = [];
  const providersUsed = new Set();
  let attempts = 0;
  let anyProviderSucceeded = false;

  const runQuery = async (candidate) => {
    attempts += 1;
    return await searchOneQuery(
      queryWithDomains(candidate, includeDomains),
      {
        config,
        language,
        timeRange: time_range,
        sandbox,
        policy,
        signal,
        fetchImpl,
      },
    );
  };
  const recordResult = (result) => {
    if (result.ok) {
      anyProviderSucceeded = true;
      providersUsed.add(result.backend);
      rankedLists.push(filterByDomains(result.results, includeDomains, excludeDomains));
    } else {
      providerFailures.push(result);
    }
  };

  const initialResults = await Promise.all(initialQueries.map(runQuery));
  initialResults.forEach(recordResult);
  if (signal?.aborted) {
    return failure("Error: WebSearch was aborted.", "aborted", startedAt, {
      attempts,
      retryable: false,
    });
  }

  let merged = mergeRankedResults(rankedLists, max);
  if (merged.length < max && initialQueries.length < 4) {
    const relaxed = relaxedQuery(normalizedQuery);
    if (relaxed && !initialQueries.includes(relaxed)) {
      recordResult(await runQuery(relaxed));
      merged = mergeRankedResults(rankedLists, max);
    }
  }

  if (!anyProviderSucceeded) {
    const reason = providerFailures.map((entry) => entry.message).filter(Boolean).join("; ")
      || "No search backend was available.";
    const networkDenied = providerFailures.length > 0
      && providerFailures.every((entry) => entry.message === "Network access denied by sandbox policy.");
    return failure(networkDenied
      ? "Error: Network access denied by sandbox policy."
      : `Error: WebSearch failed: ${reason}`, networkDenied ? "network_denied" : "backend_unavailable", startedAt, {
      attempts,
      backend: config.backend,
      retryable: providerFailures.some((entry) => entry.retryable),
    });
  }

  const backend = providersUsed.size === 1 ? [...providersUsed][0] : "mixed";
  const body = merged.length === 0
    ? "No results."
    : merged.map((result, index) => {
        const snippet = result.snippet ? `\n   ${collapseWhitespace(result.snippet)}` : "";
        return `${index + 1}. [${escapeMarkdownLabel(result.title || result.url)}](${result.url})${snippet}`;
      }).join("\n\n");
  const text = [
    "[BEGIN UNTRUSTED WEB SEARCH RESULTS]",
    body,
    "[END UNTRUSTED WEB SEARCH RESULTS]",
  ].join("\n");
  return {
    text,
    outcome: {
      status: "ok",
      code: merged.length === 0 ? "no_results" : "ok",
      retryable: false,
      attempts,
      backend,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
      resultCount: merged.length,
      providerFailureCount: providerFailures.length,
    },
    error: false,
  };
}

async function searchOneQuery(query, options) {
  const { config } = options;
  const failures = [];
  if (options.signal?.aborted) return abortedSearch(config.backend);
  if (config.backend === "searxng" || (config.backend === "auto" && config.endpoint)) {
    const result = await searchSearxng(query, options);
    if (result.ok || config.backend === "searxng") return result;
    failures.push(result);
    if (options.signal?.aborted) return abortedSearch(result.backend);
  }
  if (config.backend === "keyless" || config.backend === "auto") {
    const duck = await searchDuckDuckGo(query, options);
    if (duck.ok && duck.results.length > 0) return duck;
    if (!duck.ok) failures.push(duck);
    if (options.signal?.aborted) return abortedSearch(duck.backend);
    const startpage = await searchStartpage(query, options);
    if (startpage.ok) return startpage;
    failures.push(startpage);
    if (duck.ok) return duck;
  }
  return failures[failures.length - 1] || {
    ok: false,
    backend: config.backend,
    message: "No configured search backend.",
    retryable: false,
  };
}

function abortedSearch(backend) {
  return {
    ok: false,
    backend,
    message: "WebSearch was aborted.",
    retryable: false,
  };
}

async function searchSearxng(query, options) {
  const endpoint = options.config.endpoint;
  if (!endpoint) {
    return { ok: false, backend: "searxng", message: "SearXNG endpoint is not configured.", retryable: false };
  }
  const url = `${endpoint}/search`;
  if (!options.sandbox.networkAllowsUrl(options.policy, url)) {
    return { ok: false, backend: "searxng", message: "Network access denied by sandbox policy.", retryable: false };
  }
  const body = new URLSearchParams({ q: query, format: "json", categories: "general" });
  if (typeof options.language === "string" && options.language.trim()) {
    body.set("language", options.language.trim());
  }
  if (["day", "month", "year"].includes(options.timeRange)) {
    body.set("time_range", options.timeRange);
  }
  try {
    const response = await options.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "mono-agent-web/1",
      },
      body,
      signal: requestSignal(options.signal),
      redirect: "error",
    });
    const text = await readLimitedText(response);
    if (!response.ok) {
      return {
        ok: false,
        backend: "searxng",
        message: `SearXNG HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    let data;
    try { data = JSON.parse(text); } catch {
      return { ok: false, backend: "searxng", message: "SearXNG returned invalid JSON.", retryable: false };
    }
    const results = Array.isArray(data?.results)
      ? data.results.flatMap((entry) => normalizedResult(entry, "searxng"))
      : [];
    return { ok: true, backend: "searxng", results };
  } catch (error) {
    return fetchFailure("searxng", error);
  }
}

async function searchDuckDuckGo(query, options) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  if (!options.sandbox.networkAllowsUrl(options.policy, url)) {
    return { ok: false, backend: "duckduckgo", message: "Network access denied by sandbox policy.", retryable: false };
  }
  try {
    const response = await options.fetchImpl(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": options.language || "en-US,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) mono-agent-web/1",
      },
      signal: requestSignal(options.signal),
      redirect: "error",
    });
    const html = await readLimitedText(response);
    if (!response.ok) {
      return {
        ok: false,
        backend: "duckduckgo",
        message: `DuckDuckGo HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    return { ok: true, backend: "duckduckgo", results: parseDuckDuckGoResults(html) };
  } catch (error) {
    return fetchFailure("duckduckgo", error);
  }
}

async function searchStartpage(query, options) {
  const url = `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`;
  if (!options.sandbox.networkAllowsUrl(options.policy, url)) {
    return { ok: false, backend: "startpage", message: "Network access denied by sandbox policy.", retryable: false };
  }
  try {
    const response = await options.fetchImpl(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": options.language || "en-US,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) mono-agent-web/1",
      },
      signal: requestSignal(options.signal),
      redirect: "error",
    });
    const html = await readLimitedText(response);
    if (!response.ok) {
      return {
        ok: false,
        backend: "startpage",
        message: `Startpage HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    return { ok: true, backend: "startpage", results: parseStartpageResults(html) };
  } catch (error) {
    return fetchFailure("startpage", error);
  }
}

export function parseDuckDuckGoResults(html) {
  const { document } = parseHTML(String(html || ""));
  const rows = [...document.querySelectorAll(".result")];
  return rows.flatMap((row) => {
    const link = row.querySelector("a.result__a");
    if (!link) return [];
    const url = canonicalizeSearchUrl(link.getAttribute("href"), "https://html.duckduckgo.com/");
    if (!url) return [];
    return [{
      title: collapseWhitespace(link.textContent),
      url,
      snippet: collapseWhitespace(row.querySelector(".result__snippet")?.textContent),
      backend: "duckduckgo",
    }];
  });
}

export function parseStartpageResults(html) {
  const { document } = parseHTML(String(html || ""));
  const selectors = [".w-gl__result", ".result", "article"];
  const rows = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const link = row.querySelector("a.w-gl__result-title, a.result-link, h2 a, h3 a");
    if (!link) continue;
    const url = canonicalizeSearchUrl(link.getAttribute("href"), "https://www.startpage.com/");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: collapseWhitespace(link.textContent),
      url,
      snippet: collapseWhitespace(
        row.querySelector(".w-gl__description, .result-description, p")?.textContent,
      ),
      backend: "startpage",
    });
  }
  return results;
}

function normalizedResult(entry, backend) {
  if (!entry || typeof entry !== "object") return [];
  const url = canonicalizeSearchUrl(entry.url);
  if (!url) return [];
  return [{
    title: collapseWhitespace(entry.title) || url,
    url,
    snippet: collapseWhitespace(entry.content || entry.snippet),
    backend,
  }];
}

export function canonicalizeSearchUrl(value, base) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed;
  try { parsed = new URL(value, base); } catch { return null; }
  const wrapped = ["uddg", "url", "u", "target"].map((key) => parsed.searchParams.get(key)).find(Boolean);
  if (wrapped && (
    parsed.hostname.endsWith("duckduckgo.com")
    || parsed.hostname.endsWith("startpage.com")
  )) {
    try { parsed = new URL(wrapped); } catch { /* keep the wrapper URL */ }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();
  if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.href;
}

export function mergeRankedResults(rankedLists, limit = 10) {
  const merged = new Map();
  for (const list of rankedLists) {
    for (let index = 0; index < list.length; index += 1) {
      const result = list[index];
      const url = canonicalizeSearchUrl(result.url);
      if (!url) continue;
      const existing = merged.get(url);
      const score = 1 / (RRF_K + index + 1);
      if (existing) {
        existing.score += score;
        if (!existing.snippet && result.snippet) existing.snippet = result.snippet;
      } else {
        merged.set(url, { ...result, url, score });
      }
    }
  }
  return [...merged.values()]
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
    .slice(0, clampInteger(limit, 1, 10, 10))
    .map(({ score: _score, ...result }) => result);
}

function normalizeSearchConfig(input) {
  const backend = input?.backend ?? "auto";
  if (!["auto", "searxng", "keyless"].includes(backend)) {
    return { error: "Web search backend must be auto, searxng, or keyless." };
  }
  let endpoint;
  if (input?.endpoint !== undefined && String(input.endpoint).trim()) {
    try {
      const parsed = new URL(String(input.endpoint));
      if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname) || parsed.username || parsed.password) {
        return { error: "SearXNG endpoint must be an unauthenticated loopback http URL." };
      }
      if (parsed.search || parsed.hash) {
        return { error: "SearXNG endpoint must not contain a query string or fragment." };
      }
      parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
      endpoint = parsed.href.replace(/\/+$/u, "");
    } catch {
      return { error: "SearXNG endpoint must be a valid loopback http URL." };
    }
  }
  if (backend === "searxng" && !endpoint) {
    return { error: "SearXNG backend requires tools.web.search.endpoint." };
  }
  return { backend, endpoint };
}

function isLoopbackHost(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function normalizeDomains(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase().replace(/^\*\./u, "").replace(/\.$/u, "");
    if (!/^[a-z0-9.-]+$/u.test(normalized) || normalized.includes("..")) continue;
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= 10) break;
  }
  return out;
}

function filterByDomains(results, include, exclude) {
  return results.filter((result) => {
    let host;
    try { host = new URL(result.url).hostname.toLowerCase(); } catch { return false; }
    if (exclude.some((domain) => domainMatches(host, domain))) return false;
    return include.length === 0 || include.some((domain) => domainMatches(host, domain));
  });
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function queryWithDomains(query, domains) {
  if (domains.length === 0) return query;
  return `${query} (${domains.map((domain) => `site:${domain}`).join(" OR ")})`;
}

function relaxedQuery(query) {
  const relaxed = query
    .replace(/"([^"]+)"/gu, "$1")
    .replace(/\bsite:\S+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return relaxed && relaxed !== query ? relaxed : null;
}

function uniqueStrings(values, limit) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function escapeMarkdownLabel(value) {
  return collapseWhitespace(value).replace(/[[\]\\]/gu, "\\$&");
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readLimitedText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > SEARCH_RESPONSE_MAX_BYTES) {
      throw new Error(`search response exceeded ${SEARCH_RESPONSE_MAX_BYTES} bytes`);
    }
    return text;
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > SEARCH_RESPONSE_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw new Error(`search response exceeded ${SEARCH_RESPONSE_MAX_BYTES} bytes`);
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fetchFailure(backend, error) {
  const name = error?.name;
  const retryable = name === "AbortError"
    || name === "TimeoutError"
    || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code ?? error?.cause?.code);
  return {
    ok: false,
    backend,
    message: `${backend} request failed: ${error?.message || String(error)}`,
    retryable,
  };
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

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
