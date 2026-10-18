// FIFO counting semaphore for run-scoped tool concurrency.
//
// agent-harness owns the equivalent helper for provider-execution width, but
// the kernel cannot depend on the harness, so the shape is duplicated here for
// the in-process tools that need to bound their own fan-out.

// @ts-check

/**
 * @param limit Maximum simultaneous holders. Values below 1 are clamped.
 */
export function createCountingSemaphore(limit: number): CountingSemaphore {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 1;
  let active = 0;
  const waiters: { resolve: (release: () => void) => void; reject: (error: Error) => void; settled: boolean; }[] = [];

  const release = () => {
    // A release function is single-use: a double call would hand out a slot the
    // holder no longer owns and let the limit drift upward for the whole run.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      pump();
    };
  };

  const pump = () => {
    while (active < max && waiters.length > 0) {
      const waiter = ((waiters.shift()) as any);
      if (waiter.settled) continue;
      waiter.settled = true;
      active += 1;
      waiter.resolve(release());
    }
  };

  return {
    acquire(signal) {
      if (signal?.aborted) {
        return Promise.reject(new Error("tool execution aborted"));
      }
      if (active < max) {
        active += 1;
        return Promise.resolve(release());
      }
      return new Promise((resolve, reject) => {
        const waiter: any = { resolve, reject, settled: false };
        waiters.push(waiter);
        signal?.addEventListener("abort", () => {
          if (waiter.settled) return;
          waiter.settled = true;
          reject(new Error("tool execution aborted"));
        }, { once: true });
      });
    },
    inFlight: () => active,
    queued: () => waiters.filter((waiter) => !waiter.settled).length,
  };
}

export type CountingSemaphore = {
  /**
   * Resolves with
   * a single-use release function once a slot is free. Rejects if `signal`
   * aborts while queued; an already-acquired slot is never leaked.
   */
  acquire: (signal?: AbortSignal) => Promise<() => void>;
  /**
   * Slots currently held.
   */
  inFlight: () => number;
  /**
   * Waiters not yet admitted.
   */
  queued: () => number;
};
