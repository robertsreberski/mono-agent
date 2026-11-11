import { expect, it } from "vitest";
import { E2_RETRY_POLICY, authorizeE2Retry, retryCause } from "../lib/continuity-e2-retry.mjs";
import { e2ExecutionPolicy } from "../lib/continuity-e2-execution-policy.mjs";
import { e2FailureCause, e2CandidateCause, observeE2NativeCause, registerE2CauseObserver } from "../lib/continuity-e2-cause.mjs";
function fixture(overrides = {}) {
  const hold = { round: 1, paidRole: "probe", checkpoint: 0, payloadDigest: "a".repeat(64), consumed: true,
    summaryPresence: { none: true }, settlement: { kind: "lost", retainedUnits: "3920000000" } };
  hold.nativeCause = { ...e2FailureCause({ ...hold, role: hold.paidRole }, { providerClass: "stream", sourceStage: "dispatch" }, { stopReason: "error", content: [] }), ...overrides };
  const state = { stop: null, slots: [{ holds: [hold], terminal: "lost" }] };
  return { state, hold, slot: state.slots[0], request: { round: 1, ownerCanceled: false } };
}
it("pins the source-owned one/eight retry policy", () => {
  expect(E2_RETRY_POLICY).toEqual({ schema: "continuity-e2-retry-policy-v1", maxPerRequest: 1, maxPerRun: 8,
    eligibleCauseClasses: ["stream", "http_5xx", "http_429", "empty_final_text", "unowned_aborted_result"] });
});
it.each(["guard_refused", "sdk_length_result", "unknown"])("cannot force controller retry of durable %s with child payload", causeClass => {
  const { state, request } = fixture({ causeClass });
  expect(authorizeE2Retry(state, 0, request)).toEqual({ allowed: false });
  expect(authorizeE2Retry(state, 0, { ...request, causeClass: "stream" })).toEqual({ allowed: false });
});
it.each(["context", "auth", "quota", "deadline", "request", "policy", "length"])("refuses closed %s even with otherwise eligible HTTP status", providerClass => {
  expect(retryCause(fixture({ providerClass, httpStatus: 503 }).hold.nativeCause)).toBeNull();
});
it.each([400, 401, 403, 404, 408, 409, 422])("refuses HTTP %s even with stream classification", httpStatus => {
  expect(retryCause(fixture({ httpStatus }).hold.nativeCause)).toBeNull();
});
it.each(["e2_worker_timeout", "e2_run_deadline", "e2_phase_failed", "budget_admission", "e2_body_mismatch"])("refuses any existing sticky stop (%s)", stop => {
  const { state, request } = fixture(); state.stop = stop;
  expect(authorizeE2Retry(state, 0, request)).toEqual({ allowed: false });
});
it("requires durable bound failure evidence and an already witnessed/settled consume", () => {
  for (const mutate of [h => delete h.nativeCause, h => h.nativeCause.payloadDigest = "b".repeat(64), h => h.nativeCause.ownerCanceled = true,
    h => h.consumed = false, h => delete h.summaryPresence, h => h.settlement = null, h => h.settlement.kind = "own_abort_after_send",
    h => h.retryOf = 1, h => h.settlement.kind = "integrity_stop"]) {
    const { state, hold, request } = fixture(); mutate(hold);
    expect(authorizeE2Retry(state, 0, request)).toEqual({ allowed: false });
  }
});
it("persists one grant without altering the failed settlement and cannot grant twice", () => {
  const { state, hold, slot, request } = fixture(), settlement = structuredClone(hold.settlement);
  expect(authorizeE2Retry(state, 0, request)).toEqual({ allowed: true });
  expect(hold.settlement).toEqual(settlement); expect(slot.retryPending).toBe(1); expect(slot.terminal).toBe("lost");
  expect(authorizeE2Retry(state, 0, request)).toEqual({ allowed: false });
});
it("counts retries in every prior slot against the run-wide ceiling", () => {
  const { state, request } = fixture(); state.slots.unshift({ holds: Array.from({ length: E2_RETRY_POLICY.maxPerRun }, () => ({ retryOf: 1 })) });
  expect(authorizeE2Retry(state, 1, request)).toEqual({ allowed: false });
});

it("accepts canonically equal policy keys in a different serialization order", () => {
  const { state, request } = fixture();
  const pilot = { descriptor: { retryPolicy: Object.fromEntries(Object.entries(E2_RETRY_POLICY).reverse()) } };
  expect(e2ExecutionPolicy.retry(pilot, state, 0, request)).toEqual({ allowed: true });
  expect(e2ExecutionPolicy.deferNativeFailure(pilot, 429)).toBe(true);
});

it("releases an owner-cancelled pending grant without spending any run-wide retry", () => {
  const { state, slot, request, hold } = fixture();
  expect(authorizeE2Retry(state, 0, request).allowed).toBe(true);
  expect(authorizeE2Retry(state, 0, { ...request, ownerCanceled: true }).allowed).toBe(false);
  expect(slot.retryPending).toBeUndefined(); expect(slot.terminal).toBe("lost"); expect(hold.retryCanceled).toBe(true);
  expect(state.slots.reduce((n, s) => n + s.holds.filter(h => h.retryOf).length, 0)).toBe(0);
  expect(authorizeE2Retry(state, 0, request).allowed).toBe(false);
});

it("uses the policy's per-logical-request retry count even for a consumed failed retry", () => {
  const { state, slot, hold, request } = fixture();
  hold.round = 2; hold.retryOf = 1; hold.nativeCause.round = 2;
  slot.holds.unshift({ round: 1 }); request.round = 2;
  expect(authorizeE2Retry(state, 0, request)).toEqual({ allowed: false });
});

it.each([
  ["context_length_exceeded", "context"], ["authentication_error", "auth"], ["insufficient_quota", "quota"],
  ["invalid_request_error", "request"], ["content_policy_violation", "policy"], ["max_output_tokens", "length"], ["ETIMEDOUT", "deadline"],
])("gives a fixed %s candidate precedence over every retryable event field", (code, providerClass) => {
  expect(e2CandidateCause(["server_error", code], true)).toBe(providerClass);
  expect(e2CandidateCause([code, "server_error"], true)).toBe(providerClass);
  const safety = {}, observations = [];
  registerE2CauseObserver(safety, value => observations.push(value));
  observeE2NativeCause(safety, "provider_terminal", null, ["server_error", code]);
  expect(observations).toHaveLength(1); expect(observations[0].providerClass).toBe(providerClass);
});
it("uses the first matching retryable class when no candidate forbids retry", () => {
  expect(e2CandidateCause(["server_error", "rate_limit_exceeded"])).toBe("server");
  expect(e2CandidateCause(["rate_limit_exceeded", "server_error"])).toBe("rate");
  expect(e2CandidateCause(["rate_limit_exceeded", "server_error"], true)).toBe("stream");
});
it("never defers a fixed JSON quota class merely because the HTTP status is 429", () => {
  const pilot = { descriptor: { retryPolicy: E2_RETRY_POLICY } };
  expect(e2ExecutionPolicy.deferNativeFailure(pilot, 429, ["server_error", "insufficient_quota"])).toBe(false);
  expect(e2ExecutionPolicy.deferNativeFailure(pilot, 429, ["rate_limit_exceeded"])).toBe(true);
});
