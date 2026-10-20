// @ts-check
// Synchronous session-liveness primitives over a createSessionRegistry.
//
// The Pi bridge owns session DURABILITY by keeping a Session transcript; this
// kernel layer owns session LIVENESS —
// the concurrency claim that keeps two turns from driving one session at once.
// The primitives here are deliberately SYNCHRONOUS: each does its registry
// get -> check -> set in a single await-free span, so the "busy claim must be
// await-free" invariant (I1) and the create-on-miss reservation race (R8) are
// enforced by construction rather than by careful inline sequencing.
//
// The registry stays the storage + idle-TTL + dispose fan-out layer (its
// exports are unchanged, worklab-compatible); liveness only adds the claim /
// reserve / release / adoptIfPresent seam that Pi's session lifecycle consumes.

/**
 * Wrap a session registry with the synchronous liveness primitives. The
 * explicit return typedef pins the claim/reserve discriminated unions so
 * callers narrow on `ok` (object-literal inference would otherwise widen `ok`
 * to boolean and break narrowing).
 */
export function createSessionLiveness(registry: SessionRegistryLike): SessionLiveness {
  return {
    /**
     * Claim a live entry for a turn. The registry get -> busy check -> set-busy
     * span is await-free (I1): a concurrent claim of a busy entry loses and is
     * told `busy`, never adopting the session mid-turn.
     */
    claim(id: string): { ok: true; entry: any; } | { ok: false; reason: "busy" | "missing"; } {
      const entry = registry.get(id);
      if (!entry) return { ok: false, reason: "missing" };
      if (entry.busy) return { ok: false, reason: "busy" };
      entry.busy = true;
      return { ok: true, entry };
    },

    /**
     * Re-read the registry after an awaited step (F4): a second concurrent cold
     * resume could have reopened+inserted its own entry in the await window, so
     * the caller adopts whatever is present (possibly busy) instead of racing a
     * second insert. Returns null when nothing is present.
     */
    adoptIfPresent(id: string): any {
      return registry.get(id) ?? null;
    },

    /**
     * Reserve an id with a BUSY placeholder before an awaited create (R8). The
     * get -> check -> set span is await-free, so a second concurrent first turn
     * observes the placeholder (busy) and loses the reservation — exactly one
     * create per durable id. On loss the concurrent entry is returned so the
     * caller can fall into the busy-claim path.
     * @param seed BUSY placeholder entry to insert.
     * @param ttl per-entry idle timeout.
     */
    reserve(id: string, seed: any, ttl: number | undefined): { ok: true; id: string; release: () => void; commit: (entry: any) => void; } | { ok: false; entry: any; } {
      const concurrent = registry.get(id);
      if (concurrent) return { ok: false, entry: concurrent };
      registry.set(id, seed, { idleTimeoutMs: ttl });
      return {
        ok: true,
        id,
        // Drop the placeholder (drop / error / abort paths). delete() removes
        // without running onEvict, matching the raw registry.delete it replaces.
        release: () => { registry.delete(id); },
        // Overwrite the placeholder with the finalized entry on the keep-alive
        // success path (same id, same ttl).
        commit: (entry: any) => { registry.set(id, entry, { idleTimeoutMs: ttl }); },
      };
    },

    /**
     * Release a session's liveness (remove without running onEvict — the caller
     * has already cleaned up, or is dropping an uncommitted session).
     */
    release(id: string): void {
      registry.delete(id);
    },
  };
}

export type SessionRegistryLike = {
    get: (id: string) => any;
    set: (id: string, value: any, opts?: {
        idleTimeoutMs?: number | undefined;
    }) => void;
    delete: (id: string) => boolean;
};
export type ClaimResult = {
    ok: true;
    entry: any;
} | {
    ok: false;
    reason: "busy" | "missing";
};
export type ReserveResult = {
    ok: true;
    id: string;
    release: () => void;
    commit: (entry: any) => void;
} | {
    ok: false;
    entry: any;
};
export type SessionLiveness = {
    claim: (id: string) => ClaimResult;
    adoptIfPresent: (id: string) => any;
    reserve: (id: string, seed: any, ttl: number | undefined) => ReserveResult;
    release: (id: string) => void;
};
