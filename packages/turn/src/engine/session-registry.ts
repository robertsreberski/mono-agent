// Native registry factory; registration/fan-out is owned by the runtime.
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function normalizeTtl(value: any, fallback: any): any {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1_000) return fallback;
  return n;
}

export function createSessionRegistry({
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onEvict,
  onSync,
  now = Date.now,
  isBusy,
}: { idleTimeoutMs?: number | undefined; onEvict?: (value: any, reason: string) => (void | Promise<void>); onSync?: (value: any) => (void | Promise<void>); now?: () => number; isBusy?: (value: any) => boolean; } = {}): {
    get(id: any): any;
    set(id: any, value: any, options?: {
        idleTimeoutMs?: number | undefined;
    }): boolean;
    touch(id: any, options?: {
        idleTimeoutMs?: number | undefined;
    }): void;
    has(id: any): boolean;
    /** Remove without running onEvict — for callers that already cleaned up. */
    delete(id: any): boolean;
    dispose(id: any): Promise<any>;
    sync(id: any): Promise<any>;
    refresh(id: any): Promise<any>;
    invalidate(id: any): Promise<any>;
    disposeAll(): Promise<void>;
    size(): number;
} {
  const entries = new Map();
  const defaultTtlMs = normalizeTtl(idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  // A destructive invalidation must keep the id occupied until provider
  // cleanup is durably complete. Returning a busy placeholder makes existing
  // await-free liveness claims fail closed instead of treating the id as a
  // cold-reopen miss while its JSONL is still being unlinked.
  const unavailable = Object.freeze({ busy: true });

  async function evictBestEffort(id: any, reason: any): Promise<any> {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.state !== "active") {
      if ((entry.state === "invalidating" || entry.state === "refreshing") && entry.operation) {
        try { return await entry.operation; } catch { return false; }
      }
      return false;
    }
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

  async function sync(id: any): Promise<any> {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.state === "syncing" && entry.operation) return entry.operation;
    if (entry.state === "invalidating" && entry.operation) {
      await entry.operation;
      return false;
    }
    if (entry.state === "refreshing" && entry.operation) {
      await entry.operation;
      return false;
    }
    if (entry.state === "invalidation_failed") return false;

    clearTimeout(entry.timer);
    entry.state = "syncing";
    const operation = (async () => {
      try {
        await onSync?.(entry.value);
        if (entries.get(id) === entry) {
          entry.state = "active";
          entry.operation = null;
          entry.lastActivityAt = now();
          armTimer(id, entry);
        }
        return true;
      } catch (error) {
        // A provider that cannot prove its durable transcript is on disk must
        // not become resumable. Keep the busy marker in place so the host can
        // follow with destructive invalidation (or retry sync) honestly.
        if (entries.get(id) === entry) {
          entry.state = "sync_failed";
          entry.operation = null;
        }
        throw error;
      }
    })();
    entry.operation = operation;
    return operation;
  }

  async function invalidate(id: any): Promise<any> {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.state === "invalidating" && entry.operation) return entry.operation;
    if (entry.state === "syncing" && entry.operation) {
      try { await entry.operation; } catch { /* invalidation supersedes sync */ }
      return invalidate(id);
    }
    if (entry.state === "refreshing" && entry.operation) {
      try { await entry.operation; } catch { /* invalidation supersedes refresh */ }
      return invalidate(id);
    }

    clearTimeout(entry.timer);
    entry.state = "invalidating";
    const operation = (async () => {
      try {
        // Unlike ordinary eviction, destructive provider cleanup is the
        // operation being promised to the caller. Run it before removal and
        // let every error propagate; forgetting the entry first would report a
        // lie and permit a poisoned durable transcript to cold-reopen.
        await onEvict?.(entry.value, "invalidated");
        if (entries.get(id) === entry) entries.delete(id);
        return true;
      } catch (error) {
        if (entries.get(id) === entry) {
          entry.state = "invalidation_failed";
          entry.operation = null;
        }
        throw error;
      }
    })();
    entry.operation = operation;
    return operation;
  }

  async function refresh(id: any): Promise<any> {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.state === "refreshing" && entry.operation) return entry.operation;
    if (entry.state === "invalidating" && entry.operation) {
      await entry.operation;
      return;
    }
    if (entry.state === "syncing" && entry.operation) {
      await entry.operation;
      return refresh(id);
    }
    if (entry.state === "invalidation_failed") {
      throw new Error(`Provider session ${String(id)} is awaiting destructive invalidation`);
    }

    clearTimeout(entry.timer);
    entry.state = "refreshing";
    const operation = (async () => {
      try {
        // A refresh is stronger than ordinary best-effort disposal: callers use
        // its successful completion as proof that a subsequent resume cannot
        // adopt stale process memory. Preserve provider-owned durable state,
        // but propagate cleanup failures and retain the unavailable marker.
        await onEvict?.(entry.value, "refreshed");
        if (entries.get(id) === entry) entries.delete(id);
      } catch (error) {
        if (entries.get(id) === entry) {
          entry.state = "refresh_failed";
          entry.operation = null;
        }
        throw error;
      }
    })();
    entry.operation = operation;
    return operation;
  }

  function armTimer(id: any, entry: any): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void evictBestEffort(id, "idle_timeout");
    }, entry.ttlMs);
    entry.timer.unref?.();
  }

  const registry = {
    get(id: any): any {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (entry.state !== "active") return unavailable;
      if (now() - entry.lastActivityAt > entry.ttlMs && !isBusy?.(entry.value)) {
        void evictBestEffort(id, "idle_timeout");
        return undefined;
      }
      return entry.value;
    },
    set(id: any, value: any, { idleTimeoutMs: entryTtl }: { idleTimeoutMs?: number | undefined; } = {}): boolean {
      const previous = entries.get(id);
      // Never overwrite an in-flight/failed durability operation. The marker
      // deliberately owns this id until sync recovers or invalidation removes
      // it, preventing a cold reopen from winning an unlink race.
      if (previous && previous.state !== "active") return false;
      if (previous) clearTimeout(previous.timer);
      const entry = {
        value,
        lastActivityAt: now(),
        timer: null,
        ttlMs: normalizeTtl(entryTtl, defaultTtlMs),
        state: "active",
        operation: null,
      };
      entries.set(id, entry);
      armTimer(id, entry);
      return true;
    },
    touch(id: any, { idleTimeoutMs: entryTtl }: { idleTimeoutMs?: number | undefined; } = {}): void {
      const entry = entries.get(id);
      if (!entry) return;
      if (entry.state !== "active") return;
      if (entryTtl !== undefined) entry.ttlMs = normalizeTtl(entryTtl, entry.ttlMs);
      entry.lastActivityAt = now();
      armTimer(id, entry);
    },
    has(id: any): boolean {
      return registry.get(id) !== undefined;
    },
    /** Remove without running onEvict — for callers that already cleaned up. */
    delete(id: any): boolean {
      const entry = entries.get(id);
      if (!entry) return false;
      if (entry.state !== "active") return false;
      entries.delete(id);
      clearTimeout(entry.timer);
      return true;
    },
    async dispose(id: any): Promise<any> {
      return evictBestEffort(id, "disposed");
    },
    async sync(id: any): Promise<any> {
      return sync(id);
    },
    async refresh(id: any): Promise<any> {
      return refresh(id);
    },
    async invalidate(id: any): Promise<any> {
      return invalidate(id);
    },
    async disposeAll(): Promise<void> {
      const ids = [...entries.keys()];
      for (const id of ids) await evictBestEffort(id, "disposed");
    },
    size(): number {
      return entries.size;
    },
  };

  return registry;
}
