// Closed, content-free native failure diagnostics. Never serialize SDK errors.
const observers = new WeakMap(), captures = new WeakMap();
export function registerE2CauseObserver(safety, observe, capture) { observers.set(safety, observe); if (capture) captures.set(safety, capture); }
export function captureE2NativeCause(safety, message, error) { return captures.get(safety)?.(message, !!error, error) ?? null; }
export function observeE2NativeCause(safety, stage, status, code, binding) {
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const providerClass = e2ProviderCause(code, httpStatus);
  observers.get(safety)?.({ sourceStage: stages.includes(stage) ? stage : "unknown",
    ...(binding && Number.isSafeInteger(binding.round) && binding.round > 0 && Number.isSafeInteger(binding.checkpoint) && binding.checkpoint >= 0
      && ["probe", "continuation", "summary"].includes(binding.role) && /^[a-f0-9]{64}$/u.test(binding.payloadDigest ?? "")
      ? { binding: { round: binding.round, checkpoint: binding.checkpoint, role: binding.role, payloadDigest: binding.payloadDigest } } : {}),
    ...(httpStatus === null ? {} : { httpStatus, responseHeadersObserved: true }),
    ...(providerClass === "unknown" ? {} : { providerClass }) });
}
const stages = ["guard_refused", "request_setup", "dispatch", "response_headers", "provider_terminal", "sdk_result", "sdk_promise", "unknown"];
const reasons = ["stop", "error", "length", "aborted", "toolUse", "unknown"];
const classes = ["guard_refused", "sdk_error_result", "sdk_aborted_result", "sdk_length_result", "empty_final_text", "sdk_promise_rejected", "unknown"];
const providers = ["context", "auth", "quota", "rate", "server", "stream", "deadline", "unknown"];
export function e2ProviderCause(code, status) {
  if (["context_length_exceeded", "context_window_exceeded"].includes(code)) return "context";
  if (["invalid_api_key", "authentication_error", "permission_denied", "e2_auth_failure"].includes(code) || [401, 403].includes(status)) return "auth";
  if (["insufficient_quota", "quota_exceeded", "e2_quota_exhausted", "usage_limit_reached", "usage_limit_exceeded"].includes(code)) return "quota";
  if (code === "rate_limit_exceeded" || status === 429) return "rate";
  if (["server_error", "internal_server_error"].includes(code) || status >= 500 && status <= 599) return "server";
  if (["ETIMEDOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "e2_worker_timeout", "e2_run_deadline"].includes(code)) return "deadline";
  if (["stream_error", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"].includes(code)) return "stream";
  return "unknown";
}
export function e2FailureCause(binding, observed, message, rejected = false) {
  const stopReason = reasons.includes(message?.stopReason) ? message.stopReason : "unknown";
  const textPresent = (message?.content ?? []).some(p => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0);
  return { schema: "continuity-e2-native-cause-v1", round: binding.round, role: binding.role, checkpoint: binding.checkpoint, payloadDigest: binding.payloadDigest,
    ownerCanceled: observed.ownerCanceled === true, sourceStage: rejected ? stages.includes(observed.sourceStage) ? observed.sourceStage : "unknown" : "sdk_result", sdkStopReason: stopReason, textPresent,
    responseHeadersObserved: observed.responseHeadersObserved === true, terminalUsageObserved: observed.terminalUsageObserved === true,
    httpStatus: Number.isInteger(observed.httpStatus) && observed.httpStatus >= 100 && observed.httpStatus <= 599 ? observed.httpStatus : null,
    causeClass: observed.sourceStage === "guard_refused" ? "guard_refused" : rejected ? "sdk_promise_rejected" : ({ error: "sdk_error_result", aborted: "sdk_aborted_result", length: "sdk_length_result", stop: "empty_final_text" }[stopReason] ?? "unknown"),
    providerClass: providers.includes(observed.providerClass) ? observed.providerClass : "unknown" };
}
export function validE2FailureCause(value, slot) {
  if (!value || Object.keys(value).sort().join() !== "causeClass,checkpoint,httpStatus,ownerCanceled,payloadDigest,providerClass,responseHeadersObserved,role,round,schema,sdkStopReason,sourceStage,terminalUsageObserved,textPresent") return false;
  const h = slot.holds.find(h => h.round === value.round);
  return value.schema === "continuity-e2-native-cause-v1" && Number.isSafeInteger(value.round) && value.round > 0
    && ["probe", "continuation", "summary"].includes(value.role) && Number.isSafeInteger(value.checkpoint) && value.checkpoint >= 0
    && (value.payloadDigest === null && !h || !!h && h.paidRole === value.role && h.checkpoint === value.checkpoint && h.payloadDigest === value.payloadDigest)
    && stages.includes(value.sourceStage) && reasons.includes(value.sdkStopReason) && classes.includes(value.causeClass) && providers.includes(value.providerClass)
    && ["ownerCanceled", "textPresent", "responseHeadersObserved", "terminalUsageObserved"].every(k => typeof value[k] === "boolean")
    && (value.httpStatus === null || Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599);
}
