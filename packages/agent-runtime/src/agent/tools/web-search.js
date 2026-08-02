// @ts-check

import { parseHTML } from "linkedom";
import { passthroughSandbox } from "../sandbox-seam.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { createCountingSemaphore } from "./shared/semaphore.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";

const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const RRF_K = 60;

// Keyless engines rate-limit by source IP, and one agent can hammer them from
// many directions at once: a single WebSearch fans out to up to four queries,
// and every subagent runs its own web controller, so nothing below this module
// sees the aggregate. Measured against html.duckduckgo.com: ~8 requests in ~4s
// served normally, ~12 in ~5s tripped an `HTTP 202` anomaly page that persisted
// for over two minutes. These bounds therefore live at MODULE scope so they
// apply process-wide (one process is one agent instance), not per run.
const KEYLESS_DEFAULT_THROTTLE = {
  // Simultaneous in-flight keyless requests across the whole process.
  maxConcurrency: 3,
  // Minimum gap between two requests to the SAME keyless backend, i.e. ~0.67/s
  // against roughly 2.4/s measured to trip a ban. The asymmetry is deliberate:
  // being too slow costs a few seconds on a multi-query search, while being too
  // fast costs a five-minute outage that escalates from a 202 challenge to an
  // outright 403. Only the fan-out pays it — a single-query search never waits.
  minSpacingMs: 1_500,
  // How long a backend stays skipped after it signals rate limiting. Observed
  // blocks outlasted several minutes, so this is deliberately longer.
  cooldownMs: 5 * 60_000,
};
// Ordered keyless fallback chain. DuckDuckGo first: it yields cleaner titles and
// snippets, but it is also the one that bans, which is precisely why Startpage
// behind it has to actually work.
const KEYLESS_BACKENDS = ["duckduckgo", "startpage"];
// Markers that identify an interstitial/bot-gate body served with a 2xx status.
const CHALLENGE_BODY_RE = /anomaly|unusual traffic|captcha|are you a robot|challenge-(?:platform|form)/iu;
// Statuses these engines use to say "you are sending too much", all of which
// must put the backend into cooldown rather than be retried next search.
const RATE_LIMIT_STATUSES = new Set([202, 403, 429]);

let keylessThrottle = { ...KEYLESS_DEFAULT_THROTTLE };
let keylessSemaphore = createCountingSemaphore(keylessThrottle.maxConcurrency);
/** @type {Map<string, number>} Backend -> epoch ms until which it is skipped. */
const backendCooldownUntil = new Map();
/** @type {Map<string, number>} Backend -> epoch ms its next request may start. */
const backendNextAvailableAt = new Map();
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
    // Chain failures are reported even when a later backend rescued the query,
    // so a silent degradation to the fallback is still visible in the outcome.
    if (result.failures?.length) providerFailures.push(...result.failures);
    if (result.ok) {
      anyProviderSucceeded = true;
      providersUsed.add(result.backend);
      rankedLists.push(filterByDomains(result.results, includeDomains, excludeDomains));
    } else if (!result.failures?.length) {
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
    // Four query variants against two backends produce the same handful of
    // messages over and over; dedupe so the reason stays readable.
    const reason = [...new Set(providerFailures.map((entry) => entry.message).filter(Boolean))].join("; ")
      || "No search backend was available.";
    const networkDenied = providerFailures.length > 0
      && providerFailures.every((entry) => entry.message === "Network access denied by sandbox policy.");
    const throttled = providerFailures.some((entry) => entry.rateLimited || entry.cooldown);
    return failure(networkDenied
      ? "Error: Network access denied by sandbox policy."
      : `Error: WebSearch failed: ${reason}`,
    networkDenied ? "network_denied" : (throttled ? "rate_limited" : "backend_unavailable"), startedAt, {
      attempts,
      backend: config.backend,
      retryable: providerFailures.some((entry) => entry.retryable),
      rateLimited: throttled,
      cooldownBackends: [...backendCooldownUntil.keys()],
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
      rateLimited: providerFailures.some((entry) => entry.rateLimited || entry.cooldown),
      cooldownBackends: [...backendCooldownUntil.keys()],
    },
    error: false,
  };
}

const KEYLESS_RUNNERS = {
  duckduckgo: searchDuckDuckGo,
  startpage: searchStartpage,
};

