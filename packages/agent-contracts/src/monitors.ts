/**
 * Durable lifecycle states shared by monitor hosts and operator clients.
 *
 * A monitor is a long-lived host-owned watch: its command streams stdout lines
 * that the host coalesces into batches and delivers to the originating
 * conversation as wake turns. Unlike a process job it produces MANY wakes, so
 * `running` is the normal steady state and every terminal state below delivers
 * exactly one final wake.
 */
export const MONITOR_STATES = [
  "starting",
  "running",
  "exited",
  "timed_out",
  "cancelled",
  "spawn_failed",
  "rate_limited",
  "interrupted",
] as const;

export type MonitorState = (typeof MONITOR_STATES)[number];

/** Maximum monitor identities a channel adapter or operator client must retain. */
export const MAX_MONITOR_OUTSTANDING_LIFECYCLES = 1_024;

/** Stable machine-readable failures exposed at the runtime/operator boundary. */
export const MONITOR_ERROR_CODES = [
  "monitor_unsupported",
  "monitor_unsupported_channel",
  "monitor_disabled",
  "monitor_controller_unavailable",
  "monitor_platform_unsupported",
  "monitor_not_found",
  "monitor_conflict",
  "monitor_capacity",
  "monitor_conversation_capacity",
  "monitor_chain_depth_exceeded",
  "monitor_spawn_failed",
  "monitor_exited",
  "monitor_timeout",
  "monitor_cancelled",
  "monitor_rate_limited",
  "monitor_agent_restarted",
  "monitor_cleanup_incomplete",
  "monitor_store_error",
  "monitor_wake_failed",
  "monitor_response_too_large",
  "monitor_invalid",
] as const;

export type MonitorErrorCode = (typeof MONITOR_ERROR_CODES)[number];

/** Stable secret-free messages paired with public monitor error codes. */
export const MONITOR_PUBLIC_ERROR_MESSAGES: Readonly<Record<MonitorErrorCode, string>> = Object.freeze({
  monitor_unsupported: "Monitors are unsupported for this tool call.",
  monitor_unsupported_channel: "Monitors are unsupported for this channel.",
  monitor_disabled: "Monitors are disabled.",
  monitor_controller_unavailable: "The monitor controller is unavailable.",
  monitor_platform_unsupported: "Monitors are unsupported on this platform.",
  monitor_not_found: "The monitor was not found.",
  monitor_conflict: "The monitor is no longer in the required state.",
  monitor_capacity: "Monitor capacity is full.",
  monitor_conversation_capacity: "This conversation reached its monitor capacity.",
  monitor_chain_depth_exceeded: "The monitor chain-depth limit was reached.",
  monitor_spawn_failed: "The monitor could not be launched.",
  monitor_exited: "The monitored command exited.",
  monitor_timeout: "The monitor exceeded its runtime limit.",
  monitor_cancelled: "The monitor was cancelled.",
  monitor_rate_limited: "The monitor was stopped because it produced events too quickly.",
  monitor_agent_restarted: "The monitor was interrupted by an agent restart.",
  monitor_cleanup_incomplete: "Monitor cleanup could not be confirmed.",
  monitor_store_error: "Monitor storage failed.",
  monitor_wake_failed: "Monitor wake delivery failed.",
  monitor_response_too_large: "The monitor response exceeded its size limit.",
  monitor_invalid: "The monitor request is invalid.",
});

/** Construct one stable public failure without retaining ambient exception text. */
export function monitorPublicError(code: MonitorErrorCode): MonitorProjectionError {
  return { code, message: MONITOR_PUBLIC_ERROR_MESSAGES[code] };
}

export interface MonitorProjectionError {
  readonly code: MonitorErrorCode;
  readonly message: string;
}

export interface MonitorProjectionOrigin {
  /** Exact conversation identity, including any host-owned rollover bucket. */
  readonly conversationId: string;
  readonly channel: string;
  readonly runId: string;
  readonly bucket: string | null;
}

