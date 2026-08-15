/** Durable lifecycle states shared by process-job hosts and operator clients. */
export const PROCESS_JOB_STATES = [
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_failed",
  "queue_expired",
  "interrupted",
] as const;

export type ProcessJobState = (typeof PROCESS_JOB_STATES)[number];

/** Stable machine-readable failures exposed at the runtime/operator boundary. */
export const PROCESS_JOB_ERROR_CODES = [
  "background_unsupported",
  "background_unsupported_channel",
  "process_job_disabled",
  "process_job_controller_unavailable",
  "process_job_platform_unsupported",
  "process_job_not_found",
  "process_job_conflict",
  "process_job_capacity",
  "process_job_conversation_capacity",
  "process_job_queue_full",
  "process_job_queue_expired",
  "process_job_chain_depth_exceeded",
  "process_job_spawn_failed",
  "process_job_failed",
  "process_job_timeout",
  "process_job_cancelled",
  "process_job_agent_restarted",
  "process_job_store_error",
  "process_job_wake_failed",
  "process_job_response_too_large",
  "process_job_invalid",
] as const;

export type ProcessJobErrorCode = (typeof PROCESS_JOB_ERROR_CODES)[number];

export type ProcessJobWakeState = "pending" | "delivered" | "failed";

export interface ProcessJobProjectionOrigin {
  /** Exact conversation identity, including any host-owned rollover bucket. */
  readonly conversationId: string;
  readonly channel: string;
  readonly runId: string;
  readonly historyBoundary: string;
  readonly bucket: string | null;
}

export interface ProcessJobProjectionTimestamps {
  readonly admittedAt: string;
  readonly queueDeadlineAt: string;
  readonly startedAt: string | null;
  readonly runtimeDeadlineAt: string | null;
  readonly completedAt: string | null;
}

export interface ProcessJobProjectionLimits {
  readonly maxRuntimeMs: number;
  readonly maxOutputBytes: number;
  readonly previewChars: number;
  readonly chainDepth: number;
}

export interface ProcessJobProjectionOutput {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  /** Bounded, redacted, untrusted preview suitable for an operator UI. */
  readonly preview: string;
  /** Agent-root-relative artifact references; never arbitrary filesystem paths. */
  readonly stdoutRef: string | null;
  readonly stderrRef: string | null;
}

export interface ProcessJobProjectionWake {
  readonly state: ProcessJobWakeState;
  readonly attempts: number;
  readonly deliveryKey: string;
  readonly lastAttemptAt: string | null;
}

export interface ProcessJobProjectionError {
  readonly code: ProcessJobErrorCode;
  readonly message: string;
}

/**
 * Secret-free operator projection of one durable process job.
 *
 * This intentionally excludes argv, environment values, sandbox settings
 * paths, the separate owner-private normalized reply-target fields, PIDs, and
 * process-incarnation evidence. `origin.conversationId` deliberately remains:
 * it is the exact bound originating conversation and therefore the operator
 * projection's reply route, including any host-owned rollover bucket.
 */
export interface ProcessJobProjection {
  readonly schema: "mono-agent.process-job-projection.v1";
  readonly jobId: string;
  readonly tool: "Exec" | "Bash";
  readonly state: ProcessJobState;
  readonly summary: string;
  readonly origin: ProcessJobProjectionOrigin;
  readonly timestamps: ProcessJobProjectionTimestamps;
  readonly limits: ProcessJobProjectionLimits;
  readonly output: ProcessJobProjectionOutput;
  readonly wake: ProcessJobProjectionWake;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly cancelRequested: boolean;
  readonly lastError: ProcessJobProjectionError | null;
}

/** Neutral owner-authorized operator surface used by app, TUI, CLI, and web proxy. */
export interface ProcessJobOperator {
  /** Owner-only bearer used by local operator routes. Never expose to a model. */
  readonly operatorToken: string;
  list(): Promise<readonly ProcessJobProjection[]>;
  get(jobId: string): Promise<ProcessJobProjection | undefined>;
  cancel(jobId: string): Promise<ProcessJobProjection>;
}

const PROJECTION_KEYS = [
  "schema",
  "jobId",
  "tool",
  "state",
  "summary",
  "origin",
  "timestamps",
  "limits",
  "output",
  "wake",
  "exitCode",
  "signal",
  "durationMs",
  "cancelRequested",
  "lastError",
] as const;

// The host can transiently retain its 10,000 terminal-record maximum alongside
// all 32 running and 64 queued records. The separate byte bound still governs
// serialized operator responses.
const MAX_PROCESS_JOB_PROJECTION_LIST_ITEMS = 10_096;

/** Strictly parse one projection, rejecting unknown keys at every depth. */
export function parseProcessJobProjection(value: unknown): ProcessJobProjection {
  if (!isRecord(value) || !hasExactlyKeys(value, PROJECTION_KEYS)) {
    throw invalid("envelope");
  }
  if (value.schema !== "mono-agent.process-job-projection.v1"
    || !boundedNonEmptyString(value.jobId, 256)
    || (value.tool !== "Exec" && value.tool !== "Bash")
    || !isProcessJobState(value.state)
    || !boundedString(value.summary, 8_000)
    || typeof value.cancelRequested !== "boolean"
    || !nullableInteger(value.exitCode)
    || !nullableBoundedString(value.signal, 128)
    || !nullableNonNegativeInteger(value.durationMs)) {
    throw invalid("envelope");
  }

  parseOrigin(value.origin);
  parseTimestamps(value.timestamps);
  parseLimits(value.limits);
  parseOutput(value.output);
  parseWake(value.wake);
  parseError(value.lastError);
  if (value.output.preview.length > value.limits.previewChars
    || value.output.stdoutBytes + value.output.stderrBytes > value.limits.maxOutputBytes) {
    throw invalid("output limits");
  }
  return value as unknown as ProcessJobProjection;
}

