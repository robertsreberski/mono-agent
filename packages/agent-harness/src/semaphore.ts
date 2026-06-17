/**
 * Minimal FIFO counting semaphore for bounding concurrent runtime runs.
 *
 * Admission-control only: a caller acquires immediately before starting work
 * and releases when done. Callers waiting for a permit hold nothing, so a
 * queued follow-up (waiting in the live-session queue) never occupies a slot —
 * which is what keeps `maxConcurrentRuns` from deadlocking against the
 * per-conversation queue.
 */
export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  /** Permits currently held. */
  inUse(): number;
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let held = 0;
  const waiters: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      if (held < limit) {
        held += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release(): void {
      const next = waiters.shift();
      if (next !== undefined) {
        // Hand the permit directly to the next waiter (held stays the same).
        next();
        return;
      }
      held = Math.max(0, held - 1);
    },
    inUse(): number {
      return held;
    },
  };
}
