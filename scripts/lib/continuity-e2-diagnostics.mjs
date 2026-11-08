// Closed content-free refusal record. Never persist arbitrary exception fields.
const KINDS = new Set(["provider_unavailable", "provider_unavailable_exhausted", "provider_auth", "context_limit", "usage_limit", "process_death", "runtime_error", "cancelled", "cancelled_user", "cancelled_stale", "cancelled_shutdown", "cancelled_signal"]);
const ROUTE_CODES = new Set(["E2_MODEL_UNREGISTERED", "E2_COMPACTION_LIMIT", "E2_COMPACTION_LIFECYCLE_INVALID", "E2_COMPACTION_NOT_DURABLE", "E2_SOURCE_REQUEST_LIMIT", "E2_SUMMARY_NOT_AUTHORIZED", "E2_SUMMARY_OPTIONS_INVALID", "E2_SUMMARY_REQUEST_LIMIT", "E2_MODELS_METHOD_REFUSED", "E2_SOURCE_REPLY_REFUSED", "E2_STEER_INVALID", "E2_STEER_REFUSED", "E2_STEER_NOT_DELIVERED", "E2_TOOL_CALL_MISMATCH", "E2_PROBE_REQUEST_LIMIT", "E2_PROBE_TOOLS_REFUSED", "E2_SOUL_MISMATCH"]);
const ordinal = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
export function diagnosticRecord(value = {}) {
  return { turnOrdinal: ordinal(value.turnOrdinal), replyCursor: ordinal(value.replyCursor), replyCount: ordinal(value.replyCount),
    cancelled: value.cancelled === true, aborted: value.aborted === true,
    failureKind: value.failureKind == null ? null : KINDS.has(value.failureKind) ? value.failureKind : "runtime_error",
    routeRefusalCode: ROUTE_CODES.has(value.routeRefusalCode) ? value.routeRefusalCode : null };
}
