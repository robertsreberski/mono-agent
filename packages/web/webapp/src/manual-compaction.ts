import type { AgentManualCompactionReason } from "@mono-agent/contracts";
import type { ThreadSummary } from "./types.js";

/** Thread snapshots are JSON from the server; ignore malformed transient hints. */
export const runningManualCompaction = (thread: ThreadSummary | null | undefined): boolean => {
  const value: unknown = thread?.compaction;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === "running" && record.trigger === "manual"
    && typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt));
};

/** Deliberately no provider text: old markers without a reason still render. */
export const compactionReasonLabels = {
  timeout: "Summary request timed out.",
  cancelled: "Compaction was cancelled.",
  provider_overloaded: "Provider overloaded.",
  rate_limited: "Provider rate limit reached.",
  authentication: "Summary model authentication failed.",
  context_too_large: "Conversation too large for the summary model.",
  summary_refused: "Summary was refused or incomplete.",
  insufficient_headroom: "Not enough room for a useful summary.",
  nothing_to_compact: "Nothing to compact yet.",
  busy: "Conversation is busy; try again when idle.",
  provider_error: "Summary provider request failed.",
  outcome_unknown: "Response lost; it may have completed.",
  model_changed: "Model changed.",
  unsupported: "Manual compaction is unavailable for this agent.",
  agent_offline: "Agent is offline; compaction did not start.",
  internal_error: "Agent could not complete compaction safely.",
  session_unavailable: "Compacted session could not be saved safely.",
  commit_failed: "Compaction could not be committed safely.",
  summary_failed: "Summary generation failed.",
  not_reducible: "Context could not be reduced.",
  insufficient_savings: "Summary would not save enough context.",
  headroom_unavailable: "Not enough room for a useful summary.",
  failure_cooldown: "Summary provider is cooling down.",
  historical_preservation_refused: "Historical summary could not be preserved.",
  insufficient_summary_headroom: "Not enough room for a useful summary.",
  recent_identical_failure: "Waiting to retry after a recent compaction failure.",
  preservation_growth_required: "Waiting for more context before retrying historical preservation.",
  protected_tuples_missing: "Summary did not preserve protected historical details.",
  summary_budget_exceeded: "Summary exceeded its context budget.",
  output_truncated: "Summary was cut off before completion.",
  inherited_prefix_not_reducible: "Inherited context could not be reduced safely.",
  guarded: "Compaction was declined by a safety check.",
  aborted: "Compaction was cancelled.",
  attempt_in_flight: "A compaction attempt is already in progress.",
  below_trigger: "Context is below the compaction threshold.",
  no_new_assistant: "Waiting for a new assistant response before retrying.",
  insufficient_growth: "Not enough new context to retry compaction.",
  projected_savings: "The planned cut would not save enough context.",
} as const satisfies Record<AgentManualCompactionReason, string>;

export function compactionFailureDetail(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.reason !== "string" || !Object.hasOwn(compactionReasonLabels, payload.reason)) return undefined;
  const label = compactionReasonLabels[payload.reason as keyof typeof compactionReasonLabels];
  const status = payload.httpStatus;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? `${label.replace(/\.$/, "")} (HTTP ${status}).` : label;
}
