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

interface OutcomeClassification {
  /** The background job's terminal card, when there is one to speak for. */
  readonly terminal: NonNullable<JobActivity["latestTerminal"]> | undefined;
  /** Whether that card, rather than the foreground turn, is the latest word. */
  readonly jobIsLatest: boolean;
  /** What went wrong, in the words the status line uses, or nothing. */
  readonly error: string | undefined;
}

const classifyOutcome = (thread: ThreadSummary): OutcomeClassification => {
  const { runState, jobActivity } = thread;
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
  return { terminal, jobIsLatest, error };
};

/**
 * The failure, cancellation or interruption a conversation is CURRENTLY
 * presenting, or `undefined` when there is none.
 *
 * The one implementation of that precedence, shared with
 * {@link threadPresentation}: the dashboard's row glyph reads this rather than
 * parsing the status line, so a row can never draw an alert beside text that
 * says nothing went wrong -- or stay quiet beside text that says it did.
 *
 * A running turn is never troubled: whatever it is retrying, what the console
 * is showing is the work in flight.
 */
export function threadOutcomeError(thread: ThreadSummary): string | undefined {
  if (thread.runState.status === "running") return undefined;
  return classifyOutcome(thread).error;
}

/**
 * What this conversation's BACKGROUND jobs are doing, in the status line's own
 * words, or nothing.
 *
 * Shared with the dashboard's running card, which replaces the foreground half
 * of the line with the turn's activity and keeps this half verbatim. One
 * implementation so the two lines can never disagree about how many jobs are
 * queued.
 */
export function threadJobSummaries(thread: ThreadSummary): readonly string[] {
  const { jobActivity } = thread;
  return (["running", "starting", "queued"] as const).flatMap((state) => {
    const count = jobActivity?.[state] ?? 0;
    return count > 0 ? [`${count} background ${count === 1 ? "job" : "jobs"} ${state}`] : [];
  });
}

/** The sidebar's text and activity indicator must describe the same work. */
export function threadPresentation(thread: ThreadSummary): { readonly text: string; readonly active: boolean } {
  const { runState } = thread;
  const jobs = threadJobSummaries(thread);
  if (runState.status === "running") {
    return { text: ["Working…", ...jobs].join(" · "), active: true };
  }

  const { terminal, jobIsLatest, error } = classifyOutcome(thread);
  const outcome = runState.lastOutcome === undefined ? runState : runState.lastOutcome;
  if (jobs.length > 0) {
    return { text: [...(error === undefined ? [] : [error]), ...jobs].join(" · "), active: true };
  }
  if (error !== undefined) return { text: error, active: false };
  // An idle success says nothing: the row keeps its project badge and tags,
  // but omits the "Completed" label.
  if (jobIsLatest && terminal !== undefined) return { text: "", active: false };
  return {
    text: outcome?.status === "complete" ? ""
      : thread.messageCount > 0 ? "No reply yet" : "New conversation",
    active: false,
  };
}

/**
 * The one line a SETTLED conversation row may spend on what was last said, or
 * `undefined` when the row has something better to say.
 *
 * This fills exactly the slot {@link threadPresentation} leaves empty: a
 * conversation whose latest word is a success, whether that came from the
 * foreground turn or from the latest background job card. Anything the status
 * line still says -- work in flight, a failure, "No reply yet" -- keeps its
 * place, so the excerpt can never talk over it.
 *
 * Read from the presentation rather than re-deriving the precedence, so the
 * two cannot disagree about which rows have an empty slot. Running cards and
 * the store's running projection keep reading `threadPresentation` directly,
 * which is why this lives beside it instead of widening its text: they must
 * keep describing work, never a message.
 *
 * The preview arrives capped by the server and may span lines, so it is
 * collapsed to one line here and left to the row's CSS to ellipsize -- the
 * component never re-truncates it.
 */
export function threadRowExcerpt(thread: ThreadSummary): string | undefined {
  if (threadPresentation(thread).text !== "") return undefined;
  const preview = thread.lastMessagePreview?.replace(/\s+/gu, " ").trim();
  return preview === undefined || preview === "" ? undefined : preview;
}
