import type { DataMessagePartProps } from "@assistant-ui/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { api } from "../api";
import { currentDataMode } from "../data-mode";
import { useDocumentVisible } from "../document-visibility";
import type { ProcessJobProjection, ProcessJobState } from "../types";
import { ActivityRow, type ActivityStatus } from "./ActivityRow";
import { ActivityElapsed, type ActivityTiming } from "./assistant-ui/ActivityElapsed";

export const TERMINAL_PROCESS_JOB_STATES: ReadonlySet<ProcessJobState> = new Set<ProcessJobState>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_failed",
  "queue_expired",
  "interrupted",
]);
const PROCESS_JOB_POLL_INITIAL_MS = 1_000;
const PROCESS_JOB_POLL_MAX_MS = 10_000;
/**
 * Half the rate on a metered link.
 *
 * A background job is not a stream: the card exists to say what state the job
 * reached, and reaching it two seconds later costs the operator nothing but
 * saves half the requests over the life of a long run.
 */
const LEAN_PROCESS_JOB_POLL_INITIAL_MS = 2_000;
const LEAN_PROCESS_JOB_POLL_MAX_MS = 20_000;

/**
 * Where a state sits in the job's lifecycle. The lifecycle only moves forward
 * (`queued` → `starting` → `running` → one terminal state), and the retained
 * store enforces exactly that on every card update, so rank is the ordering two
 * projections of the same job can be compared by. Every terminal state shares
 * the top rank: none of them is "after" another.
 */
const PROCESS_JOB_STATE_RANK: Readonly<Record<ProcessJobState, number>> = {
  queued: 0,
  starting: 1,
  running: 2,
  succeeded: 3,
  failed: 3,
  timed_out: 3,
  cancelled: 3,
  spawn_failed: 3,
  queue_expired: 3,
  interrupted: 3,
};

/** Whether `to` is further along the lifecycle than `from`. Same state, or terminal to terminal, is not. */
export const processJobAdvances = (from: ProcessJobState, to: ProcessJobState): boolean =>
  PROCESS_JOB_STATE_RANK[to] > PROCESS_JOB_STATE_RANK[from];

/**
 * Whether a projection fetched by the poll or supplied by a card repair should
 * replace the one the row has. Rank decides across states. Within one state,
 * lifecycle facts and byte counters may only move forward; this admits a live
 * output tail without letting a delayed response erase a richer projection.
 */
export const processJobSupersedes = (current: ProcessJobProjection, next: ProcessJobProjection): boolean => {
  if (processJobAdvances(current.state, next.state)) return true;
  if (current.state !== next.state) return false;
  if (current.timestamps.startedAt !== null && next.timestamps.startedAt === null) return false;
  if (current.cancelRequested && !next.cancelRequested) return false;
  if (next.output.stdoutBytes < current.output.stdoutBytes
    || next.output.stderrBytes < current.output.stderrBytes) return false;
  const started = current.timestamps.startedAt === null && next.timestamps.startedAt !== null;
  const cancelled = !current.cancelRequested && next.cancelRequested;
  const output = next.output.stdoutBytes > current.output.stdoutBytes
    || next.output.stderrBytes > current.output.stderrBytes;
  const wakeRank = (wake: ProcessJobProjection["wake"]): number => wake.state === "pending" ? 0 : 1;
  const wake = TERMINAL_PROCESS_JOB_STATES.has(next.state)
    && (wakeRank(next.wake) > wakeRank(current.wake)
      || (next.wake.state === current.wake.state && next.wake.attempts > current.wake.attempts));
  const error = current.lastError === null && next.lastError !== null;
  return started || cancelled || output || wake || error;
};

/**
 * What a projection would tell this card that it does not already know.
 *
 * The fields the row and its poll actually turn on: lifecycle state, process
 * start, wake attempts, exit code, output byte counts, and cancellation. Two
 * projections agreeing on these say the same thing however many times the
 * transcript is rebuilt.
 */
const projectionSignature = (job: ProcessJobProjection | undefined): string =>
  job === undefined ? "" : [
    job.state,
    job.timestamps.startedAt ?? "",
    String(job.wake.attempts),
    job.exitCode === null ? "" : String(job.exitCode),
    String(job.output.stdoutBytes),
    String(job.output.stderrBytes),
    String(job.cancelRequested),
  ].join(" ");

/** The retained web thread a job reports to, or nothing for an origin the console cannot poll. */
export const processJobThreadId = (job: ProcessJobProjection): string | undefined => {
  const base = job.origin.conversationId.split("#", 1)[0];
  if (base === undefined || !base.startsWith("web:") || base === "web:new") return undefined;
  return base.slice("web:".length) || undefined;
};

/**
 * `succeeded` is the only good ending. Queued and starting jobs are still work,
 * so they pulse like a running one; every other terminal state ended without a
 * result and reads as a failure, with the row's tag saying which kind.
 */
export const processJobStatus = (state: ProcessJobState): ActivityStatus =>
  state === "queued" || state === "starting" || state === "running"
    ? "running"
    : state === "succeeded" ? "complete" : "failed";

