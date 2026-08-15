import type { AgentStreamEvent } from "./index.js";

/** Producer ceiling; consumers retain a separate 1 MiB defensive read cap. */
export const MAX_CRON_OPERATOR_RESPONSE_BYTES = 768 * 1024;
export const MAX_CRON_OPERATOR_RUN_PAGE = 100;
export const MAX_CRON_OPERATOR_JOBS = 64;
export const MAX_CRON_OPERATOR_JOB_ID_BYTES = 256;
export const MAX_CRON_OPERATOR_EXPRESSION_BYTES = 256;
export const MAX_CRON_OPERATOR_TIMEZONE_BYTES = 128;
export const MAX_CRON_OPERATOR_CONVERSATION_ID_BYTES = 512;
export const MAX_CRON_OPERATOR_RUN_ID_BYTES = 2_048;
export const MAX_CRON_OPERATOR_CURSOR_BYTES = 4_096;
export const MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES = 4_096;
export const MAX_CRON_OPERATOR_SUMMARY_TEXT_BYTES = 2 * 1024;
export const MAX_CRON_OPERATOR_SUMMARY_ERROR_BYTES = 512;
export const MAX_CRON_OPERATOR_SUMMARY_ARTIFACT_ID_BYTES = 512;
export const MAX_CRON_OPERATOR_SUMMARY_FAILURE_KIND_BYTES = 128;
export const MAX_CRON_OPERATOR_DETAIL_TEXT_BYTES = 128 * 1024;
export const MAX_CRON_OPERATOR_DETAIL_ERROR_BYTES = 32 * 1024;
export const MAX_CRON_OPERATOR_DETAIL_ARTIFACT_ID_BYTES = 4 * 1024;
export const MAX_CRON_OPERATOR_DETAIL_FAILURE_KIND_BYTES = 512;
export const MAX_CRON_OPERATOR_DETAIL_EVENTS = 256;
export const MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES = 384 * 1024;

export type CronOperatorRunTrigger = "scheduled" | "manual";

export type CronOperatorRunStatus =
  | "admitted"
  | "running"
  | "queued"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped_overlap"
  | "dropped";

export type CronOperatorHealth = "healthy" | "warning" | "unhealthy" | "disabled" | "unknown";

export type CronOperatorRunTruncatedField =
  | "artifactRunId"
  | "error"
  | "failureKind"
  | "text";

export interface CronOperatorRunBase {
  readonly runId: string;
  readonly jobId: string;
  readonly scheduledAt: string;
  readonly orderedAt: string;
  readonly sequence: number;
  readonly trigger: CronOperatorRunTrigger;
  readonly status: CronOperatorRunStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly artifactRunId?: string;
  readonly text?: string;
  readonly error?: string;
  readonly failureKind?: string;
  readonly blockedByRunId?: string;
  readonly blockedByTrigger?: CronOperatorRunTrigger;
  readonly queueDepth?: number;
  readonly eventCount: number;
  readonly fieldsTruncated?: readonly CronOperatorRunTruncatedField[];
  readonly eventsTruncated?: true;
}

/** Compact list/overview projection. Event payloads are forbidden. */
export interface CronOperatorRunSummary extends CronOperatorRunBase {
  readonly projection: "summary";
}

/** Bounded activity projection returned only for an explicitly selected run. */
export interface CronOperatorRunDetail extends CronOperatorRunBase {
  readonly projection: "detail";
  readonly events: readonly AgentStreamEvent[];
  readonly eventsIncluded: number;
}

export type CronOperatorRun = CronOperatorRunSummary | CronOperatorRunDetail;

export interface CronOperatorJob {
  readonly jobId: string;
  readonly expression?: string;
  readonly timezone?: string;
  readonly conversationId: string;
  readonly configured: boolean;
  readonly declaredEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly nextRunAt?: string;
  readonly health: CronOperatorHealth;
  readonly lastRun?: CronOperatorRunSummary;
  readonly activeRunId?: string;
}

export interface CronOperatorOverview {
  readonly generatedAt: string;
  readonly actionsEnabled: boolean;
  readonly jobs: readonly CronOperatorJob[];
  readonly degradedReason?: string;
  readonly jobsTruncated?: true;
}

export interface CronOperatorRunPage {
  readonly runs: readonly CronOperatorRunSummary[];
  readonly nextCursor?: string;
}

export class CronOperatorWireError extends TypeError {
  constructor() {
    super("Invalid cron operator wire data.");
    this.name = "CronOperatorWireError";
  }
}

