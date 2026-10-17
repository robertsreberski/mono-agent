// Internal per-execution evidence. Never seed this from host/provider options.
/** @returns {import("../../contracts/runtime.js").RuntimeDispatchProgress} */
export function createDispatchProgress() {
  return { version: 1, armed: false, toolAdmitted: false, liveInputTaken: false };
}

/** @param {unknown} value @returns {value is import("../../contracts/runtime.js").RuntimeDispatchProgress} */
export function isDispatchProgress(value) {
  return value !== null && typeof value === "object" && value["version"] === 1
    && ["armed", "toolAdmitted", "liveInputTaken"].every((key) => typeof value[key] === "boolean");
}

/** Preserve side-effect evidence even when native teardown itself throws.
 * @param {unknown} error @param {import("../../contracts/runtime.js").RuntimeDispatchProgress} progress
 * @returns {Error & {dispatchProgress: import("../../contracts/runtime.js").RuntimeDispatchProgress}} */
export function withDispatchProgress(error, progress) {
  const snapshot = Object.freeze({ ...progress });
  // Prefer the original error (including its identity, code and cause chain).
  // Frozen/non-object throws need an annotatable wrapper instead.
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "dispatchProgress", { value: snapshot, configurable: true, enumerable: true });
      return /** @type {Error & {dispatchProgress: import("../../contracts/runtime.js").RuntimeDispatchProgress}} */ (error);
    } catch { /* retain the original as cause below */ }
  }
  return Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { dispatchProgress: snapshot });
}
