// Controller-owned bounded attempts. Original logical budgets are never expanded.
import { validE2FailureCause, E2_NONRETRY_PROVIDER_CLASSES } from "./continuity-e2-cause.mjs";
import { rejectedE2Summary } from "./continuity-e2-compaction.mjs";
export const E2_RETRY_POLICY = Object.freeze({ schema: "continuity-e2-retry-policy-v1", maxPerRequest: 1, maxPerRun: 8,
  eligibleCauseClasses: Object.freeze(["stream", "http_5xx", "http_429", "empty_final_text", "unowned_aborted_result"]) });
export function retryCause(cause) {
  if (!cause || cause.ownerCanceled || ["guard_refused", "sdk_length_result", "unknown"].includes(cause.causeClass)
    || cause.sourceStage === "guard_refused" || E2_NONRETRY_PROVIDER_CLASSES.includes(cause.providerClass)
    || cause.httpStatus >= 400 && cause.httpStatus < 500 && cause.httpStatus !== 429) return null;
  if (!["sdk_error_result", "sdk_promise_rejected", "empty_final_text", "sdk_aborted_result"].includes(cause.causeClass)) return null;
  const candidate = cause.httpStatus >= 500 && cause.httpStatus <= 599 ? "http_5xx"
    : cause.httpStatus === 429 ? "http_429" : cause.providerClass === "stream" ? "stream"
    : cause.causeClass === "empty_final_text" ? "empty_final_text"
    : cause.causeClass === "sdk_aborted_result" ? "unowned_aborted_result" : null;
  return E2_RETRY_POLICY.eligibleCauseClasses.includes(candidate) ? candidate : null;
}
export function authorizeE2Retry(state, index, payload) {
  const slot = state.slots[index], h = slot.holds.at(-1);
  if (payload && Object.keys(payload).sort().join() === "ownerCanceled,round" && payload.ownerCanceled === true
    && h?.round === payload.round && slot.retryPending === h.round && h.retryAuthorized) {
    delete slot.retryPending; h.retryCanceled = true; return { allowed: false };
  }
  if (!payload || Object.keys(payload).sort().join() !== "ownerCanceled,round" || payload.ownerCanceled !== false
    || state.stop || !h || h.round !== payload.round || h.retryAuthorized || !h.consumed || !h.summaryPresence
    || !["lost", "settled"].includes(h.settlement?.kind) || slot.terminal === "integrity_stop"
    || !validE2FailureCause(h.nativeCause, slot) || !retryCause(h.nativeCause)
    || slot.holds.filter(v => v.retryOf === (h.retryOf ?? h.round)).length >= E2_RETRY_POLICY.maxPerRequest
    || state.slots.reduce((n, s) => n + s.holds.filter(v => v.retryOf).length, 0) >= E2_RETRY_POLICY.maxPerRun) return { allowed: false };
  h.retryAuthorized = true; slot.retryPending = h.round;
  return { allowed: true };
}
// This is recognition of an already authorized retry-v1 chain, not a retry
// grant. No failed attempt disappears solely because a later receipt exists.
export function supersedingE2Summary(holds, h) {
  if (h.paidRole !== "summary" || h.retryOf || h.retryAuthorized !== true || h.retryCanceled || !h.consumed || !h.summaryPresence
    || !["lost", "settled"].includes(h.settlement?.kind) || !validE2FailureCause(h.nativeCause, { holds }) || !retryCause(h.nativeCause)) return undefined;
  return holds.find(r => r.round === h.round + 1 && r.retryOf === h.round && r.paidRole === "summary" && r.consumed
    && r.settlement?.kind === "settled" && r.summaryReceipt?.verified === true && !r.nativeCause
    && ["payloadDigest", "model", "checkpoint", "operationDigest", "measuredInputTokens", "reservedUnits"].every(k => r[k] === h[k]));
}
export function effectiveE2Summaries(holds) {
  return holds.filter(h => h.paidRole === "summary" && !rejectedE2Summary(h) && !supersedingE2Summary(holds, h));
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