/** Strictly parse a bounded operator list response. */
export function parseProcessJobProjections(value: unknown): readonly ProcessJobProjection[] {
  if (!Array.isArray(value) || value.length > MAX_PROCESS_JOB_PROJECTION_LIST_ITEMS) {
    throw new TypeError("Process-job projection list is invalid.");
  }
  return value.map((entry) => parseProcessJobProjection(entry));
}

export function isProcessJobState(value: unknown): value is ProcessJobState {
  return typeof value === "string" && (PROCESS_JOB_STATES as readonly string[]).includes(value);
}

export function isProcessJobErrorCode(value: unknown): value is ProcessJobErrorCode {
  return typeof value === "string" && (PROCESS_JOB_ERROR_CODES as readonly string[]).includes(value);
}

function parseOrigin(value: unknown): asserts value is ProcessJobProjectionOrigin {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["conversationId", "channel", "runId", "historyBoundary", "bucket"])
    || !boundedNonEmptyString(value.conversationId, 2_048)
    || !boundedNonEmptyString(value.channel, 128)
    || !boundedNonEmptyString(value.runId, 512)
    || !boundedNonEmptyString(value.historyBoundary, 512)
    || !nullableBoundedString(value.bucket, 512)) {
    throw invalid("origin");
  }
}

function parseTimestamps(value: unknown): asserts value is ProcessJobProjectionTimestamps {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["admittedAt", "queueDeadlineAt", "startedAt", "runtimeDeadlineAt", "completedAt"])
    || !validDate(value.admittedAt)
    || !validDate(value.queueDeadlineAt)
    || !nullableValidDate(value.startedAt)
    || !nullableValidDate(value.runtimeDeadlineAt)
    || !nullableValidDate(value.completedAt)) {
    throw invalid("timestamps");
  }
}

function parseLimits(value: unknown): asserts value is ProcessJobProjectionLimits {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["maxRuntimeMs", "maxOutputBytes", "previewChars", "chainDepth"])
    || !boundedPositiveInteger(value.maxRuntimeMs, 24 * 60 * 60 * 1_000)
    || !boundedPositiveInteger(value.maxOutputBytes, 8 * 1024 * 1024)
    || !boundedPositiveInteger(value.previewChars, 8_000)
    || !nonNegativeInteger(value.chainDepth)
    || Number(value.chainDepth) > 8) {
    throw invalid("limits");
  }
}

function parseOutput(value: unknown): asserts value is ProcessJobProjectionOutput {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["stdoutBytes", "stderrBytes", "truncated", "preview", "stdoutRef", "stderrRef"])
    || !nonNegativeInteger(value.stdoutBytes)
    || !nonNegativeInteger(value.stderrBytes)
    || typeof value.truncated !== "boolean"
    || !boundedCharacters(value.preview, 8_000)
    || !nullableArtifactRef(value.stdoutRef)
    || !nullableArtifactRef(value.stderrRef)) {
    throw invalid("output");
  }
}

function parseWake(value: unknown): asserts value is ProcessJobProjectionWake {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["state", "attempts", "deliveryKey", "lastAttemptAt"])
    || (value.state !== "pending" && value.state !== "delivered" && value.state !== "failed")
    || !nonNegativeInteger(value.attempts)
    || !boundedNonEmptyString(value.deliveryKey, 512)
    || !nullableValidDate(value.lastAttemptAt)) {
    throw invalid("wake");
  }
}

function parseError(value: unknown): asserts value is ProcessJobProjectionError | null {
  if (value === null) return;
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["code", "message"])
    || !isProcessJobErrorCode(value.code)
    || !boundedNonEmptyString(value.message, 8_000)) {
    throw invalid("lastError");
  }
}

function invalid(part: string): TypeError {
  return new TypeError(`Process-job projection has an invalid ${part}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8Bytes(value) <= maxBytes;
}

function boundedCharacters(value: unknown, maxCharacters: number): value is string {
  return typeof value === "string" && value.length <= maxCharacters;
}

function boundedNonEmptyString(value: unknown, maxBytes: number): value is string {
  return boundedString(value, maxBytes) && value.trim().length > 0;
}

function nullableBoundedString(value: unknown, maxBytes: number): value is string | null {
  return value === null || boundedString(value, maxBytes);
}

function nullableArtifactRef(value: unknown): value is string | null {
  if (value === null) return true;
  return boundedNonEmptyString(value, 1_024)
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && Number(value) > 0;
}

function boundedPositiveInteger(value: unknown, max: number): value is number {
  return positiveInteger(value) && Number(value) <= max;
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || nonNegativeInteger(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nullableValidDate(value: unknown): value is string | null {
  return value === null || validDate(value);
}
