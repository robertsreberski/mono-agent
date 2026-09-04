import { createHmac } from "node:crypto";
import { isAbsolute, join, sep } from "node:path";

import {
  isMonitorErrorCode,
  isMonitorState,
  isTerminalMonitorState,
  monitorPublicError,
  type MonitorErrorCode,
  type MonitorProjection,
  type MonitorState,
} from "@mono-agent/agent-contracts";

import { readBoundedOwnerOnlyFile, writeJsonAtomic } from "./continuation-store-fs.js";
import { MONITORS_CAPS, MONITORS_MAX_TERMINAL_RECORDS } from "./monitors-config.js";
import { processIncarnationFromJson, type ProcessIncarnation } from "./process-incarnation.js";
import { isProcessJobOriginRecord, type ProcessJobOriginRecord } from "./process-jobs-store.js";

export const MONITOR_RECORD_SCHEMA = 1;
export const MONITOR_STATE_FILE = "monitors-v1.json";
export const MONITOR_OWNER_LOCK_FILE = ".monitors-owner";
export const MONITOR_OWNER_SCHEMA = "mono-agent.monitors-owner.v1";

/** Bounded by the compiled active cap plus retained terminal wake obligations. */
export const MONITOR_STORE_MAX_RECORDS = MONITORS_CAPS.maxActive + MONITORS_MAX_TERMINAL_RECORDS;
/**
 * A record holds only bounded identity, lifecycle and counters, never argv,
 * environment values, or event text, so the whole file stays small.
 */
export const MAX_MONITOR_STATE_BYTES = 256 * 1024;
const MAX_DESCRIPTION_CHARS = 500;
const READ_ATTEMPTS = 4;
const READ_RETRY_MS = 25;
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001F\\u007F]", "gu");

export interface DurableMonitorRecord {
  readonly schemaVersion: typeof MONITOR_RECORD_SCHEMA;
  readonly monitorId: string;
  state: MonitorState;
  /** Bounded, redacted, model-authored purpose. */
  readonly description: string;
  /** Kernel-produced summary; contains no argument values. */
  readonly summary: string;
  readonly persistent: boolean;
  readonly origin: ProcessJobOriginRecord;
  readonly chainDepth: number;
  readonly agentIncarnation: ProcessIncarnation;
  processIncarnation?: ProcessIncarnation;
  pid: number | null;
  pgid: number | null;
  sandboxSettingsPath: string | null;
  readonly maxRuntimeMs: number;
  readonly coalesceMs: number;
  readonly maxBatchLines: number;
  readonly maxBatchBytes: number;
  readonly startedAt: string;
  runtimeDeadlineAt: string | null;
  lastEventAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  cancelRequested: boolean;
  seq: number;
  batchesDelivered: number;
  linesObserved: number;
  linesDelivered: number;
  droppedLines: number;
  pendingLines: number;
  /** True only while the single terminal wake for this monitor is still owed. */
  terminalWakePending: boolean;
  lastError: { code: MonitorErrorCode; message: string } | null;
}

export interface MonitorStoreSnapshot {
  readonly schemaVersion: typeof MONITOR_RECORD_SCHEMA;
  readonly records: readonly DurableMonitorRecord[];
}

/**
 * Derive the monitor operator bearer from the SAME owner-private secret the
 * process-job operator surface uses. A distinct HMAC label keeps the two bearers
 * unrelated, so a leaked monitor token can never authorize job routes.
 */
export function monitorOperatorToken(secret: Uint8Array): string {
  if (secret.byteLength !== 32) throw new Error("Monitor operator secret must contain exactly 32 bytes.");
  return createHmac("sha256", secret).update("mono-agent-monitor-operator-v1").digest("base64url");
}

export function monitorStatePath(stateDir: string): string {
  return join(stateDir, MONITOR_STATE_FILE);
}

/**
 * Read the durable snapshot. A missing file is an empty store. A corrupt or
 * oversized file is reported to the caller rather than silently discarded: the
 * only durable obligation monitors carry is the restart wake, and losing it
 * quietly would make an interrupted watch look like one that never existed.
 */
