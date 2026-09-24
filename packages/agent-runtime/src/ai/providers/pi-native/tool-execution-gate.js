// @ts-check

// Only explicitly known independent tools share admission. Unknown/custom tools,
// MCP tools, and tools carrying a sequential marker are exclusive by default.
const SHARED_TOOLS = new Set([
  "Agent", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "ReadSkill",
  "RunHistory", "SessionHistory",
]);

/** @param {{name?: string, executionMode?: string}} tool */
export function isSharedTool(tool) {
  return tool.executionMode !== "sequential" && SHARED_TOOLS.has(tool.name ?? "");
}

/** FIFO admission within one harness run. An exclusive waiter bars later shared calls. */
export function createToolExecutionGate() {
  let active = 0;
  let exclusive = false;
  /** @type {Array<{shared: boolean, resolve: (release: () => void) => void, signal?: AbortSignal, onAbort: () => void}>} */
  const pending = [];

  const drain = () => {
    while (pending.length && !exclusive) {
      const next = pending[0];
      if (!next.shared && active > 0) break;
      pending.shift();
      next.signal?.removeEventListener("abort", next.onAbort);
      // An abort that raced with admission must not enter the tool.
      if (next.signal?.aborted) {
        // The waiter checks its signal immediately after admission.
        next.resolve(() => {});
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
    if (signal?.aborted) return Promise.reject(new Error("tool execution aborted"));
    return new Promise((resolve, reject) => {
      /** @type {any} */
      const waiter = {
        shared, signal, resolve,
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
  return { acquire };
}
