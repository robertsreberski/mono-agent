// @ts-check

import { withWebDeadline, coordinatedWebRequest, webRequestFailure } from "./web-request.js";
import { isIP } from "node:net";
import { parseHTML } from "linkedom";
import { passthroughSandbox } from "../sandbox-seam.js";
import { searchCodexSubscription } from "./codex-subscription-search.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { createCountingSemaphore } from "./shared/semaphore.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";
import {
  claimWebSearchRequest,
  createWebSearchRunState,
  deferWebSearchProvider,
  deferredWebSearchProvider,
  MAX_WEB_SEARCH_REQUESTS_PER_RUN,
  webSearchBudgetSnapshot,
} from "./web-search-state.js";

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
// The last two are Anubis, the proof-of-work gate Startpage now fronts its
// results with. It says none of the classic things — no captcha, no anomaly,
// just "Verifying your request..." — so without these it read as a clean 200
// that happened to parse to nothing, which is exactly the lie this guard exists
// to prevent.
const CHALLENGE_BODY_RE =
  /anomaly|unusual traffic|captcha|are you a robot|challenge-(?:platform|form)|anubis[_-]?challenge|verifying your request/iu;
// Reasons SearXNG reports for an engine that is being throttled or gated rather
// than merely erroring, e.g. "CAPTCHA", "too many requests", "Suspended: CAPTCHA".
const SEARXNG_THROTTLE_REASON_RE = /captcha|too many requests|rate.?limit|suspend|blocked|denied/iu;
// Statuses these engines use to say "you are sending too much", all of which
// must put the backend into cooldown rather than be retried next search.
const RATE_LIMIT_STATUSES = new Set([202, 403, 429]);

let keylessThrottle = { ...KEYLESS_DEFAULT_THROTTLE };
let keylessSemaphore = createCountingSemaphore(keylessThrottle.maxConcurrency);
/** @type {Map<string, number>} Backend -> epoch ms until which it is skipped. */
const backendCooldownUntil = new Map();
/** @type {Map<string, number>} Backend -> epoch ms its next request may start. */
const backendNextAvailableAt = new Map();
/** @type {Map<string, ReturnType<typeof createCountingSemaphore>>} */
const processProviderSemaphores = new Map();
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
 * @param {{sandboxPolicy?: any, ctx?: any, signal?: AbortSignal, coordinator?: any, searchConfig?: any, fetchImpl?: typeof fetch}} [options]
 */
export async function webSearchToolImpl(params, options = {}) {
  return (await performWebSearch(params, options)).text;
}

/**
 * Search through an explicitly selected Ollama endpoint, an operator-owned
 * SearXNG endpoint, ChatGPT-subscription Codex search, and/or the keyless HTML fallback chain. Returns a structured
 * internal outcome for the Pi bridge.
 *
 * @param {{query: string, limit?: number, alternate_queries?: string[], domains?: string[], exclude_domains?: string[], language?: string, time_range?: string}} params
 * @param {{sandboxPolicy?: any, ctx?: any, signal?: AbortSignal, coordinator?: any, searchConfig?: any, searchState?: any, fetchImpl?: typeof fetch, codexSearch?: typeof searchCodexSubscription}} [options]
 */
export async function performWebSearch(params, options = {}) {
  return await withWebDeadline(options.signal, 60_000, (signal) => performSearch(params, { ...options, signal }));
}

/**
 * Search through an operator-owned SearXNG endpoint, ChatGPT-subscription
 * Codex search, and/or the keyless HTML fallback chain. Returns a structured
 * internal outcome for the Pi bridge.
 *
 * @param {{query: string, limit?: number, alternate_queries?: string[], domains?: string[], exclude_domains?: string[], language?: string, time_range?: string}} params
 * @param {{sandboxPolicy?: any, ctx?: any, signal?: AbortSignal, coordinator?: any, searchConfig?: any, searchState?: any, fetchImpl?: typeof fetch, codexSearch?: typeof searchCodexSubscription}} [options]
 */