export function parseCronOperatorOverview(value: unknown): CronOperatorOverview {
  const overview = requireRecord(value);
  if (!hasOnlyKeys(overview, ["generatedAt", "actionsEnabled", "jobs", "degradedReason", "jobsTruncated"])
    || !validDate(overview.generatedAt)
    || typeof overview.actionsEnabled !== "boolean"
    || !Array.isArray(overview.jobs)
    || overview.jobs.length > MAX_CRON_OPERATOR_JOBS
    || !optionalBoundedString(overview.degradedReason, MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES)
    || (overview.jobsTruncated !== undefined && overview.jobsTruncated !== true)) fail();
  return {
    generatedAt: overview.generatedAt as string,
    actionsEnabled: overview.actionsEnabled as boolean,
    jobs: (overview.jobs as unknown[]).map(parseCronOperatorJob),
    ...(overview.degradedReason === undefined ? {} : { degradedReason: overview.degradedReason as string }),
    ...(overview.jobsTruncated === true ? { jobsTruncated: true as const } : {}),
  };
}

export function parseCronOperatorJob(value: unknown): CronOperatorJob {
  const job = requireRecord(value);
  if (!hasOnlyKeys(job, [
    "jobId", "expression", "timezone", "conversationId", "configured", "declaredEnabled",
    "effectiveEnabled", "nextRunAt", "health", "lastRun", "activeRunId",
  ])
    || !boundedString(job.jobId, MAX_CRON_OPERATOR_JOB_ID_BYTES, true)
    || !optionalBoundedString(job.expression, MAX_CRON_OPERATOR_EXPRESSION_BYTES)
    || !optionalBoundedString(job.timezone, MAX_CRON_OPERATOR_TIMEZONE_BYTES)
    || !boundedString(job.conversationId, MAX_CRON_OPERATOR_CONVERSATION_ID_BYTES)
    || typeof job.configured !== "boolean"
    || typeof job.declaredEnabled !== "boolean"
    || typeof job.effectiveEnabled !== "boolean"
    || !["healthy", "warning", "unhealthy", "disabled", "unknown"].includes(String(job.health))
    || (job.nextRunAt !== undefined && !validDate(job.nextRunAt))
    || !optionalBoundedString(job.activeRunId, MAX_CRON_OPERATOR_RUN_ID_BYTES)) fail();
  return {
    jobId: job.jobId as string,
    ...(job.expression === undefined ? {} : { expression: job.expression as string }),
    ...(job.timezone === undefined ? {} : { timezone: job.timezone as string }),
    conversationId: job.conversationId as string,
    configured: job.configured as boolean,
    declaredEnabled: job.declaredEnabled as boolean,
    effectiveEnabled: job.effectiveEnabled as boolean,
    ...(job.nextRunAt === undefined ? {} : { nextRunAt: job.nextRunAt as string }),
    health: job.health as CronOperatorHealth,
    ...(job.lastRun === undefined ? {} : { lastRun: parseCronOperatorRunSummary(job.lastRun) }),
    ...(job.activeRunId === undefined ? {} : { activeRunId: job.activeRunId as string }),
  };
}

export function parseCronOperatorRunSummary(value: unknown): CronOperatorRunSummary {
  return parseRunBase(value, "summary", RUN_BASE_KEYS) as unknown as CronOperatorRunSummary;
}

export function parseCronOperatorRunDetail(value: unknown): CronOperatorRunDetail {
  const run = parseRunBase(value, "detail", [...RUN_BASE_KEYS, "events", "eventsIncluded"]);
  if (!Array.isArray(run.events)
    || run.events.length > MAX_CRON_OPERATOR_DETAIL_EVENTS
    || !Number.isSafeInteger(run.eventsIncluded)
    || Number(run.eventsIncluded) !== run.events.length
    || Number(run.eventsIncluded) > Number(run.eventCount)
    || serializedBytes(run.events) > MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES) fail();
  return {
    ...run,
    projection: "detail",
    events: run.events.map(parseCronOperatorEvent),
    eventsIncluded: run.eventsIncluded as number,
  } as unknown as CronOperatorRunDetail;
}

export function parseCronOperatorRunPage(value: unknown): CronOperatorRunPage {
  const page = requireRecord(value);
  if (!hasOnlyKeys(page, ["runs", "nextCursor"])
    || !Array.isArray(page.runs)
    || page.runs.length > MAX_CRON_OPERATOR_RUN_PAGE
    || !optionalBoundedString(page.nextCursor, MAX_CRON_OPERATOR_CURSOR_BYTES)) fail();
  return {
    runs: (page.runs as unknown[]).map(parseCronOperatorRunSummary),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor as string }),
  };
}

