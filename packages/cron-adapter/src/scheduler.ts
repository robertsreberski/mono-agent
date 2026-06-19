import { CronExpressionParser } from "cron-parser";

import {
  BufferedMessageStream,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";
import { normalizeOptionalString } from "@mono-agent/settings";

export interface CronRequestMetadata {
  readonly jobId: string;
  readonly expression: string;
  readonly timezone: string;
  readonly scheduledAt: string;
  readonly startedAt: string;
}

export interface CronJob {
  readonly id: string;
  readonly expression: string;
  readonly timezone?: string;
  readonly prompt: string;
  readonly conversationId?: string;
  /**
   * Destination channel conversationId for a proactive notification, e.g.
   * `telegram:<chat>` or `slack:<ch>:<thread>`. When set (and the host wires a
   * {@link CronAdapterOptions.notify} router), the job's prompt is delivered as a
   * turn on that channel's own harness instead of running a headless turn.
   */
  readonly notify?: string;
}

/**
 * Overlap policy when a job fires while a prior run is still active.
 * - "skip" (default): drop the new firing (legacy behavior).
 * - "queue": preserve the firing and run it after the current one.
 * - "replace": abort the active run and run the newest firing instead.
 */
export type CronOverlapMode = "queue" | "skip" | "replace";

/** What to do when a job's queue exceeds maxQueueDepth (overlap:"queue"). */
export type CronOverflowPolicy = "preserve" | "coalesce" | "drop-oldest";

export type CronJobResult =
  | {
      readonly kind: "succeeded";
      readonly jobId: string;
      readonly scheduledAt: string;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly text?: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly kind: "failed" | "cancelled";
      readonly jobId: string;
      readonly scheduledAt: string;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly error: string;
    }
  | {
      readonly kind: "skipped";
      readonly jobId: string;
      readonly scheduledAt: string;
      readonly reason: "overlap";
    }
  | {
      readonly kind: "queued";
      readonly jobId: string;
      readonly scheduledAt: string;
      readonly queueDepth: number;
    }
  | {
      readonly kind: "dropped";
      readonly jobId: string;
      readonly scheduledAt: string;
      readonly reason: "overflow";
    };

export interface CronAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface CronAdapterOptions {
  readonly responder: AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse>;
  readonly jobs: readonly CronJob[];
  readonly now?: () => Date;
  readonly onResult?: (result: CronJobResult) => void | Promise<void>;
  readonly logger?: CronAdapterLogger;
  /**
   * Host-supplied router for a job's {@link CronJob.notify} destination. Delivers
   * the framed trigger as a turn on the destination channel's own harness (shared
   * session/history) rather than running a headless turn here. When a job has a
   * `notify` destination but this is unset, the job falls back to a headless run.
   */
  readonly notify?: (input: { readonly conversationId: string; readonly text: string }) => Promise<void>;
  /** Overlap policy for a job that fires while still running. Default "skip". */
  readonly overlap?: CronOverlapMode;
  /** Soft cap on a job's pending-firing queue (overlap:"queue"). Unbounded if unset. */
  readonly maxQueueDepth?: number;
  /** What to do past maxQueueDepth. Default "preserve" (keep all, warn). */
  readonly overflow?: CronOverflowPolicy;
}

export interface CronAdapterStartResult {
  readonly jobs: readonly CronJob[];
  readonly activeJobCount: number;
  stop(): void;
}

export type CronAdapterErrorCode = "invalid_config" | "stream_closed";

export interface CronAdapterErrorDetails {
  readonly code?: CronAdapterErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class CronAdapterError extends Error {
  readonly code: CronAdapterErrorCode;
  readonly details: CronAdapterErrorDetails;

  constructor(code: CronAdapterErrorCode, message: string, details: CronAdapterErrorDetails = {}) {
    super(message);
    this.name = "CronAdapterError";
    this.code = code;
    this.details = { ...details, code };
  }
}

interface PendingFiring {
  readonly scheduledAt: string;
}

interface JobRuntimeState {
  active: AbortController | undefined;
  pending: PendingFiring[];
}

interface ScheduledJob {
  readonly job: CronJob;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_TIMEZONE = "UTC";
const MAX_TIMEOUT_MS = 2_147_483_647;

export function startCronAdapter(options: CronAdapterOptions): CronAdapterStartResult {
  validateOptions(options);
  const jobStates = new Map<string, JobRuntimeState>();
  const scheduled = options.jobs.map((job) => ({ job, timer: undefined }) satisfies ScheduledJob);
  for (const entry of scheduled) {
    scheduleNext(entry, options, jobStates);
  }

  return {
    jobs: options.jobs.slice(),
    get activeJobCount() {
      let count = 0;
      for (const state of jobStates.values()) {
        if (state.active !== undefined) count += 1;
      }
      return count;
    },
    stop() {
      for (const entry of scheduled) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
      }
      for (const state of jobStates.values()) {
        state.pending.length = 0;
        state.active?.abort(new Error("Cron adapter stopped."));
      }
      jobStates.clear();
    },
  };
}

function scheduleNext(
  entry: ScheduledJob,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
): void {
  const now = options.now?.() ?? new Date();
  const scheduledAt = nextDateFor(entry.job, now);
  const delayMs = Math.max(0, scheduledAt.getTime() - now.getTime());
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (delayMs > MAX_TIMEOUT_MS) {
      scheduleNext(entry, options, jobStates);
      return;
    }
    handleTick(entry.job, scheduledAt, options, jobStates);
    scheduleNext(entry, options, jobStates);
  }, Math.min(delayMs, MAX_TIMEOUT_MS));
}