async function performSearch(
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
    searchState: suppliedSearchState,
    coordinator,
    fetchImpl = globalThis.fetch,
    codexSearch = searchCodexSubscription,
  } = {},
) {
  const startedAt = Date.now();
  const searchState = createWebSearchRunState(searchConfig, suppliedSearchState);
  const callClaims = { requests: 0 };
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  if (!normalizedQuery) {
    return searchFailure("Error: WebSearch query must not be empty.", "invalid_query", startedAt, searchState, callClaims.requests);
  }
  const max = clampInteger(limit, 1, 10, 5);
  const explicitDomains = normalizeDomains(Array.isArray(domains) ? domains : []);
  const includeDomains = normalizeDomains([...explicitDomains, ...querySiteDomains(normalizedQuery)]);
  const excludeDomains = normalizeDomains(exclude_domains);
  const config = normalizeSearchConfig(searchConfig);
  if ("error" in config) return searchFailure(
    `Error: ${config.error}`,
    "code" in config ? config.code : "invalid_search_config",
    startedAt,
    searchState,
    callClaims.requests,
  );

  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  // Operators, quotes, and site: constraints are never relaxed or rewritten by
  // the host. Alternate queries are explicit model input, not host-generated
  // substitutions for the user's exact primary query.
  const initialQueries = uniqueStrings([normalizedQuery, ...alternate_queries], 4);
  /** @type {Array<Array<{title: string, url: string, snippet: string, backend: string}>>} */
  const rankedLists = [];
  const providerFailures = [];
  const providersUsed = new Set();
  const attemptedBackends = new Set();
  const actualQueries = [];
  let attempts = 0;
  let anyProviderSucceeded = false;
  let queueWaitMs = 0;
  let backendDurationMs = 0;

  const runQuery = async (candidate, backend, stageSignal = signal) => {
    attempts += 1;
    attemptedBackends.add(backend);
    return await searchOneQuery(
      queryWithDomains(candidate, explicitDomains),
      {
        config: { ...config, backend },
        coordinator,
        relevanceQuery: normalizedQuery, includeDomains, excludeDomains,
        auto: config.backend === "auto",
        language,
        timeRange: time_range,
        sandbox,
        policy,
        signal: stageSignal,
        fetchImpl,
        codexSearch,
        searchState,
        callClaims,
      },
    );
  };
  const recordResult = (result) => {
    queueWaitMs += result.coordinationWaitMs || 0;
    backendDurationMs += result.backendDurationMs || 0;
    // Chain failures are reported even when a later backend rescued the query,
    // so a silent degradation to the fallback is still visible in the outcome.
    if (result.failures?.length) providerFailures.push(...result.failures);
    if (result.ok) {
      if (typeof result.actualQuery === "string" && result.actualQuery.trim()) {
        actualQueries.push(result.actualQuery.trim());
      }
      const filtered = filterRelevantResults(
        filterByDomains(result.results, includeDomains, excludeDomains),
        normalizedQuery,
      );
      if (filtered.length > 0) {
        anyProviderSucceeded = true;
        providersUsed.add(result.backend);
        rankedLists.push(filtered);
        return true;
      } else if (result.results.length === 0) {
        anyProviderSucceeded = true;
      } else {
        providerFailures.push({
          ok: false,
          backend: result.backend,
          message: `${result.backend} returned no relevant results.`,
          retryable: false,
          relevance: true,
        });
      }
    } else if (!result.failures?.length) {
      providerFailures.push(result);
    }
    return false;
  };

  // A broad primary query walks the eligible provider chain before any
  // alternate wording. Auto includes Ollama only when its block was explicitly
  // configured; all named backend modes remain strict.
  const eligibleBackends = config.backend === "auto"
    ? [...(config.ollama ? ["ollama"] : []), ...(config.endpoint ? ["searxng"] : []), "codex", "keyless"]
    : [config.backend];
  const disabledForCall = new Set();
  let merged = [];
  for (let queryIndex = 0; queryIndex < initialQueries.length && merged.length === 0; queryIndex += 1) {
    const candidate = initialQueries[queryIndex];
    for (const backend of eligibleBackends) {
      if (signal?.aborted || disabledForCall.has(backend)) continue;
      // Subscription search remains exactly one turn per WebSearch call.
      if (backend === "codex" && queryIndex > 0) continue;
      const run = (stageSignal) => runQuery(candidate, backend, stageSignal);
      const result = backend === "searxng" && config.backend === "auto"
        ? await withWebDeadline(signal, 3000, run)
        : await run(signal);
      const usable = recordResult(result);
      if (usable) {
        merged = mergeRankedResults(rankedLists, max);
        break;
      }
      if (!result.ok && !result.relevance) disabledForCall.add(backend);
      if (providerFailures.some((entry) => ["coordination_unavailable", "search_budget_exhausted"].includes(entry.code))) break;
    }
    if (providerFailures.some((entry) => ["coordination_unavailable", "search_budget_exhausted"].includes(entry.code))) break;
  }
  if (signal?.aborted) {
    return searchFailure("Error: WebSearch was aborted or exceeded its deadline.", signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted", startedAt, searchState, callClaims.requests, {
      attempts,
      retryable: false,
    });
  }

  if (providerFailures.some((r) => r.code === "coordination_unavailable")) {
    return searchFailure("Error: Web request coordination is unavailable; no uncoordinated fallback was attempted.", "coordination_unavailable", startedAt, searchState, callClaims.requests, { attempts });
  }
  if (providerFailures.some((entry) => entry.code === "search_budget_exhausted")) {
    return searchFailure("Error: WebSearch request budget exhausted for this run.", "search_budget_exhausted", startedAt, searchState, callClaims.requests, {
      attempts,
      backend: config.backend,
      attemptedBackends: [...attemptedBackends],
      providerAttempts: providerAttemptMetadata(providerFailures),
      retryInRun: false,
      nextAction: "use_available_evidence",
    });
  }
  if (!anyProviderSucceeded || (merged.length === 0 && providerFailures.some((entry) => !entry.relevance))) {
    // Four query variants against two backends produce the same handful of
    // messages over and over; dedupe so the reason stays readable.
    const reason = [...new Set(providerFailures.map((entry) => entry.message).filter(Boolean))].join("; ")
      || "No search backend was available.";
    const networkDenied = providerFailures.length > 0
      && providerFailures.every((entry) => entry.message === "Network access denied by sandbox policy.");
    const throttled = providerFailures.some((entry) => entry.rateLimited || entry.cooldown);
    const strictProviderCode = config.backend !== "auto"
      ? providerFailures.find((entry) => typeof entry.code === "string")?.code
      : undefined;
    const retryAfterMs = shortestRetry(providerFailures);
    const retryAt = earliestRetryAt(providerFailures);
    return searchFailure(networkDenied
      ? "Error: Network access denied by sandbox policy."
      : `Error: WebSearch failed: ${reason}`,
    networkDenied ? "network_denied" : (throttled ? "rate_limited" : (strictProviderCode || "backend_unavailable")), startedAt, searchState, callClaims.requests, {
      attempts,
      backend: config.backend,
      retryable: providerFailures.some((entry) => entry.retryable),
      rateLimited: throttled,
      cooldownBackends: cooldownBackendNames(searchState),
      attemptedBackends: [...attemptedBackends],
      failureMetadata: sanitizeFailureMetadata(providerFailures),
      queueWaitMs, backendDurationMs,
      cooldownSkipCount: providerFailures.filter((r) => r.cooldown).length,
      quotaSkipCount: providerFailures.filter((r) => r.quotaSkipped).length,
      retryAfterMs,
      ...(retryAt === undefined ? {} : { retryAt: new Date(retryAt).toISOString() }),
      retryInRun: false,
      nextAction: "use_available_evidence",
      providerAttempts: providerAttemptMetadata(providerFailures),
    });
  }

  const backend = providersUsed.size === 1
    ? [...providersUsed][0]
    : providersUsed.size > 1 ? "mixed" : config.backend;
  const body = merged.length === 0
    ? "No results."
    : merged.map((result, index) => {
        const snippet = result.snippet ? `\n   ${collapseWhitespace(result.snippet)}` : "";
        return `${index + 1}. [${escapeMarkdownLabel(result.title || result.url)}](${result.url})${snippet}`;
      }).join("\n\n");
  const nextAction = merged.length > 0
    ? "fetch_existing_sources"
    : searchState.requestsUsed < searchState.maxRequests ? "refine_query" : "use_available_evidence";
  const text = [
    searchControlLine(searchState, callClaims.requests, providerFailures, nextAction),
    "[BEGIN UNTRUSTED WEB SEARCH RESULTS]",
    searchMetadataLine({
      backend,
      attemptedBackends: [...attemptedBackends],
      query: actualQueries[0] || normalizedQuery,
      providerFailures,
    }),
    ...(language || time_range ? [`[Requested filters: language=${JSON.stringify(language || "default")}; time_range=${time_range || "any"}; provider-dependent, verify dates in sources.]`] : []),
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
      queueWaitMs, backendDurationMs,
      cooldownSkipCount: providerFailures.filter((r) => r.cooldown).length,
      quotaSkipCount: providerFailures.filter((r) => r.quotaSkipped).length,
      filterSupport: { language: language ? (backend === "searxng" ? "provider" : "advisory") : "not_requested", timeRange: time_range ? (["codex", "ollama", "startpage"].includes(backend) ? "advisory" : "provider") : "not_requested" },
      providerFailureCount: providerFailures.length,
      rateLimited: providerFailures.some((entry) => entry.rateLimited || entry.cooldown),
      cooldownBackends: cooldownBackendNames(searchState),
      attemptedBackends: [...attemptedBackends],
      actualQueries: uniqueStrings(actualQueries.length > 0 ? actualQueries : [normalizedQuery], 4),
      failureMetadata: sanitizeFailureMetadata(providerFailures),
      ...webSearchBudgetSnapshot(searchState, callClaims.requests),
      fallbackUsed: attemptedBackends.size > 1,
      retryInRun: searchState.requestsUsed < searchState.maxRequests,
      nextAction,
      providerAttempts: providerAttemptMetadata(providerFailures),
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
  // A genuinely empty 200 is a real answer, not a transport failure — but it is
  // only worth returning once every backend has had its turn. Scoped to the whole
  // chain, not just the keyless loop: an empty SearXNG answer used to short-
  // circuit `auto` outright, so the fallbacks below could never rescue a query.
  let emptySuccess = null;
  if (options.signal?.aborted) return abortedSearch(config.backend, failures);
  if (config.backend === "searxng") {
    const deferred = deferredResult(options.searchState, "searxng");
    if (deferred) return { ...deferred, failures };
    const result = await searchWithRequestCount(options.callClaims, () => guardedSearch("searxng", options.config.endpoint, options, () => searchSearxng(query, options)));
    return { ...rememberProviderDeferral(result, options.searchState), failures };
  }
  if (config.backend === "ollama") {
    const deferred = deferredResult(options.searchState, "ollama");
    if (deferred) return { ...deferred, failures };
    const result = await searchWithRequestCount(options.callClaims, () => guardedSearch("ollama", config.ollama.baseUrl, options, () => searchOllama(query, options)));
    return { ...rememberProviderDeferral(result, options.searchState), failures };
  }
  if (config.backend === "codex") {
    const deferred = deferredResult(options.searchState, "codex");
    if (deferred) return { ...deferred, failures };
    if (!options.sandbox.networkAllowsUrl(options.policy, "https://chatgpt.com")) {
      return {
        ok: false,
        backend: "codex",
        message: "Network access denied by sandbox policy.",
        retryable: false,
        failures,
      };
    }
    const result = await searchWithRequestCount(options.callClaims, () => guardedSearch("codex", "codex", options, () => options.codexSearch(query, {
      model: config.codex.model, signal: options.signal, coordinator: options.coordinator,
      language: options.language, timeRange: options.timeRange,
      claimRequest: () => claimWebSearchRequest(options.searchState, "codex", options.callClaims),
    })));
    return { ...rememberProviderDeferral(result, options.searchState), failures };
  }
  if (config.backend === "keyless") {
    for (const backend of KEYLESS_BACKENDS) {
      if (options.signal?.aborted) return abortedSearch(backend, failures);
      const runDeferred = deferredResult(options.searchState, backend);
      if (runDeferred) {
        failures.push(runDeferred);
        continue;
      }
      if (backendInCooldown(backend)) {
        failures.push({
          ok: false,
          backend,
          message: `${backend} skipped: cooling down after rate limiting.`,
          retryable: true,
          cooldown: true,
          retryAfterMs: processCooldownRemaining(backend),
          retryAtMs: Date.now() + processCooldownRemaining(backend),
        });
        continue;
      }
      const result = await searchWithRequestCount(options.callClaims, () => guardedSearch(backend, backend, options, () => KEYLESS_RUNNERS[backend](query, options)));
      rememberProviderDeferral(result, options.searchState);
      if (result.ok) {
        if (result.results.length > 0) {
          const usable = filterRelevantResults(filterByDomains(result.results, options.includeDomains, options.excludeDomains), options.relevanceQuery);
          if (usable.length > 0) return { ...result, results: usable, failures };
          failures.push({ backend, message: `${backend} returned no relevant results.`, relevance: true });
          continue;
        }
        emptySuccess ??= result;
        continue;
      }
      // The cooldown is already open — rateLimited() sets it at detection.
      failures.push(result);
      if (result.code === "coordination_unavailable") return { ...result, failures };
    }
  }
  if (emptySuccess) return { ...emptySuccess, failures };
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

function deferredResult(searchState, backend) {
  const deferred = deferredWebSearchProvider(searchState, backend);
  if (!deferred) return null;
  const retryAfterMs = deferred.retryAtMs === undefined ? undefined : Math.max(0, deferred.retryAtMs - Date.now());
  return {
    ok: false,
    backend,
    code: "rate_limited",
    message: `${backend} is deferred for the remainder of this run.`,
    retryable: true,
    retryInRun: false,
    cooldown: true,
    rateLimited: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs, retryAtMs: deferred.retryAtMs }),
  };
}

