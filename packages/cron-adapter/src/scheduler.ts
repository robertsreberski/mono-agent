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

interface RunningJob {
  readonly controller: AbortController;
}

interface ScheduledJob {
  readonly job: CronJob;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_TIMEZONE = "UTC";
const MAX_TIMEOUT_MS = 2_147_483_647;

export function startCronAdapter(options: CronAdapterOptions): CronAdapterStartResult {
  validateOptions(options);
  const activeJobs = new Map<string, RunningJob>();
  const scheduled = options.jobs.map((job) => ({ job, timer: undefined }) satisfies ScheduledJob);
  for (const entry of scheduled) {
    scheduleNext(entry, options, activeJobs);
  }

  return {
    jobs: options.jobs.slice(),
    get activeJobCount() {
      return activeJobs.size;
    },
    stop() {
      for (const entry of scheduled) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
      }
      for (const running of activeJobs.values()) {
        running.controller.abort(new Error("Cron adapter stopped."));
      }
      activeJobs.clear();
    },
  };
}

function scheduleNext(
  entry: ScheduledJob,
  options: CronAdapterOptions,
  activeJobs: Map<string, RunningJob>,
): void {
  const now = options.now?.() ?? new Date();
  const scheduledAt = nextDateFor(entry.job, now);
  const delayMs = Math.max(0, scheduledAt.getTime() - now.getTime());
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (delayMs > MAX_TIMEOUT_MS) {
      scheduleNext(entry, options, activeJobs);
      return;
    }
    handleTick(entry.job, scheduledAt, options, activeJobs);
    scheduleNext(entry, options, activeJobs);
  }, Math.min(delayMs, MAX_TIMEOUT_MS));
}

function handleTick(
  job: CronJob,
  scheduledAtDate: Date,
  options: CronAdapterOptions,
  activeJobs: Map<string, RunningJob>,
): void {
  const scheduledAt = scheduledAtDate.toISOString();
  if (activeJobs.has(job.id)) {
    const result: CronJobResult = { kind: "skipped", jobId: job.id, scheduledAt, reason: "overlap" };
    options.logger?.warn?.("Cron job skipped because a prior run is still active.", { jobId: job.id, scheduledAt });
    void emitResult(options, result);
    return;
  }

  const controller = new AbortController();
  activeJobs.set(job.id, { controller });
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

  void options.responder.respond(request, stream)
    .then(async (response) => {
      await stream.finish(response.text);
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
      activeJobs.delete(job.id);
    });
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

function validateOptions(options: CronAdapterOptions): void {
  if (typeof options.responder?.respond !== "function") {
    throw new CronAdapterError("invalid_config", "Cron adapter requires a responder.");
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
