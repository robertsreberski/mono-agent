/**
 * Durable-history bookkeeping is host business, not conversation content. A
 * successful write, its record id and sequence, and the untrusted-evidence
 * marker (which exists for the model, not the reader) say nothing a person acts
 * on, so only a lost record is surfaced — that one means the tool's output is
 * gone for good. Shared so the transcript and the subagent panel agree.
 */
export const toolHistoryFailure = (
  history: Record<string, unknown> | undefined,
): string | undefined => {
  if (history?.persistence !== "failed") return undefined;
  const code = typeof history.errorCode === "string" ? ` (${history.errorCode})` : "";
  return `Tool history for this call was not saved${code}.`;
};
