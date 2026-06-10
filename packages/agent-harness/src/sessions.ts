export type RuntimeSessionEvictReason = "idle_timeout" | "stale" | "replaced" | "disposed";

export interface RuntimeSessionRecord {
  readonly conversationId: string;
  readonly providerSessionId: string;
  readonly createdAt: number;
  lastActivityAt: number;
  busy: boolean;
}

export interface RuntimeSessionStoreOptions {
  readonly idleTimeoutMs: number;
  readonly onEvict?: (record: RuntimeSessionRecord, reason: RuntimeSessionEvictReason) => void | Promise<void>;
  readonly now?: () => number;
}

export interface RuntimeSessionStore {
  /**
   * Returns the live record for a conversation and marks it busy, or
   * undefined when there is no session, it idled out (lazy wall-clock check
   * covers stalled timers), or another run already holds it.
   */
  acquire(conversationId: string): RuntimeSessionRecord | undefined;
  release(conversationId: string): void;
  /** Upsert; a differing stored id is evicted first with reason "replaced". */
  save(conversationId: string, providerSessionId: string): void;
  evict(conversationId: string, reason: RuntimeSessionEvictReason): Promise<void>;
  disposeAll(): Promise<void>;
}

interface StoredRecord {
  record: RuntimeSessionRecord;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createRuntimeSessionStore(options: RuntimeSessionStoreOptions): RuntimeSessionStore {
  const idleTimeoutMs = Math.max(1_000, options.idleTimeoutMs);
  const now = options.now ?? Date.now;
  const entries = new Map<string, StoredRecord>();

  async function evictStored(conversationId: string, reason: RuntimeSessionEvictReason): Promise<void> {
    const stored = entries.get(conversationId);
    if (stored === undefined) {
      return;
    }
    entries.delete(conversationId);
    if (stored.timer !== undefined) {
      clearTimeout(stored.timer);
    }
    if (options.onEvict !== undefined) {
      try {
        await options.onEvict(stored.record, reason);
      } catch {
        // Eviction cleanup is best-effort; the store must forget the session
        // even when the provider-side dispose fails.
      }
    }
  }

  function armTimer(conversationId: string, stored: StoredRecord): void {
    if (stored.timer !== undefined) {
      clearTimeout(stored.timer);
    }
    stored.timer = setTimeout(() => {
      void evictStored(conversationId, "idle_timeout");
    }, idleTimeoutMs);
    stored.timer.unref?.();
  }

  function clearTimer(stored: StoredRecord): void {
    if (stored.timer !== undefined) {
      clearTimeout(stored.timer);
      stored.timer = undefined;
    }
  }

  return {
    acquire(conversationId: string): RuntimeSessionRecord | undefined {
      const stored = entries.get(conversationId);
      if (stored === undefined) {
        return undefined;
      }
      if (now() - stored.record.lastActivityAt > idleTimeoutMs) {
        void evictStored(conversationId, "idle_timeout");
        return undefined;
      }
      if (stored.record.busy) {
        return undefined;
      }
      stored.record.busy = true;
      // No idle eviction while a run holds the session.
      clearTimer(stored);
      return stored.record;
    },
    release(conversationId: string): void {
      const stored = entries.get(conversationId);
      if (stored === undefined) {
        return;
      }
      stored.record.busy = false;
      stored.record.lastActivityAt = now();
      armTimer(conversationId, stored);
    },
    save(conversationId: string, providerSessionId: string): void {
      const stored = entries.get(conversationId);
      if (stored !== undefined && stored.record.providerSessionId !== providerSessionId) {
        void evictStored(conversationId, "replaced");
      } else if (stored !== undefined) {
        stored.record.lastActivityAt = now();
        if (!stored.record.busy) {
          armTimer(conversationId, stored);
        }
        return;
      }
      const timestamp = now();
      const next: StoredRecord = {
        record: {
          conversationId,
          providerSessionId,
          createdAt: timestamp,
          lastActivityAt: timestamp,
          busy: false,
        },
        timer: undefined,
      };
      entries.set(conversationId, next);
      armTimer(conversationId, next);
    },
    async evict(conversationId: string, reason: RuntimeSessionEvictReason): Promise<void> {
      await evictStored(conversationId, reason);
    },
    async disposeAll(): Promise<void> {
      const conversationIds = [...entries.keys()];
      for (const conversationId of conversationIds) {
        await evictStored(conversationId, "disposed");
      }
    },
  };
}
