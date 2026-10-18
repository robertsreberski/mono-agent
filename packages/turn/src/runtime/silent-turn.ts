// @ts-check
// One admission rule for the tool, empty-reply retry, and terminal seal.

export function silentTurnRefusalReason(state: SilentTurnState, controller: { eligible: () => boolean; } | null | undefined, result: { aborted?: boolean; failed?: boolean; finalText?: string; } | undefined = {}): "live_input_consumed" | "live_input_uncertain" | "failure" | "not_sole_call" | "visible_content" | "pending_question" | "ineligible_turn" | null {
  if (result.aborted || result.failed || state.failed) return "failure";
  if (!state.soleCall) return "not_sole_call";
  if (state.visibleContent || result.finalText?.trim()) return "visible_content";
  if (state.pendingQuestion) return "pending_question";
  if (controller?.eligible() !== true) return "ineligible_turn";
  return state.liveInputRefusalReason ? state.liveInputRefusalReason() : "live_input_uncertain";
}

export function canCertifySilentTurn(state: SilentTurnState, controller: { eligible: () => boolean; } | null | undefined, result?: { aborted?: boolean; failed?: boolean; finalText?: string; } | undefined): boolean {
  return state.completed === true && silentTurnRefusalReason(state, controller, result) === null;
}

export type SilentTurnState = {
  soleCall: boolean;
  visibleContent: boolean;
  pendingQuestion: boolean;
  failed: boolean;
  completed: boolean;
  liveInputRefusalReason?: () => ("live_input_consumed" | "live_input_uncertain" | null);
};