export interface MonitorProjectionTimestamps {
  readonly startedAt: string;
  readonly runtimeDeadlineAt: string | null;
  readonly lastEventAt: string | null;
  readonly completedAt: string | null;
}

export interface MonitorProjectionLimits {
  readonly maxRuntimeMs: number;
  readonly coalesceMs: number;
  readonly maxBatchLines: number;
  readonly maxBatchBytes: number;
  readonly chainDepth: number;
}

/**
 * Cumulative, secret-free delivery accounting. `droppedLines` is the number of
 * oldest lines evicted from a pending batch that hit its bound; it is reported
 * to the model so a gap is never silently invisible.
 */
export interface MonitorProjectionCounters {
  readonly seq: number;
  readonly batchesDelivered: number;
  readonly linesObserved: number;
  readonly linesDelivered: number;
  readonly droppedLines: number;
  readonly pendingLines: number;
}

/**
 * Secret-free operator projection of one live monitor.
 *
 * This intentionally excludes argv, environment values, sandbox settings paths,
 * PIDs, and process-incarnation evidence. `description` is the bounded, redacted
 * model-authored purpose; monitor event text is never retained here.
 */
export interface MonitorProjection {
  readonly schema: "mono-agent.monitor-projection.v1";
  readonly monitorId: string;
  readonly state: MonitorState;
  readonly description: string;
  readonly persistent: boolean;
  readonly origin: MonitorProjectionOrigin;
  readonly timestamps: MonitorProjectionTimestamps;
  readonly limits: MonitorProjectionLimits;
  readonly counters: MonitorProjectionCounters;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cancelRequested: boolean;
  readonly lastError: MonitorProjectionError | null;
}

/** Neutral owner-authorized operator surface used by app, CLI, and web proxy. */
export interface MonitorOperator {
  /** Owner-only bearer used by local operator routes. Never expose to a model. */
  readonly operatorToken: string;
  list(): Promise<readonly MonitorProjection[]>;
  get(monitorId: string): Promise<MonitorProjection | undefined>;
  cancel(monitorId: string): Promise<MonitorProjection>;
}

const PROJECTION_KEYS = [
  "schema",
  "monitorId",
  "state",
  "description",
  "persistent",
  "origin",
  "timestamps",
  "limits",
  "counters",
  "exitCode",
  "signal",
  "cancelRequested",
  "lastError",
] as const;

/** Strictly parse one projection, rejecting unknown keys at every depth. */
export function parseMonitorProjection(value: unknown): MonitorProjection {
  if (!isRecord(value) || !hasExactlyKeys(value, PROJECTION_KEYS)) {
    throw invalid("envelope");
  }
  if (value.schema !== "mono-agent.monitor-projection.v1"
    || !boundedNonEmptyString(value.monitorId, 256)
    || !isMonitorState(value.state)
    || !boundedString(value.description, 4_000)
    || typeof value.persistent !== "boolean"
    || typeof value.cancelRequested !== "boolean"
    || !nullableInteger(value.exitCode)
    || !nullableBoundedString(value.signal, 128)) {
    throw invalid("envelope");
  }

  parseOrigin(value.origin);
  parseTimestamps(value.timestamps);
  parseLimits(value.limits);
  parseCounters(value.counters);
  parseError(value.lastError);
  const parsed = value as unknown as MonitorProjection;
  if (parsed.counters.linesDelivered + parsed.counters.droppedLines + parsed.counters.pendingLines
    > parsed.counters.linesObserved) {
    throw invalid("counters");
  }
  return parsed.lastError === null
    || parsed.lastError.message === MONITOR_PUBLIC_ERROR_MESSAGES[parsed.lastError.code]
    ? parsed
    : { ...parsed, lastError: monitorPublicError(parsed.lastError.code) };
}