const RUN_BASE_KEYS = [
  "projection", "runId", "jobId", "scheduledAt", "orderedAt", "sequence", "trigger", "status",
  "startedAt", "completedAt", "artifactRunId", "text", "error", "failureKind", "blockedByRunId",
  "blockedByTrigger", "queueDepth", "eventCount", "fieldsTruncated", "eventsTruncated",
] as const;

function parseRunBase(
  value: unknown,
  projection: CronOperatorRun["projection"],
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const run = requireRecord(value);
  const detail = projection === "detail";
  if (!hasOnlyKeys(run, allowedKeys)
    || run.projection !== projection
    || !boundedString(run.runId, MAX_CRON_OPERATOR_RUN_ID_BYTES, true)
    || !boundedString(run.jobId, MAX_CRON_OPERATOR_JOB_ID_BYTES, true)
    || !validDate(run.scheduledAt)
    || !validDate(run.orderedAt)
    || !Number.isSafeInteger(run.sequence)
    || Number(run.sequence) <= 0
    || (run.trigger !== "scheduled" && run.trigger !== "manual")
    || !["admitted", "running", "queued", "succeeded", "failed", "cancelled", "skipped_overlap", "dropped"]
      .includes(String(run.status))
    || !Number.isSafeInteger(run.eventCount)
    || Number(run.eventCount) < 0
    || Number(run.eventCount) > MAX_CRON_OPERATOR_DETAIL_EVENTS
    || !optionalBoundedString(run.artifactRunId, detail
      ? MAX_CRON_OPERATOR_DETAIL_ARTIFACT_ID_BYTES
      : MAX_CRON_OPERATOR_SUMMARY_ARTIFACT_ID_BYTES)
    || !optionalBoundedString(run.text, detail
      ? MAX_CRON_OPERATOR_DETAIL_TEXT_BYTES
      : MAX_CRON_OPERATOR_SUMMARY_TEXT_BYTES)
    || !optionalBoundedString(run.error, detail
      ? MAX_CRON_OPERATOR_DETAIL_ERROR_BYTES
      : MAX_CRON_OPERATOR_SUMMARY_ERROR_BYTES)
    || !optionalBoundedString(run.failureKind, detail
      ? MAX_CRON_OPERATOR_DETAIL_FAILURE_KIND_BYTES
      : MAX_CRON_OPERATOR_SUMMARY_FAILURE_KIND_BYTES)
    || !optionalBoundedString(run.blockedByRunId, MAX_CRON_OPERATOR_RUN_ID_BYTES)
    || (run.startedAt !== undefined && !validDate(run.startedAt))
    || (run.completedAt !== undefined && !validDate(run.completedAt))
    || (run.blockedByTrigger !== undefined
      && run.blockedByTrigger !== "scheduled"
      && run.blockedByTrigger !== "manual")
    || (run.queueDepth !== undefined && (!Number.isSafeInteger(run.queueDepth) || Number(run.queueDepth) < 0))
    || (run.eventsTruncated !== undefined && run.eventsTruncated !== true)) fail();
  const fields = run.fieldsTruncated;
  const allowedFields: readonly string[] = ["artifactRunId", "error", "failureKind", "text"];
  if (fields !== undefined
    && (!Array.isArray(fields)
      || new Set(fields).size !== fields.length
      || fields.some((field) => !allowedFields.includes(String(field))))) fail();
  return run;
}