function rememberProviderDeferral(result, searchState) {
  if (result?.rateLimited || result?.cooldown) {
    const retryAtMs = Number.isFinite(result.retryAtMs)
      ? result.retryAtMs
      : Number.isFinite(result.retryAfterMs) ? Date.now() + result.retryAfterMs : undefined;
    deferWebSearchProvider(searchState, result.backend, retryAtMs);
  }
  return result;
}

async function searchWithRequestCount(callClaims, execute) {
  const before = callClaims.requests;
  const result = await execute();
  return { ...result, requestsConsumed: callClaims.requests - before };
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

function backendInCooldown(backend, key = backend) {
  const cooldownKey = processCooldownKey(backend, key);
  const until = backendCooldownUntil.get(cooldownKey);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    backendCooldownUntil.delete(cooldownKey);
    return false;
  }
  return true;
}

function processCooldownKey(backend, key) {
  return `${backend}:${String(key)}`;
}

function processCooldownRemaining(backend, key = backend) {
  return Math.max(0, (backendCooldownUntil.get(processCooldownKey(backend, key)) ?? Date.now()) - Date.now());
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
  processProviderSemaphores.clear();
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
    claimWebSearchRequest(options.searchState, "searxng", options.callClaims);
    const response = await options.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "mono-agent-web/1",
      },
      body,
      signal: options.auto ? AbortSignal.any([options.signal, AbortSignal.timeout(3000)]) : requestSignal(options.signal),
      redirect: "error",
    });
    const text = await readLimitedText(response);
    if (!response.ok) {
      return {
        ok: false,
        backend: "searxng",
        message: `SearXNG HTTP ${response.status}`,
        rateLimited: response.status === 429, retryAfterMs: parseRetryAfter(response),
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
    // An instance whose engines are all captcha'd or suspended still answers
    // `200 {"results": []}`, and `unresponsive_engines` is the only thing that
    // tells that apart from a query nothing matched. Reading `results` alone is
    // what let a completely dead instance report "No results." on every query
    // for weeks. Naming each engine and its reason is what makes the next one
    // diagnosable from the tool output instead of from the container logs.
    //
    // Counted on the RAW array, not the normalized one: results that all fail
    // canonicalization are an unusable answer from working engines, which is a
    // different fault and must not be blamed on the engines that did fail.
    const unresponsive = normalizeUnresponsiveEngines(data?.unresponsive_engines);
    if (!Array.isArray(data?.results) || (data.results.length === 0 && unresponsive.length > 0)) {
      if (unresponsive.length === 0) {
        return { ok: false, backend: "searxng", message: "SearXNG returned no results array.", retryable: false };
      }
      // Deliberately not "every engine failed": SearXNG lists only the engines
      // that failed, so a working engine that simply matched nothing is
      // indistinguishable here from one that was never queried.
      const detail = unresponsive.map((entry) => `${entry.name}: ${entry.reason}`).join("; ");
      return {
        ok: false,
        backend: "searxng",
        message: `SearXNG returned no results and ${unresponsive.length === 1 ? "1 engine" : `${unresponsive.length} engines`} failed (${detail})`,
        retryable: true,
        rateLimited: unresponsive.some((entry) => SEARXNG_THROTTLE_REASON_RE.test(entry.reason)),
      };
    }
    return { ok: true, backend: "searxng", results };
  } catch (error) {
    return fetchFailure("searxng", error);
  }
}

