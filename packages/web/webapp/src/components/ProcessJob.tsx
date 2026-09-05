import type { DataMessagePartProps } from "@assistant-ui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { api } from "../api";
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
  // The projection the store handed over most recently. A poll answer that was
  // already in flight when the store moved on is older than what it would
  // replace, so the poll checks this before applying what it fetched.
  const retainedRef = useRef(initial);
  const threadId = initial === undefined ? undefined : processJobThreadId(initial);
  const jobId = initial?.jobId;
  const terminal = live === undefined || TERMINAL_PROCESS_JOB_STATES.has(live.state);

  useEffect(() => {
    retainedRef.current = initial;
    setLive(initial);
  }, [initial]);

  useEffect(() => {
    if (terminal || threadId === undefined || jobId === undefined) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let delayMs = PROCESS_JOB_POLL_INITIAL_MS;
    const refresh = async () => {
      const retained = retainedRef.current;
      try {
        const next = await api.threadJob(threadId, jobId, controller.signal);
        if (controller.signal.aborted) return;
        if (retainedRef.current === retained) setLive(next);
        if (TERMINAL_PROCESS_JOB_STATES.has(next.state)) return;
      } catch {
        // The retained card remains authoritative while its owner is offline.
      }
      if (controller.signal.aborted) return;
      timer = window.setTimeout(() => void refresh(), delayMs);
      delayMs = Math.min(PROCESS_JOB_POLL_MAX_MS, delayMs * 2);
    };
    void refresh();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [jobId, terminal, threadId]);

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
            <pre>{live.output.preview}</pre>
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