export const processJobStateLabel = (state: ProcessJobState): string => state.replaceAll("_", " ");

/**
 * The job's own window. It opens when the host started the process — or, while
 * the job still waits, when it was admitted — and closes at the host's reported
 * duration, falling back to the completion stamp. Host stamps and the console's
 * server clock come from the same machine, so the live figure ticks in server
 * time like the Activity header.
 */
export const processJobTiming = (job: ProcessJobProjection): ActivityTiming | undefined => {
  const startedAt = Date.parse(job.timestamps.startedAt ?? job.timestamps.admittedAt);
  if (!Number.isFinite(startedAt)) return undefined;
  if (job.durationMs !== null && Number.isFinite(job.durationMs) && job.durationMs >= 0) {
    return { startedAt, finishedAt: startedAt + job.durationMs };
  }
  const completedAt = job.timestamps.completedAt === null ? Number.NaN : Date.parse(job.timestamps.completedAt);
  return Number.isFinite(completedAt) ? { startedAt, finishedAt: completedAt } : { startedAt };
};

/** `exit 137 · SIGKILL`, either half alone, or nothing before the process has ended. */
export const processJobExitLabel = (job: ProcessJobProjection): string | undefined => {
  const pieces = [
    ...(job.exitCode === null ? [] : [`exit ${String(job.exitCode)}`]),
    ...(job.signal === null ? [] : [job.signal]),
  ];
  return pieces.length === 0 ? undefined : pieces.join(" · ");
};

const joinMeta = (items: readonly ReactNode[]): ReactNode =>
  items.flatMap((item, index) => (index === 0 ? [item] : [" · ", item]));

/**
 * What the time slot says: the state word (unless the tag already says it), the
 * elapsed or final duration, how the process ended, and a failed wake — the one
 * wake outcome an operator has to act on.
 */
const processJobMeta = (job: ProcessJobProjection, terminal: boolean): ReactNode => {
  const timing = processJobTiming(job);
  const exit = processJobExitLabel(job);
  const items: ReactNode[] = [];
  if (processJobStatus(job.state) !== "failed") items.push(processJobStateLabel(job.state));
  // A settled job with no finish stamp has nothing honest to show; leave the slot out.
  if (timing !== undefined && (!terminal || timing.finishedAt !== undefined)) {
    items.push(<ActivityElapsed key="elapsed" timing={timing} live={!terminal} />);
  }
  if (exit !== undefined) items.push(exit);
  // Its own element: a phone-width row lets the meta wrap, and this is the one
  // token that must neither split across lines nor be the part that clips.
  if (terminal && job.wake.state === "failed") {
    items.push(<span key="wake" className="activity-row-alert">wake failed</span>);
  }
  return items.length === 0 ? undefined : joinMeta(items);
};

const wakeLabel = (wake: ProcessJobProjection["wake"]): string =>
  wake.attempts === 0
    ? wake.state
    : `${wake.state} (${String(wake.attempts)} ${wake.attempts === 1 ? "attempt" : "attempts"})`;

/**
 * One background `Exec`/`Bash` job as an Activity row. The row is the card the
 * host keeps updating in place: it reads the retained projection it was given,
 * takes any newer projection the store hands it after a `message.changed`
 * refresh, and polls its exact thread-bound job endpoint with backoff until the
 * job settles. Everything but tool, purpose, state and time waits behind the
 * disclosure.
 */