async function searchOllama(query, options) {
  const config = options.config.ollama;
  if (!config) {
    return { ok: false, backend: "ollama", message: "Ollama Web Search is not configured.", retryable: false };
  }
  const official = config.baseUrl === "https://ollama.com";
  const paths = official ? ["/api/web_search"] : ["/api/experimental/web_search", "/api/web_search"];
  for (let index = 0; index < paths.length; index += 1) {
    const url = `${config.baseUrl}${paths[index]}`;
    if (!options.sandbox.networkAllowsUrl(options.policy, url)) {
      return { ok: false, backend: "ollama", message: "Network access denied by sandbox policy.", retryable: false };
    }
    try {
      claimWebSearchRequest(options.searchState, "ollama", options.callClaims);
      const response = await options.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "mono-agent-web/1",
          ...(official ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ query, max_results: 10 }),
        signal: requestSignal(options.signal),
        redirect: "error",
      });
      const text = await readLimitedText(response);
      if (!official && index === 0 && [404, 405].includes(response.status)) continue;
      if (!official && index === 1 && [404, 405].includes(response.status)) {
        return { ok: false, backend: "ollama", code: "endpoint_not_supported", message: "Ollama Web Search endpoints are not supported by this server.", retryable: false };
      }
      if (!response.ok) {
        return {
          ok: false,
          backend: "ollama",
          code: [401, 403].includes(response.status) ? "auth_failed"
            : response.status === 408 ? "timeout"
              : response.status === 429 ? "rate_limited"
              : response.status >= 500 ? "provider_unavailable" : "provider_unavailable",
          message: `Ollama Web Search HTTP ${response.status}`,
          rateLimited: response.status === 429,
          retryAfterMs: parseRetryAfter(response),
          retryable: [408, 429].includes(response.status) || response.status >= 500,
        };
      }
      let data;
      try { data = JSON.parse(text); } catch {
        return { ok: false, backend: "ollama", code: "invalid_response", message: "Ollama Web Search returned invalid JSON.", retryable: false };
      }
      if (!Array.isArray(data?.results)) {
        return { ok: false, backend: "ollama", code: "invalid_response", message: "Ollama Web Search returned no results array.", retryable: false };
      }
      const results = data.results.flatMap((entry) => normalizedResult(entry, "ollama"));
      if (data.results.length > 0 && results.length === 0) {
        return { ok: false, backend: "ollama", code: "invalid_response", message: "Ollama Web Search returned no usable result URLs.", retryable: false };
      }
      return {
        ok: true,
        backend: "ollama",
        results,
      };
    } catch (error) {
      return ollamaFetchFailure(error, options.signal);
    }
  }
  return { ok: false, backend: "ollama", message: "Ollama Web Search endpoint is unavailable.", retryable: false };
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
    if (backendInCooldown(spec.backend, spec.backend)) {
      return {
        ok: false,
        backend: spec.backend,
        message: `${spec.backend} skipped: cooling down after rate limiting.`,
        retryable: true,
        cooldown: true,
      };
    }
    claimWebSearchRequest(options.searchState, spec.backend, options.callClaims);
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
      return rateLimited(spec, `HTTP ${response.status}`, response);
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
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${({ day: "d", month: "m", year: "y" }[options.timeRange]) ? `&df=${({ day: "d", month: "m", year: "y" }[options.timeRange])}` : ""}`,
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
function rateLimited(spec, detail, response) {
  const retryAfterMs = parseRetryAfter(response) ?? keylessThrottle.cooldownMs;
  const retryAtMs = Date.now() + retryAfterMs;
  backendCooldownUntil.set(processCooldownKey(spec.backend, spec.backend), retryAtMs);
  return {
    ok: false,
    backend: spec.backend,
    message: `${spec.label} rate-limited (${detail})`,
    retryAfterMs,
    retryAtMs,
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

/**
 * SearXNG reports each failed engine as a `[name, reason]` pair. Older builds
 * and some forks send objects instead, so both shapes are accepted.
 */
function normalizeUnresponsiveEngines(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const [name, reason] = Array.isArray(entry) ? entry : [entry?.name, entry?.error ?? entry?.reason];
    const normalizedName = collapseWhitespace(name);
    if (!normalizedName) return [];
    return [{ name: normalizedName, reason: collapseWhitespace(reason) || "unknown error" }];
  });
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
  if (!["auto", "searxng", "ollama", "codex", "keyless"].includes(backend)) {
    return { error: "Web search backend must be auto, searxng, ollama, codex, or keyless." };
  }
  const maxRequestsPerRun = input?.maxRequestsPerRun ?? 4;
  if (!Number.isSafeInteger(maxRequestsPerRun) || maxRequestsPerRun < 1 || maxRequestsPerRun > MAX_WEB_SEARCH_REQUESTS_PER_RUN) {
    return { error: `Web search maxRequestsPerRun must be an integer from 1 to ${MAX_WEB_SEARCH_REQUESTS_PER_RUN}.` };
  }
  const legacyEndpoint = input?.endpoint;
  const nestedEndpoint = input?.searxng?.endpoint;
  if (legacyEndpoint && nestedEndpoint && String(legacyEndpoint).trim() !== String(nestedEndpoint).trim()) {
    return { error: "Legacy and canonical SearXNG endpoints disagree." };
  }
  let endpoint;
  const endpointInput = nestedEndpoint ?? legacyEndpoint;
  if (endpointInput !== undefined && String(endpointInput).trim()) {
    try {
      const parsed = new URL(String(endpointInput));
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
    return { error: "SearXNG backend requires tools.web.search.searxng.endpoint." };
  }
  const ollama = normalizeOllamaSearchConfig(input?.ollama, backend);
  if (ollama.error) return {
    error: ollama.error,
    ...(ollama.code === undefined ? {} : { code: ollama.code }),
  };
  const model = typeof input?.codex?.model === "string" && input.codex.model.trim()
    ? input.codex.model.trim()
    : "gpt-5.6-luna";
  if (model.length > 160 || /[\u0000-\u001f\u007f]/u.test(model)) {
    return { error: "Codex web search model must be a valid model id." };
  }
  return { backend, maxRequestsPerRun, endpoint, ...(ollama.value === undefined ? {} : { ollama: ollama.value }), codex: { model } };
}

function normalizeOllamaSearchConfig(input, backend) {
  if (backend !== "ollama" && input === undefined) return { value: undefined };
  let parsed;
  try { parsed = new URL(input?.baseUrl || "http://127.0.0.1:11434"); }
  catch { return { error: "Ollama Web Search base URL must be a valid HTTP(S) origin." }; }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !["", "/"].includes(parsed.pathname)) {
    return { error: "Ollama Web Search base URL must be an HTTP(S) origin without credentials, path, query, or fragment." };
  }
  const baseUrl = parsed.origin;
  const official = baseUrl === "https://ollama.com";
  if (!official && !isPrivateOllamaOrigin(parsed) && (parsed.protocol !== "https:" || input?.trustPublicUrl !== true)) {
    return { error: "A public custom Ollama origin requires HTTPS and trustPublicUrl=true." };
  }
  if (!official && (input?.apiKey !== undefined || input?.apiKeyEnv !== undefined)) {
    return { error: "Ollama Web Search credentials are allowed only for the exact https://ollama.com origin." };
  }
  if (official && (typeof input?.apiKey !== "string" || input.apiKey.trim().length === 0)) {
    return { error: "Hosted Ollama Web Search requires a resolved API key.", code: "auth_missing" };
  }
  return { value: {
    baseUrl,
    trustPublicUrl: input?.trustPublicUrl === true,
    ...(official ? { apiKey: input.apiKey } : {}),
    ...(typeof input?.apiKeyEnv === "string" ? { apiKeyEnv: input.apiKeyEnv } : {}),
  } };
}

function isPrivateOllamaOrigin(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (["localhost", "host.docker.internal", "::1"].includes(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) {
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
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

const RELEVANCE_STOP_WORDS = new Set([
  "about", "after", "before", "best", "find", "from", "into", "latest",
  "near", "news", "that", "the", "their", "this", "time", "what", "when",
  "where", "which", "with", "your",
]);

function filterRelevantResults(results, query) {
  const phrases = [...String(query).matchAll(/"([^"]{2,})"/gu)]
    .map((match) => comparableText(match[1]))
    .filter(Boolean);
  const terms = uniqueStrings(
    comparableText(String(query)
      .replace(/"[^"]*"/gu, " ")
      .replace(/\bsite:\S+/giu, " "))
      .split(" ")
      .filter((term) => term.length >= 3 && !RELEVANCE_STOP_WORDS.has(term)),
    20,
  );
  if (phrases.length === 0 && terms.length === 0) return results;
  const requiredTerms = Math.min(terms.length, terms.length >= 3 ? 2 : 1);
  return results.filter((result) => {
    const haystack = comparableText(`${result.title} ${result.snippet} ${result.url}`);
    if (phrases.some((phrase) => !haystack.includes(phrase))) return false;
    if (requiredTerms === 0) return true;
    let matches = 0;
    for (const term of terms) {
      if (haystack.includes(term)) matches += 1;
      if (matches >= requiredTerms) return true;
    }
    return false;
  });
}

function comparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function queryWithDomains(query, domains) {
  if (domains.length === 0) return query;
  return `${query} (${domains.map((domain) => `site:${domain}`).join(" OR ")})`;
}

function querySiteDomains(query) {
  return [...String(query).matchAll(/\bsite:([a-z0-9.-]+)(?:\/\S*)?/giu)]
    .map((match) => match[1]);
}

function sanitizeFailureMetadata(failures) {
  const seen = new Set();
  const metadata = [];
  for (const failureEntry of failures) {
    const backend = collapseWhitespace(failureEntry?.backend).slice(0, 40) || "unknown";
    const code = ["quota_reserved", "quota_unavailable", "coordination_unavailable", "search_budget_exhausted", "auth_failed", "invalid_response", "timeout", "provider_unavailable", "access_challenge"].includes(failureEntry?.code) ? failureEntry.code : failureEntry?.relevance
      ? "no_relevant_results"
      : failureEntry?.rateLimited ? "rate_limited"
        : failureEntry?.cooldown ? "cooldown"
          : failureEntry?.message === "Network access denied by sandbox policy."
            ? "network_denied"
            : "unavailable";
    const key = `${backend}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    metadata.push({ backend, code });
    if (metadata.length >= 12) break;
  }
  return metadata;
}

