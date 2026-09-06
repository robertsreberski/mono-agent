// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";
import { performWebFetch, formatWebFetchDocument } from "./web-fetch.js";
import { performWebSearch } from "./web-search.js";
import { createWebSearchRunState, webSearchBudgetSnapshot } from "./web-search-state.js";

const MAX_CACHE_ENTRIES = 64;
const MAX_SHARED_SEARCH_ENTRIES = 256;
const SHARED_SEARCH_TTL_MS = 15 * 60_000;

// Search results are shared process-wide rather than per model run. A run-scoped
// cache dies at the end of every turn and is invisible to sibling subagents, so
// an agent that keeps circling the same topic re-hits the network every time —
// which is exactly the request volume that gets keyless engines to rate-limit.
// One process is one agent instance, so the sharing stays inside one tenant.
//
// Only completed results are shared. In-flight promises stay per-controller on
// purpose: they carry the originating run's AbortSignal, and handing that to a
// sibling would let one turn's cancellation fail another turn's search.
/** @type {Map<string, {value: any, expiresAt: number}>} */
const sharedSearchCache = new Map();

/**
 * One ephemeral web-tool controller for one model run. It owns in-memory
 * deduplication, the fetch result cache, anonymous browser namespaces, and
 * cleanup. Search results are the exception: they live in the process-wide
 * cache above so sibling subagents and later turns can reuse them.
 *
 * @param {{coordinator?: any, searchConfig?: any, searchState?: any, fetchConfig?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, fetchImpl?: typeof fetch, browserRenderer?: any, codexSearch?: any}} [options]
 */