export function ProcessJobPart({ data }: DataMessagePartProps) {
  const payload = data as { readonly job?: ProcessJobProjection; readonly responseText?: unknown };
  const initial = payload.job;
  const [live, setLive] = useState(initial);
  const visible = useDocumentVisible();
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);
  const manuallyCollapsed = useRef(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const threadId = initial === undefined ? undefined : processJobThreadId(initial);
  const jobId = initial?.jobId;
  const terminal = live === undefined || TERMINAL_PROCESS_JOB_STATES.has(live.state);
  /**
   * When the store last handed this card a projection that SAID something new.
   *
   * By value, not by reference: every conversation read rebuilds the message and
   * its parts, so the card is handed a fresh object carrying the same job about
   * once a second during a turn. Reference equality read each of those as "the
   * stream just answered" and suppressed every poll round for the length of the
   * turn. Comparing the signature also means neither the first render nor
   * StrictMode's repeated effect can be mistaken for an arrival.
   */
  const projectedRef = useRef({ signature: projectionSignature(initial), at: 0 });

  useEffect(() => {
    setLive((current) => {
      if (initial === undefined || current === undefined || current.jobId !== initial.jobId) return initial;
      return processJobSupersedes(current, initial) ? initial : current;
    });
    const signature = projectionSignature(initial);
    if (projectedRef.current.signature !== signature) {
      projectedRef.current = { signature, at: Date.now() };
    }
  }, [initial]);

  useEffect(() => {
    autoOpened.current = false;
    manuallyCollapsed.current = false;
    followOutput.current = true;
    setOpen(false);
  }, [jobId]);

  useEffect(() => {
    if (live?.state !== "running" || live.output.preview.length === 0 || autoOpened.current) return;
    autoOpened.current = true;
    if (!manuallyCollapsed.current) setOpen(true);
  }, [live?.output.preview, live?.state]);

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (!open || output === null || !followOutput.current) return;
    output.scrollTop = output.scrollHeight;
  }, [live?.output.preview, open]);

  useEffect(() => {
    // A hidden tab has nobody to show a state change to. The card keeps what it
    // holds and the loop resumes -- with an immediate read -- when the operator
    // comes back, which is the only moment the answer is worth anything.
    if (terminal || threadId === undefined || jobId === undefined || !visible) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const lean = currentDataMode() === "lean";
    const initialDelayMs = lean ? LEAN_PROCESS_JOB_POLL_INITIAL_MS : PROCESS_JOB_POLL_INITIAL_MS;
    const maxDelayMs = lean ? LEAN_PROCESS_JOB_POLL_MAX_MS : PROCESS_JOB_POLL_MAX_MS;
    let delayMs = initialDelayMs;
    const schedule = () => {
      const waitedMs = delayMs;
      timer = window.setTimeout(() => void refresh(waitedMs), waitedMs);
      delayMs = Math.min(maxDelayMs, delayMs * 2);
    };
    /** `waitedMs` is the interval this round slept; 0 for the read that opens the loop. */
    const refresh = async (waitedMs = 0) => {
      // The stream answered inside the interval this round waited out. Re-armed
      // at the same delay rather than the next one: nothing was asked, so
      // nothing has earned a longer backoff.
      if (waitedMs > 0 && Date.now() - projectedRef.current.at < waitedMs) {
        timer = window.setTimeout(() => void refresh(waitedMs), waitedMs);
        return;
      }
      try {
        const next = await api.threadJob(threadId, jobId, controller.signal);
        if (controller.signal.aborted) return;
        // A poll answer counts only when it moves the job forward. The store can
        // hand the row a newer projection while a request is out: a slower
        // answer that is further back in the lifecycle must not drag the row
        // back, one that says the same state counts only for the start stamp
        // it may bring, and a terminal one is progress however the request and
        // the store interleaved. Judged against the latest state, not the
        // closure's.
        setLive((current) => current === undefined || processJobSupersedes(current, next) ? next : current);
        // Terminal always advances the nonterminal row this effect exists for,
        // so the answer that ends the loop is one the row has taken.
        if (TERMINAL_PROCESS_JOB_STATES.has(next.state)) return;
        if (next.state === "running") {
          // A live tail stays at the mode's initial cadence. Queued/starting
          // jobs and failed reads retain the existing exponential backoff.
          delayMs = initialDelayMs;
        }
      } catch {
        // The retained card remains authoritative while its owner is offline.
      }
      if (controller.signal.aborted) return;
      schedule();
    };
    void refresh();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [jobId, terminal, threadId, visible]);

  if (live === undefined) return null;
  const responseText = typeof payload.responseText === "string" && payload.responseText.trim().length > 0
    ? payload.responseText
    : undefined;
  const status = processJobStatus(live.state);
  const stateLabel = processJobStateLabel(live.state);
  const outputRefs = [live.output.stdoutRef, live.output.stderrRef].filter((ref): ref is string => ref !== null);
  return (
    <ActivityRow
      variant="job"
      status={status}
      label={`${live.tool} job`}
      summary={live.summary}
      failed={status === "failed" ? stateLabel : undefined}
      duration={processJobMeta(live, terminal)}
      open={open}
      onToggle={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) manuallyCollapsed.current = true;
      }}
      ariaLabel={`${live.tool} background job ${stateLabel}`}
    >
      <div className="activity-payload is-indented">
        <dl className="process-job-facts">
          <div><dt>State</dt><dd>{stateLabel}</dd></div>
          {live.exitCode !== null && <div><dt>Exit</dt><dd>{live.exitCode}</dd></div>}
          {live.signal !== null && <div><dt>Signal</dt><dd>{live.signal}</dd></div>}
          <div><dt>Wake</dt><dd>{wakeLabel(live.wake)}</dd></div>
        </dl>
        {live.output.preview.length > 0 && (
          <>
            <span>Output{live.output.truncated ? " (truncated)" : ""}</span>
            <pre
              ref={outputRef}
              className="process-job-output"
              onScroll={(event) => {
                const target = event.currentTarget;
                followOutput.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 24;
              }}
            >{live.output.preview}</pre>
          </>
        )}
        {outputRefs.length > 0 && (
          <>
            <span>Artifacts</span>
            <pre>{outputRefs.join("\n")}</pre>
          </>
        )}
        {live.lastError !== null && (
          <p className="activity-error"><strong>{live.lastError.code}</strong> {live.lastError.message}</p>
        )}
        {responseText !== undefined && (
          <>
            <span>Response</span>
            <pre>{responseText}</pre>
          </>
        )}
      </div>
    </ActivityRow>
  );
}
