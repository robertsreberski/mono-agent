// Controller-owned bounded attempts. Original logical budgets are never expanded.
import { validE2FailureCause } from "./continuity-e2-cause.mjs";
export const E2_RETRY_POLICY = Object.freeze({ schema: "continuity-e2-retry-policy-v1", maxPerRequest: 1, maxPerRun: 8,
  eligibleCauseClasses: Object.freeze(["stream", "http_5xx", "http_429", "empty_final_text", "unowned_aborted_result"]) });
export function retryCause(cause) {
  if (!cause || cause.ownerCanceled || ["guard_refused", "sdk_length_result", "unknown"].includes(cause.causeClass)
    || cause.sourceStage === "guard_refused" || ["context", "auth", "quota", "deadline"].includes(cause.providerClass)
    || cause.httpStatus >= 400 && cause.httpStatus < 500 && cause.httpStatus !== 429) return null;
  if (!["sdk_error_result", "sdk_promise_rejected", "empty_final_text", "sdk_aborted_result"].includes(cause.causeClass)) return null;
  if (cause.httpStatus >= 500 && cause.httpStatus <= 599) return "http_5xx";
  if (cause.httpStatus === 429) return "http_429";
  if (cause.providerClass === "stream") return "stream";
  if (cause.causeClass === "empty_final_text") return "empty_final_text";
  if (cause.causeClass === "sdk_aborted_result") return "unowned_aborted_result";
  return null;
}
export function authorizeE2Retry(state, index, payload) {
  const slot = state.slots[index], h = slot.holds.at(-1);
  if (!payload || Object.keys(payload).sort().join() !== "ownerCanceled,round" || payload.ownerCanceled !== false
    || state.stop || !h || h.round !== payload.round || h.retryOf || h.retryAuthorized || !h.consumed || !h.summaryPresence
    || !["lost", "settled"].includes(h.settlement?.kind) || slot.terminal === "integrity_stop"
    || !validE2FailureCause(h.nativeCause, slot) || !retryCause(h.nativeCause)
    || state.slots.reduce((n, s) => n + s.holds.filter(v => v.retryOf).length, 0) >= E2_RETRY_POLICY.maxPerRun) return { allowed: false };
  h.retryAuthorized = true; slot.retryPending = h.round; slot.terminal = null;
  return { allowed: true };
}
export function effectiveE2Summaries(holds) {
  return holds.filter(h => h.paidRole === "summary" && !holds.some(r => r.retryOf === h.round && r.settlement?.kind === "settled" && r.summaryReceipt?.verified));
}
export function e2RetryCounts(slots) {
  const result = { attempted: 0, succeeded: 0, causeClasses: {} };
  for (const s of slots) for (const h of s.holds) if (h.retryOf) {
    result.attempted++; if (h.settlement?.kind === "settled" && !h.nativeCause) result.succeeded++;
    const cause = retryCause(s.holds.find(v => v.round === h.retryOf)?.nativeCause) ?? "unknown";
    result.causeClasses[cause] = (result.causeClasses[cause] ?? 0) + 1;
  }
  return result;
}