export function createWebToolController({
  coordinator,
  searchConfig,
  searchState: suppliedSearchState,
  fetchConfig,
  sandboxPolicy,
  sandboxEngine,
  ctx,
  fetchImpl,
  browserRenderer,
  codexSearch,
} = {}) {
  const namespace = `mono-agent-web-${randomUUID()}`;
  const fetchCache = new Map();
  const searchInFlight = new Map();
  const fetchInFlight = new Map();
  const cleanups = new Set();
  let closed = false;
  const searchState = createWebSearchRunState(searchConfig, suppliedSearchState);

  function registerCleanup(cleanup) {
    if (closed) {
      void Promise.resolve().then(cleanup);
      return () => {};
    }
    cleanups.add(cleanup);
    return () => cleanups.delete(cleanup);
  }

  /**
   * @param {Map<string, any>} cache
   * @param {Map<string, Promise<any>>} inFlight
   * @param {string} key
   * @param {() => Promise<any>} execute
   */
  async function cachedRun(cache, inFlight, key, execute) {
    if (closed) return closedResult();
    const cached = cache.get(key);
    if (cached) return withCacheHit(cached);
    const active = inFlight.get(key);
    if (active) return withCacheHit(await active);
    const task = Promise.resolve().then(execute);
    inFlight.set(key, task);
    try {
      const result = await task;
      if (!result.error) {
        cache.set(key, cloneResult(result));
        while (cache.size > MAX_CACHE_ENTRIES || [...cache.values()].reduce((n, r) => n + Buffer.byteLength(r.document?.body || "", "utf8"), 0) > 32 * 1024 * 1024) {
          cache.delete(cache.keys().next().value);
        }
      }
      return result;
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * @param {string} key
   * @param {() => Promise<any>} execute
   */
  async function cachedSearch(key, query, execute) {
    if (closed) return closedResult();
    const cached = readSharedSearch(key);
    if (cached) return withSearchCacheHit(cached, searchState, query);
    const active = searchInFlight.get(key);
    if (active) return withSearchCacheHit(await active, searchState, query);
    const task = Promise.resolve().then(execute);
    searchInFlight.set(key, task);
    try {
      const result = await task;
      // Failures stay uncached; the backend cooldown in web-search.js is what
      // stops a rate-limited engine from being hammered again.
      if (!result.error) writeSharedSearch(key, cloneResult(result));
      return result;
    } finally {
      searchInFlight.delete(key);
    }
  }

  return {
    namespace,

    async search(params, execution = {}) {
      if (execution.signal?.aborted) return { text: "Error: WebSearch was aborted.", error: true, outcome: { status: "error", code: "aborted" } };
      // The key must pin the backend, the endpoint AND the network policy the
      // search actually ran under. A params-only key was safe while the cache
      // lived and died with one run; process-wide it would let controllers with
      // different backends read each other's results.
      //
      // The policy has to be the RESOLVED one, computed exactly as
      // performWebSearch computes it: the effective policy is the context
      // policy merged with the request policy, so keying on the request half
      // alone would let a run whose context denies network read entries a
      // network-allowed run had populated. Resolved per call because
      // readToolRuntime() is mutable process state.
      //
      // The snapshot is then handed to performWebSearch as the request policy
      // rather than letting it re-resolve. Execution is deferred by a microtask
      // and updateToolContext mutates the context in place by design, so a
      // re-resolve could enforce a policy the key never described — caching a
      // network-allowed result under a denied key. Merging is monotonic, so
      // passing the snapshot back in means enforcement can only be at least as
      // strict as the key claims.
      const resolvedCtx = ctx ?? readToolRuntime();
      const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
      const key = stableKey({ params, searchConfig: safeSearchCacheIdentity(searchConfig), policy, coordination: coordinator?.scope });
      return cachedSearch(key, params.query, async () => performWebSearch(params, {
        coordinator,
        searchConfig,
        sandboxPolicy: policy,
        ctx: resolvedCtx,
        fetchImpl,
        codexSearch,
        searchState,
        signal: execution.signal,
      }));
    },

    async fetch(params, execution = {}) {
      if (execution.signal?.aborted) return { text: "Error: WebFetch was aborted.", error: true, outcome: { status: "error", code: "aborted" } };
      const resolvedCtx = ctx ?? readToolRuntime();
      const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
      const { start_line, max_lines, max_output_chars, ...request } = params;
      if ((start_line !== undefined && (!Number.isSafeInteger(start_line) || start_line < 1))
        || (max_lines !== undefined && (!Number.isSafeInteger(max_lines) || max_lines < 1 || max_lines > 10000))) {
        return { text: "Error: Invalid WebFetch line range.", error: true, outcome: { status: "error", code: "invalid_range" } };
      }
      const key = stableKey({ request, fetchConfig, policy, coordination: coordinator?.scope });
      const result = await cachedRun(fetchCache, fetchInFlight, key, async () => performWebFetch(request, {
        documentOnly: true, coordinator, fetchConfig, sandboxPolicy: policy, sandboxEngine,
        ctx: resolvedCtx, fetchImpl, browserRenderer, signal: execution.signal,
        namespace, registerCleanup,
      }));
      if (result.error || !result.document) return result;
      const sliced = formatWebFetchDocument({ ...result.document, outcome: result.outcome }, params, resolvedCtx);
      return { ...sliced, document: undefined, outcome: { ...sliced.outcome, cacheHit: result.outcome.cacheHit } };
    },

    async close() {
      if (closed) return;
      closed = true;
      const pending = [...cleanups];
      cleanups.clear();
      await Promise.allSettled(pending.map((cleanup) => Promise.resolve().then(cleanup)));
      // The shared search cache deliberately outlives the controller; only
      // run-owned state (browser namespaces, fetch results, in-flight work) is
      // dropped here.
      fetchCache.clear();
      searchInFlight.clear();
      fetchInFlight.clear();
    },
  };
}

function safeSearchCacheIdentity(searchConfig) {
  if (!searchConfig || typeof searchConfig !== "object") return searchConfig;
  const { maxRequestsPerRun: _budget, ...identity } = searchConfig;
  if (typeof searchConfig?.ollama?.apiKey !== "string") return identity;
  return {
    ...identity,
    ollama: {
      ...searchConfig.ollama,
      apiKey: `sha256:${createHash("sha256").update(searchConfig.ollama.apiKey).digest("hex")}`,
    },
  };
}

function readSharedSearch(key) {
  const entry = sharedSearchCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    sharedSearchCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeSharedSearch(key, value) {
  sharedSearchCache.set(key, { value, expiresAt: Date.now() + SHARED_SEARCH_TTL_MS });
  // Drop expired entries before falling back to insertion-order eviction, so a
  // burst of stale keys cannot push a live one out.
  for (const [entryKey, entry] of sharedSearchCache) {
    if (Date.now() >= entry.expiresAt) sharedSearchCache.delete(entryKey);
  }
  while (sharedSearchCache.size > MAX_SHARED_SEARCH_ENTRIES) {
    sharedSearchCache.delete(sharedSearchCache.keys().next().value);
  }
}

/** Test hook: the shared cache is module state and would leak between cases. */
export function __resetSharedSearchCacheForTests() {
  sharedSearchCache.clear();
}

function stableKey(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

function cloneResult(result) {
  return {
    ...result,
    outcome: result.outcome ? {
      ...result.outcome,
      ...(Array.isArray(result.outcome.providerAttempts)
        ? { providerAttempts: result.outcome.providerAttempts.map((entry) => ({ ...entry })) }
        : {}),
      ...(Array.isArray(result.outcome.failureMetadata)
        ? { failureMetadata: result.outcome.failureMetadata.map((entry) => ({ ...entry })) }
        : {}),
    } : result.outcome,
  };
}

function withCacheHit(result) {
  return {
    ...cloneResult(result),
    outcome: {
      ...(result.outcome || {}),
      cacheHit: true,
      attempts: 0, durationMs: 0, queueWaitMs: 0, backendDurationMs: 0,
      cooldownSkipCount: 0, quotaSkipCount: 0,
    },
  };
}

function withSearchCacheHit(result, searchState, requestedQuery) {
  const cloned = withCacheHit(result);
  const budget = webSearchBudgetSnapshot(searchState, 0);
  const resultCount = Number.isSafeInteger(cloned.outcome?.resultCount) ? cloned.outcome.resultCount : 0;
  const nextAction = resultCount > 0
    ? "fetch_existing_sources"
    : budget.requestsRemaining > 0 ? "refine_query" : "use_available_evidence";
  const action = nextAction === "fetch_existing_sources"
    ? "Use WebFetch on the strongest returned URLs before searching again."
    : nextAction === "refine_query"
      ? "Refine the query only for a material evidence gap."
      : "Do not retry WebSearch in this run; use available evidence and state the limitation.";
  const control = `[Search control: requests=${budget.requestsUsed}/${budget.maxRequestsPerRun}; remaining=${budget.requestsRemaining}; ${action}]`;
  const query = collapseWhitespace(requestedQuery).slice(0, 500);
  const metadata = `[Search metadata: backend=${cloned.outcome?.backend || "unknown"}; attempted=none; actual_query=${JSON.stringify(query)}; fallback=none]`;
  const textWithControl = typeof cloned.text === "string" && cloned.text.startsWith("[Search control:")
    ? cloned.text.replace(/^\[Search control:[^\n]*\]/u, control)
    : `${control}\n${cloned.text}`;
  const text = textWithControl.includes("[Search metadata:")
    ? textWithControl.replace(/^\[Search metadata:[^\n]*\]/mu, metadata)
    : textWithControl.replace("[BEGIN UNTRUSTED WEB SEARCH RESULTS]", `[BEGIN UNTRUSTED WEB SEARCH RESULTS]\n${metadata}`);
  const {
    retryAfterMs: _retryAfterMs,
    retryAt: _retryAt,
    retryAtMs: _retryAtMs,
    ...cachedOutcome
  } = cloned.outcome || {};
  return {
    ...cloned,
    text,
    outcome: {
      ...cachedOutcome,
      ...budget,
      bytes: Buffer.byteLength(text, "utf8"),
      attemptedBackends: [],
      actualQueries: [],
      providerAttempts: [],
      failureMetadata: [],
      providerFailureCount: 0,
      rateLimited: false,
      cooldownBackends: [],
      fallbackUsed: false,
      retryInRun: budget.requestsRemaining > 0,
      nextAction,
    },
  };
}

function collapseWhitespace(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function closedResult() {
  const text = "Error: Web tool controller has already closed.";
  return {
    text,
    outcome: {
      status: "error",
      code: "controller_closed",
      retryable: false,
      attempts: 0,
      backend: "none",
      cacheHit: false,
      durationMs: 0,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
    },
    error: true,
  };
}