/** Strictly parse a bounded operator list response. */
export function parseMonitorProjections(value: unknown): readonly MonitorProjection[] {
  if (!Array.isArray(value) || value.length > MAX_MONITOR_OUTSTANDING_LIFECYCLES) {
    throw new TypeError("Monitor projection list is invalid.");
  }
  return value.map((entry) => parseMonitorProjection(entry));
}

export function isMonitorState(value: unknown): value is MonitorState {
  return typeof value === "string" && (MONITOR_STATES as readonly string[]).includes(value);
}

export function isMonitorErrorCode(value: unknown): value is MonitorErrorCode {
  return typeof value === "string" && (MONITOR_ERROR_CODES as readonly string[]).includes(value);
}

/** A monitor in a terminal state has delivered, or is owed, exactly one final wake. */
export function isTerminalMonitorState(state: MonitorState): boolean {
  return state !== "starting" && state !== "running";
}

function parseOrigin(value: unknown): asserts value is MonitorProjectionOrigin {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["conversationId", "channel", "runId", "bucket"])
    || !boundedNonEmptyString(value.conversationId, 2_048)
    || !boundedNonEmptyString(value.channel, 128)
    || !boundedNonEmptyString(value.runId, 512)
    || !nullableBoundedString(value.bucket, 512)) {
    throw invalid("origin");
  }
}

function parseTimestamps(value: unknown): asserts value is MonitorProjectionTimestamps {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["startedAt", "runtimeDeadlineAt", "lastEventAt", "completedAt"])
    || !validDate(value.startedAt)
    || !nullableValidDate(value.runtimeDeadlineAt)
    || !nullableValidDate(value.lastEventAt)
    || !nullableValidDate(value.completedAt)) {
    throw invalid("timestamps");
  }
}

function parseLimits(value: unknown): asserts value is MonitorProjectionLimits {
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["maxRuntimeMs", "coalesceMs", "maxBatchLines", "maxBatchBytes", "chainDepth"])
    || !boundedPositiveInteger(value.maxRuntimeMs, 24 * 60 * 60 * 1_000)
    || !boundedPositiveInteger(value.coalesceMs, 60_000)
    || !boundedPositiveInteger(value.maxBatchLines, 10_000)
    || !boundedPositiveInteger(value.maxBatchBytes, 8 * 1024 * 1024)
    || !nonNegativeInteger(value.chainDepth)
    || Number(value.chainDepth) > 8) {
    throw invalid("limits");
  }
}

function parseCounters(value: unknown): asserts value is MonitorProjectionCounters {
  if (!isRecord(value)
    || !hasExactlyKeys(value, [
      "seq",
      "batchesDelivered",
      "linesObserved",
      "linesDelivered",
      "droppedLines",
      "pendingLines",
    ])
    || !nonNegativeInteger(value.seq)
    || !nonNegativeInteger(value.batchesDelivered)
    || !nonNegativeInteger(value.linesObserved)
    || !nonNegativeInteger(value.linesDelivered)
    || !nonNegativeInteger(value.droppedLines)
    || !nonNegativeInteger(value.pendingLines)) {
    throw invalid("counters");
  }
}

function parseError(value: unknown): asserts value is MonitorProjectionError | null {
  if (value === null) return;
  if (!isRecord(value)
    || !hasExactlyKeys(value, ["code", "message"])
    || !isMonitorErrorCode(value.code)
    || !boundedNonEmptyString(value.message, 4_000)) {
    throw invalid("lastError");
  }
}

function invalid(part: string): TypeError {
  return new TypeError(`Monitor projection has an invalid ${part}.`);
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

function boundedNonEmptyString(value: unknown, maxBytes: number): value is string {
  return boundedString(value, maxBytes) && value.trim().length > 0;
}

function nullableBoundedString(value: unknown, maxBytes: number): value is string | null {
  return value === null || boundedString(value, maxBytes);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedPositiveInteger(value: unknown, max: number): value is number {
  return nonNegativeInteger(value) && Number(value) > 0 && Number(value) <= max;
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nullableValidDate(value: unknown): value is string | null {
  return value === null || validDate(value);
}
