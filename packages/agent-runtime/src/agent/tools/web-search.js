// @ts-check

import { parallelSessionId } from "./parallel-mcp.js";
import { withWebDeadline } from "./web-request.js";
import { passthroughSandbox } from "../sandbox-seam.js";
import { searchCodexSubscription } from "./codex-subscription-search.js";
import { requireToolContext, resolveSandboxPolicy } from "./shared/tool-context.js";
import { webSearchProviders, expandSearchProvider } from "./web-search-providers/registry.js";
import { guardedSearch, canonicalizeSearchUrl, collapseWhitespace, cooldownBackendNames } from "./web-search-providers/shared.js";
export { canonicalizeSearchUrl, __resetWebSearchThrottleForTests } from "./web-search-providers/shared.js";
export { parseDuckDuckGoResults } from "./web-search-providers/duckduckgo.js";
export { parseStartpageResults } from "./web-search-providers/startpage.js";
import { boundWebSearchEntries } from "./web-search-output.js";
import { buildWebNextAction, formatActionableEnvelope, webStatusForCode } from "./web-actionable.js";
import { normalizeSearchCountry, unsupportedCountryFilter } from "./web-search-country.js";
import {
  refundWebSearchRequests,
  createWebSearchRunState,
  deferWebSearchProvider,
  deferredWebSearchProvider,
  MAX_WEB_SEARCH_REQUESTS_PER_RUN,
  webSearchBudgetSnapshot,
} from "./web-search-state.js";

const RRF_K = 60;

// Only bounded, sanitized attempt metadata survives between calls in a run.
// Weak ownership avoids retaining finished run states or their query text.
const runProviderFailures = new WeakMap();

/**
 * Compatibility wrapper for direct callers.
 *
 * @param {{query: string, limit?: number, alternate_queries?: string[], domains?: string[], exclude_domains?: string[], language?: string, country?: string, time_range?: string}} params
 * @param {{ctx: import("./shared/tool-context.js").ToolContext, sandboxPolicy?: any, signal?: AbortSignal, coordinator?: any, searchConfig?: any, fetchImpl?: typeof fetch}} options
 */
export async function webSearchToolImpl(params, options) {
  return (await performWebSearch(params, options)).text;
}

/**
 * Search through an explicitly selected Ollama endpoint, an operator-owned
 * SearXNG endpoint, ChatGPT-subscription Codex search, and/or the keyless HTML fallback chain. Returns a structured
 * internal outcome for the Pi bridge.
 *
 * @param {{query: string, limit?: number, alternate_queries?: string[], domains?: string[], exclude_domains?: string[], language?: string, country?: string, time_range?: string}} params
 * @param {{ctx: import("./shared/tool-context.js").ToolContext, sandboxPolicy?: any, signal?: AbortSignal, coordinator?: any, searchConfig?: any, searchState?: any, fetchImpl?: typeof fetch, codexSearch?: typeof searchCodexSubscription}} options
 */
export async function performWebSearch(params, options) {
  const resolvedCtx = requireToolContext(options?.ctx);
  const resolvedOptions = { ...(options ?? {}), ctx: resolvedCtx };
  return await withWebDeadline(resolvedOptions.signal, 60_000, (signal) => performSearch(params, { ...resolvedOptions, signal }));
}

