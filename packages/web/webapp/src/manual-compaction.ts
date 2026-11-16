import type { ThreadSummary } from "./types";

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
} as const;

export function compactionFailureDetail(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.reason !== "string" || !Object.hasOwn(compactionReasonLabels, payload.reason)) return undefined;
  const label = compactionReasonLabels[payload.reason as keyof typeof compactionReasonLabels];
  const status = payload.httpStatus;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? `${label.replace(/\.$/, "")} (HTTP ${status}).` : label;
}