export async function readMonitorStore(stateDir: string): Promise<{
  readonly snapshot: MonitorStoreSnapshot;
  readonly corrupt: boolean;
  /** Why the state was rejected, for the operator-facing log. Never the bytes. */
  readonly reason?: string;
}> {
  let contents: string | undefined;
  let lastError: unknown;
  // The reader rejects a file whose identity changed under it, which is exactly
  // what an atomic replace looks like from the outside. That is a transient
  // observation, not corruption, and treating it as corruption would make a
  // concurrent write permanently disable monitors.
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    try {
      contents = await readBoundedOwnerOnlyFile(
        monitorStatePath(stateDir),
        MAX_MONITOR_STATE_BYTES,
        "Monitor state",
      );
      break;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { snapshot: emptySnapshot(), corrupt: false };
      lastError = error;
      if (attempt + 1 < READ_ATTEMPTS) await delay(READ_RETRY_MS);
    }
  }
  if (contents === undefined) {
    return { snapshot: emptySnapshot(), corrupt: true, reason: `unreadable: ${reasonOf(lastError)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    return { snapshot: emptySnapshot(), corrupt: true, reason: `invalid JSON: ${reasonOf(error)}` };
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== MONITOR_RECORD_SCHEMA
    || !Array.isArray(parsed.records)
    || parsed.records.length > MONITOR_STORE_MAX_RECORDS) {
    return { snapshot: emptySnapshot(), corrupt: true, reason: "envelope is not a bounded v1 record set" };
  }
  const records: DurableMonitorRecord[] = [];
  let corrupt = false;
  for (const entry of parsed.records) {
    if (isDurableMonitorRecord(entry)) records.push(entry);
    else corrupt = true;
  }
  const ids = new Set(records.map((record) => record.monitorId));
  if (ids.size !== records.length) {
    return { snapshot: emptySnapshot(), corrupt: true, reason: "duplicate monitor ids" };
  }
  return corrupt
    ? { snapshot: { schemaVersion: MONITOR_RECORD_SCHEMA, records }, corrupt, reason: "one or more records failed validation" }
    : { snapshot: { schemaVersion: MONITOR_RECORD_SCHEMA, records }, corrupt };
}

export async function writeMonitorStore(
  stateDir: string,
  records: readonly DurableMonitorRecord[],
): Promise<void> {
  if (records.length > MONITOR_STORE_MAX_RECORDS) {
    throw new Error("Monitor durable record capacity is exceeded.");
  }
  await writeJsonAtomic(
    monitorStatePath(stateDir),
    { schemaVersion: MONITOR_RECORD_SCHEMA, records },
    true,
    MAX_MONITOR_STATE_BYTES,
  );
}

export function projectMonitor(record: DurableMonitorRecord): MonitorProjection {
  return {
    schema: "mono-agent.monitor-projection.v1",
    monitorId: record.monitorId,
    state: record.state,
    description: record.description,
    persistent: record.persistent,
    origin: {
      conversationId: record.origin.conversationId,
      channel: record.origin.channel,
      runId: record.origin.runId,
      bucket: record.origin.bucket,
    },
    timestamps: {
      startedAt: record.startedAt,
      runtimeDeadlineAt: record.runtimeDeadlineAt,
      lastEventAt: record.lastEventAt,
      completedAt: record.completedAt,
    },
    limits: {
      maxRuntimeMs: record.maxRuntimeMs,
      coalesceMs: record.coalesceMs,
      maxBatchLines: record.maxBatchLines,
      maxBatchBytes: record.maxBatchBytes,
      chainDepth: record.chainDepth,
    },
    counters: {
      seq: record.seq,
      batchesDelivered: record.batchesDelivered,
      linesObserved: record.linesObserved,
      linesDelivered: record.linesDelivered,
      droppedLines: record.droppedLines,
      pendingLines: record.pendingLines,
    },
    exitCode: record.exitCode,
    signal: record.signal,
    cancelRequested: record.cancelRequested,
    lastError: record.lastError === null ? null : monitorPublicError(record.lastError.code),
  };
}

/** Bound and neutralize the model-authored description before it is retained. */
export function boundMonitorDescription(value: string): string {
  const collapsed = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_DESCRIPTION_CHARS
    ? `${collapsed.slice(0, MAX_DESCRIPTION_CHARS - 3)}...`
    : collapsed;
}

export function isDurableMonitorRecord(value: unknown): value is DurableMonitorRecord {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== MONITOR_RECORD_SCHEMA) return false;
  if (!boundedString(value.monitorId, 256) || !isMonitorState(value.state)) return false;
  if (typeof value.description !== "string" || value.description.length > MAX_DESCRIPTION_CHARS) return false;
  if (typeof value.summary !== "string" || value.summary.length > 8_000) return false;
  if (typeof value.persistent !== "boolean" || typeof value.cancelRequested !== "boolean") return false;
  if (typeof value.terminalWakePending !== "boolean") return false;
  if (!isMonitorOriginRecord(value.origin)) return false;
  if (!nonNegativeInteger(value.chainDepth) || Number(value.chainDepth) > MONITORS_CAPS.maxChainDepth) return false;
  if (processIncarnationFromJson(value.agentIncarnation) === undefined) return false;
  if (value.processIncarnation !== undefined
    && processIncarnationFromJson(value.processIncarnation) === undefined) return false;
  if (!nullablePositiveInteger(value.pid) || !nullablePositiveInteger(value.pgid)) return false;
  // A detached watcher always leads its own group, and a recorded PID is only
  // actionable with the incarnation that distinguishes it from a later reuse.
  // Accepting a half-formed combination would let recovery either signal a
  // group it cannot attest or silently discard a live one.
  if ((value.pid === null) !== (value.pgid === null)) return false;
  if (value.pid !== null && value.pid !== value.pgid) return false;
  if (value.pid !== null && value.processIncarnation === undefined) return false;
  // The sandbox path is passed to rm() during recovery, so it must be an
  // absolute path with no traversal segments.
  if (value.sandboxSettingsPath !== null
    && (!boundedString(value.sandboxSettingsPath, 4_096)
      || !isAbsolute(value.sandboxSettingsPath)
      || value.sandboxSettingsPath.split(sep).some((part) => part === ".." ))) return false;
  if (!positiveInteger(value.maxRuntimeMs)
    || Number(value.maxRuntimeMs) > MONITORS_CAPS.persistentMaxRuntimeMs) return false;
  if (!positiveInteger(value.coalesceMs)
    || !positiveInteger(value.maxBatchLines)
    || !positiveInteger(value.maxBatchBytes)) return false;
  if (!validDate(value.startedAt)) return false;
  if (!nullableValidDate(value.runtimeDeadlineAt)
    || !nullableValidDate(value.lastEventAt)
    || !nullableValidDate(value.completedAt)) return false;
  if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) return false;
  if (value.signal !== null && !boundedString(value.signal, 128)) return false;
  for (const key of [
    "seq",
    "batchesDelivered",
    "linesObserved",
    "linesDelivered",
    "droppedLines",
    "pendingLines",
  ] as const) {
    if (!nonNegativeInteger(value[key])) return false;
  }
  if (value.lastError !== null) {
    if (!isRecord(value.lastError)
      || !isMonitorErrorCode(value.lastError.code)
      || typeof value.lastError.message !== "string"
      || value.lastError.message.length > 4_000) return false;
  }
  // A terminal record must carry its completion instant; recovery uses that to
  // tell an interrupted live watch from one that already settled.
  if (isTerminalMonitorState(value.state) && value.completedAt === null) return false;
  return true;
}

function emptySnapshot(): MonitorStoreSnapshot {
  return { schemaVersion: MONITOR_RECORD_SCHEMA, records: [] };
}

/**
 * Reuse the process-job origin validator rather than re-deriving one.
 *
 * Field-by-field checks are not enough: a damaged record whose fields are each
 * individually well-formed but mutually inconsistent could deliver into one
 * conversation while authorizing MonitorStop from another. The shared validator
 * is relational — it re-derives the base id and bucket from the conversation id
 * and requires the reply target, normalized target and history boundary to
 * agree — which is exactly the property that binds a monitor to one route.
 */
function isMonitorOriginRecord(value: unknown): value is ProcessJobOriginRecord {
  return isProcessJobOriginRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && Number(value) > 0;
}

function nullablePositiveInteger(value: unknown): value is number | null {
  return value === null || positiveInteger(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nullableValidDate(value: unknown): value is string | null {
  return value === null || validDate(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
