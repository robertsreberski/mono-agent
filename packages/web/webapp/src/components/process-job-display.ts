import type { ProcessJobProjection, ProcessJobState } from "../types";
import { formatToolPreview } from "./tool-preview";

/**
 * Pure presentation rules for the background-jobs shelf and its rows.
 *
 * Everything here is derived from one projection plus one clock snapshot, so
 * the shelf's counts, its row order and every row's labels agree with each
 * other at any instant. Nothing here polls, formats elapsed time or touches the
 * lifecycle merge: the card and the stack own those.
 */

/** Mirrors the host's terminal set without importing the stateful card module. */
const TERMINAL: ReadonlySet<ProcessJobState> = new Set<ProcessJobState>([
  "succeeded", "failed", "timed_out", "cancelled", "spawn_failed", "queue_expired", "interrupted",
]);

export const processJobIsTerminal = (job: ProcessJobProjection): boolean => TERMINAL.has(job.state);

/** Command jobs run a process; agent jobs are a child or peer agent turn. */
export type ProcessJobKind = "command" | "agent";
export const processJobKind = (job: ProcessJobProjection): ProcessJobKind =>
  job.tool === "Exec" || job.tool === "Bash" ? "command" : "agent";

/** Colour role of a status; the glyph's inner mark carries the same meaning by shape. */
export type ProcessJobTone = "waiting" | "running" | "stopping" | "question" | "success" | "danger" | "neutral";
/** Inner status mark, drawn inside the kind-shaped container. */
export type ProcessJobMark = "clock" | "ring" | "stop" | "question" | "check" | "close";

export interface ProcessJobDisplayState {
  readonly tone: ProcessJobTone;
  readonly mark: ProcessJobMark;
  /** The row's explicit state word. */
  readonly word: string;
  /** A second state a terminal job still carries, e.g. a pending peer question. */
  readonly pending?: string;
  /** Exit code and signal, command jobs only; never `exit 0`. */
  readonly details: readonly string[];
  /** Exact operator alert tokens (wording is contract). */
  readonly alerts: readonly string[];
  /** Past facts worth a word on the row. */
  readonly notes: readonly string[];
  readonly stopping: boolean;
}

const STATES: Readonly<Record<ProcessJobState, readonly [ProcessJobTone, ProcessJobMark, string]>> = {
  queued: ["waiting", "clock", "Queued"],
  starting: ["running", "ring", "Starting"],
  running: ["running", "ring", "Running"],
  succeeded: ["success", "check", "Done"],
  failed: ["danger", "close", "Failed"],
  timed_out: ["danger", "clock", "Timed out"],
  spawn_failed: ["danger", "close", "Failed to start"],
  queue_expired: ["danger", "clock", "Expired in queue"],
  interrupted: ["danger", "close", "Interrupted"],
  cancelled: ["neutral", "stop", "Cancelled"],
};

/**
 * A PeerAgent question the host still reports as awaiting an answer, before its
 * own deadline. The host persists the question when the peer job SETTLES and
 * retires it later (`settlePeerQuestion`), so a pending question normally sits
 * on a terminal job.
 */
export const pendingPeerQuestion = (job: ProcessJobProjection, now: number): boolean => {
  if (job.kind !== "internal" || job.peerQuestion?.state !== "awaiting_answer") return false;
  const deadline = Date.parse(job.peerQuestion.expiresAt);
  return Number.isFinite(deadline) && deadline > now;
};

/** The earliest future deadline of a pending question, for the shelf's single clock. */
export const nextPeerQuestionDeadline = (jobs: readonly ProcessJobProjection[], now: number): number | undefined => {
  let next: number | undefined;
  for (const job of jobs) {
    if (!pendingPeerQuestion(job, now) || job.kind !== "internal" || job.peerQuestion === undefined) continue;
    const deadline = Date.parse(job.peerQuestion.expiresAt);
    if (next === undefined || deadline < next) next = deadline;
  }
  return next;
};

/** Current work: lifecycle-active jobs plus settled peer jobs whose question is still open. */
export const processJobIsCurrent = (job: ProcessJobProjection, now: number): boolean =>
  !processJobIsTerminal(job) || pendingPeerQuestion(job, now);