function providerAttemptMetadata(failures) {
  return sanitizeFailureMetadata(failures).slice(0, 12).map((entry) => {
    const source = failures.find((failureEntry) => collapseWhitespace(failureEntry?.backend).slice(0, 40) === entry.backend
      && sanitizeFailureMetadata([failureEntry])[0]?.code === entry.code);
    const retryAtMs = Number.isFinite(source?.retryAtMs)
      ? source.retryAtMs
      : Number.isFinite(source?.retryAfterMs) ? Date.now() + source.retryAfterMs : undefined;
    return {
      backend: entry.backend,
      code: entry.code,
      disposition: source?.cooldown || source?.rateLimited ? "deferred_for_run" : "advanced",
      requests: Number.isSafeInteger(source?.requestsConsumed)
        ? source.requestsConsumed
        : source?.cooldown || source?.quotaSkipped ? 0 : 1,
      ...(Number.isFinite(source?.retryAfterMs) ? { retryAfterMs: source.retryAfterMs } : {}),
      ...(retryAtMs === undefined ? {} : { retryAt: new Date(retryAtMs).toISOString() }),
    };
  });
}

function earliestRetryAt(failures) {
  const values = failures.flatMap((entry) => {
    if (Number.isFinite(entry.retryAtMs)) return [entry.retryAtMs];
    if (Number.isFinite(entry.retryAfterMs)) return [Date.now() + entry.retryAfterMs];
    return [];
  }).filter((value) => value >= 0 && value <= 8_640_000_000_000_000);
  return values.length ? Math.min(...values) : undefined;
}

