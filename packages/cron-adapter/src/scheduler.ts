import {
  BufferedMessageStream,
  isAgentResponseCancelledError,
  normalizeOptionalString,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamEvent,
} from "@mono-agent/agent-contracts";

import { validateCronExpression } from "./cron-expression.js";

export interface CronRequestMetadata {
  readonly jobId: string;
  /** Stable cron-domain identity; distinct from the harness artifact run id. */
  readonly cronRunId: string;
  readonly sequence: number;
  readonly orderedAt: string;
  readonly trigger: CronRunTrigger;
  readonly expression: string;
  readonly timezone: string;
  readonly scheduledAt: string;
  readonly startedAt: string;
  readonly nativeNotify?: {
    readonly enabled: true;
    readonly conversationId?: string;
  };
  /** Per-job runtime model override (raw string; parsed/validated by the app). */
  readonly model?: string;
  /** Per-job reasoning effort override (raw string; validated by the app). */
  readonly effort?: string;
}

export interface CronJob {
  readonly id: string;
  /** Runtime-effective state. Defaults to true for programmatic compatibility. */
  readonly enabled?: boolean;
  readonly expression: string;
  readonly timezone?: string;
  readonly prompt: string;
  readonly conversationId?: string;
  /** Per-job watchdog override in milliseconds. Falls back to CronAdapterOptions.maxRunMs. */
  readonly maxRunMs?: number;
  /** When true, the app host may deliver the final answer to a notify-capable conversation. */
  readonly notify?: boolean;
  /** Optional destination conversationId for native notification delivery. */
  readonly notifyConversationId?: string;
  /**
   * Pre-resolved fallback used only when notifyConversationId is absent.
   * Programmatic hosts that need a live destination set should prefer the
   * adapter-level per-run resolver.
   */
  readonly notifyFallbackConversationId?: string;
  /** Per-job runtime model override (raw string; parsed/validated by the app). */
  readonly model?: string;
  /** Per-job reasoning effort override (raw string; validated by the app). */
  readonly effort?: string;
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

export type CronRunTrigger = "scheduled" | "manual";

/** Immutable identity allocated once for every admitted firing. */
export interface CronFiringIdentity {
  readonly runId: string;
  readonly jobId: string;
  readonly scheduledAt: string;
  readonly orderedAt: string;
  readonly sequence: number;
  readonly trigger: CronRunTrigger;
}

interface CronResultIdentity {
  readonly cronRunId: string;
  readonly jobId: string;
  readonly scheduledAt: string;
  readonly orderedAt: string;
  readonly sequence: number;
  readonly trigger: CronRunTrigger;
}

export type CronJobResult =
  | (CronResultIdentity & {
      readonly kind: "succeeded";
      readonly startedAt: string;
      readonly completedAt: string;
      /** Physical native-notify route snapshotted before the responder started. */
      readonly notifyConversationId?: string;
      readonly text?: string;
      readonly metadata?: Record<string, unknown>;
    })
  | (CronResultIdentity & {
      readonly kind: "failed" | "cancelled";
      readonly startedAt: string;
      readonly completedAt: string;
      readonly error: string;
      readonly failureKind?: string;
      /** Harness artifact id, when a recorder was created before failure. */
      readonly runId?: string;
    })
  | (CronResultIdentity & {
      readonly kind: "skipped";
      readonly reason: "overlap";
      readonly blockedByRunId: string;
      readonly blockedByTrigger: CronRunTrigger;
    })
  | (CronResultIdentity & {
      readonly kind: "queued";
      readonly queueDepth: number;
    })
  | (CronResultIdentity & {
      readonly kind: "dropped";
      readonly reason: "overflow";
    });

export interface CronAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface CronAdapterOptions {
  readonly responder: AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse>;
  readonly jobs: readonly CronJob[];
  /**
   * Host-owned fallback resolver for native-notify jobs without an explicit or
   * pre-resolved destination. It runs once per firing so the request's replyTo
   * and the resulting delivery route share the same lifecycle snapshot. The
   * optional signal allows cooperative cancellation; the adapter also races
   * resolver settlement against it.
   */
  readonly resolveNotifyFallbackConversationId?: (abortSignal?: AbortSignal) => Promise<string | undefined>;
  readonly now?: () => Date;
  /** Host-owned durable identity allocator. Called synchronously before admission. */
  readonly admitFiring?: (input: {
    readonly jobId: string;
    readonly scheduledAt: string;
    readonly observedAt: string;
    readonly trigger: CronRunTrigger;
  }) => CronFiringIdentity;
  /** Observe the exact transition into responder execution. */
  readonly onRunStarted?: (firing: CronFiringIdentity, startedAt: string) => void | Promise<void>;
  /** Persist/render canonical runtime events without inventing cron-only cards. */
  readonly onEvent?: (firing: CronFiringIdentity, event: AgentStreamEvent) => void | Promise<void>;
  /** Resolve the harness artifact id correlated by the host recorder hook. */
  readonly resolveArtifactRunId?: (firing: CronFiringIdentity) => string | undefined;
  readonly onResult?: (result: CronJobResult) => void | Promise<void>;
  /** Host-owned durable state became unavailable after startup. */
  readonly onDegraded?: (reason: string) => void;
  readonly logger?: CronAdapterLogger;
  /** Overlap policy for a job that fires while still running. Default "skip". */
  readonly overlap?: CronOverlapMode;
  /** Soft cap on a job's pending-firing queue (overlap:"queue"). Unbounded if unset. */
  readonly maxQueueDepth?: number;
  /** What to do past maxQueueDepth. Default "preserve" (keep all, warn). */
  readonly overflow?: CronOverflowPolicy;
  /**
   * Watchdog: if a run does not settle within this many ms, abort it and reclaim the
   * slot (`state.active`) so the job is not blocked forever. A hung resolver or
   * responder otherwise leaves `state.active` set, and every future firing is
   * skipped as "a prior run is still active".
   * Unset (default) disables the watchdog, preserving prior behavior.
   */
  readonly maxRunMs?: number;
}

export interface CronAdapterStartResult {
  readonly jobs: readonly CronJob[];
  readonly activeJobCount: number;
  snapshots(): readonly CronJobSnapshot[];
  /** Start a manual firing; an optional identity must have been host-admitted durably. */
  runNow(jobId: string, admitted?: CronFiringIdentity): CronFiringIdentity;
  setEffectiveEnabled(jobId: string, enabled: boolean): CronJobSnapshot;
  stop(): void;
}

export interface CronJobSnapshot {
  readonly jobId: string;
  readonly expression: string;
  readonly timezone: string;
  readonly effectiveEnabled: boolean;
  readonly conversationId: string;
  readonly nextRunAt?: string;
  readonly activeRunId?: string;
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

interface PendingFiring extends CronFiringIdentity {}

interface ActiveFiring {
  readonly controller: AbortController;
  readonly firing: CronFiringIdentity;
}

interface JobRuntimeState {
  active: ActiveFiring | undefined;
  pending: PendingFiring[];
}

interface ScheduledJob {
  readonly job: CronJob;
  enabled: boolean;
  nextRunAt: Date | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_TIMEZONE = "UTC";
const MAX_TIMEOUT_MS = 2_147_483_647;

export function startCronAdapter(options: CronAdapterOptions): CronAdapterStartResult {
  validateOptions(options);
  const jobStates = new Map<string, JobRuntimeState>();
  const sequenceByJob = new Map<string, number>();
  let stopped = false;
  const scheduled = options.jobs.map((job) => ({
    job,
    enabled: job.enabled !== false,
    nextRunAt: undefined,
    timer: undefined,
  }) satisfies ScheduledJob);
  for (const entry of scheduled) {
    if (entry.enabled) scheduleNext(entry, options, jobStates, sequenceByJob);
  }

  const requireEntry = (jobId: string): ScheduledJob => {
    const entry = scheduled.find((candidate) => candidate.job.id === jobId);
    if (entry === undefined) {
      throw new CronAdapterError("invalid_config", `Unknown cron job "${jobId}".`, { jobId });
    }
    return entry;
  };

  const snapshotOfEntry = (entry: ScheduledJob): CronJobSnapshot => {
    const active = jobStates.get(entry.job.id)?.active;
    return {
      jobId: entry.job.id,
      expression: entry.job.expression,
      timezone: entry.job.timezone ?? DEFAULT_TIMEZONE,
      effectiveEnabled: entry.enabled,
      conversationId: entry.job.conversationId ?? `cron:${entry.job.id}`,
      ...(entry.nextRunAt === undefined ? {} : { nextRunAt: entry.nextRunAt.toISOString() }),
      ...(active === undefined ? {} : { activeRunId: active.firing.runId }),
    };
  };

  return {
    jobs: options.jobs.slice(),
    get activeJobCount() {
      let count = 0;
      for (const state of jobStates.values()) {
        if (state.active !== undefined) count += 1;
      }
      return count;
    },
    snapshots() {
      return scheduled.map(snapshotOfEntry);
    },
    runNow(jobId, admitted) {
      if (stopped) {
        throw new CronAdapterError("invalid_config", "Cron adapter is stopped.", { jobId });
      }
      const entry = requireEntry(jobId);
      const now = admitted === undefined
        ? options.now?.() ?? new Date()
        : new Date(admitted.scheduledAt);
      return handleTick(entry.job, now, options, jobStates, sequenceByJob, "manual", admitted);
    },
    setEffectiveEnabled(jobId, enabled) {
      if (stopped) {
        throw new CronAdapterError("invalid_config", "Cron adapter is stopped.", { jobId });
      }
      const entry = requireEntry(jobId);
      if (entry.enabled === enabled) return snapshotOfEntry(entry);
      entry.enabled = enabled;
      if (!enabled) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.nextRunAt = undefined;
      } else {
        scheduleNext(entry, options, jobStates, sequenceByJob);
      }
      return snapshotOfEntry(entry);
    },
    stop() {
      stopped = true;
      for (const entry of scheduled) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
        entry.nextRunAt = undefined;
      }
      for (const state of jobStates.values()) {
        state.pending.length = 0;
        state.active?.controller.abort(new Error("Cron adapter stopped."));
      }
      jobStates.clear();
    },
  };
}

function scheduleNext(
  entry: ScheduledJob,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  sequenceByJob: Map<string, number>,
  lastFiredScheduledAt?: Date,
): void {
  if (!entry.enabled) return;
  const now = options.now?.() ?? new Date();
  // Belt-and-braces against a backward clock step (or a timer that coalesced early
  // and woke the just-fired timer before its target): never compute the next fire
  // from an instant at or before the firing we just dispatched, or cron-parser's
  // strictly-after `.next()` could hand back the SAME scheduledAt and we would fire
  // it twice. Anchoring to at-or-after the last firing guarantees a strictly-later
  // next target.
  const base =
    lastFiredScheduledAt === undefined
      ? now
      : new Date(Math.max(now.getTime(), lastFiredScheduledAt.getTime()));
  const scheduledAt = nextDateFor(entry.job, base);
  entry.nextRunAt = scheduledAt;
  armTimer(entry, scheduledAt, options, jobStates, sequenceByJob);
}

/**
 * Arm (or re-arm) `entry.timer` to fire at `scheduledAt`. Splitting arming from
 * computing lets the early-wake guard below re-arm for the SAME target without
 * recomputing the next cron instant. The callback never dispatches before
 * `scheduledAt`: OS timer coalescing (observed on macOS) can wake a timer a few
 * ms EARLY, and firing then would dispatch the firing and immediately schedule
 * the same target again — a duplicate that trips the overlap guard as a spurious
 * kind:"skipped".
 */
function armTimer(
  entry: ScheduledJob,
  scheduledAt: Date,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  sequenceByJob: Map<string, number>,
): void {
  if (!entry.enabled) return;
  const now = options.now?.() ?? new Date();
  const delayMs = Math.max(0, scheduledAt.getTime() - now.getTime());
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    // Long-delay chunking: the full delay to `scheduledAt` exceeded a single
    // setTimeout's max, so this wake only counted down MAX_TIMEOUT_MS. Re-arm for
    // the SAME target and keep counting down the remainder. (Today's code recomputes
    // the next cron instant here; keeping the same target is more precise, identical
    // semantics.)
    if (delayMs > MAX_TIMEOUT_MS) {
      armTimer(entry, scheduledAt, options, jobStates, sequenceByJob);
      return;
    }
    // Early-wake guard: if the timer woke before `scheduledAt`, re-arm for the
    // remaining sliver (max(1, …) ms) instead of firing. The loop converges because
    // the remainder shrinks as the real clock catches up to `scheduledAt`.
    const wake = options.now?.() ?? new Date();
    if (wake.getTime() < scheduledAt.getTime()) {
      armTimer(entry, scheduledAt, options, jobStates, sequenceByJob);
      return;
    }
    if (!entry.enabled) return;
    entry.nextRunAt = undefined;
    // Due (now >= scheduledAt): dispatch this firing, then schedule the next one
    // anchored at-or-after this firing so a backward clock step cannot recompute the
    // same target (see scheduleNext's `base`).
    try {
      handleTick(entry.job, scheduledAt, options, jobStates, sequenceByJob, "scheduled");
    } catch (error) {
      reportDegraded(options, "Cron firing admission failed.", error, {
        jobId: entry.job.id,
        scheduledAt: scheduledAt.toISOString(),
      });
    } finally {
      // Admission is host-persistent and may fail synchronously. The failed
      // instant is still consumed: always compute the next strictly-later target
      // from the original scheduled anchor so one store fault neither crashes
      // the timer callback nor permanently unarms the job.
      if (entry.enabled) {
        try {
          scheduleNext(entry, options, jobStates, sequenceByJob, scheduledAt);
        } catch (error) {
          reportDegraded(options, "Cron timer could not schedule its next firing.", error, {
            jobId: entry.job.id,
            scheduledAt: scheduledAt.toISOString(),
          });
        }
      }
    }
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

function resultIdentity(firing: CronFiringIdentity): CronResultIdentity {
  return {
    cronRunId: firing.runId,
    jobId: firing.jobId,
    scheduledAt: firing.scheduledAt,
    orderedAt: firing.orderedAt,
    sequence: firing.sequence,
    trigger: firing.trigger,
  };
}

function artifactRunIdFields(options: CronAdapterOptions, firing: CronFiringIdentity): { readonly runId: string } | {} {
  const runId = options.resolveArtifactRunId?.(firing);
  return runId === undefined ? {} : { runId };
}

function assertFiringIdentity(
  firing: CronFiringIdentity,
  expected: { readonly jobId: string; readonly scheduledAt: string; readonly trigger: CronRunTrigger },
): void {
  if (
    normalizeOptionalString(firing.runId) === undefined
    || firing.jobId !== expected.jobId
    || firing.scheduledAt !== expected.scheduledAt
    || firing.trigger !== expected.trigger
    || !Number.isSafeInteger(firing.sequence)
    || firing.sequence <= 0
    || Number.isNaN(Date.parse(firing.orderedAt))
  ) {
    throw new CronAdapterError("invalid_config", "Cron firing allocator returned an invalid identity.", {
      jobId: expected.jobId,
      scheduledAt: expected.scheduledAt,
      trigger: expected.trigger,
    });
  }
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
  sequenceByJob: Map<string, number> = new Map(),
  trigger: CronRunTrigger = "scheduled",
  admitted?: CronFiringIdentity,
): CronFiringIdentity {
  const scheduledAt = scheduledAtDate.toISOString();
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const nextSequence = (sequenceByJob.get(job.id) ?? 0) + 1;
  const fallbackFiring: CronFiringIdentity = {
    runId: trigger === "manual"
      ? `cron:${encodeURIComponent(job.id)}:${observedAt}:m${String(nextSequence)}`
      : `cron:${encodeURIComponent(job.id)}:${scheduledAt}`,
    jobId: job.id,
    scheduledAt,
    orderedAt: observedAt,
    sequence: nextSequence,
    trigger,
  };
  const firing = admitted
    ?? options.admitFiring?.({ jobId: job.id, scheduledAt, observedAt, trigger })
    ?? fallbackFiring;
  assertFiringIdentity(firing, { jobId: job.id, scheduledAt, trigger });
  sequenceByJob.set(job.id, Math.max(nextSequence, firing.sequence));
  const state = ensureState(jobStates, job.id);

  // No run in flight for this job: start immediately. Distinct jobs always run
  // in parallel because each has its own state.
  if (state.active === undefined) {
    startRun(job, firing, options, jobStates, state);
    return firing;
  }

  // Default to "skip" (the documented/legacy behavior): an overlapping firing is
  // dropped while a prior run is active. "queue"/"replace" are opt-in; "queue"
  // should be paired with maxQueueDepth to bound memory.
  const mode: CronOverlapMode = options.overlap ?? "skip";
  if (mode === "skip") {
    options.logger?.warn?.("Cron job skipped because a prior run is still active.", { jobId: job.id, scheduledAt });
    void emitResult(options, {
      ...resultIdentity(firing),
      kind: "skipped",
      reason: "overlap",
      blockedByRunId: state.active.firing.runId,
      blockedByTrigger: state.active.firing.trigger,
    });
    return firing;
  }
  if (mode === "replace") {
    // Discard pending + the in-flight run; the newest firing wins. Emit a
    // terminal "dropped" for every firing we discard so a previously-reported
    // kind:"queued" never becomes a dangling firing with no terminal — mirroring
    // the queue branch's drop-oldest/coalesce observability below.
    for (const dropped of state.pending) {
      void emitResult(options, { ...resultIdentity(dropped), kind: "dropped", reason: "overflow" });
    }
    state.pending = [firing];
    state.active.controller.abort(new Error("Cron job replaced by a newer scheduled run."));
    void emitResult(options, { ...resultIdentity(firing), kind: "queued", queueDepth: state.pending.length });
    return firing;
  }

  // "queue" (opt-in): preserve every firing, drained in order after the active
  // run finishes. Bound it with maxQueueDepth + overflow to limit memory.
  if (mode === "queue") {
    state.pending.push(firing);
    const max = options.maxQueueDepth;
    if (max !== undefined && max >= 0 && state.pending.length > max) {
      const overflow: CronOverflowPolicy = options.overflow ?? "preserve";
      if (overflow === "drop-oldest") {
        const dropped = state.pending.shift();
        if (dropped !== undefined) {
          options.logger?.warn?.("Cron firing dropped (queue overflow, drop-oldest).", { jobId: job.id, maxQueueDepth: max });
          void emitResult(options, { ...resultIdentity(dropped), kind: "dropped", reason: "overflow" });
        }
      } else if (overflow === "coalesce") {
        const newest = state.pending[state.pending.length - 1];
        const droppedOnes = state.pending.slice(0, -1);
        state.pending = newest === undefined ? [] : [newest];
        for (const dropped of droppedOnes) {
          void emitResult(options, { ...resultIdentity(dropped), kind: "dropped", reason: "overflow" });
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
    void emitResult(options, { ...resultIdentity(firing), kind: "queued", queueDepth: state.pending.length });
    return firing;
  }

  // Any unrecognized mode (e.g. an invalid value passed via a cast or untyped
  // JS/JSON consumer) defaults to the safe "skip" behavior rather than silently
  // falling through into the unbounded-memory "queue" branch.
  options.logger?.warn?.("Cron overlap mode unrecognized; defaulting to skip.", {
    jobId: job.id,
    overlap: options.overlap,
  });
  void emitResult(options, {
    ...resultIdentity(firing),
    kind: "skipped",
    reason: "overlap",
    blockedByRunId: state.active.firing.runId,
    blockedByTrigger: state.active.firing.trigger,
  });
  return firing;
}

function startRun(
  job: CronJob,
  firing: CronFiringIdentity,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  state: JobRuntimeState,
): void {
  const controller = new AbortController();
  state.active = { controller, firing };
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const stream = new CronMessageStream(firing, options);

  // Finalize the run at most once. Hung run work (a resolver or responder promise
  // that never settles AND ignores the abort signal) would otherwise leave
  // `state.active` set forever, skipping every future firing.
  // The watchdog below races the run pipeline so the slot is always reclaimed; whichever path fires
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

  const effectiveMaxRunMs = job.maxRunMs ?? options.maxRunMs;
  if (effectiveMaxRunMs !== undefined && effectiveMaxRunMs > 0) {
    const limitMs = effectiveMaxRunMs;
    watchdog = setTimeout(() => {
      // Signal in-flight run work to stop, then reclaim the slot even if it never settles.
      controller.abort(new Error(`Cron job exceeded maxRunMs (${limitMs}ms).`));
      finalize(async () => {
        const result: CronJobResult = {
          ...resultIdentity(firing),
          kind: "failed",
          startedAt,
          completedAt: (options.now?.() ?? new Date()).toISOString(),
          error: `Cron job timed out after ${limitMs}ms (run did not settle); reclaiming the slot.`,
          ...artifactRunIdFields(options, firing),
        };
        options.logger?.error?.("Cron job timed out; reclaiming the slot.", { jobId: job.id, maxRunMs: limitMs });
        await emitResult(options, result);
      });
    }, limitMs);
    // Don't let the watchdog timer keep the process alive on its own.
    (watchdog as { unref?: () => void }).unref?.();
  }

  // Defer host callback evaluation into the promise chain: Promise.resolve(x)
  // cannot catch a synchronous throw that occurs while evaluating x. A failed
  // durable running transition fails this firing before model work starts, then
  // the common finalizer reclaims the overlap slot.
  void Promise.resolve()
    .then(async () => await options.onRunStarted?.(firing, startedAt))
    .catch((error: unknown) => {
      reportDegraded(options, "Cron run-start persistence failed.", error, {
        jobId: job.id,
        runId: firing.runId,
      });
      throw error;
    })
    .then(async () => await resolveNotifyConversationId(job, options, controller.signal))
    .then(async (notifyConversationId) => {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error("Cron job was cancelled before responder start.");
      }
      const request: AgentRequestBase = {
        conversationId: job.conversationId ?? `cron:${job.id}`,
        text: job.prompt,
        abortSignal: controller.signal,
        ...(job.notify === true ? toReplyTarget(notifyConversationId) : {}),
        metadata: {
          cron: {
            jobId: job.id,
            cronRunId: firing.runId,
            sequence: firing.sequence,
            orderedAt: firing.orderedAt,
            trigger: firing.trigger,
            expression: job.expression,
            timezone: job.timezone ?? DEFAULT_TIMEZONE,
            scheduledAt: firing.scheduledAt,
            startedAt,
            ...(job.notify === true
              ? {
                  nativeNotify: {
                    enabled: true,
                    ...(job.notifyConversationId === undefined ? {} : { conversationId: job.notifyConversationId }),
                  },
                }
              : {}),
            ...(job.model === undefined ? {} : { model: job.model }),
            ...(job.effort === undefined ? {} : { effort: job.effort }),
          } satisfies CronRequestMetadata,
        },
      };
      const response = await options.responder.respond(request, stream);
      return { response, notifyConversationId };
    })
    .then(({ response, notifyConversationId }) => {
      finalize(async () => {
        await stream.finish(response.text, {
          ...(response.parts === undefined ? {} : { parts: response.parts }),
          unsupportedPartFallback: "none",
        });
        // Guard against a responder that ignores/races the abort signal and still
        // resolves with text: if THIS run's controller was aborted (overlap:"replace"
        // discarding the in-flight run, the watchdog, or stop()), report the run as
        // cancelled rather than succeeded. `controller` is captured per-run, so this keys
        // the abort check to this specific firing (not a newer run's controller). This
        // mirrors the .catch() classification below and LiveSessionManager.drain().
        if (controller.signal.aborted) {
          const result: CronJobResult = {
            ...resultIdentity(firing),
            kind: "cancelled",
            startedAt,
            completedAt: (options.now?.() ?? new Date()).toISOString(),
            error: "Cron job cancelled (responder resolved after abort).",
            ...artifactRunIdFields(options, firing),
          };
          options.logger?.warn?.("Cron job responder resolved after abort; reporting cancelled.", {
            jobId: job.id,
            error: "Cron job cancelled (responder resolved after abort).",
          });
          await emitResult(options, result);
          return;
        }
        const result: CronJobResult = {
          ...resultIdentity(firing),
          kind: "succeeded",
          startedAt,
          completedAt: (options.now?.() ?? new Date()).toISOString(),
          ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
          ...(stream.text.length === 0 ? {} : { text: stream.text }),
          ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
        };
        await emitResult(options, result);
      });
    })
    .catch((error: unknown) => {
      finalize(async () => {
        const cancelled = controller.signal.aborted || isAgentResponseCancelledError(error);
        const failureKind = failureKindFromUnknown(error);
        const result: CronJobResult = {
          ...resultIdentity(firing),
          kind: cancelled ? "cancelled" : "failed",
          startedAt,
          completedAt: (options.now?.() ?? new Date()).toISOString(),
          error: errorToMessage(error),
          ...(failureKind === undefined ? {} : { failureKind }),
          ...artifactRunIdFields(options, firing),
        };
        options.logger?.[cancelled ? "warn" : "error"]?.("Cron job run failed.", {
          jobId: job.id,
          error: errorToMessage(error),
        });
        await emitResult(options, result);
      });
    });
}

class CronMessageStream extends BufferedMessageStream {
  constructor(
    private readonly firing: CronFiringIdentity,
    private readonly options: CronAdapterOptions,
  ) {
    super({
      onClosed: () =>
        new CronAdapterError("stream_closed", "Cannot write to a finished cron stream."),
    });
  }

  override async event(event: AgentStreamEvent): Promise<void> {
    try {
      await this.options.onEvent?.(this.firing, event);
    } catch (error) {
      reportDegraded(this.options, "Cron run event could not be persisted.", error, {
        jobId: this.firing.jobId,
        runId: this.firing.runId,
      });
    }
  }
}

async function resolveNotifyConversationId(
  job: CronJob,
  options: CronAdapterOptions,
  abortSignal: AbortSignal,
): Promise<string | undefined> {
  if (job.notify !== true) {
    return undefined;
  }
  const configured = job.notifyConversationId ?? job.notifyFallbackConversationId;
  if (configured !== undefined) {
    return configured;
  }
  if (options.resolveNotifyFallbackConversationId === undefined) {
    return undefined;
  }
  try {
    const resolution = Promise.resolve(options.resolveNotifyFallbackConversationId(abortSignal));
    return normalizeOptionalString(await raceAgainstAbort(resolution, abortSignal));
  } catch (error) {
    if (abortSignal.aborted) {
      throw abortSignal.reason ?? error;
    }
    options.logger?.warn?.("Cron native-notify destination resolution failed; running without a reply target.", {
      jobId: job.id,
      error: errorToMessage(error),
    });
    return undefined;
  }
}

/**
 * Reject when the run is aborted even if host-owned resolver work ignores the
 * signal. Attaching both settlement handlers also consumes a late resolver
 * rejection after the abort path has already won.
 */
function raceAgainstAbort<T>(operation: Promise<T>, abortSignal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      abortSignal.removeEventListener("abort", onAbort);
      reject(abortSignal.reason ?? new Error("Cron run was aborted."));
    };
    // Observe the resolver before consulting the signal. A host resolver can
    // synchronously trigger replacement/stop and only then return its promise;
    // its eventual rejection must still be consumed after abort wins.
    void operation.then(
      (value) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function toReplyTarget(conversationId: string | undefined): Pick<AgentRequestBase, "replyTo"> {
  return conversationId === undefined ? {} : { replyTo: { conversationId } };
}

function drainNext(
  job: CronJob,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  state: JobRuntimeState,
): void {
  const next = state.pending.shift();
  if (next !== undefined) {
    startRun(job, next, options, jobStates, state);
    return;
  }
  if (state.active === undefined && state.pending.length === 0) {
    jobStates.delete(job.id);
  }
}

async function emitResult(options: CronAdapterOptions, result: CronJobResult): Promise<void> {
  try {
    await options.onResult?.(result);
  } catch (error) {
    reportDegraded(options, "Cron run-result persistence failed.", error, {
      jobId: result.jobId,
      runId: result.cronRunId,
      kind: result.kind,
    });
  }
}

function reportDegraded(
  options: CronAdapterOptions,
  message: string,
  error: unknown,
  metadata: Readonly<Record<string, unknown>>,
): void {
  const detail = errorToMessage(error);
  options.logger?.error?.(message, { ...metadata, error: detail });
  try {
    options.onDegraded?.(`${message} ${detail}`);
  } catch (callbackError) {
    options.logger?.error?.("Cron degradation callback failed.", {
      ...metadata,
      error: errorToMessage(callbackError),
    });
  }
}

function nextDateFor(job: CronJob, currentDate: Date): Date {
  const result = validateCronExpression(job.expression, {
    currentDate,
    hashSeed: job.id,
    timezone: job.timezone ?? DEFAULT_TIMEZONE,
  });
  if (result.ok) {
    return result.nextDate;
  }
  if (result.code === "required") {
    throw new CronAdapterError("invalid_config", "Cron job expression is required.", { jobId: job.id });
  }
  if (result.code === "field_count") {
    throw new CronAdapterError("invalid_config", "Cron job expression must use exactly five fields.", {
      jobId: job.id,
      fieldCount: result.fieldCount,
    });
  }
  throw new CronAdapterError("invalid_config", "Cron job expression is invalid.", {
    jobId: job.id,
    reason: result.reason,
  });
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
    if (job.maxRunMs !== undefined && (!Number.isInteger(job.maxRunMs) || job.maxRunMs <= 0)) {
      throw new CronAdapterError("invalid_config", "Cron job maxRunMs must be a positive integer.", {
        jobId: job.id,
        maxRunMs: job.maxRunMs,
      });
    }
    nextDateFor(job, options.now?.() ?? new Date());
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureKindFromUnknown(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const direct = normalizedString(error.failureKind);
  if (direct !== undefined) {
    return direct;
  }
  const failure = error.failure;
  if (isRecord(failure)) {
    return normalizedString(failure.kind);
  }
  return undefined;
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