/**
 * An outcome an operator may have to deal with. A cancelled job is what was
 * asked for, unless its wake or child ownership went wrong.
 */
export const processJobIsIssue = (job: ProcessJobProjection): boolean => processJobIsTerminal(job) && (
  (job.state !== "succeeded" && job.state !== "cancelled")
  || job.wake.state === "failed"
  || job.wake.state === "unknown"
  || (job.kind === "internal" && job.childStillBusy));

export function processJobDisplayState(job: ProcessJobProjection, now: number): ProcessJobDisplayState {
  const terminal = processJobIsTerminal(job);
  let [tone, mark, word] = STATES[job.state];
  const stopping = !terminal && job.cancelRequested;
  if (stopping) [tone, mark, word] = ["stopping", "stop", "Stopping"];
  const question = pendingPeerQuestion(job, now);
  let pending: string | undefined;
  if (question && job.state === "succeeded") [tone, mark, word] = ["question", "question", "Question pending"];
  else if (question) pending = "Question pending";
  const details = processJobKind(job) === "command" ? [
    ...(job.exitCode !== null && job.exitCode !== 0 ? [`exit ${String(job.exitCode)}`] : []),
    ...(job.signal === null ? [] : [job.signal]),
  ] : [];
  const alerts = terminal ? [
    ...(job.kind === "internal" && job.childStillBusy ? ["child still busy · awaiting actual settlement"] : []),
    ...(job.wake.state === "failed" ? ["wake failed"] : []),
    ...(job.wake.state === "unknown" ? ["wake outcome unknown · replay suppressed"] : []),
  ] : [];
  const notes = job.kind === "internal" && job.subagentQuestion ? ["asked the parent agent a question"] : [];
  return { tone, mark, word, ...(pending === undefined ? {} : { pending }), details, alerts, notes, stopping };
}

/** The purpose, without the host's `Purpose: ` prefix on command jobs. */
export const processJobDisplayTitle = (job: ProcessJobProjection): string =>
  processJobKind(job) === "command" && job.summary.startsWith("Purpose: ")
    ? job.summary.slice("Purpose: ".length)
    : job.summary;

/** The legacy group name tests and assistive tech already know, plus a stop request. */
export const processJobGroupName = (job: ProcessJobProjection): string =>
  `${job.tool} background job ${job.state.replaceAll("_", " ")}${!processJobIsTerminal(job) && job.cancelRequested ? " (stopping)" : ""}`;

/** The host's "nothing printed" preview for a settled job (process-jobs-service outputPreview). */
export const EMPTY_OUTPUT_PREVIEW = "(no output)";
const PREVIEW_MARKERS = new Set(["STDOUT:", "STDERR:", "… [earlier output omitted]", EMPTY_OUTPUT_PREVIEW]);

export const processJobOutputIsEmpty = (preview: string): boolean =>
  preview.length === 0 || preview === EMPTY_OUTPUT_PREVIEW;

export interface ProcessJobPreview {
  /** Plain label saying what the text is, or empty for a bare status phrase. */
  readonly label: string;
  readonly text: string;
  readonly mono: boolean;
}

/**
 * One line for a collapsed row. For a command this is the LAST line of the
 * host's preview, which lists stdout before stderr: an output preview, not a
 * claim about the newest activity.
 */
export function processJobPreview(job: ProcessJobProjection, now: number): ProcessJobPreview | undefined {
  const terminal = processJobIsTerminal(job);
  if (processJobKind(job) === "command") {
    if (job.state === "queued" || job.state === "starting") return undefined;
    if (processJobOutputIsEmpty(job.output.preview)) return terminal ? undefined : { label: "", text: "No output yet", mono: false };
    const line = job.output.preview.split("\n").map((value) => value.trim())
      .filter((value) => value.length > 0 && !PREVIEW_MARKERS.has(value)).at(-1);
    return line === undefined ? undefined : { label: "Output", text: line.slice(0, 200), mono: true };
  }
  if (job.kind !== "internal") return undefined;
  if (pendingPeerQuestion(job, now)) {
    const line = job.peerQuestion!.message.split("\n").map((value) => value.trim()).filter(Boolean).at(-1);
    return line === undefined ? undefined : { label: "Asks", text: line.slice(0, 200), mono: false };
  }
  const progress = job.subagentProgress;
  if (terminal) {
    const head = progress?.answerHead?.split("\n").map((value) => value.trim()).find(Boolean);
    return head === undefined ? undefined : { label: "Report", text: head.slice(0, 200), mono: false };
  }
  const call = progress?.recent.filter((entry) => entry.status === "running").at(-1) ?? progress?.recent.at(-1);
  if (call === undefined) return undefined;
  const preview = formatToolPreview(call.toolName, call.argsSummary, call.workdir, 60)?.preview;
  return { label: call.toolName, text: preview ?? "", mono: true };
}

