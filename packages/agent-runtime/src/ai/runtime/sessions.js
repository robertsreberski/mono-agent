// Provider session registries.
//
// Bridges that support continuous provider sessions (codex-app keeps the
// app-server subprocess + thread alive, pi-sdk keeps a pi Session transcript)
// register their live sessions here, keyed by provider session id. The host
// owns session lifetime policy (which conversation maps to which session,
// when to resume, when to retire); these registries only make sure nothing
// leaks if the host forgets: every entry carries an idle TTL backstop with an
// unref'd timer plus a lazy wall-clock check, so a stalled timer (laptop
// sleep) still cannot resurrect an expired session.
//
// `createSessionRegistry` instances self-register in a module-level set so
// the runtime surface can expose `disposeSession(id)` / `disposeAllSessions()`
// without knowing which bridge owns the id. Provider session ids are unique
// across bridges (codex thread ids, pi uuids), so fan-out dispose is safe.

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const allRegistries = new Set();

function normalizeTtl(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1_000) return fallback;
  return n;
}

export function createSessionRegistry({ idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, onEvict, now = Date.now, isBusy } = {}) {
  const entries = new Map();
  const defaultTtlMs = normalizeTtl(idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);

  async function evict(id, reason) {
    const entry = entries.get(id);
    if (!entry) return false;
    if (reason === "idle_timeout" && isBusy?.(entry.value)) {
      // A session executing a turn must not be torn down by the idle timer;
      // give it a fresh TTL window. Explicit dispose still wins.
      entry.lastActivityAt = now();
      armTimer(id, entry);
      return false;
    }
    entries.delete(id);
    clearTimeout(entry.timer);
    if (onEvict) {
      try {
        await onEvict(entry.value, reason);
      } catch {
        // Eviction cleanup is best-effort; a failed close must not block
        // the registry from forgetting the session.
      }
    }
    return true;
  }

  function armTimer(id, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void evict(id, "idle_timeout");
    }, entry.ttlMs);
    entry.timer.unref?.();
  }

  const registry = {
    get(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (now() - entry.lastActivityAt > entry.ttlMs && !isBusy?.(entry.value)) {
        void evict(id, "idle_timeout");
        return undefined;
      }
      return entry.value;
    },
    set(id, value, { idleTimeoutMs: entryTtl } = {}) {
      const previous = entries.get(id);
      if (previous) clearTimeout(previous.timer);
      const entry = { value, lastActivityAt: now(), timer: null, ttlMs: normalizeTtl(entryTtl, defaultTtlMs) };
      entries.set(id, entry);
      armTimer(id, entry);
    },
    touch(id, { idleTimeoutMs: entryTtl } = {}) {
      const entry = entries.get(id);
      if (!entry) return;
      if (entryTtl !== undefined) entry.ttlMs = normalizeTtl(entryTtl, entry.ttlMs);
      entry.lastActivityAt = now();
      armTimer(id, entry);
    },
    has(id) {
      return registry.get(id) !== undefined;
    },
    /** Remove without running onEvict — for callers that already cleaned up. */
    delete(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      entries.delete(id);
      clearTimeout(entry.timer);
      return true;
    },
    async dispose(id) {
      return evict(id, "disposed");
    },
    async disposeAll() {
      const ids = [...entries.keys()];
      for (const id of ids) await evict(id, "disposed");
    },
    size() {
      return entries.size;
    },
  };

  allRegistries.add(registry);
  return registry;
}

export async function disposeProviderSession(providerSessionId) {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) return false;
  let disposed = false;
  for (const registry of allRegistries) {
    if (await registry.dispose(providerSessionId)) disposed = true;
  }
  return disposed;
}

export async function disposeAllProviderSessions() {
  for (const registry of allRegistries) {
    await registry.disposeAll();
  }
}