function ensureState(jobStates: Map<string, JobRuntimeState>, jobId: string): JobRuntimeState {
  let state = jobStates.get(jobId);
  if (state === undefined) {
    state = { active: undefined, pending: [] };
    jobStates.set(jobId, state);
  }
  return state;
}

/**
 * Internal: dispatch a single firing for a job, honoring the overlap policy.
 * Exported (but not re-exported from the package index) so the overlap
 * defense-in-depth fallback can be regression-tested directly, bypassing the
 * startup `validateOptions` gate that rejects invalid overlap values.
 */
export function handleTick(
  job: CronJob,
  scheduledAtDate: Date,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
): void {
  const scheduledAt = scheduledAtDate.toISOString();
  const state = ensureState(jobStates, job.id);

  // No run in flight for this job: start immediately. Distinct jobs always run
  // in parallel because each has its own state.
  if (state.active === undefined) {
    startRun(job, scheduledAt, options, jobStates, state);
    return;
  }

  // Default to "skip" (the documented/legacy behavior): an overlapping firing is
  // dropped while a prior run is active. "queue"/"replace" are opt-in; "queue"
  // should be paired with maxQueueDepth to bound memory.
  const mode: CronOverlapMode = options.overlap ?? "skip";
  if (mode === "skip") {
    options.logger?.warn?.("Cron job skipped because a prior run is still active.", { jobId: job.id, scheduledAt });
    void emitResult(options, { kind: "skipped", jobId: job.id, scheduledAt, reason: "overlap" });
    return;
  }
  if (mode === "replace") {
    // Discard pending + the in-flight run; the newest firing wins. Emit a
    // terminal "dropped" for every firing we discard so a previously-reported
    // kind:"queued" never becomes a dangling firing with no terminal — mirroring
    // the queue branch's drop-oldest/coalesce observability below.
    for (const dropped of state.pending) {
      void emitResult(options, { kind: "dropped", jobId: job.id, scheduledAt: dropped.scheduledAt, reason: "overflow" });
    }
    state.pending = [{ scheduledAt }];
    state.active.abort(new Error("Cron job replaced by a newer scheduled run."));
    void emitResult(options, { kind: "queued", jobId: job.id, scheduledAt, queueDepth: state.pending.length });
    return;
  }

  // "queue" (opt-in): preserve every firing, drained in order after the active
  // run finishes. Bound it with maxQueueDepth + overflow to limit memory.
  if (mode === "queue") {
    state.pending.push({ scheduledAt });
    const max = options.maxQueueDepth;
    if (max !== undefined && max >= 0 && state.pending.length > max) {
      const overflow: CronOverflowPolicy = options.overflow ?? "preserve";
      if (overflow === "drop-oldest") {
        const dropped = state.pending.shift();
        if (dropped !== undefined) {
          options.logger?.warn?.("Cron firing dropped (queue overflow, drop-oldest).", { jobId: job.id, maxQueueDepth: max });
          void emitResult(options, { kind: "dropped", jobId: job.id, scheduledAt: dropped.scheduledAt, reason: "overflow" });
        }
      } else if (overflow === "coalesce") {
        const newest = state.pending[state.pending.length - 1];
        const droppedOnes = state.pending.slice(0, -1);
        state.pending = newest === undefined ? [] : [newest];
        for (const dropped of droppedOnes) {
          void emitResult(options, { kind: "dropped", jobId: job.id, scheduledAt: dropped.scheduledAt, reason: "overflow" });
        }
      } else {
        // "preserve": keep everything, but surface backpressure (never a silent drop).
        options.logger?.warn?.("Cron queue depth exceeds maxQueueDepth (preserving every firing).", {
          jobId: job.id,
          depth: state.pending.length,
          maxQueueDepth: max,
        });
      }
    }
    void emitResult(options, { kind: "queued", jobId: job.id, scheduledAt, queueDepth: state.pending.length });
    return;
  }

  // Any unrecognized mode (e.g. an invalid value passed via a cast or untyped
  // JS/JSON consumer) defaults to the safe "skip" behavior rather than silently
  // falling through into the unbounded-memory "queue" branch.
  options.logger?.warn?.("Cron overlap mode unrecognized; defaulting to skip.", {
    jobId: job.id,
    overlap: options.overlap,
  });
  void emitResult(options, { kind: "skipped", jobId: job.id, scheduledAt, reason: "overlap" });
}