export type ProcessJobCallOutcome = "complete" | "failed" | "running";

/** The last recorded call outcomes, oldest first. Categorical: never a progress claim. */
export const processJobCallOutcomes = (job: ProcessJobProjection, limit = 8): readonly ProcessJobCallOutcome[] =>
  job.kind === "internal" && job.subagentProgress !== undefined
    ? job.subagentProgress.recent.slice(-limit).map((call) => call.status)
    : [];

export const processJobCallOutcomesLabel = (outcomes: readonly ProcessJobCallOutcome[]): string => {
  const count = (status: ProcessJobCallOutcome) => outcomes.filter((value) => value === status).length;
  return `Last ${String(outcomes.length)} tool ${outcomes.length === 1 ? "call" : "calls"}: ${[
    `${String(count("complete"))} complete`,
    ...(count("failed") > 0 ? [`${String(count("failed"))} failed`] : []),
    ...(count("running") > 0 ? [`${String(count("running"))} running`] : []),
  ].join(", ")}`;
};

export interface ProcessJobStackCounts {
  /** Lifecycle-active jobs only; a pending question never inflates it. */
  readonly active: number;
  /** Rows in the Finished group (terminal and not waiting on a question). */
  readonly finished: number;
  readonly issues: number;
  readonly questions: number;
}

export const processJobStackCounts = (jobs: readonly ProcessJobProjection[], now: number): ProcessJobStackCounts => ({
  active: jobs.filter((job) => !processJobIsTerminal(job)).length,
  finished: jobs.filter((job) => !processJobIsCurrent(job, now)).length,
  issues: jobs.filter(processJobIsIssue).length,
  questions: jobs.filter((job) => pendingPeerQuestion(job, now)).length,
});

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

export const processJobCountWords = {
  active: (count: number): string => `${String(count)} active`,
  finished: (count: number, bounded: boolean): string => `${String(count)} finished${bounded ? " shown" : ""}`,
  issues: (count: number): string => plural(count, "issue", "issues"),
  questions: (count: number): string => plural(count, "question awaiting the agent", "questions awaiting the agent"),
} as const;

/**
 * The shelf's visible wording summary (the legend at the top of the open
 * shelf) and, with a comma join, its one polite announcement. Counts only:
 * never elapsed time, expiry, purpose or output.
 */
export const processJobStackSummaryParts = (counts: ProcessJobStackCounts, bounded: boolean): readonly string[] => [
  counts.active === 0 ? "No active jobs" : processJobCountWords.active(counts.active),
  ...(counts.finished > 0 ? [processJobCountWords.finished(counts.finished, bounded)] : []),
  ...(counts.issues > 0 ? [processJobCountWords.issues(counts.issues)] : []),
  ...(counts.questions > 0 ? [processJobCountWords.questions(counts.questions)] : []),
];

export const processJobStackAnnouncement = (counts: ProcessJobStackCounts, bounded: boolean): string =>
  `Background jobs: ${processJobStackSummaryParts(counts, bounded).join(", ")}.`;

/**
 * A pending question's deadline in words. "<1 min" until the deadline itself,
 * so rounding never calls a live question expired.
 */
export const peerQuestionExpiryLabel = (expiresAt: string, now: number): string => {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return "";
  const remaining = deadline - now;
  if (remaining <= 0) return "past its expiry time";
  if (remaining < 60_000) return "expires in <1 min";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) return `expires in ${String(minutes)} min`;
  if (minutes < 24 * 60) return `expires in ${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
  return `expires ${new Date(deadline).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
};
