import type { AgentStreamEvent } from "./index.js";
import {
  isAgentReplyPartDeliveryOutcomes,
  sanitizeReplyPartDeliveryOutcomes,
  type AgentReplyPartDeliveryOutcome,
} from "./reply-part-outcomes.js";
import { MAX_AGENT_REPLY_PARTS } from "./stream-wire.js";

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
/** Compact projections retain the first ordered outcomes; detail retains the full shared 20-outcome contract. */
export const MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES = 8;
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
  /** Bounded sanitized terminal outcomes; summary keeps 8 ordered records and detail keeps the shared 20. */
  readonly replyPartOutcomes?: readonly AgentReplyPartDeliveryOutcome[];
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
  /** May be shorter than the requested item limit when the next summary would exceed the response byte ceiling. */
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
  const overview = snapshotOwnDataRecord(value);
  const jobs = snapshotOwnDataArray(overview.jobs, MAX_CRON_OPERATOR_JOBS);
  if (!hasOnlyKeys(overview, ["generatedAt", "actionsEnabled", "jobs", "degradedReason", "jobsTruncated"])
    || !validDate(overview.generatedAt)
    || typeof overview.actionsEnabled !== "boolean"
    || !optionalBoundedString(overview.degradedReason, MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES)
    || (overview.jobsTruncated !== undefined && overview.jobsTruncated !== true)) fail();
  return {
    generatedAt: overview.generatedAt as string,
    actionsEnabled: overview.actionsEnabled as boolean,
    jobs: jobs.map(parseCronOperatorJob),
    ...(overview.degradedReason === undefined ? {} : { degradedReason: overview.degradedReason as string }),
    ...(overview.jobsTruncated === true ? { jobsTruncated: true as const } : {}),
  };
}

export function parseCronOperatorJob(value: unknown): CronOperatorJob {
  const job = snapshotOwnDataRecord(value);
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
    || !oneOf(job.health, ["healthy", "warning", "unhealthy", "disabled", "unknown"])
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
  const sourceEvents = snapshotOwnDataArray(run.events, MAX_CRON_OPERATOR_DETAIL_EVENTS);
  const events = sourceEvents.map(parseCronOperatorEvent);
  if (!Number.isSafeInteger(run.eventsIncluded)
    || Number(run.eventsIncluded) !== events.length
    || Number(run.eventsIncluded) > Number(run.eventCount)
    || serializedBytes(events) > MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES) fail();
  return {
    ...run,
    projection: "detail",
    events,
    eventsIncluded: run.eventsIncluded as number,
  } as unknown as CronOperatorRunDetail;
}

export function parseCronOperatorRunPage(value: unknown): CronOperatorRunPage {
  const page = snapshotOwnDataRecord(value);
  const sourceRuns = snapshotOwnDataArray(page.runs, MAX_CRON_OPERATOR_RUN_PAGE);
  if (!hasOnlyKeys(page, ["runs", "nextCursor"])
    || !optionalBoundedString(page.nextCursor, MAX_CRON_OPERATOR_CURSOR_BYTES)) fail();
  const parsed: CronOperatorRunPage = {
    runs: sourceRuns.map(parseCronOperatorRunSummary),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor as string }),
  };
  if (serializedBytes(parsed) > MAX_CRON_OPERATOR_RESPONSE_BYTES) fail();
  return parsed;
}

const RUN_BASE_KEYS = [
  "projection", "runId", "jobId", "scheduledAt", "orderedAt", "sequence", "trigger", "status",
  "startedAt", "completedAt", "artifactRunId", "text", "error", "failureKind", "blockedByRunId",
  "blockedByTrigger", "queueDepth", "replyPartOutcomes", "eventCount", "fieldsTruncated", "eventsTruncated",
] as const;

function parseRunBase(
  value: unknown,
  projection: CronOperatorRun["projection"],
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const run = snapshotOwnDataRecord(value);
  const detail = projection === "detail";
  const sourceReplyPartOutcomes = run.replyPartOutcomes;
  if (!hasOnlyKeys(run, allowedKeys)
    || run.projection !== projection
    || !boundedString(run.runId, MAX_CRON_OPERATOR_RUN_ID_BYTES, true)
    || !boundedString(run.jobId, MAX_CRON_OPERATOR_JOB_ID_BYTES, true)
    || !validDate(run.scheduledAt)
    || !validDate(run.orderedAt)
    || !Number.isSafeInteger(run.sequence)
    || Number(run.sequence) <= 0
    || (run.trigger !== "scheduled" && run.trigger !== "manual")
    || !oneOf(run.status, [
      "admitted", "running", "queued", "succeeded", "failed", "cancelled", "skipped_overlap", "dropped",
    ])
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
  const fields = run.fieldsTruncated === undefined
    ? undefined
    : snapshotOwnDataArray(run.fieldsTruncated, 4);
  const allowedFields = ["artifactRunId", "error", "failureKind", "text"] as const;
  if (fields !== undefined && (new Set(fields).size !== fields.length
    || fields.some((field) => !oneOf(field, allowedFields)))) fail();
  const replyPartOutcomes = sourceReplyPartOutcomes === undefined
    ? undefined
    : parseReplyPartOutcomes(
        sourceReplyPartOutcomes,
        detail ? MAX_AGENT_REPLY_PARTS : MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES,
      );
  const parsed: Record<string, unknown> = {
    projection,
    runId: run.runId as string,
    jobId: run.jobId as string,
    scheduledAt: run.scheduledAt as string,
    orderedAt: run.orderedAt as string,
    sequence: run.sequence as number,
    trigger: run.trigger as CronOperatorRunTrigger,
    status: run.status as CronOperatorRunStatus,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt as string }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt as string }),
    ...(run.artifactRunId === undefined ? {} : { artifactRunId: run.artifactRunId as string }),
    ...(run.text === undefined ? {} : { text: run.text as string }),
    ...(run.error === undefined ? {} : { error: run.error as string }),
    ...(run.failureKind === undefined ? {} : { failureKind: run.failureKind as string }),
    ...(run.blockedByRunId === undefined ? {} : { blockedByRunId: run.blockedByRunId as string }),
    ...(run.blockedByTrigger === undefined
      ? {}
      : { blockedByTrigger: run.blockedByTrigger as CronOperatorRunTrigger }),
    ...(run.queueDepth === undefined ? {} : { queueDepth: run.queueDepth as number }),
    ...(replyPartOutcomes === undefined ? {} : { replyPartOutcomes }),
    eventCount: run.eventCount as number,
    ...(fields === undefined ? {} : { fieldsTruncated: fields as readonly CronOperatorRunTruncatedField[] }),
    ...(run.eventsTruncated === true ? { eventsTruncated: true as const } : {}),
  };
  return detail
    ? { ...parsed, events: run.events, eventsIncluded: run.eventsIncluded }
    : parsed;
}

