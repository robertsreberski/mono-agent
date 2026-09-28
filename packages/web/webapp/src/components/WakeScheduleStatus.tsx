import type { ThreadSummary } from "../types";
import { wakeStatusText } from "./wake/wake-schedule-model";

/**
 * Summary-only status for the conversation menu: kind, then state or the next
 * wake-up in this device's time. The summary carries no zone, so the menu
 * never pretends to show the schedule's own wall time.
 */
export function WakeScheduleStatus({ thread }: { thread: ThreadSummary }) {
  const wake = thread.wakeSchedule;
  if (wake === undefined) return null;
  return <span className="conversation-menu-hint" aria-label="Wake-up schedule status">{wakeStatusText(wake)}</span>;
}