function parseCronOperatorEvent(value: unknown): AgentStreamEvent {
  const event = requireRecord(value);
  const metadataValid = event.metadata === undefined || isRecord(event.metadata);
  if (!metadataValid || typeof event.type !== "string") fail();
  switch (event.type) {
    case "assistant_thought":
      if (!hasOnlyKeys(event, ["type", "text", "metadata"]) || typeof event.text !== "string") fail();
      break;
    case "tool_call_started":
      if (!hasOnlyKeys(event, ["type", "id", "name", "arguments", "history", "metadata"])
        || typeof event.id !== "string"
        || typeof event.name !== "string"
        || !validToolHistoryMetadata(event.history)) fail();
      break;
    case "tool_call_completed":
      if (!hasOnlyKeys(event, ["type", "id", "name", "arguments", "content", "isError", "executionMs", "history", "metadata"])
        || typeof event.id !== "string"
        || (event.name !== undefined && typeof event.name !== "string")
        || (event.isError !== undefined && typeof event.isError !== "boolean")
        || !optionalFiniteNumber(event.executionMs, true)
        || !validToolHistoryMetadata(event.history)) fail();
      break;
    case "tool_call_progress":
      if (!hasOnlyKeys(event, ["type", "id", "name", "partialResult", "metadata"])
        || typeof event.id !== "string"
        || (event.name !== undefined && typeof event.name !== "string")) fail();
      break;
    case "usage_update": {
      if (!hasOnlyKeys(event, ["type", "model", "cumulativeUsd", "tokens", "metadata"])
        || (event.model !== undefined && typeof event.model !== "string")
        || !optionalFiniteNumber(event.cumulativeUsd, true)) fail();
      if (event.tokens !== undefined) {
        const tokens = requireRecord(event.tokens);
        if (!hasOnlyKeys(tokens, ["input", "output", "cacheRead", "cacheCreation"])
          || !nonnegativeInteger(tokens.input)
          || !nonnegativeInteger(tokens.output)
          || !nonnegativeInteger(tokens.cacheRead)
          || !nonnegativeInteger(tokens.cacheCreation)) fail();
      }
      break;
    }
    case "provider_status":
      if (!hasOnlyKeys(event, [
        "type", "kind", "model", "from", "to", "attemptIndex", "retryIndex", "reason", "durationMs",
        "cancelled", "metadata",
      ])
        || !["request_started", "request_completed", "failover_started", "failover_completed", "retry_started"]
          .includes(String(event.kind))
        || !optionalString(event.model)
        || !optionalString(event.from)
        || !optionalString(event.to)
        || !optionalString(event.reason)
        || !optionalNonnegativeInteger(event.attemptIndex)
        || !optionalNonnegativeInteger(event.retryIndex)
        || !optionalFiniteNumber(event.durationMs, true)
        || (event.cancelled !== undefined && typeof event.cancelled !== "boolean")) fail();
      break;
    case "memory_recalled":
      if (!hasOnlyKeys(event, ["type", "source", "bytes", "metadata"])
        || !optionalString(event.source)
        || !optionalNonnegativeInteger(event.bytes)) fail();
      break;
    case "runtime_telemetry":
      if (!hasOnlyKeys(event, ["type", "kind", "data", "metadata"])
        || typeof event.kind !== "string"
        || (event.data !== undefined && !isRecord(event.data))) fail();
      break;
    case "runtime_warning":
      if (!hasOnlyKeys(event, ["type", "message", "warningKind", "metadata"])
        || typeof event.message !== "string"
        || !optionalString(event.warningKind)) fail();
      break;
    default:
      fail();
  }
  return event as unknown as AgentStreamEvent;
}

function validToolHistoryMetadata(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "recordId", "sequence", "persistence", "terminalState", "truncated", "originalBytes",
      "retainedBytes", "artifactReferences", "errorCode", "untrusted",
    ])
    || !optionalString(value.recordId)
    || !optionalNonnegativeInteger(value.sequence)
    || !["persisted", "failed"].includes(String(value.persistence))
    || (value.terminalState !== undefined && ![
      "success", "rejected", "error", "exit_nonzero", "timeout", "signal", "cancelled", "interrupted",
    ].includes(String(value.terminalState)))
    || (value.truncated !== undefined && typeof value.truncated !== "boolean")
    || !optionalNonnegativeInteger(value.originalBytes)
    || !optionalNonnegativeInteger(value.retainedBytes)
    || !optionalString(value.errorCode)
    || value.untrusted !== true
    || (value.artifactReferences !== undefined && !Array.isArray(value.artifactReferences))) return false;
  return value.artifactReferences === undefined || value.artifactReferences.every((artifact) =>
    isRecord(artifact)
    && hasOnlyKeys(artifact, ["id", "available"])
    && typeof artifact.id === "string"
    && typeof artifact.available === "boolean");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function boundedString(value: unknown, maxBytes: number, nonempty = false): value is string {
  return typeof value === "string"
    && (!nonempty || value.length > 0)
    && utf8Bytes(value) <= maxBytes;
}

function optionalBoundedString(value: unknown, maxBytes: number): boolean {
  return value === undefined || boundedString(value, maxBytes);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalNonnegativeInteger(value: unknown): boolean {
  return value === undefined || nonnegativeInteger(value);
}

function optionalFiniteNumber(value: unknown, nonnegative: boolean): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && (!nonnegative || value >= 0));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function serializedBytes(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function fail(): never {
  throw new CronOperatorWireError();
}