function parseCronOperatorEvent(value: unknown): AgentStreamEvent {
  const event = snapshotJsonRecord(value);
  const metadataValid = event.metadata === undefined || isSnapshotRecord(event.metadata);
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
        if (!isSnapshotRecord(event.tokens)
          || !hasOnlyKeys(event.tokens, ["input", "output", "cacheRead", "cacheCreation"])
          || !nonnegativeInteger(event.tokens.input)
          || !nonnegativeInteger(event.tokens.output)
          || !nonnegativeInteger(event.tokens.cacheRead)
          || !nonnegativeInteger(event.tokens.cacheCreation)) fail();
      }
      break;
    }
    case "provider_status":
      if (!hasOnlyKeys(event, [
        "type", "kind", "model", "from", "to", "attemptIndex", "retryIndex", "reason", "durationMs",
        "cancelled", "metadata",
      ])
        || !oneOf(event.kind, [
          "request_started", "request_completed", "failover_started", "failover_completed", "retry_started",
        ])
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
        || (event.data !== undefined && !isSnapshotRecord(event.data))) fail();
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
  if (!isSnapshotRecord(value)
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
    isSnapshotRecord(artifact)
    && hasOnlyKeys(artifact, ["id", "available"])
    && typeof artifact.id === "string"
    && typeof artifact.available === "boolean");
}

function parseReplyPartOutcomes(
  value: unknown,
  maxLength: number,
): readonly AgentReplyPartDeliveryOutcome[] {
  const source = snapshotOwnDataArray(value, maxLength).map(snapshotOwnDataRecord);
  if (!isAgentReplyPartDeliveryOutcomes(source)) fail();
  const parsed = sanitizeReplyPartDeliveryOutcomes(source);
  if (parsed === undefined) fail();
  return parsed;
}

function snapshotOwnDataRecord(value: unknown): Record<string, unknown> {
  let descriptors: ReturnType<typeof Object.getOwnPropertyDescriptors>;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail();
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) fail();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotOwnDataArray(value: unknown, maxLength: number): readonly unknown[] {
  let descriptors: ReturnType<typeof Object.getOwnPropertyDescriptors>;
  try {
    if (!Array.isArray(value)) fail();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || lengthDescriptor.enumerable !== false
    || !Number.isSafeInteger(lengthDescriptor.value)
    || Number(lengthDescriptor.value) < 0
    || Number(lengthDescriptor.value) > maxLength) fail();
  const length = Number(lengthDescriptor.value);
  const snapshot = new Array<unknown>(length);
  let elementCount = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail();
    if (key === "length") continue;
    const index = canonicalArrayIndex(key);
    const descriptor = descriptors[key];
    if (index === undefined
      || index >= length
      || descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)) fail();
    snapshot[index] = descriptor.value;
    elementCount += 1;
  }
  if (elementCount !== length) fail();
  return snapshot;
}

function canonicalArrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : undefined;
}

interface JsonSnapshotContext {
  readonly active: WeakSet<object>;
  readonly snapshots: WeakMap<object, unknown>;
}

function createJsonSnapshotContext(): JsonSnapshotContext {
  return { active: new WeakSet(), snapshots: new WeakMap() };
}

function snapshotJsonRecord(value: unknown): Record<string, unknown> {
  try {
    const snapshot = snapshotJsonValue(value, createJsonSnapshotContext());
    if (!isSnapshotRecord(snapshot)) fail();
    return snapshot;
  } catch {
    fail();
  }
}

function snapshotJsonValue(value: unknown, context: JsonSnapshotContext): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (typeof value !== "object") fail();
  if (context.active.has(value)) fail();
  const cached = context.snapshots.get(value);
  if (cached !== undefined) return cached;
  context.active.add(value);
  try {
    if (isArrayValue(value)) {
      const source = snapshotOwnDataArray(value, MAX_CRON_OPERATOR_DETAIL_EVENT_BYTES);
      const snapshot = new Array<unknown>(source.length);
      context.snapshots.set(value, snapshot);
      for (let index = 0; index < source.length; index += 1) {
        snapshot[index] = snapshotJsonValue(source[index], context);
      }
      return snapshot;
    }
    const source = snapshotOwnDataRecord(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    context.snapshots.set(value, snapshot);
    for (const key of Object.keys(source)) {
      snapshot[key] = snapshotJsonValue(source[key], context);
    }
    return snapshot;
  } finally {
    context.active.delete(value);
  }
}

function isSnapshotRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArrayValue(value: object): boolean {
  try {
    return Array.isArray(value);
  } catch {
    fail();
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
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
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? utf8Bytes(serialized) : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function fail(): never {
  throw new CronOperatorWireError();
}
