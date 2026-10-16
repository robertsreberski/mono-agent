


/**
 * Reserved final-text token a notify-enabled cron/webhook turn emits to suppress
 * its own notification ("nothing worth reporting"). Single source of truth shared
 * by the harness (which instructs the agent) and the app (which matches it before
 * delivery). Matched trimmed + case-insensitively, as the whole text or as its
 * final line; never substring-matched. See `classifyNotifySuppression`.
 */
export const NOTHING_TO_REPORT_SENTINEL = "NOTHING_TO_REPORT";

/**
 * How a notify turn's final text suppresses its own delivery, if at all.
 *
 * `narrated-sentinel` is the off-contract-but-unambiguous case: the model wrote
 * out its reasoning and *then* emitted the marker on its own last line. The
 * harness asks for the sentinel alone, and most models comply, but a fallback
 * model narrating first still plainly decided to stay silent — delivering its
 * scratch work instead is the worst available reading of that.
 */
type NotifySuppression = "none" | "empty" | "sentinel" | "narrated-sentinel";

/**
 * Classify a notify turn's final text.
 *
 * Anchored to the final line, never a substring search: a report that merely
 * mentions the sentinel mid-body is still delivered, because the marker only
 * carries meaning where a final answer ends.
 */
export function classifyNotifySuppression(text: string | undefined): NotifySuppression {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) {
    return "empty";
  }
  if (trimmed.toUpperCase() === NOTHING_TO_REPORT_SENTINEL) {
    return "sentinel";
  }
  const finalLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  return finalLine.toUpperCase() === NOTHING_TO_REPORT_SENTINEL ? "narrated-sentinel" : "none";
}

/** Whether a notify-enabled turn's final text intentionally suppresses delivery. */
export function suppressesNotification(text: string | undefined): boolean {
  return classifyNotifySuppression(text) !== "none";
}
