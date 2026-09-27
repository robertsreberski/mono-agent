import type { ThreadSummary } from "../types";

/** Summary-only status shared by the conversation controls and browser proof. */
export function WakeScheduleStatus({ thread }: { thread: ThreadSummary }) {
  const wake = thread.wakeSchedule;
  if (wake === undefined) return null;
  return <span className="conversation-menu-hint" aria-label="Wake-up schedule status">
    {wake.state}{wake.nextFireAt === null ? "" : ` · next ${new Date(wake.nextFireAt).toLocaleString()}`}
  </span>;
}
