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

/**
 * Colour role of a status, the same in every console theme (never the accent):
 * in progress is yellow, done green, a question amber, a failure the danger
 * colour, and waiting, stopping and cancelled stay neutral. The glyph's shape
 * carries the same meaning without the colour.
 */
export type ProcessJobTone = "waiting" | "running" | "stopping" | "question" | "success" | "danger" | "neutral";
/**
 * The status glyph, one circle per status family. An outlined ring is work that
 * is still current; a solid disc is a settled outcome. The shape inside names
 * the family, so every status reads without its colour.
 */
export type ProcessJobMark =
  /** Queued: an empty ring, nothing started yet. */
  | "empty"
  /** Starting or running: a ring half filled. Static; only the bar's spinner moves. */
  | "half"
  /** A stop was asked for and the job is still winding down: a square in a ring. */
  | "stop"
  /** A peer question is waiting: a question mark in a ring. */
  | "question"
  /** Succeeded: a check cut out of a solid disc. */
  | "check"
  /** Failed, failed to start or interrupted: a cross cut out of a solid disc. */
  | "cross"
  /** Timed out or expired in queue: clock hands cut out of a solid disc. */
  | "clock"
  /** Cancelled: a square cut out of a solid disc. */
  | "stopped";

/** Outlined marks are current work; the rest are solid, settled outcomes. */
export const processJobMarkIsSettled = (mark: ProcessJobMark): boolean =>
  mark !== "empty" && mark !== "half" && mark !== "stop" && mark !== "question";

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
  queued: ["waiting", "empty", "Queued"],
  // A job being spawned is already in progress; a quarter fill would read as
  // a measured 25 %, which the host never reports, so it shares the half mark.
  starting: ["running", "half", "Starting"],
  running: ["running", "half", "Running"],
  succeeded: ["success", "check", "Done"],
  failed: ["danger", "cross", "Failed"],
  timed_out: ["danger", "clock", "Timed out"],
  spawn_failed: ["danger", "cross", "Failed to start"],
  queue_expired: ["danger", "clock", "Expired in queue"],
  interrupted: ["danger", "cross", "Interrupted"],
  cancelled: ["neutral", "stopped", "Cancelled"],
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

/**
 * A job's purpose under its agent group's id. The host labels a PeerAgent job
 * `Peer <peer> thread <thread>`; beside the peer's own id that prefix only
 * repeats it.
 */
export const processJobPurposeInGroup = (job: ProcessJobProjection, instanceId: string): string => {
  const title = processJobDisplayTitle(job);
  const prefix = `Peer ${instanceId} `;
  return job.tool === "PeerAgent" && title.startsWith(prefix) && title.length > prefix.length
    ? title.slice(prefix.length)
    : title;
};

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

/**
 * The one bucket a shelf row counts in (see `processJobItemBucket`). Every row
 * counts in exactly one, so the counts always add up to the rows.
 */
export type ProcessJobBucket =
  /** A peer question awaits the agent, whatever the job's own outcome. */
  | "question"
  /** Queued, starting, running or stopping. */
  | "active"
  /** Failed, timed out, failed to start, expired, interrupted, or a wake or child problem even on a success. */
  | "issue"
  /** Cancelled as asked, with nothing wrong. */
  | "cancelled"
  /** Succeeded with nothing wrong. */
  | "done";

/** The shelf's one fixed order: its chips, left to right, and its announcement. */
export const PROCESS_JOB_BUCKETS: readonly ProcessJobBucket[] = ["question", "active", "issue", "cancelled", "done"];

/** Current rows sit above History; the other buckets are the finished rows behind it. */
export const processJobBucketIsCurrent = (bucket: ProcessJobBucket): boolean =>
  bucket === "question" || bucket === "active";

/** Rows per bucket. They partition the shelf: the sum is its row count. */
export type ProcessJobStackCounts = Readonly<Record<ProcessJobBucket, number>>;

export interface ProcessJobActiveMark {
  readonly tone: ProcessJobTone;
  readonly mark: ProcessJobMark;
  /** The bar's one spinner: only while a job is actually starting or running. */
  readonly spinning: boolean;
}

/**
 * The closed bar's mark for its active count. It spins while any active job is
 * in progress; active jobs that are only queued or stopping show that state's
 * still mark instead of claiming work that is not happening.
 */
export const processJobActiveMark = (jobs: readonly ProcessJobProjection[], now: number): ProcessJobActiveMark => {
  const marks = jobs.filter((job) => !processJobIsTerminal(job)).map((job) => processJobDisplayState(job, now).mark);
  if (marks.includes("half")) return { tone: "running", mark: "half", spinning: true };
  if (marks.includes("stop")) return { tone: "stopping", mark: "stop", spinning: false };
  return { tone: "waiting", mark: "empty", spinning: false };
};

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/**
 * Each bucket's count in words: a chip's tooltip and spoken name, and a part of
 * the announcement. On screen a chip is only its glyph and number.
 */
export const processJobCountWords: Readonly<Record<ProcessJobBucket, (count: number) => string>> = {
  question: (count) => plural(count, "question awaiting the agent", "questions awaiting the agent"),
  active: (count) => `${String(count)} active`,
  // Not "failed": a success whose wake failed is an issue, and its row still says Done.
  issue: (count) => plural(count, "issue", "issues"),
  cancelled: (count) => `${String(count)} cancelled`,
  done: (count) => `${String(count)} done`,
};

/** The rows behind History, in words for assistive tech; on screen History shows the bare number. */
export const processJobFinishedWords = (count: number): string => `${String(count)} finished`;

/**
 * Every non-zero bucket in words, in the chips' order. Counts only: never
 * elapsed time, expiry, purpose or output, and never a word for what is absent.
 */
export const processJobStackSummaryParts = (counts: ProcessJobStackCounts): readonly string[] =>
  PROCESS_JOB_BUCKETS.filter((bucket) => counts[bucket] > 0).map((bucket) => processJobCountWords[bucket](counts[bucket]));

/**
 * How many whole entries of the closed bar's current list fit in `available`
 * pixels. `widths[i]` is entry i with the separator in front of it (none
 * before the first); `more(rest)` is the width of the trailing "· +rest" that
 * stands for the entries left out. The most entries that fit win, and at least
 * one always shows: a single name too long for the bar ellipsizes instead.
 */
export function processJobFitCount(widths: readonly number[], more: (rest: number) => number, available: number): number {
  const sums = widths.reduce<number[]>((total, width) => [...total, (total.at(-1) ?? 0) + width], []);
  for (let shown = widths.length; shown > 1; shown -= 1) {
    const rest = widths.length - shown;
    // Half a pixel of slack absorbs sub-pixel rounding in measured widths.
    if (sums[shown - 1]! + (rest > 0 ? more(rest) : 0) <= available + 0.5) return shown;
  }
  return Math.min(1, widths.length);
}

/** The shelf's one polite announcement. */
export const processJobStackAnnouncement = (counts: ProcessJobStackCounts): string => {
  const parts = processJobStackSummaryParts(counts);
  return `Background jobs: ${parts.length === 0 ? "none" : parts.join(", ")}.`;
};

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
