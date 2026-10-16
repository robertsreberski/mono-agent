/**
 * Run a single prompt on the harness and wait for it to go idle. A stream error
 * surfaces on the harness (not a throw), so a thrown prompt is captured as
 * runError; waitForIdle always runs afterward.
 * @param {any} harness
 * @param {string} promptText
 * @param {Array<any>} promptImages
 * @param {{onOperationAdmitted?: (operationId: string) => void}} [hooks]
 *   `onOperationAdmitted` fires as soon as Pi admits the run, before any
 *   provider request, so the live-input epoch can own the operation up front.
 * @returns {Promise<{runError: any, operationId?: string, suspended?: boolean}>}
 */
export async function runHarnessPrompt(harness, promptText, promptImages, hooks) {
  let runError = null;
  let operationId, suspended = false;
  try {
    // Pass structured images (when present) so multimodal input reaches the
    // model as image blocks rather than stringified text. The engine adapter prompt
    // takes them under an options object (`{ images }`); a bare array would be
    // read as `options` and silently dropped (options?.images === undefined).
    const promptOptions = {
      ...(Array.isArray(promptImages) && promptImages.length > 0 ? { images: promptImages } : {}),
      ...(typeof hooks?.onOperationAdmitted === "function"
        ? { onOperationAdmitted: hooks.onOperationAdmitted }
        : {}),
    };
    const result = Object.keys(promptOptions).length > 0
      ? await harness.prompt(promptText, promptOptions)
      : await harness.prompt(promptText);
    operationId = result?.operationId; suspended = result?.status === "suspended";
  } catch (err) {
    runError = err;
  }
  await harness.waitForIdle();
  return { runError, ...(operationId === undefined ? {} : { operationId }), ...(suspended ? { suspended: true } : {}) };
}
