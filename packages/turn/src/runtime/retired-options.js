// Direct turn callers cannot depend on config's host-level diagnostics.
/** @param {object} options */
export function assertNoRetiredRunOptions(options) {
  if (Object.hasOwn(options, "piToolParallelismMode")) {
    throw new TypeError("piToolParallelismMode was renamed to piToolExecutionMode; use sequential instead of one-at-a-time, or safe-parallel instead of all");
  }
}
