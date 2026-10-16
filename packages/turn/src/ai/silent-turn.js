// @ts-check
// One admission rule for the tool, empty-reply retry, and terminal seal.

/** @typedef {{soleCall: boolean, visibleContent: boolean, pendingQuestion: boolean, failed: boolean, completed: boolean, liveInputEligible?: () => boolean}} SilentTurnState */

/**
 * @param {SilentTurnState} state
 * @param {{eligible: () => boolean}|undefined|null} controller
 * @param {{aborted?: boolean, failed?: boolean, finalText?: string}} [result]
 */
export function silentTurnRefusalReason(state, controller, result = {}) {
  if (result.aborted || result.failed || state.failed) return "failure";
  if (!state.soleCall) return "not_sole_call";
  if (state.visibleContent || result.finalText?.trim()) return "visible_content";
  if (state.pendingQuestion) return "pending_question";
  if (controller?.eligible() !== true) return "ineligible_turn";
  if (state.liveInputEligible?.() !== true) return "live_input_consumed";
  return null;
}

/**
 * @param {SilentTurnState} state
 * @param {{eligible: () => boolean}|undefined|null} controller
 * @param {{aborted?: boolean, failed?: boolean, finalText?: string}} [result]
 */
export function canCertifySilentTurn(state, controller, result) {
  return state.completed === true && silentTurnRefusalReason(state, controller, result) === null;
}
