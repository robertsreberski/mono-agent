// Internal per-execution evidence. Never seed this from host/provider options.
/** @returns {import('../../types.js').RuntimeDispatchProgress} */
export function createDispatchProgress() {
  return { version: 1, armed: false, assistantOutput: false, toolAdmitted: false, liveInputTaken: false };
}

/** @param {unknown} value @returns {value is import('../../types.js').RuntimeDispatchProgress} */
export function isDispatchProgress(value) {
  return value !== null && typeof value === "object" && value["version"] === 1
    && ["armed", "assistantOutput", "toolAdmitted", "liveInputTaken"].every((key) => typeof value[key] === "boolean");
}

/** Future prepared continuation must positively prove armed, empty evidence.
 * Ordinary routing still uses event evidence when this optional marker is absent.
 * @param {unknown} value @returns {boolean} */
export function hasNoDispatchProgress(value) {
  return isDispatchProgress(value) && value.armed && !value.assistantOutput && !value.toolAdmitted && !value.liveInputTaken;
}

/** @param {import('../../types.js').RuntimeDispatchProgress|undefined} progress @param {any} message */
export function noteAssistantContent(progress, message) {
  if (!progress?.armed || message?.role !== "assistant" || !Array.isArray(message.content)) return;
  if (message.content.some((part) => {
    if (typeof part === "string") return part.length > 0;
    if (!part || typeof part !== "object") return false;
    if (part.type === "text") return typeof part.text === "string" && part.text.length > 0;
    if (part.type === "thinking") return (typeof part.thinking === "string" && part.thinking.length > 0)
      || (typeof part.text === "string" && part.text.length > 0);
    // Tool-only output and unknown nonempty blocks are progress, not a licence
    // to replay a prepared turn. Neither needs to have produced a text delta.
    return Object.keys(part).length > 0;
  })) progress.assistantOutput = true;
}

/** Preserve side-effect evidence even when native teardown itself throws.
 * @param {unknown} error @param {import('../../types.js').RuntimeDispatchProgress} progress
 * @returns {Error & {dispatchProgress: import('../../types.js').RuntimeDispatchProgress}} */
export function withDispatchProgress(error, progress) {
  const snapshot = Object.freeze({ ...progress });
  // Prefer the original error (including its identity, code and cause chain).
  // Frozen/non-object throws need an annotatable wrapper instead.
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "dispatchProgress", { value: snapshot, configurable: true, enumerable: true });
      return /** @type {Error & {dispatchProgress: import('../../types.js').RuntimeDispatchProgress}} */ (error);
    } catch { /* retain the original as cause below */ }
  }
  return Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { dispatchProgress: snapshot });
}
