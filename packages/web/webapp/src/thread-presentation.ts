import type { JobActivity, ThreadSummary } from "./types.js";

const jobOutcome: Readonly<Record<NonNullable<JobActivity["latestTerminal"]>["state"], string>> = {
  succeeded: "Completed",
  failed: "Background job failed",
  timed_out: "Background job timed out",
  cancelled: "Background job cancelled",
  spawn_failed: "Background job failed to start",
  queue_expired: "Background job expired in queue",
  interrupted: "Background job interrupted",
};

/** The sidebar's text and activity indicator must describe the same work. */
export function threadPresentation(thread: ThreadSummary): { readonly text: string; readonly active: boolean } {
  const { runState, jobActivity } = thread;
  const jobs = (["running", "starting", "queued"] as const).flatMap((state) => {
    const count = jobActivity?.[state] ?? 0;
    return count > 0 ? [`${count} background ${count === 1 ? "job" : "jobs"} ${state}`] : [];
  });
  if (runState.status === "running") {
    return { text: ["Working…", ...jobs].join(" · "), active: true };
  }

  const terminal = jobActivity?.latestTerminal;
  // Silent assistant-only host wakes settle real runs, but do not resolve a
  // previous failure. Missing metadata preserves historical cached summaries.
  const outcome = runState.lastOutcome === undefined ? runState : runState.lastOutcome;
  // A later foreground answer can resolve an older job failure. Use the job's
  // actual completion, not a later retry of its notification or wake receipt.
  const jobIsLatest = terminal !== undefined && (outcome?.finishedAt === undefined
    || Date.parse(terminal.completedAt) > Date.parse(outcome.finishedAt));
  const error = jobIsLatest
    ? terminal.state === "succeeded" ? undefined : jobOutcome[terminal.state]
    : outcome?.status === "failed" ? "Failed"
      : outcome?.status === "cancelled" ? "Cancelled"
        : outcome?.status === "interrupted" ? "Interrupted" : undefined;
  if (jobs.length > 0) {
    return { text: [...(error === undefined ? [] : [error]), ...jobs].join(" · "), active: true };
  }
  if (error !== undefined) return { text: error, active: false };
  if (jobIsLatest) return { text: terminal.replyPreview || "Completed", active: false };
  return {
    text: thread.lastMessagePreview || (outcome?.status === "complete" ? "Completed"
      : thread.messageCount > 0 ? "No reply yet" : "New conversation"),
    active: false,
  };
}
