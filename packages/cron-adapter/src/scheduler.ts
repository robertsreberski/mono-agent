import {
  BufferedMessageStream,
  isAgentResponseCancelledError,
  normalizeOptionalString,
  unsupportedReplyPartDeliveryOutcomes,
  type AgentMessageStream,
  type AgentReplyPartDeliveryOutcome,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamEvent,
} from "@mono-agent/agent-contracts";

import { validateCronExpression } from "./cron-expression.js";
import { CronAdapterError, type CronAdapterErrorCode, type CronAdapterErrorDetails } from "./errors.js";
import {
  DEFAULT_CRON_PREFLIGHT_TIMEOUT_MS,
  MAX_CRON_PREFLIGHT_INPUT_BYTES,
  boundCronPreflightReason,
  boundCronPreflightText,
  normalizeCronPreflightArgv,
  normalizeCronPreflightTimeoutMs,
  type CronPreflightErrorCode,
  type CronPreflightOutcome,
  type CronPreflightRecord,
  type CronPreflightRecordOutcome,
} from "./preflight.js";

export type { CronAdapterErrorCode, CronAdapterErrorDetails } from "./errors.js";
export { CronAdapterError } from "./errors.js";
export {
  DEFAULT_CRON_PREFLIGHT_TIMEOUT_MS,
  MAX_CRON_PREFLIGHT_INPUT_BYTES,
  MAX_CRON_PREFLIGHT_REASON_BYTES,
  MAX_CRON_PREFLIGHT_TIMEOUT_MS,
  boundCronPreflightText,
} from "./preflight.js";
export type {
  CronPreflightErrorCode,
  CronPreflightOutcome,
  CronPreflightRecord,
  CronPreflightRecordOutcome,
} from "./preflight.js";

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
  /**
   * Present when the job declared a preflight gate. `outcome` is what actually
   * happened to the gate (`run`, `overridden`, `error`, or `timeout`);
   * `inputBytes` is the size of the appended `<preflight-input>` payload.
   */
  readonly preflight?: {
    readonly outcome: CronPreflightRecordOutcome;
    readonly inputBytes?: number;
  };
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
  /**
   * Deterministic argv gate evaluated before the responder. Absent means no
   * gate at all: the firing goes straight to the responder. The argv is never
   * split from a string and never interpreted as a shell command line.
   */
  readonly preflight?: readonly string[];
  /**
   * How long the host's preflight callback may take before the adapter fails
   * open and runs the job with its plain prompt. Falls back to
   * {@link CronAdapterOptions.preflightTimeoutMs}, then to
   * {@link DEFAULT_CRON_PREFLIGHT_TIMEOUT_MS}.
   */
  readonly preflightTimeoutMs?: number;
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
      /** Terminal, sanitized outcomes for rich parts this adapter cannot deliver. */
      readonly replyPartOutcomes?: readonly AgentReplyPartDeliveryOutcome[];
    })
  | (CronResultIdentity & {
      readonly kind: "failed";
      readonly startedAt: string;
      readonly completedAt: string;
      readonly error: string;
      readonly failureKind?: string;
      /** Harness artifact id, when a recorder was created before failure. */
      readonly runId?: string;
      /** Present when a responder resolved with parts after this run was cancelled. */
      readonly replyPartOutcomes?: readonly AgentReplyPartDeliveryOutcome[];
    })
  | (CronResultIdentity & {
      readonly kind: "cancelled";
      /**
       * Absent when the firing was cancelled before the responder ever started
       * (a gate cancelled during preflight, or a stop/replace that landed first).
       */
      readonly startedAt?: string;
      readonly completedAt: string;
      readonly error: string;
      readonly failureKind?: string;
      /** Harness artifact id, when a recorder was created before failure. */
      readonly runId?: string;
      /** Present when a responder resolved with parts after this run was cancelled. */
      readonly replyPartOutcomes?: readonly AgentReplyPartDeliveryOutcome[];
    })
  | (CronResultIdentity & {
      readonly kind: "skipped";
      readonly reason: "overlap";
      readonly blockedByRunId: string;
      readonly blockedByTrigger: CronRunTrigger;
    })
  | (CronResultIdentity & {
      readonly kind: "skipped";
      /** The job's preflight gate declined this firing: no responder turn ran. */
      readonly reason: "gate";
      readonly completedAt: string;
      /** Bounded gate-supplied reason; never raw gate stdout or stderr. */
      readonly gateReason?: string;
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
  /**
   * Host-owned executor for a job's `preflight` argv. It receives the firing
   * and the run's abort signal; the adapter races it against the preflight
   * timeout. Every failure is fail-open: the job still runs with its plain
   * prompt. A job without `preflight` never calls it.
   */
  readonly preflight?: (
    firing: CronFiringIdentity,
    abortSignal: AbortSignal,
  ) => CronPreflightOutcome | Promise<CronPreflightOutcome>;
  /**
   * Observe exactly one bounded record per attempted gate — subprocess
   * verdicts, adapter timeouts, aborts, and manual overrides alike — before the
   * skip result is emitted or the run starts. Raw gate output never appears here.
   */
  readonly onPreflight?: (firing: CronFiringIdentity, record: CronPreflightRecord) => void | Promise<void>;
  /** Adapter-level preflight race timeout. Default {@link DEFAULT_CRON_PREFLIGHT_TIMEOUT_MS}. */
  readonly preflightTimeoutMs?: number;
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

interface PendingFiring extends CronFiringIdentity {}

interface ActiveFiring {
  readonly controller: AbortController;
  readonly firing: CronFiringIdentity;
  /**
   * A firing holds its job's overlap slot through both phases. The gate phase
   * never consumes the run watchdog; the watchdog is armed in `startRun`.
   */
  phase: "preflight" | "run";
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
/** Diagnostic text (a failed host callback) is logged truncated, never recorded verbatim. */
const MAX_CRON_PREFLIGHT_LOG_BYTES = 1024;

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
  // in parallel because each has its own state. A declared preflight gate runs
  // first, still holding this slot (see beginFiring).
  if (state.active === undefined) {
    beginFiring(job, firing, options, jobStates, state);
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

/** Adapter-owned settlement of one attempted preflight gate. */
type CronPreflightSettlement =
  | { readonly kind: "verdict"; readonly outcome: unknown }
  | { readonly kind: "callback_failed" }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" };

/** One attempted gate resolved into its durable record plus what happens next. */
interface CronPreflightDecision {
  readonly record: CronPreflightRecord;
  readonly action:
    | { readonly kind: "run"; readonly outcome: CronPreflightRecordOutcome; readonly input?: string }
    | { readonly kind: "skip"; readonly gateReason?: string }
    | { readonly kind: "cancelled" };
}

/**
 * What the gate phase hands to `startRun` so the slot and the abort wiring stay
 * identical across the phase boundary.
 */
interface CronPreflightHandoff {
  readonly controller?: AbortController;
  /** What actually happened to the gate (`run`, `overridden`, `error`, `timeout`). */
  readonly record?: CronPreflightRecordOutcome;
  /** Gate input appended to the prompt as one `<preflight-input>` block. */
  readonly input?: string;
}

/**
 * Dispatch one admitted firing. Without a declared gate (or without a host
 * executor) this is `startRun` unchanged. With a gate, the firing holds its
 * overlap slot through the gate phase, exactly one bounded record is observed,
 * and only then either the responder starts or the firing ends as `skipped_gate`.
 * Every gate failure is fail-open: the job runs with its plain prompt.
 */
function beginFiring(
  job: CronJob,
  firing: CronFiringIdentity,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  state: JobRuntimeState,
): void {
  const preflight = options.preflight;
  if (job.preflight === undefined || preflight === undefined) {
    if (job.preflight !== undefined) {
      // Fail-open, but never silently: this host cannot evaluate a declared gate.
      options.logger?.warn?.(
        "Cron job declares a preflight but the host has no preflight executor; running with the plain prompt.",
        { jobId: job.id, runId: firing.runId },
      );
    }
    startRun(job, firing, options, jobStates, state);
    return;
  }

  const controller = new AbortController();
  state.active = { controller, firing, phase: "preflight" };
  const gateStartedAt = (options.now?.() ?? new Date()).toISOString();
  const timeoutMs = job.preflightTimeoutMs ?? options.preflightTimeoutMs ?? DEFAULT_CRON_PREFLIGHT_TIMEOUT_MS;
  const releaseSlot = (): void => {
    state.active = undefined;
    drainNext(job, options, jobStates, state);
  };

  // Single-settle fence for the gate phase. A verdict, the adapter timeout, or
  // an abort wins exactly once; a late verdict from an uncooperative callback
  // is a no-op. The slot is released here for skip/cancel and handed to
  // `startRun` unchanged for run/override/fail-open.
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveSettlement: ((settlement: CronPreflightSettlement) => void) | undefined;
  const onAbort = (): void => {
    settle({ kind: "cancelled" });
  };
  function settle(value: CronPreflightSettlement): void {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    controller.signal.removeEventListener("abort", onAbort);
    resolveSettlement?.(value);
  }
  const settlement = new Promise<CronPreflightSettlement>((resolve) => {
    resolveSettlement = resolve;
  });

  timeout = setTimeout(() => {
    settle({ kind: "timeout" });
  }, timeoutMs);
  (timeout as { unref?: () => void }).unref?.();
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();

  void Promise.resolve()
    // Promise.resolve(x) cannot catch a synchronous throw while evaluating x,
    // so the callback invocation is deferred into the chain.
    .then(async () => await preflight(firing, controller.signal))
    .then(
      (outcome) => {
        settle({ kind: "verdict", outcome });
      },
      (error: unknown) => {
        // A rejected host callback is a gate failure, not a job failure: the
        // job still runs. The message is logged bounded and never recorded.
        options.logger?.warn?.("Cron preflight callback failed; running with the plain prompt.", {
          jobId: job.id,
          runId: firing.runId,
          error: boundCronPreflightText(errorToMessage(error), MAX_CRON_PREFLIGHT_LOG_BYTES),
        });
        settle({ kind: "callback_failed" });
      },
    );

  void settlement
    .then(async (value) => {
      const completedAt = (options.now?.() ?? new Date()).toISOString();
      const decision = decidePreflight(firing, value, { startedAt: gateStartedAt, completedAt });
      await emitPreflight(options, firing, decision.record);
      if (decision.action.kind === "skip") {
        options.logger?.info?.("Cron firing skipped by its preflight gate.", {
          jobId: job.id,
          runId: firing.runId,
          ...(decision.action.gateReason === undefined ? {} : { reason: decision.action.gateReason }),
        });
        await emitResult(options, {
          ...resultIdentity(firing),
          kind: "skipped",
          reason: "gate",
          completedAt,
          ...(decision.action.gateReason === undefined ? {} : { gateReason: decision.action.gateReason }),
        });
        releaseSlot();
        return;
      }
      if (decision.action.kind === "cancelled") {
        await emitResult(options, {
          ...resultIdentity(firing),
          kind: "cancelled",
          completedAt,
          error: "Cron firing was cancelled during preflight before the responder started.",
        });
        releaseSlot();
        return;
      }
      startRun(job, firing, options, jobStates, state, {
        controller,
        record: decision.action.outcome,
        ...(decision.action.input === undefined ? {} : { input: decision.action.input }),
      });
    })
    .catch((error: unknown) => {
      // The gate phase must never wedge the job's overlap slot.
      reportDegraded(options, "Cron preflight handoff failed.", error, {
        jobId: job.id,
        runId: firing.runId,
      });
      releaseSlot();
    });
}

/** Resolve one gate settlement into its bounded record and the resulting action. */
function decidePreflight(
  firing: CronFiringIdentity,
  settlement: CronPreflightSettlement,
  times: { readonly startedAt: string; readonly completedAt: string },
): CronPreflightDecision {
  if (settlement.kind === "cancelled") {
    return {
      record: { outcome: "cancelled", ...times },
      action: { kind: "cancelled" },
    };
  }
  if (settlement.kind === "timeout") {
    return {
      record: { outcome: "timeout", ...times },
      action: { kind: "run", outcome: "timeout" },
    };
  }
  if (settlement.kind === "callback_failed") {
    return {
      record: { outcome: "error", reason: "preflight callback failed", ...times },
      action: { kind: "run", outcome: "error" },
    };
  }
  const verdict = normalizePreflightOutcome(settlement.outcome);
  if (verdict.outcome === "error") {
    return {
      record: {
        outcome: "error",
        code: verdict.code,
        ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
        ...times,
      },
      action: { kind: "run", outcome: "error" },
    };
  }
  const inputBytes = verdict.input === undefined ? undefined : Buffer.byteLength(verdict.input, "utf8");
  const reason = verdict.reason;
  if (verdict.outcome === "skip" && firing.trigger !== "manual") {
    return {
      record: {
        outcome: "skip",
        ...(reason === undefined ? {} : { reason }),
        ...(inputBytes === undefined ? {} : { inputBytes }),
        ...times,
      },
      action: { kind: "skip", ...(reason === undefined ? {} : { gateReason: reason }) },
    };
  }
  // A `run` verdict and a manual firing that overrides `skip` both start the
  // responder, and both keep the gate's input.
  const outcome: CronPreflightRecordOutcome = verdict.outcome === "skip" ? "overridden" : "run";
  return {
    record: {
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(inputBytes === undefined ? {} : { inputBytes }),
      ...times,
    },
    action: {
      kind: "run",
      outcome,
      ...(verdict.input === undefined ? {} : { input: verdict.input }),
    },
  };
}

const INVALID_PREFLIGHT_VALUE: unique symbol = Symbol("invalid-preflight-value");
type InvalidPreflightValue = typeof INVALID_PREFLIGHT_VALUE;

const PREFLIGHT_ERROR_CODES: ReadonlySet<string> = new Set<CronPreflightErrorCode>([
  "exit_nonzero",
  "signal",
  "spawn_failed",
  "timeout",
  "invalid_json",
  "invalid_verdict",
  "output_overflow",
  "callback_timeout",
]);

/**
 * Defensive normalization of a host callback return. Typed hosts always pass a
 * valid verdict; an untyped or buggy host fails open with `invalid_verdict`
 * instead of corrupting the prompt or the record.
 */
function normalizePreflightOutcome(value: unknown): CronPreflightOutcome {
  if (!isRecord(value)) {
    return invalidPreflightVerdict("preflight callback returned a non-object verdict.");
  }
  const reason = normalizePreflightText(value.reason, true);
  if (reason === INVALID_PREFLIGHT_VALUE) {
    return invalidPreflightVerdict("preflight callback returned a non-string reason.");
  }
  const outcome = value.outcome;
  if (outcome === "error") {
    const code = value.code;
    if (typeof code !== "string" || !PREFLIGHT_ERROR_CODES.has(code)) {
      return invalidPreflightVerdict("preflight callback returned an unknown error code.");
    }
    return {
      outcome: "error",
      code: code as CronPreflightErrorCode,
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (outcome !== "run" && outcome !== "skip") {
    return invalidPreflightVerdict("preflight callback returned an unknown verdict.");
  }
  const input = normalizePreflightText(value.input, false);
  if (input === INVALID_PREFLIGHT_VALUE) {
    return invalidPreflightVerdict("preflight callback returned a non-string input.");
  }
  if (input !== undefined && Buffer.byteLength(input, "utf8") > MAX_CRON_PREFLIGHT_INPUT_BYTES) {
    return {
      outcome: "error",
      code: "output_overflow",
      reason: "preflight input exceeded the configured byte cap",
    };
  }
  return {
    outcome,
    ...(input === undefined ? {} : { input }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function invalidPreflightVerdict(reason: string): CronPreflightOutcome {
  return { outcome: "error", code: "invalid_verdict", reason };
}

/**
 * `undefined` means absent, {@link INVALID_PREFLIGHT_VALUE} means the wrong
 * type. Reasons are bounded; the gate input is only byte-counted.
 */
function normalizePreflightText(
  value: unknown,
  bound: boolean,
): string | undefined | InvalidPreflightValue {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return typeof value === "string" ? undefined : INVALID_PREFLIGHT_VALUE;
  }
  return bound ? boundCronPreflightReason(value) : value;
}

/** Observe the gate record without letting a host callback failure wedge the job. */
async function emitPreflight(
  options: CronAdapterOptions,
  firing: CronFiringIdentity,
  record: CronPreflightRecord,
): Promise<void> {
  try {
    await options.onPreflight?.(firing, record);
  } catch (error) {
    reportDegraded(options, "Cron preflight record persistence failed.", error, {
      jobId: firing.jobId,
      runId: firing.runId,
      outcome: record.outcome,
    });
  }
}

/**
 * Append the gate's input to the job prompt as one documented block. The block
 * is operator-owned data: nothing in the runtime interprets it, and the job
 * prompt itself is responsible for saying what to do when it is absent
 * (a fail-open run).
 */
function preflightPromptText(prompt: string, input: string | undefined): string {
  return input === undefined ? prompt : `${prompt}\n\n<preflight-input>\n${input}\n</preflight-input>`;
}

function startRun(
  job: CronJob,
  firing: CronFiringIdentity,
  options: CronAdapterOptions,
  jobStates: Map<string, JobRuntimeState>,
  state: JobRuntimeState,
  handoff: CronPreflightHandoff = {},
): void {
  const controller = handoff.controller ?? new AbortController();
  state.active = { controller, firing, phase: "run" };
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
        text: preflightPromptText(job.prompt, handoff.input),
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
            ...(handoff.record === undefined
              ? {}
              : {
                  preflight: {
                    outcome: handoff.record,
                    ...(handoff.input === undefined
                      ? {}
                      : { inputBytes: Buffer.byteLength(handoff.input, "utf8") }),
                  },
                }),
          } satisfies CronRequestMetadata,
        },
      };
      const response = await options.responder.respond(request, stream);
      return { response, notifyConversationId };
    })
    .then(({ response, notifyConversationId }) => {
      finalize(async () => {
        const replyPartOutcomes = unsupportedReplyPartDeliveryOutcomes(response.parts);
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
            ...(replyPartOutcomes === undefined ? {} : { replyPartOutcomes }),
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
          ...((response.text ?? stream.text).length === 0 ? {} : { text: response.text ?? stream.text }),
          ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
          ...(replyPartOutcomes === undefined ? {} : { replyPartOutcomes }),
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
    // Queued and replacement firings are gated exactly like scheduled ones.
    beginFiring(job, next, options, jobStates, state);
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
  normalizeCronPreflightTimeoutMs(options.preflightTimeoutMs, "Cron adapter preflightTimeoutMs");
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
    normalizeCronPreflightArgv(job.preflight, "Cron job preflight", { jobId: job.id });
    normalizeCronPreflightTimeoutMs(job.preflightTimeoutMs, "Cron job preflightTimeoutMs", { jobId: job.id });
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
