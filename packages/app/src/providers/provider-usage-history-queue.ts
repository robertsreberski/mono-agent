import { setImmediate as defer } from "node:timers";

/** Passive history must never hold a live vendor result or an unbounded shutdown. */
export function createProviderUsageHistoryQueue(options: {
  readonly timeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly maxPending?: number;
} = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 500;
  const controllers = new Set<AbortController>();
  let tail = Promise.resolve();
  let accepting = true;

  function enqueue<T>(run: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    if (!accepting || controllers.size >= (options.maxPending ?? 64)) {
      return Promise.reject(new Error("Quota history queue is unavailable."));
    }
    const controller = new AbortController();
    controllers.add(controller);
    // Deadline includes time waiting in the queue, not just the actual operation.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const result = tail.then(() => new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error("Quota history operation interrupted."));
      controller.signal.addEventListener("abort", abort, { once: true });
      defer(() => {
        if (controller.signal.aborted) { abort(); return; }
        // This turn starts only AFTER the live-result publication microtasks.
        Promise.resolve().then(() => run(controller.signal)).then(resolve, reject);
      });
    }));
    tail = result.then(() => undefined, () => undefined).finally(() => {
      clearTimeout(timer);
      controllers.delete(controller);
    });
    return result;
  }

  return {
    enqueue,
    drain: () => tail,
    async close() {
      accepting = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        tail,
        new Promise<void>(resolve => { timer = setTimeout(resolve, closeTimeoutMs); }),
      ]);
      clearTimeout(timer);
      // Late asynchronous initialization cannot commit after the close fence.
      for (const controller of controllers) controller.abort();
    },
  };
}
