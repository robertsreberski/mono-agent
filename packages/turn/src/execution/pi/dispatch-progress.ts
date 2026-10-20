// Internal per-execution evidence. Never seed this from host/provider options.
export function createDispatchProgress(): import("../../contracts/runtime.js").RuntimeDispatchProgress {
  return { version: 1, armed: false, toolAdmitted: false, liveInputTaken: false };
}

export function isDispatchProgress(value: unknown): value is import("../../contracts/runtime.js").RuntimeDispatchProgress {
  return value !== null && typeof value === "object" && (value as Record<string, unknown>)["version"] === 1
    && ["armed", "toolAdmitted", "liveInputTaken"].every((key) => typeof (value as Record<string, unknown>)[key] === "boolean");
}

/**
 * Preserve side-effect evidence even when native teardown itself throws.
 */
export function withDispatchProgress(error: unknown, progress: import("../../contracts/runtime.js").RuntimeDispatchProgress): Error & {
    dispatchProgress: import("../../contracts/runtime.js").RuntimeDispatchProgress;
} {
  const snapshot = Object.freeze({ ...progress });
  // Prefer the original error (including its identity, code and cause chain).
  // Frozen/non-object throws need an annotatable wrapper instead.
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "dispatchProgress", { value: snapshot, configurable: true, enumerable: true });
      return ((error) as Error & {dispatchProgress: import("../../contracts/runtime.js").RuntimeDispatchProgress});
    } catch { /* retain the original as cause below */ }
  }
  return Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { dispatchProgress: snapshot });
}