function startRun(
  job: CronJob,
  scheduledAt: string,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  state: JobRuntimeState,
): void {
  const controller = new AbortController();
  state.active = controller;
  const startedAt = (options.now?.() ?? new Date()).toISOString();

  // A job with a notify destination is delivered as a turn on the destination
  // channel's OWN harness (shared session/history + native delivery) instead of
  // a headless run here, so the destination channel's next live turn sees it.
  if (job.notify !== undefined && options.notify !== undefined) {
    startNotifyRun(job, job.notify, options.notify, scheduledAt, startedAt, options, jobStates, state, controller);
    return;
  }

  const stream = new BufferedMessageStream({
    onClosed: () =>
      new CronAdapterError("stream_closed", "Cannot write to a finished cron stream."),
  });
  const request: AgentRequestBase = {
    conversationId: job.conversationId ?? `cron:${job.id}`,
    text: job.prompt,
    abortSignal: controller.signal,
    metadata: {
      cron: {
        jobId: job.id,
        expression: job.expression,
        timezone: job.timezone ?? DEFAULT_TIMEZONE,
        scheduledAt,
        startedAt,
      } satisfies CronRequestMetadata,
    },
  };

  void options.responder.respond(request, stream)
    .then(async (response) => {
      await stream.finish(response.text);
      // Guard against a responder that ignores/races the abort signal and still
      // resolves with text: if THIS run's controller was aborted (overlap:"replace"
      // discarding the in-flight run, or stop()), report the run as cancelled
      // rather than succeeded. `controller` is captured per-run, so this keys the
      // abort check to this specific firing (not a newer run's controller). This
      // mirrors the .catch() classification below and LiveSessionManager.drain().
      if (controller.signal.aborted) {
        const result: CronJobResult = {
          kind: "cancelled",
          jobId: job.id,
          scheduledAt,
          startedAt,
          completedAt: (options.now?.() ?? new Date()).toISOString(),
          error: "Cron job cancelled (responder resolved after abort).",
        };
        options.logger?.warn?.("Cron job responder resolved after abort; reporting cancelled.", {
          jobId: job.id,
          error: result.error,
        });
        await emitResult(options, result);
        return;
      }
      const result: CronJobResult = {
        kind: "succeeded",
        jobId: job.id,
        scheduledAt,
        startedAt,
        completedAt: (options.now?.() ?? new Date()).toISOString(),
        ...(stream.text.length === 0 ? {} : { text: stream.text }),
        ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
      };
      await emitResult(options, result);
    })
    .catch(async (error: unknown) => {
      const cancelled = controller.signal.aborted || isAgentResponseCancelledError(error);
      const result: CronJobResult = {
        kind: cancelled ? "cancelled" : "failed",
        jobId: job.id,
        scheduledAt,
        startedAt,
        completedAt: (options.now?.() ?? new Date()).toISOString(),
        error: errorToMessage(error),
      };
      options.logger?.[cancelled ? "warn" : "error"]?.("Cron job responder failed.", {
        jobId: job.id,
        error: result.error,
      });
      await emitResult(options, result);
    })
    .finally(() => {
      state.active = undefined;
      drainNext(job, options, jobStates, state);
    });
}

/** Provenance-framed trigger text so the destination channel's agent knows the turn is a proactive cron nudge. */
function frameCronTrigger(jobId: string, prompt: string): string {
  return `Proactive trigger from cron job "${jobId}".\n\n${prompt}`;
}

/**
 * Deliver a job to its notify destination by routing the framed prompt to the
 * destination channel's harness. Mirrors the headless path's result emission +
 * overlap drain so observability and queueing behave identically; the router
 * resolves once the destination turn has been delivered.
 */