async function searchOneQuery(query, options) {
  const { config } = options;
  // Every failure along the chain is kept and carried out on the winning result
  // too. Reporting only the last one is what made a DuckDuckGo ban surface as
  // "startpage request failed: fetch failed" and sent diagnosis the wrong way.
  const failures = [];
  if (options.signal?.aborted) return abortedSearch(config.backend, failures);
  if (config.backend === "searxng" || (config.backend === "auto" && config.endpoint)) {
    const result = await searchSearxng(query, options);
    if (result.ok || config.backend === "searxng") return { ...result, failures };
    failures.push(result);
    if (options.signal?.aborted) return abortedSearch(result.backend, failures);
  }
  if (config.backend === "keyless" || config.backend === "auto") {
    // A genuinely empty 200 is a real answer, not a transport failure — but it
    // is only worth returning once every backend has had its turn.
    let emptySuccess = null;
    for (const backend of KEYLESS_BACKENDS) {
      if (options.signal?.aborted) return abortedSearch(backend, failures);
      if (backendInCooldown(backend)) {
        failures.push({
          ok: false,
          backend,
          message: `${backend} skipped: cooling down after rate limiting.`,
          retryable: true,
          cooldown: true,
        });
        continue;
      }
      const result = await KEYLESS_RUNNERS[backend](query, options);
      if (result.ok) {
        if (result.results.length > 0) return { ...result, failures };
        emptySuccess = result;
        continue;
      }
      // The cooldown is already open — rateLimited() sets it at detection.
      failures.push(result);
    }
    if (emptySuccess) return { ...emptySuccess, failures };
  }
  return {
    ...(failures[failures.length - 1] || {
      ok: false,
      backend: config.backend,
      message: "No configured search backend.",
      retryable: false,
    }),
    failures,
  };
}

function abortedSearch(backend, failures = []) {
  return {
    ok: false,
    backend,
    message: "WebSearch was aborted.",
    retryable: false,
    failures,
  };
}

function backendInCooldown(backend) {
  const until = backendCooldownUntil.get(backend);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    backendCooldownUntil.delete(backend);
    return false;
  }
  return true;
}

/**
 * Atomically claims this backend's next send slot and reports how long the
 * caller must wait for it. Synchronous on purpose: concurrent callers each
 * reserve a distinct slot instead of all reading the same "last sent at".
 *
 * @returns {number} Milliseconds to wait before sending.
 */
function reserveKeylessSlot(backend) {
  const now = Date.now();
  const earliest = Math.max(now, backendNextAvailableAt.get(backend) ?? 0);
  backendNextAvailableAt.set(backend, earliest + keylessThrottle.minSpacingMs);
  return earliest - now;
}

// Deliberately NOT unref'd: this delay is part of an in-flight search the
// caller is awaiting. An unref'd timer lets the event loop drain while the
// search is still pending, and a one-shot CLI turn then exits mid-query.
// Cancellation is the signal's job, not the timer's.
function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      // Named so fetchFailure classifies it alongside every other abort.
      rejectPromise(Object.assign(new Error("WebSearch was aborted."), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolvePromise();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Test hook: restores the shipped throttle values and clears cooldown/spacing
 * state. Module-scoped state would otherwise leak between test cases.
 *
 * @param {{maxConcurrency?: number, minSpacingMs?: number, cooldownMs?: number}} [overrides]
 */
export function __resetWebSearchThrottleForTests(overrides = {}) {
  keylessThrottle = { ...KEYLESS_DEFAULT_THROTTLE, ...overrides };
  keylessSemaphore = createCountingSemaphore(keylessThrottle.maxConcurrency);
  backendCooldownUntil.clear();
  backendNextAvailableAt.clear();
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

/**
 * Shared transport for the keyless HTML engines. Both are scraped the same way
 * and both bot-gate the same way, so request shaping, throttling, challenge
 * detection, and error classification live here exactly once.
 *
 * @param {{backend: string, label: string, url: string, init?: RequestInit, parse: (html: string) => any[]}} spec
 */
async function keylessHtmlSearch(spec, options) {
  if (!options.sandbox.networkAllowsUrl(options.policy, spec.url)) {
    return { ok: false, backend: spec.backend, message: "Network access denied by sandbox policy.", retryable: false };
  }
  let release;
  try {
    release = await keylessSemaphore.acquire(options.signal);
  } catch {
    // Queued behind the concurrency bound when the turn was cancelled.
    return { ok: false, backend: spec.backend, message: "WebSearch was aborted.", retryable: false };
  }
  try {
    const waitMs = reserveKeylessSlot(spec.backend);
    if (waitMs > 0) await sleep(waitMs, options.signal);
    // Query variants all clear the cooldown check together and then queue here,
    // so by the time this one is admitted a sibling may already have been
    // blocked. Without this second look the very first block still costs a full
    // round of requests against a backend we know is refusing them.
    if (backendInCooldown(spec.backend)) {
      return {
        ok: false,
        backend: spec.backend,
        message: `${spec.backend} skipped: cooling down after rate limiting.`,
        retryable: true,
        cooldown: true,
      };
    }
    const response = await options.fetchImpl(spec.url, {
      // "manual", not "error": these engines answer a throttled query with a
      // redirect to a captcha page, and "error" collapses that into an opaque
      // `TypeError: fetch failed` with no way to tell it from a real outage.
      // The redirect is still never followed, so the open-redirect guard holds.
      redirect: "manual",
      ...(spec.init || {}),
      // Headers are merged last on purpose: spreading `spec.init` afterwards
      // would replace the whole headers object with the backend's few extra
      // entries, and a Startpage POST without a User-Agent gets bot-gated.
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": options.language || "en-US,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) mono-agent-web/1",
        ...(spec.init?.headers || {}),
      },
      signal: requestSignal(options.signal),
    });
    const html = await readLimitedText(response);
    // Startpage answers a blocked source IP with `303 -> /sp/captcha-block`.
    // The destination is the block itself, never results, so following it only
    // costs a round trip and still parses to nothing.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") || "";
      return rateLimited(spec, /captcha|blocked|sorry|challenge/iu.test(location)
        ? "captcha redirect"
        : `HTTP ${response.status} redirect`);
    }
    // 202 is DuckDuckGo's soft challenge (and is `ok`, so status alone would let
    // an interstitial through as an empty success); 403 is what it escalates to
    // once it stops asking politely. No credentials are ever sent to these
    // endpoints, so a 403 can only mean "blocked", never "unauthorized".
    if (RATE_LIMIT_STATUSES.has(response.status)) {
      return rateLimited(spec, `HTTP ${response.status}`);
    }
    if (!response.ok) {
      return {
        ok: false,
        backend: spec.backend,
        message: `${spec.label} HTTP ${response.status}`,
        retryable: response.status >= 500,
      };
    }
    const results = spec.parse(html);
    // A 200 that parses to nothing is ambiguous: either a genuinely empty
    // result set or a bot gate. Only the body markers tell them apart, and
    // conflating them is what made a ban look like "No results."
    if (results.length === 0 && CHALLENGE_BODY_RE.test(html)) {
      return rateLimited(spec, "interstitial challenge page");
    }
    return { ok: true, backend: spec.backend, results };
  } catch (error) {
    return fetchFailure(spec.backend, error, spec.label);
  } finally {
    release();
  }
}

