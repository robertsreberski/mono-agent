// @ts-check

// Only explicitly known independent tools share admission. Unknown/custom tools,
// MCP tools, and tools carrying a sequential marker are exclusive by default.
const SHARED_TOOLS = new Set([
  "Agent", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "ReadSkill",
]);

/** @param {{name?: string, executionMode?: string}} tool */
export function isSharedTool(tool) {
  return tool.executionMode !== "sequential" && SHARED_TOOLS.has(tool.name ?? "");
}

/** FIFO admission within one harness run. An exclusive waiter bars later shared calls. */
export function createToolExecutionGate() {
  let active = 0;
  let exclusive = false;
  let stopped = false;
  /** @type {Array<{shared: boolean, resolve: (release: () => void) => void, reject: (error: Error) => void, signal?: AbortSignal, onAbort: () => void}>} */
  const pending = [];

  const drain = () => {
    while (pending.length && !exclusive && !stopped) {
      const next = pending[0];
      if (!next.shared && active > 0) break;
      pending.shift();
      next.signal?.removeEventListener("abort", next.onAbort);
      // An abort that raced with admission must not enter the tool.
      if (next.signal?.aborted) {
        next.reject(new Error("tool execution aborted"));
        continue;
      }
      active += 1;
      if (!next.shared) exclusive = true;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        if (!next.shared) exclusive = false;
        drain();
      });
      if (exclusive) break;
    }
  };

  /** @param {boolean} shared @param {AbortSignal} [signal] */
  const acquire = (shared, signal) => {
    if (stopped || signal?.aborted) return Promise.reject(new Error("tool execution aborted"));
    return new Promise((resolve, reject) => {
      /** @type {any} */
      const waiter = {
        shared, signal, resolve, reject,
        onAbort: () => {
          const index = pending.indexOf(waiter);
          if (index < 0) return;
          pending.splice(index, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(new Error("tool execution aborted"));
          drain();
        },
      };
      pending.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      drain();
    });
  };
  const stop = () => {
    stopped = true;
    for (const waiter of pending.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("tool execution aborted"));
    }
  };
  // Only call after Pi has accepted a new run. The previous batch must already
  // have settled; do not reopen admission during abort or close.
  const resume = () => { stopped = false; };
  return { acquire, stop, resume };
}