function startNotifyRun(
  job: CronJob,
  destination: string,
  notify: NonNullable<CronAdapterOptions["notify"]>,
  scheduledAt: string,
  startedAt: string,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  state: JobRuntimeState,
  controller: AbortController,
): void {
  const completedAt = (): string => (options.now?.() ?? new Date()).toISOString();
  void notify({ conversationId: destination, text: frameCronTrigger(job.id, job.prompt) })
    .then(async () => {
      if (controller.signal.aborted) {
        await emitResult(options, {
          kind: "cancelled",
          jobId: job.id,
          scheduledAt,
          startedAt,
          completedAt: completedAt(),
          error: "Cron job cancelled (notify resolved after abort).",
        });
        return;
      }
      await emitResult(options, {
        kind: "succeeded",
        jobId: job.id,
        scheduledAt,
        startedAt,
        completedAt: completedAt(),
      });
    })
    .catch(async (error: unknown) => {
      const cancelled = controller.signal.aborted || isAgentResponseCancelledError(error);
      const result: CronJobResult = {
        kind: cancelled ? "cancelled" : "failed",
        jobId: job.id,
        scheduledAt,
        startedAt,
        completedAt: completedAt(),
        error: errorToMessage(error),
      };
      options.logger?.[cancelled ? "warn" : "error"]?.("Cron job proactive notify failed.", {
        jobId: job.id,
        error: result.error,
      });
      await emitResult(options, result);
    })
    .finally(() => {
      state.active = undefined;
      drainNext(job, options, jobStates, state);
    });
}

function drainNext(
  job: CronJob,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  state: JobRuntimeState,
): void {
  const next = state.pending.shift();
  if (next !== undefined) {
    startRun(job, next.scheduledAt, options, jobStates, state);
    return;
  }
  if (state.active === undefined && state.pending.length === 0) {
    jobStates.delete(job.id);
  }
}

async function emitResult(options: CronAdapterOptions, result: CronJobResult): Promise<void> {
  await options.onResult?.(result);
}

function nextDateFor(job: CronJob, currentDate: Date): Date {
  try {
    return CronExpressionParser.parse(job.expression, {
      currentDate,
      tz: job.timezone ?? DEFAULT_TIMEZONE,
    }).next().toDate();
  } catch (error) {
    throw new CronAdapterError("invalid_config", "Cron job expression is invalid.", {
      jobId: job.id,
      reason: errorToMessage(error),
    });
  }
}

const VALID_OVERLAP_MODES: ReadonlySet<CronOverlapMode> = new Set(["queue", "skip", "replace"]);
const VALID_OVERFLOW_POLICIES: ReadonlySet<CronOverflowPolicy> = new Set(["preserve", "coalesce", "drop-oldest"]);

function validateOptions(options: CronAdapterOptions): void {
  if (typeof options.responder?.respond !== "function") {
    throw new CronAdapterError("invalid_config", "Cron adapter requires a responder.");
  }
  if (options.overlap !== undefined && !VALID_OVERLAP_MODES.has(options.overlap)) {
    throw new CronAdapterError("invalid_config", "Cron overlap mode is invalid.", { overlap: options.overlap });
  }
  if (options.overflow !== undefined && !VALID_OVERFLOW_POLICIES.has(options.overflow)) {
    throw new CronAdapterError("invalid_config", "Cron overflow policy is invalid.", { overflow: options.overflow });
  }
  const seen = new Set<string>();
  for (const job of options.jobs) {
    if (normalizeOptionalString(job.id) === undefined) {
      throw new CronAdapterError("invalid_config", "Cron job id is required.");
    }
    if (seen.has(job.id)) {
      throw new CronAdapterError("invalid_config", "Cron job ids must be unique.", { jobId: job.id });
    }
    seen.add(job.id);
    if (normalizeOptionalString(job.prompt) === undefined) {
      throw new CronAdapterError("invalid_config", "Cron job prompt is required.", { jobId: job.id });
    }
    assertFiveFieldExpression(job);
    nextDateFor(job, options.now?.() ?? new Date());
  }
}

function assertFiveFieldExpression(job: CronJob): void {
  const expression = normalizeOptionalString(job.expression);
  if (expression === undefined) {
    throw new CronAdapterError("invalid_config", "Cron job expression is required.", { jobId: job.id });
  }
  const fields = expression.split(/\s+/u);
  if (fields.length !== 5) {
    throw new CronAdapterError("invalid_config", "Cron job expression must use exactly five fields.", {
      jobId: job.id,
      fieldCount: fields.length,
    });
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