function searchDuckDuckGo(query, options) {
  return keylessHtmlSearch({
    backend: "duckduckgo",
    label: "DuckDuckGo",
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGoResults,
  }, options);
}

function searchStartpage(query, options) {
  // Startpage serves its results from a form POST. The old query-string GET was
  // answered with a 3xx, which `redirect: "error"` turned into a bare
  // `TypeError: fetch failed` — so this backend never once returned a result,
  // and its useless error was the only thing the operator ever saw.
  const body = new URLSearchParams({ query, cat: "web" });
  const withDate = { day: "d", month: "m", year: "y" }[options.timeRange];
  if (withDate) body.set("with_date", withDate);
  return keylessHtmlSearch({
    backend: "startpage",
    label: "Startpage",
    url: "https://www.startpage.com/sp/search",
    init: {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    },
    parse: parseStartpageResults,
  }, options);
}

// Opens the cooldown at the moment of detection rather than letting the caller
// do it. The semaphore slot is released before this result reaches the caller,
// so a queued sibling would otherwise be admitted and re-check the cooldown
// while it was still closed, and every variant in flight would hit the wire.
function rateLimited(spec, detail) {
  backendCooldownUntil.set(spec.backend, Date.now() + keylessThrottle.cooldownMs);
  return {
    ok: false,
    backend: spec.backend,
    message: `${spec.label} rate-limited (${detail})`,
    retryable: true,
    rateLimited: true,
  };
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
  // Startpage inlines emotion CSS in <style> tags nested inside the result
  // anchors, and textContent happily returns the stylesheet as part of the
  // title (".css-i3irj7{line-height:18px;...}Best time to visit Japan").
  for (const node of document.querySelectorAll("style, script")) node.remove();
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

// undici reports transport problems as a bare `TypeError: fetch failed` and
// keeps the real reason on `error.cause` — dropping it is what left an
// "unexpected redirect" looking like an unexplained network fault.
const RETRYABLE_FETCH_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function fetchFailure(backend, error, label = backend) {
  const name = error?.name;
  const retryable = name === "AbortError"
    || name === "TimeoutError"
    || RETRYABLE_FETCH_CODES.has(error?.code ?? error?.cause?.code);
  const message = error?.message || String(error);
  const cause = error?.cause?.message;
  const detail = cause && cause !== message ? `${message} (${cause})` : message;
  return {
    ok: false,
    backend,
    message: `${label} request failed: ${detail}`,
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