/**
 * Search through an operator-owned SearXNG endpoint, ChatGPT-subscription
 * Codex search, and/or the keyless HTML fallback chain. Returns a structured
 * internal outcome for the Pi bridge.
 *
 * @param {{query: string, limit?: number, alternate_queries?: string[], domains?: string[], exclude_domains?: string[], language?: string, country?: string, time_range?: string}} params
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
    country: requestedCountry,
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
  const normalizedCountry = normalizeSearchCountry(requestedCountry);
  if (normalizedCountry.error) {
    return searchFailure(`Error: ${normalizedCountry.error}`, "invalid_country", startedAt, searchState, callClaims.requests);
  }
  const country = normalizedCountry.value;
  const max = clampInteger(limit, 1, 10, 5);
  const explicitDomains = normalizeDomains(Array.isArray(domains) ? domains : []);
  const includeDomains = normalizeDomains([...explicitDomains, ...querySiteDomains(normalizedQuery)]);
  const excludeDomains = normalizeDomains(exclude_domains);
  const config = normalizeSearchConfig(searchConfig);
  if ("error" in config) return searchFailure(
    `Error: ${config.error}`,
    config.code ?? "invalid_search_config",
    startedAt,
    searchState,
    callClaims.requests,
  );

  const resolvedCtx = requireToolContext(ctx);
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  // Operators, quotes, and site: constraints are never relaxed or rewritten by
  // the host. Alternate queries are explicit model input, not host-generated
  // substitutions for the user's exact primary query.
  const initialQueries = uniqueStrings([normalizedQuery, ...alternate_queries], 4);
  /** @type {Array<Array<{title: string, url: string, snippet: string, backend: string}>>} */
  const rankedLists = [];
  const providerFailures = [];
  const engineOutcomes = [];
  let partialEngines = false;
  let houndStopped = false;
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
        chained: Array.isArray(config.backend) && config.backend.length > 1,
        language,
        country,
        timeRange: time_range,
        sandbox,
        policy,
        signal: stageSignal,
        fetchImpl,
        codexSearch,
        searchState,
        callClaims,
        maxResults: max,
        queries: webSearchProviders.get(backend)?.batchesQueries ? initialQueries : undefined,
        sessionId: parallelSessionId(resolvedCtx, searchState),
      },
    );
  };
  const recordResult = (result) => {
    queueWaitMs += result.coordinationWaitMs || 0;
    backendDurationMs += result.backendDurationMs || 0;
    // Chain failures are reported even when a later backend rescued the query,
    // so a silent degradation to the fallback is still visible in the outcome.
    if (result.failures?.length) providerFailures.push(...result.failures);
    if (result.backend === "hound" && Array.isArray(result.engineOutcomes)) {
      engineOutcomes.push(...result.engineOutcomes.slice(0, 3));
      partialEngines ||= result.partial === true;
      // Only a terminal local-provider failure (no answer possible now) marks
      // the provider stopped. A per-engine denial on a search that still
      // answered must never gate the chain or the remaining query variants.
      houndStopped ||= result.ok === false && result.engineOutcomes.some((entry) => ["robots_denied", "robots_unavailable", "robots_crawl_delay", "access_challenge", "authentication_required", "rate_limited", "search_budget_exhausted", "network_denied"].includes(entry.code));
    }
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

  // A primary query walks the explicit ordered chain before alternate wording.
  // A single provider name remains strict; keyless is a virtual group.
  const eligibleBackends = Array.isArray(config.backend) ? config.backend : [config.backend];
  const disabledForCall = new Set();
  let merged = [];
  for (let queryIndex = 0; queryIndex < initialQueries.length && merged.length === 0; queryIndex += 1) {
    const candidate = initialQueries[queryIndex];
    for (const backend of eligibleBackends) {
      if (signal?.aborted || disabledForCall.has(backend)) continue;
      // Subscription search remains exactly one turn per WebSearch call.
      if ((webSearchProviders.get(backend)?.primaryOnly || webSearchProviders.get(backend)?.batchesQueries) && queryIndex > 0) continue;
      const run = (stageSignal) => runQuery(candidate, backend, stageSignal);
      const result = webSearchProviders.get(backend)?.chainDeadlineMs && eligibleBackends.length > 1
        ? await withWebDeadline(signal, webSearchProviders.get(backend).chainDeadlineMs, run)
        : await run(signal);
      const usable = recordResult(result);
      if (usable) {
        merged = mergeRankedResults(rankedLists, max);
        break;
      }
      if (!result.ok && !result.relevance) disabledForCall.add(backend);
      // A stopped local provider only stops further local attempts (via
      // disabledForCall above); the chain still advances to the next
      // configured backend, and alternate queries still run against it. Only
      // run-wide terminal conditions stop the whole call.
      if (providerFailures.some((entry) => ["coordination_unavailable", "search_budget_exhausted"].includes(entry.code))) break;
    }
    if (providerFailures.some((entry) => ["coordination_unavailable", "search_budget_exhausted"].includes(entry.code))) break;
  }
  rememberRunProviderFailures(searchState, providerFailures);
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
    return searchFailure(searchBudgetExhaustionMessage(searchState, providerFailures), "search_budget_exhausted", startedAt, searchState, callClaims.requests, {
      attempts,
      ...(engineOutcomes.length ? { engineOutcomes: engineOutcomes.slice(0, 12) } : {}),
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
    const terminalHoundCode = houndStopped ? providerFailures.find((entry) => entry.backend === "hound")?.code : undefined;
    const strictProviderCode = !Array.isArray(config.backend)
      ? providerFailures.find((entry) => typeof entry.code === "string")?.code
      : undefined;
    const retryAfterMs = shortestRetry(providerFailures);
    const retryAt = earliestRetryAt(providerFailures);
    return searchFailure(networkDenied
      ? "Error: Network access denied by sandbox policy."
      : `Error: WebSearch failed: ${reason}`,
    networkDenied ? "network_denied" : (throttled ? "rate_limited" : (terminalHoundCode || strictProviderCode || "backend_unavailable")), startedAt, searchState, callClaims.requests, {
      attempts,
      ...(engineOutcomes.length ? { engineOutcomes: engineOutcomes.slice(0, 12) } : {}),
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
      ...(country ? {
        filterSupport: { country: providerFailures.length > 0 && providerFailures.every((entry) => entry.code === "unsupported_country_filter") ? "unsupported" : "not_applied" },
        requestedFilters: {
          country,
          note: "Country is a provider-dependent localization preference, not a guarantee that results are located there; IP-based ranking may still apply.",
        },
      } : {}),
    });
  }

  const backend = providersUsed.size === 1
    ? [...providersUsed][0]
    : providersUsed.size > 1 ? "mixed" : config.backend;
  const bounded = boundWebSearchEntries(merged);
  const budget = webSearchBudgetSnapshot(searchState, callClaims.requests);
  const retryInRun = !houndStopped && searchState.requestsUsed < searchState.maxRequests;
  const nextAction = bounded.resultCount > 0
    ? "fetch_existing_sources"
    : retryInRun ? "refine_query" : "use_available_evidence";
  const code = bounded.resultCount === 0 ? "no_results" : "ok";
  // Lossy output truncation is honest incompleteness; a rescued chain whose
  // results are whole stays ok with its degradation disclosed in coverage.
  // Result entries double as the source citations (title/url/published), so no
  // separate sources array duplicates them. The entries JSON is already bounded
  // to the 64 KiB allocation inside boundWebSearchEntries; envelope framing
  // (summary, coverage, next actions) stays outside it, as the old
  // control/metadata framing did.
  const fittedEntries = bounded.entries;
  const omittedCount = bounded.omittedCount;
  const truncatedFinal = bounded.truncated;
  const status = truncatedFinal || partialEngines ? "partial" : "ok";
  const actualQueryList = uniqueStrings(actualQueries.length > 0 ? actualQueries : [normalizedQuery], 4);
  const failureSummary = sanitizeFailureMetadata(providerFailures)
    .map((entry) => `${entry.backend}:${entry.code}`);
  const coverage = {
    resultCount: fittedEntries.length,
    ...(engineOutcomes.length ? { engineOutcomes: engineOutcomes.slice(0, 12), partialEngines, searchStopped: houndStopped } : {}),
    truncated: truncatedFinal,
    ...(omittedCount > 0 ? { omittedResults: omittedCount } : {}),
    backend,
    attemptedBackends: [...attemptedBackends],
    actualQueries: actualQueryList,
    ...(failureSummary.length > 0 ? { failureSummary } : {}),
    providerFailureCount: providerFailures.length,
    fallbackUsed: attemptedBackends.size > 1,
    rateLimited: providerFailures.some((entry) => entry.rateLimited || entry.cooldown),
    cooldownBackends: cooldownBackendNames(searchState),
    filterSupport: {
      language: language ? (webSearchProviders.get(backend)?.filterSupport.language ?? "advisory") : "not_requested",
      country: country ? (webSearchProviders.get(backend)?.filterSupport.country ?? "provider_dependent") : "not_requested",
      timeRange: time_range ? (webSearchProviders.get(backend)?.filterSupport.timeRange ?? "provider") : "not_requested",
    },
    ...(language || country || time_range ? { requestedFilters: {
      ...(language ? { language: collapseWhitespace(language).slice(0, 100) } : {}),
      ...(country ? { country } : {}),
      ...(time_range ? { timeRange: collapseWhitespace(time_range).slice(0, 100) } : {}),
      note: country
        ? "Country is a provider-dependent localization preference, not a guarantee that results are located there; IP-based ranking may still apply. Verify dates in sources."
        : "Provider-dependent; verify dates in sources.",
    } } : {}),
    ...budget,
    retryInRun,
  };
  const shownQuery = collapseWhitespace(actualQueryList[0] || normalizedQuery).slice(0, 120);
  const summary = fittedEntries.length > 0
    ? `${status === "partial" ? "Partially showing" : "Found"} ${fittedEntries.length} result${fittedEntries.length === 1 ? "" : "s"} from ${backend} for ${JSON.stringify(shownQuery)}. Snippets are untrusted discovery leads, not fetched evidence; use WebFetch for evidence.`
    : `No results from ${backend} for ${JSON.stringify(shownQuery)}.`;
  const next_actions = [];
  if (fittedEntries.length > 0) {
    for (const entry of fittedEntries) {
      if (next_actions.length >= 3) break;
      if (typeof entry?.url !== "string" || entry.url.length === 0 || entry.url.length > 2000) continue;
      // Only suggest fetching URLs the resolved network policy actually
      // allows. A denied URL stays visible as a discovery lead in results,
      // but never becomes a next action; hints confer no authority. Tool
      // exposure (whether WebFetch is enabled for the run) is enforced at
      // the delivery boundaries that know it (controller cache reads and the
      // Pi bridge), which re-filter these candidates.
      let policyAllows = false;
      try {
        policyAllows = sandbox.networkAllowsUrl(policy, entry.url);
      } catch {
        policyAllows = false;
      }
      if (!policyAllows) continue;
      const action = buildWebNextAction("WebFetch", { url: entry.url },
        "Fetch the strongest returned URL for evidence; snippets are leads only.");
      if (action) next_actions.push(action);
    }
  }
  const text = formatActionableEnvelope({
    tool: "WebSearch",
    status,
    code,
    summary,
    ...(fittedEntries.length > 0 ? {
      results: fittedEntries.map((entry) => ({
        title: entry.title,
        url: entry.url,
        ...(entry.published === undefined ? {} : { published: entry.published }),
        snippet: entry.snippet,
      })),
    } : {}),
    coverage,
    ...(fittedEntries.length > 0 ? { untrusted_fields: ["results"] } : {}),
    ...(next_actions.length > 0 ? { next_actions } : {}),
  });
  return {
    text,
    outcome: {
      status,
      code,
      retryable: false,
      attempts,
      backend,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: truncatedFinal,
      resultCount: fittedEntries.length,
      queueWaitMs, backendDurationMs,
      cooldownSkipCount: providerFailures.filter((r) => r.cooldown).length,
      quotaSkipCount: providerFailures.filter((r) => r.quotaSkipped).length,
      filterSupport: coverage.filterSupport,
      ...(engineOutcomes.length ? { engineOutcomes: engineOutcomes.slice(0, 12), partialEngines, searchStopped: houndStopped } : {}),
      providerFailureCount: providerFailures.length,
      rateLimited: coverage.rateLimited,
      cooldownBackends: coverage.cooldownBackends,
      attemptedBackends: coverage.attemptedBackends,
      actualQueries: actualQueryList,
      failureMetadata: sanitizeFailureMetadata(providerFailures),
      ...budget,
      fallbackUsed: coverage.fallbackUsed,
      retryInRun,
      nextAction,
      ...(next_actions.length > 0 ? { next_actions } : {}),
      providerAttempts: providerAttemptMetadata(providerFailures),
    },
    error: false,
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

async function searchWithRequestCount({ searchState, callClaims }, execute) {
  // Provider attempts within a call are sequential; concurrent calls each have
  // their own counter. Never derive a refund from the shared run-state delta.
  const before = callClaims.requests;
  const result = await execute();
  if (result.ok !== true) {
    refundWebSearchRequests(searchState, callClaims.requests - before, callClaims);
  }
  return {
    ...result,
    requestsConsumed: callClaims.requests - before,
    // Codex and coordinator failures may preserve only the error code. Recover
    // the marker from the monotonic counter without changing those contracts.
    ...(result.code === "search_budget_exhausted" && searchState.dispatchesUsed >= searchState.maxRequests * 4
      ? { reason: "dispatch_ceiling" } : {}),
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
  const backend = input?.backend ?? ["parallel", "ollama"];
  if (backend === "auto") {
    const previous = [...(input?.ollama ? ["ollama"] : []), ...(input?.endpoint || input?.searxng?.endpoint ? ["searxng"] : []), "codex", "keyless"];
    return { error: `tools.web.search.backend "auto" was removed; use ${JSON.stringify(previous)} (the previous auto order for this configuration)` };
  }
  const names = Array.isArray(backend) ? backend : [backend];
  if (!names.length || names.some((name) => name !== "keyless" && !webSearchProviders.has(name))) {
    return { error: "Unknown web search provider." };
  }
  if (new Set(names).size !== names.length) return { error: "Web search chain contains duplicate providers." };
  const maxRequestsPerRun = input?.maxRequestsPerRun ?? 4;
  if (!Number.isSafeInteger(maxRequestsPerRun) || maxRequestsPerRun < 1 || maxRequestsPerRun > MAX_WEB_SEARCH_REQUESTS_PER_RUN) {
    return { error: `Web search maxRequestsPerRun must be an integer from 1 to ${MAX_WEB_SEARCH_REQUESTS_PER_RUN}.` };
  }
  /** @type {{backend: string | string[], maxRequestsPerRun: number, [key: string]: any}} */
  const config = { backend, maxRequestsPerRun };
  for (const provider of webSearchProviders.values()) {
    const result = provider.configure(input, names.includes(provider.name));
    if (result.error) return { error: result.error, code: result.code };
    Object.assign(config, result.value);
  }
  return config;
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
    const code = ["quota_reserved", "quota_unavailable", "coordination_unavailable", "search_budget_exhausted", "auth_failed", "invalid_response", "endpoint_not_supported", "timeout", "provider_unavailable", "access_challenge", "unsupported_country_filter"].includes(failureEntry?.code) ? failureEntry.code : failureEntry?.relevance
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
        : source?.cooldown || source?.quotaSkipped || source?.preflightSkipped ? 0 : 1,
      ...(Number.isFinite(source?.retryAfterMs) ? { retryAfterMs: source.retryAfterMs } : {}),
      ...(retryAtMs === undefined ? {} : { retryAt: new Date(retryAtMs).toISOString() }),
    };
  });
}

function rememberRunProviderFailures(state, failures) {
  const history = runProviderFailures.get(state) ?? [];
  for (const entry of providerAttemptMetadata(failures)) {
    if (entry.code === "search_budget_exhausted") continue;
    if (history.some((prior) => prior.backend === entry.backend && prior.code === entry.code)) continue;
    if (history.length >= 12) break;
    history.push(entry);
  }
  runProviderFailures.set(state, history);
}

function searchBudgetExhaustionMessage(state, failures) {
  const dispatchCeiling = failures.some((entry) => entry.reason === "dispatch_ceiling");
  const prefix = dispatchCeiling
    ? `Error: WebSearch request budget exhausted: this run spent its dispatches on failing providers (${state.dispatchesUsed}/${state.maxRequests * 4} dispatches).`
    : "Error: WebSearch request budget exhausted for this run.";
  const history = runProviderFailures.get(state) ?? [];
  if (history.length === 0) return prefix;
  const attempts = [...history, ...providerAttemptMetadata(failures).filter((entry) => entry.code === "search_budget_exhausted")];
  const seen = new Set();
  const summary = [];
  for (const entry of attempts) {
    // Never render provider-controlled strings (URLs, bodies, or credentials).
    const backend = webSearchProviders.has(entry.backend) ? entry.backend : "unknown";
    const key = `${backend}:${entry.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const retryMs = entry.retryAt ? Math.max(0, Date.parse(entry.retryAt) - Date.now()) : entry.retryAfterMs;
    const retry = Number.isFinite(retryMs) && retryMs > 0
      ? ` (retry in ${Math.ceil(retryMs / 1000)}s)` : "";
    summary.push(entry.code === "search_budget_exhausted"
      ? `${backend} next dispatch refused`
      : `${backend} ${entry.code}${retry}`);
    if (summary.length >= 8) break;
  }
  return `${prefix} Provider failures this run: ${summary.join("; ")}.`.slice(0, 1000);
}

function earliestRetryAt(failures) {
  const values = failures.flatMap((entry) => {
    if (Number.isFinite(entry.retryAtMs)) return [entry.retryAtMs];
    if (Number.isFinite(entry.retryAfterMs)) return [Date.now() + entry.retryAfterMs];
    return [];
  }).filter((value) => value >= 0 && value <= 8_640_000_000_000_000);
  return values.length ? Math.min(...values) : undefined;
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
  const status = webStatusForCode(code);
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
  const summary = completeText;
  const envelope = formatActionableEnvelope({
    tool: "WebSearch",
    status,
    code,
    summary,
    coverage: {
      ...budget,
      retryInRun: extra.retryInRun ?? false,
      ...(extra.attemptedBackends === undefined ? {} : { attemptedBackends: extra.attemptedBackends }),
      ...(extra.providerAttempts === undefined ? {} : { providerAttempts: extra.providerAttempts }),
      ...(extra.failureMetadata === undefined ? {} : {
        failureSummary: extra.failureMetadata.map((entry) => `${entry.backend}:${entry.code}`),
      }),
      ...(extra.rateLimited === undefined ? {} : { rateLimited: extra.rateLimited }),
      ...(extra.engineOutcomes === undefined ? {} : { engineOutcomes: extra.engineOutcomes }),
      ...(extra.filterSupport === undefined ? {} : { filterSupport: extra.filterSupport }),
      ...(extra.requestedFilters === undefined ? {} : { requestedFilters: extra.requestedFilters }),
      ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
      ...(retryAt === undefined ? {} : { retryAt }),
    },
  });
  return failure(envelope, code, startedAt, {
    ...extra,
    ...budget,
    status,
    retryInRun: extra.retryInRun ?? false,
    nextAction: extra.nextAction ?? "use_available_evidence",
    bytes: Buffer.byteLength(envelope, "utf8"),
  });
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function shortestRetry(failures) {
  const waits = failures.map((r) => r.retryAfterMs).filter((n) => Number.isFinite(n) && n > 0);
  return waits.length ? Math.min(...waits) : undefined;
}

async function searchOneQuery(query, options) {
  const failures = [];
  let emptySuccess;
  const names = expandSearchProvider(options.config.backend);
  for (const name of names) {
    if (options.signal?.aborted) return abortedSearch(name, failures);
    const provider = webSearchProviders.get(name);
    // Capability refusal is deterministic: cooldown expiry or configuration
    // cannot make an unsupported country request dispatchable. Keep it after
    // abort (cancellation has priority), but before cooldown, eligibility,
    // admission, and budget so it has no remote or shared-state side effects.
    // Provider preflight remains for dynamic support such as DDG's region map.
    const preflight = options.country && provider.filterSupport.country === "unsupported"
      ? unsupportedCountryFilter(name)
      : provider.preflight?.(options);
    if (preflight) {
      const result = { ok: false, backend: name, ...preflight };
      if (names.length === 1) return { ...result, failures };
      failures.push(result);
      continue;
    }
    const deferred = deferredResult(options.searchState, name);
    if (deferred) {
      failures.push(deferred);
      continue;
    }
    if (!provider.eligibility(options.config)) {
      failures.push({ ok: false, backend: name, code: "backend_unavailable", message: `${name} requirements are not satisfied.`, retryable: false });
      continue;
    }
    let result;
    if (provider.ownsRequests === true) {
      // Composite adapters gate the actual child URL before each admission.
      // An aggregate .some(denied) check would wrongly deny partial allowlists.
      result = await searchWithRequestCount(options, async () => {
        const value = await provider.search(query, options);
        if (value.ok && value.engineOutcomes?.some((entry) => entry.code === "search_budget_exhausted")
          && !filterRelevantResults(filterByDomains(value.results, options.includeDomains, options.excludeDomains), options.relevanceQuery).length) {
          return { ...value, ok: false, code: "search_budget_exhausted", message: "WebSearch request budget exhausted without useful results.", retryable: false };
        }
        return value;
      });
    } else {
      const admission = provider.admission(options.config);
      if (provider.networkTargets(options.config).some((url) => !options.sandbox.networkAllowsUrl(options.policy, url))) {
        result = { ok: false, backend: name, message: "Network access denied by sandbox policy.", retryable: false };
      } else {
        result = await searchWithRequestCount(options, () => guardedSearch(admission.kind, admission.key,
          { ...options, admission }, () => provider.search(query, options)));
      }
    }
    rememberProviderDeferral(result, options.searchState);
    // Strict names preserve provider errors and raw results for the outer gate.
    if (names.length === 1) return { ...result, failures };
    if (result.ok) {
      if (!result.results.length) { emptySuccess ??= result; continue; }
      const usable = filterRelevantResults(filterByDomains(result.results, options.includeDomains, options.excludeDomains), options.relevanceQuery);
      if (usable.length) return { ...result, results: usable, failures };
      failures.push({ backend: name, message: `${name} returned no relevant results.`, relevance: true });
    } else {
      failures.push(result);
      if (["coordination_unavailable", "search_budget_exhausted"].includes(result.code)) return { ...result, failures };
    }
  }
  return emptySuccess ? { ...emptySuccess, failures } : {
    ...(failures.at(-1) ?? { ok: false, backend: options.config.backend, message: "No configured search backend.", retryable: false }), failures,
  };
}
