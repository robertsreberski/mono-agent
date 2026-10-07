// @ts-check
// One bounded, same-session plain-text finalization after normal settlement.

/** @param {import('../../types.js').RuntimePromptOverrides} [prompts] */
export function emptyReplyFinalizationPrompt(prompts) {
  if (typeof prompts?.emptyReplyFinalization === "function") return prompts.emptyReplyFinalization();
  return [
    "The previous assistant turn ended without a user-facing reply.",
    "Please write your reply to the user's request now as normal assistant text, based on the completed transcript above.",
    "Do not call tools or redo work. Keep reasoning private; provide only the user-facing reply.",
  ].join("\n");
}

/**
 * @param {{finalText: string, stopReason: unknown, outputSchema: unknown, runError: unknown, externalAbort: boolean, maxTurnsHit: boolean, silent: boolean, pendingQuestion: boolean}} state
 */
export function shouldRetryEmptyReply(state) {
  return !state.finalText.trim()
    && (state.stopReason === "stop" || state.stopReason === "length")
    && !state.outputSchema && !state.runError && !state.externalAbort
    && !state.maxTurnsHit && !state.silent && !state.pendingQuestion;
}

/**
 * The prompt is persisted only in the native provider session, just like the
 * structured-output finalization prompt. The subscriber does not project user
 * text messages into runtime events. Keep all tools disabled during this prompt.
 * @param {{harness: any, runtimeWarnings: Array<Record<string, unknown>>, abortSignal?: AbortSignal, prompts?: import('../../types.js').RuntimePromptOverrides}} deps
 * @returns {Promise<{attempted: boolean, error?: unknown}>}
 */
export async function runEmptyReplyRetry({ harness, runtimeWarnings, abortSignal, prompts }) {
  if (abortSignal?.aborted) return { attempted: false };
  const previousActive = harness.getActiveTools().map((/** @type {{name: string}} */ tool) => tool.name);
  let attempted = false;
  try {
    await harness.setActiveTools([]);
    // Cancellation may arrive while disabling tools, when no operation exists
    // for the surrounding abort handler to cancel.
    if (abortSignal?.aborted) return { attempted: false };
    attempted = true;
    runtimeWarnings.push({
      warning_kind: "empty_reply_retry", source: "pi", attempt: 1,
      reason: "empty_final_output", outcome: "started",
      message: "Pi stopped without reply text; retrying once in the same session with tools disabled.",
    });
    await harness.prompt(emptyReplyFinalizationPrompt(prompts));
    await harness.waitForIdle();
    return { attempted };
  } catch (error) {
    // Preserve runtime/provider failures rather than treating them as empty text.
    return { attempted, error };
  } finally {
    try { await harness.setActiveTools(previousActive); } catch { /* same best-effort restoration as structured output */ }
  }
}