function cooldownBackendNames(searchState) {
  const processNames = [...backendCooldownUntil.keys()].map((key) => key.split(":", 1)[0]);
  const runNames = [...(searchState?.deferredProviders?.keys?.() ?? [])];
  return [...new Set([...processNames, ...runNames])];
}

function searchControlLine(searchState, requestsThisCall, providerFailures, nextAction) {
  const budget = webSearchBudgetSnapshot(searchState, requestsThisCall);
  const deferred = providerFailures.filter((entry) => entry.rateLimited || entry.cooldown).map((entry) => entry.backend);
  const deferText = deferred.length > 0
    ? ` ${[...new Set(deferred)].join(", ")} deferred for the remainder of this run.`
    : "";
  const action = nextAction === "fetch_existing_sources"
    ? "Use WebFetch on the strongest returned URLs before searching again."
    : nextAction === "refine_query"
      ? "Refine the query only for a material evidence gap."
      : "Do not retry WebSearch in this run; use available evidence and state the limitation.";
  return `[Search control: requests=${budget.requestsUsed}/${budget.maxRequestsPerRun}; remaining=${budget.requestsRemaining};${deferText} ${action}]`;
}

function searchMetadataLine({ backend, attemptedBackends, query, providerFailures }) {
  const attempted = attemptedBackends.join(",") || "none";
  const failures = sanitizeFailureMetadata(providerFailures)
    .map((entry) => `${entry.backend}:${entry.code}`)
    .join(",") || "none";
  return `[Search metadata: backend=${backend}; attempted=${attempted}; actual_query=${JSON.stringify(collapseWhitespace(query).slice(0, 500))}; fallback=${failures}]`;
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
      throw Object.assign(new Error(`search response exceeded ${SEARCH_RESPONSE_MAX_BYTES} bytes`), { code: "response_too_large" });
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
      throw Object.assign(new Error(`search response exceeded ${SEARCH_RESPONSE_MAX_BYTES} bytes`), { code: "response_too_large" });
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
  const code = error?.code ?? error?.cause?.code;
  const retryable = code !== "search_budget_exhausted" && (name === "AbortError"
    || name === "TimeoutError"
    || RETRYABLE_FETCH_CODES.has(code));
  const message = error?.message || String(error);
  const cause = error?.cause?.message;
  const detail = cause && cause !== message ? `${message} (${cause})` : message;
  return {
    ok: false,
    backend,
    message: `${label} request failed: ${detail}`,
    retryable,
    ...(code === undefined ? {} : { code }),
  };
}

