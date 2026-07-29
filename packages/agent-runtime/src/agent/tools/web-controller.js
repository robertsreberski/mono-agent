// @ts-check

import { randomUUID } from "node:crypto";
import { performWebFetch } from "./web-fetch.js";
import { performWebSearch } from "./web-search.js";

const MAX_CACHE_ENTRIES = 64;

/**
 * One ephemeral web-tool controller for one model run. It owns in-memory
 * deduplication, result caches, anonymous browser namespaces, and cleanup.
 *
 * @param {{searchConfig?: any, fetchConfig?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, fetchImpl?: typeof fetch, browserRenderer?: any}} [options]
 */
export function createWebToolController({
  searchConfig,
  fetchConfig,
  sandboxPolicy,
  sandboxEngine,
  ctx,
  fetchImpl,
  browserRenderer,
} = {}) {
  const namespace = `mono-agent-web-${randomUUID()}`;
  const searchCache = new Map();
  const fetchCache = new Map();
  const searchInFlight = new Map();
  const fetchInFlight = new Map();
  const cleanups = new Set();
  let closed = false;

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
        while (cache.size > MAX_CACHE_ENTRIES) {
          cache.delete(cache.keys().next().value);
        }
      }
      return result;
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    namespace,

    async search(params, execution = {}) {
      const key = stableKey(params);
      return cachedRun(searchCache, searchInFlight, key, async () => performWebSearch(params, {
        searchConfig,
        sandboxPolicy,
        ctx,
        fetchImpl,
        signal: execution.signal,
      }));
    },

    async fetch(params, execution = {}) {
      const key = stableKey(params);
      return cachedRun(fetchCache, fetchInFlight, key, async () => performWebFetch(params, {
        fetchConfig,
        sandboxPolicy,
        sandboxEngine,
        ctx,
        fetchImpl,
        browserRenderer,
        signal: execution.signal,
        namespace,
        registerCleanup,
      }));
    },

    async close() {
      if (closed) return;
      closed = true;
      const pending = [...cleanups];
      cleanups.clear();
      await Promise.allSettled(pending.map((cleanup) => Promise.resolve().then(cleanup)));
      searchCache.clear();
      fetchCache.clear();
      searchInFlight.clear();
      fetchInFlight.clear();
    },
  };
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
    outcome: result.outcome ? { ...result.outcome } : result.outcome,
  };
}

function withCacheHit(result) {
  return {
    ...cloneResult(result),
    outcome: {
      ...(result.outcome || {}),
      cacheHit: true,
    },
  };
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
