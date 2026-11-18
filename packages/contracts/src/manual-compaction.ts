/** Content-free diagnostics suitable for crossing the operator boundary. */
export const manualCompactionReasons = [
  "timeout", "cancelled", "provider_overloaded", "rate_limited", "authentication",
  "context_too_large", "summary_refused", "insufficient_headroom", "nothing_to_compact",
  "busy", "provider_error", "outcome_unknown", "model_changed", "unsupported",
  "agent_offline", "internal_error", "session_unavailable", "commit_failed",
  "summary_failed", "not_reducible", "insufficient_savings", "headroom_unavailable",
  "failure_cooldown", "historical_preservation_refused",
  "insufficient_summary_headroom", "recent_identical_failure", "preservation_growth_required",
  "protected_tuples_missing", "summary_budget_exceeded", "output_truncated",
  "inherited_prefix_not_reducible", "guarded", "aborted", "attempt_in_flight",
  "below_trigger", "no_new_assistant", "insufficient_growth", "projected_savings",
] as const;
export type AgentManualCompactionReason = typeof manualCompactionReasons[number];
export type AgentManualCompactionDiagnostic = {
  readonly reason: AgentManualCompactionReason;
  readonly httpStatus?: number;
};
export function isManualCompactionReason(value: unknown): value is AgentManualCompactionReason {
  return typeof value === "string" && (manualCompactionReasons as readonly string[]).includes(value);
}
/** Never copy arbitrary messages or details, even from a typed responder. */
export function manualCompactionDiagnostic(value: unknown): AgentManualCompactionDiagnostic {
  const data = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    reason: isManualCompactionReason(data.reason) ? data.reason : "provider_error",
    ...(typeof data.httpStatus === "number" && Number.isInteger(data.httpStatus)
      && data.httpStatus >= 400 && data.httpStatus <= 599 ? { httpStatus: data.httpStatus } : {}),
  };
}