function ollamaFetchFailure(error, signal) {
  const base = fetchFailure("ollama", error, "Ollama Web Search");
  const abortCode = signal?.aborted
    ? (signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted")
    : undefined;
  const suppliedCode = error?.code ?? error?.cause?.code;
  const code = abortCode
    || (suppliedCode === "search_budget_exhausted" ? "search_budget_exhausted" : undefined)
    || (suppliedCode === "deadline_exceeded" ? "deadline_exceeded" : undefined)
    || (suppliedCode === "response_too_large" ? "response_too_large" : undefined)
    || (suppliedCode === "invalid_response" ? "invalid_response" : undefined)
    || (error?.name === "AbortError" ? "aborted" : undefined)
    || (error?.name === "TimeoutError" ? "timeout" : undefined)
    || "provider_unavailable";
  return {
    ...base,
    code,
    retryable: !["aborted", "response_too_large", "invalid_response", "search_budget_exhausted"].includes(code),
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

function searchFailure(text, code, startedAt, searchState, requestsThisCall, extra = {}) {
  const budget = webSearchBudgetSnapshot(searchState, requestsThisCall);
  const retryAfterMs = extra.retryAfterMs;
  const retryAt = extra.retryAt;
  const guidance = code === "rate_limited"
    ? `Provider retry${Number.isFinite(retryAfterMs) ? ` after ${Math.ceil(retryAfterMs / 1000)} seconds` : " time is unknown"}${retryAt ? `, at ${retryAt}` : ""}. Do not sleep or retry WebSearch to wait out this cooldown in this run. Fetch already returned URLs, or answer from available evidence and state the limitation.`
    : code === "search_budget_exhausted"
      ? "Do not retry WebSearch in this run. Fetch already returned URLs, or answer from available evidence and state the limitation."
      : "";
  const completeText = guidance
    ? `${text}\n${guidance}\nSearch requests used: ${budget.requestsUsed}/${budget.maxRequestsPerRun}.`
    : text;
  return failure(completeText, code, startedAt, {
    ...extra,
    ...budget,
    retryInRun: extra.retryInRun ?? false,
    nextAction: extra.nextAction ?? "use_available_evidence",
    bytes: Buffer.byteLength(completeText, "utf8"),
  });
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

async function guardedSearch(kind, key, options, execute) {
  try {
    if (options.coordinator || !["ollama", "searxng"].includes(kind)) {
      return await coordinatedWebRequest(options.coordinator, kind, key, options.signal, execute);
    }
    const cooldown = processCooldownRemaining(kind, key);
    if (cooldown > 0) return processCooldownResult(kind, cooldown);
    const scopedKey = processCooldownKey(kind, key);
    let semaphore = processProviderSemaphores.get(scopedKey);
    if (!semaphore) {
      semaphore = createCountingSemaphore(1);
      processProviderSemaphores.set(scopedKey, semaphore);
    }
    const release = await semaphore.acquire(options.signal);
    try {
      const queuedCooldown = processCooldownRemaining(kind, key);
      if (queuedCooldown > 0) return processCooldownResult(kind, queuedCooldown);
      const result = await execute();
      if (result?.rateLimited) {
        const retryAfterMs = result.retryAfterMs ?? keylessThrottle.cooldownMs;
        const retryAtMs = Date.now() + retryAfterMs;
        backendCooldownUntil.set(scopedKey, retryAtMs);
        return { ...result, retryAfterMs, retryAtMs };
      }
      return result;
    } finally {
      release();
    }
  }
  catch (error) { return webRequestFailure(error, kind, options.signal); }
}

function processCooldownResult(backend, retryAfterMs) {
  return {
    ok: false,
    backend,
    code: "rate_limited",
    message: `${backend} is cooling down.`,
    retryable: true,
    cooldown: true,
    rateLimited: true,
    retryAfterMs,
    retryAtMs: Date.now() + retryAfterMs,
  };
}

function parseRetryAfter(response) {
  const raw = response?.headers?.get("retry-after");
  if (!raw) return undefined;
  const now = Date.now();
  const value = raw.trim();
  let ms;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return undefined;
    ms = seconds * 1000;
  } else {
    // Retry-After allows only an integer delta-seconds or an HTTP date. Do not
    // let Date.parse reinterpret malformed numeric values such as "1.5" as a
    // calendar date.
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return undefined;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return undefined;
    ms = parsed - now;
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(8_640_000_000_000_000 - now, Math.max(1000, ms));
}

function shortestRetry(failures) {
  const waits = failures.map((r) => r.retryAfterMs).filter((n) => Number.isFinite(n) && n > 0);
  return waits.length ? Math.min(...waits) : undefined;
}
