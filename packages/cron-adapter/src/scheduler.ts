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
  /** Overlap policy for a job that fires while still running. Default "skip". */
  readonly overlap?: CronOverlapMode;
  /** Soft cap on a job's pending-firing queue (overlap:"queue"). Unbounded if unset. */
  readonly maxQueueDepth?: number;
  /** What to do past maxQueueDepth. Default "preserve" (keep all, warn). */
  readonly overflow?: CronOverflowPolicy;
  /**
   * Watchdog: if a run's responder does not settle within this many ms, abort it and reclaim the
   * slot (`state.active`) so the job is not blocked forever. A hung responder otherwise leaves
   * `state.active` set, and every future firing is skipped as "a prior run is still active".
   * Unset (default) disables the watchdog, preserving prior behavior.
   */
  readonly maxRunMs?: number;
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

  // Finalize the run at most once. A hung responder (a promise that never settles AND ignores the
  // abort signal) would otherwise leave `state.active` set forever, skipping every future firing.
  // The watchdog below races the responder so the slot is always reclaimed; whichever path fires
  // first wins, and the loser becomes a no-op. Clearing `state.active` + draining lives here so it
  // happens exactly once regardless of which path completes.
  let settled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const finalize = (handle: () => Promise<void>): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
    }
    void handle()
      .catch(() => undefined)
      .finally(() => {
        state.active = undefined;
        drainNext(job, options, jobStates, state);
      });
  };

  if (options.maxRunMs !== undefined && options.maxRunMs > 0) {
    const limitMs = options.maxRunMs;
    watchdog = setTimeout(() => {
      // Signal the responder to stop, then reclaim the slot even if it never settles.
      controller.abort(new Error(`Cron job exceeded maxRunMs (${limitMs}ms).`));
      finalize(async () => {
        const result: CronJobResult = {
          kind: "failed",
          jobId: job.id,
          scheduledAt,
          startedAt,
          completedAt: (options.now?.() ?? new Date()).toISOString(),
          error: `Cron job timed out after ${limitMs}ms (responder did not settle); reclaiming the slot.`,
        };
        options.logger?.error?.("Cron job timed out; reclaiming the slot.", { jobId: job.id, maxRunMs: limitMs });
        await emitResult(options, result);
      });
    }, limitMs);
    // Don't let the watchdog timer keep the process alive on its own.
    (watchdog as { unref?: () => void }).unref?.();
  }

  void options.responder.respond(request, stream)
    .then((response) => {
      finalize(async () => {
        await stream.finish(response.text);
        // Guard against a responder that ignores/races the abort signal and still
        // resolves with text: if THIS run's controller was aborted (overlap:"replace"
        // discarding the in-flight run, the watchdog, or stop()), report the run as
        // cancelled rather than succeeded. `controller` is captured per-run, so this keys
        // the abort check to this specific firing (not a newer run's controller). This
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
      });
    })
    .catch((error: unknown) => {
      finalize(async () => {
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
      });
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
