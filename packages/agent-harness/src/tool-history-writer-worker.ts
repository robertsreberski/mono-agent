import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  isKnownArtifactFailureKind,
  redactJsonValue,
  sanitizeVisibleText,
} from "@mono-agent/observability";
import type {
  RuntimeToolLifecycleEvent,
  RuntimeToolLifecyclePersistence,
  RuntimeToolLifecycleTerminalState,
} from "@mono-agent/runtime-adapter";

import { isProcessAlive } from "./history-process-liveness.js";
import { continueToolHistoryOperationTail } from "./tool-history-worker-queue.js";
import {
  canonicalToolArtifactRoot,
  toolHistoryArtifactAvailable,
  validatedToolHistoryArtifactPath,
} from "./tool-history-artifacts.js";
import {
  TOOL_HISTORY_APPLICATION_ID,
  TOOL_HISTORY_DATABASE,
  TOOL_HISTORY_DIRECTORY,
  TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS,
  TOOL_HISTORY_OWNER_DATABASE,
  TOOL_HISTORY_SCHEMA,
  TOOL_HISTORY_USER_VERSION,
  toolHistoryRecordId,
  type ToolHistoryRetentionOptions,
  type ToolHistoryRunBinding,
} from "./tool-history-store.js";

interface WorkerInput {
  readonly root: string;
  readonly artifactRoot: string;
  readonly artifactRootAliases: readonly string[];
  readonly retention?: ToolHistoryRetentionOptions;
  readonly ownerAcquireCeilingMs?: number;
}

interface WorkerRequest {
  readonly id: number;
  readonly operation: string;
  readonly payload?: unknown;
}

interface LifecyclePayload {
  readonly binding: ToolHistoryRunBinding;
  readonly event: RuntimeToolLifecycleEvent;
}

const DEFAULT_RETENTION: Required<ToolHistoryRetentionOptions> = {
  maxCompletedCalls: 100_000,
  maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
  maxBytes: 256 * 1024 * 1024,
  maxTombstones: 10_000,
  tombstoneMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
};
const ARGUMENT_MAX_BYTES = 8 * 1024;
const RESULT_MAX_BYTES = 16 * 1024;
const STRING_MAX_BYTES = 4 * 1024;
const SEARCH_TEXT_MAX_BYTES = 8 * 1024;
const PRE_REDACTION_MAX_NODES = 2_048;
const PRE_REDACTION_MAX_STRING_BYTES = 64 * 1024;
const PRE_REDACTION_MAX_COLLECTION_ITEMS = 512;
const PRE_REDACTION_MAX_KEY_BYTES = 512;
const PRE_REDACTION_OMISSION = "[oversized value omitted before redaction]";
const WRITER_STAT_DETAIL_MAX_BYTES = 1_000;
const WRITER_STAT_DETAIL_MAX_INSPECTION_CODE_UNITS = 4_096;
const WRITER_STAT_DETAIL_POLICY_VERSION = "visible-text-v1";
const WRITER_STAT_DETAIL_OMISSION = "[writer detail omitted because it contained private data]";
const WRITER_STAT_DETAIL_OVERSIZED_OMISSION = "[writer detail omitted because it exceeded the inspection bound]";
const TOOL_DIR_ALLOWED = new Set([TOOL_HISTORY_DATABASE, `${TOOL_HISTORY_DATABASE}-journal`]);
const TERMINAL_STATES = new Set<RuntimeToolLifecycleTerminalState>([
  "success", "rejected", "error", "exit_nonzero", "timeout", "signal", "cancelled", "interrupted",
]);
class WorkerHistoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

class RunBindingConflictError extends WorkerHistoryError {
  readonly incidentKey: string;
  readonly detail: string;

  constructor(incidentKey: string, detail: string) {
    super("history_idempotency_conflict", "Run binding changed after tool history opened.");
    this.incidentKey = incidentKey;
    this.detail = detail;
  }
}

const input = workerData as WorkerInput;
const root = resolve(input.root);
const artifactRoot = canonicalToolArtifactRoot(input.artifactRoot);
const artifactRootAliases = input.artifactRootAliases.map((value) => resolve(value));
const retention = normalizeRetention(input.retention);
const ownerAcquireCeilingMs = positiveInteger(
  input.ownerAcquireCeilingMs ?? TOOL_HISTORY_OWNER_ACQUIRE_CEILING_MS,
  "ownerAcquireCeilingMs",
);
const locksDirectory = join(root, ".locks");
const toolDirectory = join(root, TOOL_HISTORY_DIRECTORY);
const databasePath = join(toolDirectory, TOOL_HISTORY_DATABASE);
const journalPath = `${databasePath}-journal`;
const ownerPath = join(locksDirectory, TOOL_HISTORY_OWNER_DATABASE);

try {
  secureDirectoryPath(root);
  ensureSecureDirectory(locksDirectory);
  ensureSecureDirectory(toolDirectory);
  assertToolDirectoryEntries();
  ensureSecureFile(ownerPath);
  ensureSecureFile(databasePath);
} catch (error) {
  respondError(
    0,
    error instanceof WorkerHistoryError ? error.code : "history_writer_start_failed",
    reasonOf(error),
  );
  throw error;
}

let owner: { release(): void } | undefined;
let database: DatabaseSync | undefined;
try {
  owner = await acquireOwner(ownerPath, ownerAcquireCeilingMs);
  database = openContentDatabase(databasePath, retention, artifactRoot);
  closeDangling(database, undefined, "interrupted", "process_death", "recovered_after_writer_restart", true);
  applyRetention(database, retention);
  const recoveredDatabase = database;
  if (statValue(recoveredDatabase, "recovery_failures") > 0) {
    transaction(recoveredDatabase, () => clearStat(recoveredDatabase, "recovery_failures"));
  }
} catch (error) {
  try { if (database !== undefined) incrementStat(database, "recovery_failures", 1, reasonOf(error)); } catch { /* preserve the original recovery failure */ }
  try { database?.close(); } catch { /* ownership release remains authoritative */ }
  try { owner?.release(); } catch { /* startup error remains authoritative */ }
  respondError(
    0,
    error instanceof WorkerHistoryError ? error.code : "history_writer_start_failed",
    reasonOf(error),
  );
  throw error;
}

if (owner === undefined || database === undefined) {
  throw new Error("Tool history writer initialization completed without an owner or database.");
}

if (parentPort === null) throw new Error("Tool history writer requires a parent port.");

let closed = false;
let operationTail = Promise.resolve();
parentPort.on("message", (request: WorkerRequest) => {
  operationTail = continueToolHistoryOperationTail(operationTail, async () => {
    if (closed && request.operation !== "close") {
      respondError(request.id, "history_writer_closed", "Tool history writer is closed.");
      return;
    }
    try {
      switch (request.operation) {
        case "ready":
          respond(request.id, { schema: TOOL_HISTORY_SCHEMA, recovered: statValue(database, "recovered_calls") });
          break;
        case "invocation":
          respond(request.id, recordInvocation(database, lifecyclePayload(request.payload)));
          break;
        case "result":
          respond(request.id, recordResult(database, lifecyclePayload(request.payload)));
          break;
        case "finish_run": {
          const value = recordOf(request.payload);
          const binding = bindingOf(value.binding);
          const status = typeof value.status === "string" ? value.status : "interrupted";
          const state = terminalStateForRunStatus(status);
          closeDangling(
            database,
            binding,
            state,
            normalizeFailureKind(state, typeof value.failureKind === "string" ? value.failureKind : undefined) ?? "runtime_error",
            `run_${boundedCode(status)}`,
            false,
          );
          transaction(database, () => {
            database.prepare(`UPDATE runs SET status=?, terminal_at_ms=? WHERE conversation_id=? AND run_id=?`)
              .run(status, Date.now(), binding.conversationId, binding.runId);
            clearIncident(database, "write_failures", finishRunIncidentKey(binding));
          });
          respond(request.id, null);
          break;
        }
        case "reset_conversation": {
          const logicalConversationId = normalizeId(
            recordOf(request.payload).logicalConversationId,
            "logicalConversationId",
          );
          transaction(database, () => {
            resetLogicalConversation(database, logicalConversationId);
          });
          respond(request.id, null);
          break;
        }
        case "write_failure": {
          recordWriteFailure(database, request.payload);
          // A timed-out request no longer has a waiter; replying is harmless.
          respond(request.id, null);
          break;
        }
        case "stats":
          respond(request.id, workerStats(database));
          break;
        case "close":
          closeDangling(database, undefined, "interrupted", "cancelled_shutdown", "writer_shutdown", false);
          closed = true;
          database.close();
          owner.release();
          // Acknowledgement is the durability boundary: the content database is
          // closed and the ownership row is gone before the host can terminate.
          respond(request.id, null);
          break;
        default:
          respondError(request.id, "history_operation_unsupported", `Unsupported tool history operation ${request.operation}.`);
      }
    } catch (error) {
      respondError(
        request.id,
        error instanceof WorkerHistoryError ? error.code : "history_write_failed",
        reasonOf(error),
      );
    }
  });
  // A failed parent-port acknowledgement is terminal for that response, not
  // for the serialized database queue. In particular, postMessage can throw
  // while the parent is tearing down; the helper keeps the tail fulfilled so a
  // surviving port can still submit close/recovery work.
});

function recordInvocation(database: DatabaseSync, payload: LifecyclePayload): RuntimeToolLifecyclePersistence {
  const binding = bindingOf(payload.binding);
  if (payload.event.phase !== "invocation") throw new WorkerHistoryError("history_phase_invalid", "Expected invocation event.");
  const event = payload.event;
  const toolCallId = normalizeId(event.toolCallId, "toolCallId");
  const toolName = normalizeId(event.toolName, "toolName");
  const bounded = boundedPayload(event.arguments ?? null, ARGUMENT_MAX_BYTES);
  return lifecycleTransaction(database, () => {
    ensureRun(database, binding);
    const recordId = toolHistoryRecordId(binding.conversationId, binding.runId, toolCallId, "invocation");
    if (isCallTombstoned(database, binding, toolCallId)) {
      return { persistence: "failed", errorCode: "history_record_tombstoned" };
    }
    const existing = database.prepare(`
      SELECT tr.record_id, tr.seq, tr.payload_sha256, tr.truncated, tr.original_bytes, tr.retained_bytes,
             c.tool_name
      FROM tool_records tr JOIN tool_calls c
        ON c.conversation_id=tr.conversation_id AND c.run_id=tr.run_id AND c.tool_call_id=tr.tool_call_id
      WHERE tr.conversation_id=? AND tr.run_id=? AND tr.tool_call_id=? AND tr.phase='invocation'
    `).get(binding.conversationId, binding.runId, toolCallId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (
        existing.payload_sha256 !== bounded.sha256
        || existing.tool_name !== toolName
      ) {
        recordIncident(
          database,
          "idempotency_conflicts",
          lifecycleIncidentKey(binding, toolCallId, "invocation"),
          `${binding.runId}:${toolCallId}:invocation`,
        );
        return { persistence: "failed", errorCode: "history_idempotency_conflict" };
      }
      resolveLifecycleIncidents(database, binding, toolCallId, "invocation");
      return persistenceFromRow(existing);
    }
    const sequence = takeSequence(database, binding);
    const now = Date.now();
    database.prepare(`
      INSERT INTO tool_calls (
        conversation_id,run_id,tool_call_id,tool_name,start_seq,started_at_ms,recovered,synthetic_start
      ) VALUES (?,?,?,?,?,?,?,0)
    `).run(
      binding.conversationId,
      binding.runId,
      toolCallId,
      toolName,
      sequence,
      now,
      0,
    );
    insertRecord(database, {
      recordId, binding, toolCallId, phase: "invocation", sequence, bounded,
    });
    resolveLifecycleIncidents(database, binding, toolCallId, "invocation");
    return persistence(recordId, sequence, bounded);
  });
}

function recordResult(database: DatabaseSync, payload: LifecyclePayload): RuntimeToolLifecyclePersistence {
  const binding = bindingOf(payload.binding);
  if (payload.event.phase !== "result") throw new WorkerHistoryError("history_phase_invalid", "Expected result event.");
  const event = payload.event;
  const toolCallId = normalizeId(event.toolCallId, "toolCallId");
  if (!TERMINAL_STATES.has(event.state)) throw new WorkerHistoryError("history_state_invalid", "Unsupported terminal tool state.");
  const failureKind = normalizeFailureKind(event.state, event.failureKind);
  const detailCode = event.detailCode === undefined ? null : boundedCode(event.detailCode);
  const executionMs = event.executionMs === undefined ? null : nonNegativeInteger(event.executionMs);
  const artifactIds = normalizedArtifactIds(event.artifacts ?? [], binding);
  const bounded = boundedPayload(event.content ?? null, RESULT_MAX_BYTES);
  return lifecycleTransaction(database, () => {
    ensureRun(database, binding);
    const recordId = toolHistoryRecordId(binding.conversationId, binding.runId, toolCallId, "result");
    if (isCallTombstoned(database, binding, toolCallId)) {
      return { persistence: "failed", errorCode: "history_record_tombstoned" };
    }
    let call = database.prepare(`
      SELECT tool_name,end_seq,state,failure_kind,detail_code,duration_ms,synthetic_result
      FROM tool_calls WHERE conversation_id=? AND run_id=? AND tool_call_id=?
    `).get(binding.conversationId, binding.runId, toolCallId) as Record<string, unknown> | undefined;
    if (call === undefined) {
      const syntheticName = normalizeId(event.toolName ?? "unknown_tool", "toolName");
      const invocation = boundedPayload({ synthetic: true, reason: "result_observed_before_invocation" }, ARGUMENT_MAX_BYTES);
      const startSequence = takeSequence(database, binding);
      const startRecordId = toolHistoryRecordId(binding.conversationId, binding.runId, toolCallId, "invocation");
      database.prepare(`
        INSERT INTO tool_calls (
          conversation_id,run_id,tool_call_id,tool_name,start_seq,started_at_ms,recovered,synthetic_start
        ) VALUES (?,?,?,?,?,?,0,1)
      `).run(binding.conversationId, binding.runId, toolCallId, syntheticName, startSequence, Date.now());
      insertRecord(database, {
        recordId: startRecordId, binding, toolCallId, phase: "invocation", sequence: startSequence, bounded: invocation,
      });
      resolveLifecycleIncidents(database, binding, toolCallId, "invocation");
      incrementStat(database, "orphan_results", 1, `${binding.runId}:${toolCallId}`);
      call = {
        tool_name: syntheticName,
        end_seq: null,
        state: null,
        failure_kind: null,
        detail_code: null,
        duration_ms: null,
      };
    }
    const resultToolName = event.toolName === undefined ? call.tool_name : normalizeId(event.toolName, "toolName");
    if (call.tool_name !== resultToolName) {
      recordIncident(
        database,
        "idempotency_conflicts",
        lifecycleIncidentKey(binding, toolCallId, "result"),
        `${binding.runId}:${toolCallId}:result-tool-name`,
      );
      return { persistence: "failed", errorCode: "history_idempotency_conflict" };
    }
    const existing = database.prepare(`
      SELECT record_id,seq,payload_sha256,truncated,original_bytes,retained_bytes
      FROM tool_records WHERE conversation_id=? AND run_id=? AND tool_call_id=? AND phase='result'
    `).get(binding.conversationId, binding.runId, toolCallId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (Number(call.synthetic_result) === 1) {
        const sequence = Number(existing.seq);
        const now = Date.now();
        database.prepare(`
          UPDATE tool_records
          SET payload_json=?,payload_sha256=?,search_text=?,original_bytes=?,retained_bytes=?,truncated=?
          WHERE record_id=?
        `).run(
          bounded.json,
          bounded.sha256,
          bounded.searchText,
          bounded.originalBytes,
          bounded.retainedBytes,
          bounded.truncated ? 1 : 0,
          recordId,
        );
        database.prepare(`
          UPDATE tool_calls
          SET state=?,failure_kind=?,detail_code=?,ended_at_ms=?,duration_ms=?,recovered=0,synthetic_result=0
          WHERE conversation_id=? AND run_id=? AND tool_call_id=?
        `).run(
          event.state,
          failureKind,
          detailCode,
          now,
          executionMs,
          binding.conversationId,
          binding.runId,
          toolCallId,
        );
        database.prepare("DELETE FROM artifact_refs WHERE conversation_id=? AND run_id=? AND tool_call_id=?")
          .run(binding.conversationId, binding.runId, toolCallId);
        const artifacts = insertArtifacts(database, binding, toolCallId, event.artifacts ?? [], now);
        resolveLifecycleIncidents(database, binding, toolCallId, "result");
        return persistence(recordId, sequence, bounded, artifacts);
      }
      const persistedArtifactIds = artifactRefs(database, binding, toolCallId).map((reference) => reference.id).sort();
      if (
        existing.payload_sha256 !== bounded.sha256
        || call.state !== event.state
        || call.failure_kind !== failureKind
        || call.detail_code !== detailCode
        || call.duration_ms !== executionMs
        || call.tool_name !== resultToolName
        || persistedArtifactIds.join("\u0000") !== artifactIds.join("\u0000")
      ) {
        recordIncident(
          database,
          "idempotency_conflicts",
          lifecycleIncidentKey(binding, toolCallId, "result"),
          `${binding.runId}:${toolCallId}:result`,
        );
        return { persistence: "failed", errorCode: "history_idempotency_conflict" };
      }
      resolveLifecycleIncidents(database, binding, toolCallId, "result");
      return persistenceFromRow(existing, artifactRefs(database, binding, toolCallId));
    }
    const sequence = takeSequence(database, binding);
    const now = Date.now();
    database.prepare(`
      UPDATE tool_calls SET end_seq=?,state=?,failure_kind=?,detail_code=?,ended_at_ms=?,duration_ms=?
      WHERE conversation_id=? AND run_id=? AND tool_call_id=? AND end_seq IS NULL
    `).run(
      sequence,
      event.state,
      failureKind,
      detailCode,
      now,
      executionMs,
      binding.conversationId,
      binding.runId,
      toolCallId,
    );
    insertRecord(database, {
      recordId, binding, toolCallId, phase: "result", sequence, bounded,
    });
    const artifacts = insertArtifacts(database, binding, toolCallId, event.artifacts ?? [], now);
    resolveLifecycleIncidents(database, binding, toolCallId, "result");
    return persistence(recordId, sequence, bounded, artifacts);
  }, () => applyRetention(database, retention));
}

function closeDangling(
  database: DatabaseSync,
  binding: ToolHistoryRunBinding | undefined,
  state: RuntimeToolLifecycleTerminalState,
  failureKind: string,
  detailCode: string,
  recovered: boolean,
): void {
  transaction(database, () => {
    const clauses = ["end_seq IS NULL"];
    const values: string[] = [];
    if (binding !== undefined) {
      clauses.push("conversation_id=?", "run_id=?");
      values.push(binding.conversationId, binding.runId);
    }
    const rows = database.prepare(`
      SELECT conversation_id,run_id,tool_call_id FROM tool_calls WHERE ${clauses.join(" AND ")}
      ORDER BY conversation_id,run_id,start_seq,tool_call_id
    `).all(...values) as Record<string, unknown>[];
    for (const row of rows) {
      const rowBinding = runBinding(database, stringField(row, "conversation_id"), stringField(row, "run_id"));
      const toolCallId = stringField(row, "tool_call_id");
      const bounded = boundedPayload({ state, reason: detailCode }, RESULT_MAX_BYTES);
      const sequence = takeSequence(database, rowBinding);
      const recordId = toolHistoryRecordId(rowBinding.conversationId, rowBinding.runId, toolCallId, "result");
      const now = Date.now();
      insertRecord(database, { recordId, binding: rowBinding, toolCallId, phase: "result", sequence, bounded });
      database.prepare(`
        UPDATE tool_calls SET end_seq=?,state=?,failure_kind=?,detail_code=?,ended_at_ms=?,recovered=?,synthetic_result=1
        WHERE conversation_id=? AND run_id=? AND tool_call_id=? AND end_seq IS NULL
      `).run(sequence, state, failureKind, detailCode, now, recovered ? 1 : 0, rowBinding.conversationId, rowBinding.runId, toolCallId);
      resolveLifecycleIncidents(database, rowBinding, toolCallId, "result");
      if (recovered) incrementStat(database, "recovered_calls", 1, `${rowBinding.runId}:${toolCallId}`);
    }
  });
}

function resetLogicalConversation(database: DatabaseSync, logicalConversationId: string): void {
  const runs = database.prepare(`
    SELECT conversation_id,run_id FROM runs WHERE logical_id=?
    ORDER BY conversation_id,run_id
  `).all(logicalConversationId) as Record<string, unknown>[];
  for (const run of runs) {
    clearRunIncidents(
      database,
      stringField(run, "conversation_id"),
      stringField(run, "run_id"),
    );
  }
  for (const table of ["artifact_refs", "tool_records", "tombstones", "tool_calls"] as const) {
    database.prepare(`
      DELETE FROM ${table}
      WHERE EXISTS (
        SELECT 1 FROM runs
        WHERE runs.logical_id=?
          AND runs.conversation_id=${table}.conversation_id
          AND runs.run_id=${table}.run_id
      )
    `).run(logicalConversationId);
  }
  database.prepare("DELETE FROM runs WHERE logical_id=?").run(logicalConversationId);
}

function ensureRun(database: DatabaseSync, binding: ToolHistoryRunBinding): void {
  database.prepare(`
    INSERT INTO runs (conversation_id,logical_id,run_id,isolated,status,next_seq,started_at_ms)
    VALUES (?,?,?,?, 'running',1,?)
    ON CONFLICT(conversation_id,run_id) DO NOTHING
  `).run(binding.conversationId, binding.logicalConversationId, binding.runId, binding.isolated ? 1 : 0, Date.now());
  const row = database.prepare("SELECT logical_id,isolated FROM runs WHERE conversation_id=? AND run_id=?")
    .get(binding.conversationId, binding.runId) as Record<string, unknown>;
  if (row.logical_id !== binding.logicalConversationId || Number(row.isolated) !== (binding.isolated ? 1 : 0)) {
    throw new RunBindingConflictError(runBindingIncidentKey(binding), `${binding.runId}:binding`);
  }
  clearIncident(database, "idempotency_conflicts", runBindingIncidentKey(binding));
}

function takeSequence(database: DatabaseSync, binding: ToolHistoryRunBinding): number {
  const row = database.prepare("SELECT next_seq FROM runs WHERE conversation_id=? AND run_id=?")
    .get(binding.conversationId, binding.runId) as Record<string, unknown>;
  const sequence = Number(row.next_seq);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Tool history sequence is corrupt.");
  database.prepare("UPDATE runs SET next_seq=? WHERE conversation_id=? AND run_id=?")
    .run(sequence + 1, binding.conversationId, binding.runId);
  return sequence;
}

function insertRecord(database: DatabaseSync, input: {
  readonly recordId: string;
  readonly binding: ToolHistoryRunBinding;
  readonly toolCallId: string;
  readonly phase: "invocation" | "result";
  readonly sequence: number;
  readonly bounded: BoundedPayload;
}): void {
  database.prepare(`
    INSERT INTO tool_records (
      record_id,conversation_id,run_id,tool_call_id,phase,seq,payload_json,payload_sha256,
      search_text,original_bytes,retained_bytes,truncated
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.recordId,
    input.binding.conversationId,
    input.binding.runId,
    input.toolCallId,
    input.phase,
    input.sequence,
    input.bounded.json,
    input.bounded.sha256,
    input.bounded.searchText,
    input.bounded.originalBytes,
    input.bounded.retainedBytes,
    input.bounded.truncated ? 1 : 0,
  );
}

function insertArtifacts(
  database: DatabaseSync,
  binding: ToolHistoryRunBinding,
  toolCallId: string,
  artifacts: readonly { readonly path: string; readonly available?: boolean }[],
  now: number,
): { readonly id: string; readonly available: boolean }[] {
  const out: { id: string; available: boolean }[] = [];
  const seen = new Set<string>();
  for (const artifact of artifacts.slice(0, 32)) {
    if (typeof artifact.path !== "string" || artifact.path.length === 0) continue;
    const hostPath = validatedToolHistoryArtifactPath(
      artifact.path,
      artifactRoot,
      binding.runId,
      artifactRootAliases,
    );
    if (hostPath === undefined) continue;
    const id = `stha1_${createHash("sha256").update(hostPath).digest("base64url")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    database.prepare(`
      INSERT INTO artifact_refs (artifact_id,conversation_id,run_id,tool_call_id,host_path,availability,created_at_ms)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id,run_id,tool_call_id,artifact_id)
      DO UPDATE SET availability=excluded.availability
    `).run(id, binding.conversationId, binding.runId, toolCallId, hostPath, "available", now);
    out.push({ id, available: true });
  }
  return out;
}

function normalizedArtifactIds(
  artifacts: readonly { readonly path: string; readonly available?: boolean }[],
  binding: ToolHistoryRunBinding,
): string[] {
  const ids = new Set<string>();
  for (const artifact of artifacts.slice(0, 32)) {
    if (typeof artifact.path !== "string" || artifact.path.length === 0) continue;
    const hostPath = validatedToolHistoryArtifactPath(
      artifact.path,
      artifactRoot,
      binding.runId,
      artifactRootAliases,
    );
    if (hostPath !== undefined) ids.add(`stha1_${createHash("sha256").update(hostPath).digest("base64url")}`);
  }
  return [...ids].sort();
}

function applyRetention(database: DatabaseSync, limits: Required<ToolHistoryRetentionOptions>): void {
  transaction(database, () => {
    const now = Date.now();
    const ageCutoff = now - limits.maxAgeMs;
    const old = database.prepare(`
      SELECT conversation_id,run_id,tool_call_id FROM tool_calls
      WHERE end_seq IS NOT NULL AND ended_at_ms < ?
      ORDER BY ended_at_ms ASC,conversation_id ASC,run_id ASC,end_seq ASC,tool_call_id ASC
    `).all(ageCutoff) as Record<string, unknown>[];
    pruneCalls(database, old, "age", now);
    const overflow = database.prepare(`
      SELECT conversation_id,run_id,tool_call_id FROM tool_calls
      WHERE end_seq IS NOT NULL
      ORDER BY ended_at_ms DESC,conversation_id DESC,run_id DESC,end_seq DESC,tool_call_id DESC
      LIMIT -1 OFFSET ?
    `).all(limits.maxCompletedCalls) as Record<string, unknown>[];
    pruneCalls(database, overflow, "count", now);
    let retainedBytes = Number((database.prepare("SELECT coalesce(sum(retained_bytes),0) bytes FROM tool_records").get() as Record<string, unknown>).bytes);
    while (retainedBytes > limits.maxBytes) {
      const rows = database.prepare(`
        SELECT conversation_id,run_id,tool_call_id FROM tool_calls
        WHERE end_seq IS NOT NULL
        ORDER BY ended_at_ms ASC,conversation_id ASC,run_id ASC,end_seq ASC,tool_call_id ASC
        LIMIT 100
      `).all() as Record<string, unknown>[];
      if (rows.length === 0) break;
      pruneCalls(database, rows, "bytes", now);
      retainedBytes = Number((database.prepare("SELECT coalesce(sum(retained_bytes),0) bytes FROM tool_records").get() as Record<string, unknown>).bytes);
    }
    database.prepare("DELETE FROM tombstones WHERE removed_at_ms < ?").run(now - limits.tombstoneMaxAgeMs);
    database.prepare(`
      DELETE FROM tombstones WHERE record_id IN (
        SELECT record_id FROM tombstones ORDER BY removed_at_ms DESC,record_id DESC LIMIT -1 OFFSET ?
      )
    `).run(limits.maxTombstones);
    // Retention tombstones keep their run row for logical-session
    // authorization. Once both calls and tombstones are gone, remove the empty
    // run too so metadata cannot grow without the call/age/byte bounds.
    const emptyRuns = database.prepare(`
      SELECT conversation_id,run_id FROM runs
      WHERE NOT EXISTS (
        SELECT 1 FROM tool_calls c
        WHERE c.conversation_id=runs.conversation_id AND c.run_id=runs.run_id
      ) AND NOT EXISTS (
        SELECT 1 FROM tombstones t
        WHERE t.conversation_id=runs.conversation_id AND t.run_id=runs.run_id
      )
      ORDER BY conversation_id,run_id
    `).all() as Record<string, unknown>[];
    for (const run of emptyRuns) {
      const conversationId = stringField(run, "conversation_id");
      const runId = stringField(run, "run_id");
      clearRunIncidents(database, conversationId, runId);
      database.prepare("DELETE FROM runs WHERE conversation_id=? AND run_id=?")
        .run(conversationId, runId);
    }
    clearStat(database, "maintenance_failures");
  });
}

function pruneCalls(database: DatabaseSync, rows: Record<string, unknown>[], reason: string, now: number): void {
  for (const row of rows) {
    const conversationId = stringField(row, "conversation_id");
    const runId = stringField(row, "run_id");
    const toolCallId = stringField(row, "tool_call_id");
    const records = database.prepare(`
      SELECT record_id,phase FROM tool_records WHERE conversation_id=? AND run_id=? AND tool_call_id=?
    `).all(conversationId, runId, toolCallId) as Record<string, unknown>[];
    for (const record of records) {
      database.prepare(`
        INSERT OR IGNORE INTO tombstones (record_id,conversation_id,run_id,tool_call_id,phase,reason,removed_at_ms)
        VALUES (?,?,?,?,?,?,?)
      `).run(stringField(record, "record_id"), conversationId, runId, toolCallId, stringField(record, "phase"), reason, now);
    }
    clearLifecycleIncidents(database, conversationId, runId, toolCallId, "invocation");
    clearLifecycleIncidents(database, conversationId, runId, toolCallId, "result");
    database.prepare("DELETE FROM tool_calls WHERE conversation_id=? AND run_id=? AND tool_call_id=?")
      .run(conversationId, runId, toolCallId);
  }
}

function isCallTombstoned(
  database: DatabaseSync,
  binding: ToolHistoryRunBinding,
  toolCallId: string,
): boolean {
  return database.prepare(`
    SELECT 1 FROM tombstones WHERE conversation_id=? AND run_id=? AND tool_call_id=? LIMIT 1
  `).get(binding.conversationId, binding.runId, toolCallId) !== undefined;
}

function openContentDatabase(
  path: string,
  limits: Required<ToolHistoryRetentionOptions>,
  configuredArtifactRoot: string,
): DatabaseSync {
  assertSecureFile(path);
  const database = new DatabaseSync(path);
  const existingApplication = pragmaNumber(database, "application_id");
  const existingVersion = pragmaNumber(database, "user_version");
  const existingTables = database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as Record<string, unknown>[];
  const pristine = existingApplication === 0 && existingVersion === 0 && existingTables.length === 0;
  const compatible = existingApplication === TOOL_HISTORY_APPLICATION_ID
    && existingVersion >= 0
    && existingVersion <= TOOL_HISTORY_USER_VERSION;
  if (!pristine && !compatible) {
    database.close();
    throw new WorkerHistoryError(
      "history_schema_unsupported",
      "Tool history schema is newer or foreign. Downgrade hard-fails until persisted conversation state is purged.",
    );
  }
  database.exec("PRAGMA journal_mode=DELETE");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA secure_delete=ON");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA busy_timeout=250");
  transaction(database, () => {
    database.exec(`PRAGMA application_id=${String(TOOL_HISTORY_APPLICATION_ID)}`);
    database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      conversation_id TEXT NOT NULL,
      logical_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      isolated INTEGER NOT NULL CHECK(isolated IN (0,1)),
      status TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      terminal_at_ms INTEGER,
      PRIMARY KEY(conversation_id,run_id)
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      start_seq INTEGER NOT NULL,
      end_seq INTEGER,
      state TEXT,
      failure_kind TEXT,
      detail_code TEXT,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      duration_ms INTEGER,
      recovered INTEGER NOT NULL DEFAULT 0 CHECK(recovered IN (0,1)),
      synthetic_start INTEGER NOT NULL DEFAULT 0 CHECK(synthetic_start IN (0,1)),
      synthetic_result INTEGER NOT NULL DEFAULT 0 CHECK(synthetic_result IN (0,1)),
      PRIMARY KEY(conversation_id,run_id,tool_call_id),
      FOREIGN KEY(conversation_id,run_id) REFERENCES runs(conversation_id,run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tool_records (
      record_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('invocation','result')),
      seq INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      search_text TEXT NOT NULL,
      original_bytes INTEGER NOT NULL,
      retained_bytes INTEGER NOT NULL,
      truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
      UNIQUE(conversation_id,run_id,tool_call_id,phase),
      UNIQUE(conversation_id,run_id,seq),
      FOREIGN KEY(conversation_id,run_id,tool_call_id) REFERENCES tool_calls(conversation_id,run_id,tool_call_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS artifact_refs (
      artifact_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      host_path TEXT NOT NULL,
      availability TEXT NOT NULL CHECK(availability IN ('available','unavailable')),
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(conversation_id,run_id,tool_call_id,artifact_id),
      FOREIGN KEY(conversation_id,run_id,tool_call_id) REFERENCES tool_calls(conversation_id,run_id,tool_call_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      record_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      reason TEXT NOT NULL,
      removed_at_ms INTEGER NOT NULL,
      FOREIGN KEY(conversation_id,run_id) REFERENCES runs(conversation_id,run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS writer_stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL,
      last_detail TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_calls_sequence_idx ON tool_calls(conversation_id,run_id,start_seq,end_seq);
    CREATE INDEX IF NOT EXISTS tool_calls_terminal_idx ON tool_calls(ended_at_ms,state,tool_name);
    CREATE INDEX IF NOT EXISTS runs_logical_idx ON runs(logical_id,isolated,started_at_ms);
    CREATE INDEX IF NOT EXISTS records_call_idx ON tool_records(conversation_id,run_id,tool_call_id,phase);
    CREATE INDEX IF NOT EXISTS tombstones_run_idx ON tombstones(conversation_id,run_id);
    CREATE INDEX IF NOT EXISTS tombstones_removed_idx ON tombstones(removed_at_ms);
    `);
    sanitizePersistedWriterStatDetails(database);
    migrateSyntheticResultMarker(database, existingVersion);
    migrateLegacyIncidentKeys(database);
    database.exec(`PRAGMA user_version=${String(TOOL_HISTORY_USER_VERSION)}`);
    const metadata = database.prepare("INSERT OR REPLACE INTO metadata (key,value) VALUES (?,?)");
    const existingArtifactRoot = database.prepare("SELECT value FROM metadata WHERE key='artifact_root'").get() as Record<string, unknown> | undefined;
    if (existingArtifactRoot !== undefined && existingArtifactRoot.value !== configuredArtifactRoot) {
      throw new WorkerHistoryError(
        "history_artifact_root_mismatch",
        "Tool history artifact root changed for an existing canonical store.",
      );
    }
    metadata.run("schema", TOOL_HISTORY_SCHEMA);
    metadata.run("artifact_root", configuredArtifactRoot);
    metadata.run("limit_max_completed_calls", String(limits.maxCompletedCalls));
    metadata.run("limit_max_age_ms", String(limits.maxAgeMs));
    metadata.run("limit_max_bytes", String(limits.maxBytes));
    metadata.run("limit_max_tombstones", String(limits.maxTombstones));
    metadata.run("limit_tombstone_max_age_ms", String(limits.tombstoneMaxAgeMs));
  });
  const integrity = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
  if (String(Object.values(integrity)[0]) !== "ok") {
    database.close();
    throw new WorkerHistoryError("history_integrity_failed", "Tool history database failed integrity_check.");
  }
  assertSecureFile(path);
  assertToolDirectoryEntries();
  return database;
}

function migrateSyntheticResultMarker(database: DatabaseSync, priorVersion: number): void {
  const columns = database.prepare("PRAGMA table_info(tool_calls)").all() as Record<string, unknown>[];
  if (!columns.some((column) => column.name === "synthetic_result")) {
    database.exec(`
      ALTER TABLE tool_calls
      ADD COLUMN synthetic_result INTEGER NOT NULL DEFAULT 0 CHECK(synthetic_result IN (0,1))
    `);
  }
  if (priorVersion >= 2) return;

  // The reviewed v1 writer durably emitted this exact terminal payload before
  // it had an explicit marker. Recognize only that byte-identical host shape so
  // existing sidecars recover without reclassifying ordinary provider results.
  const candidates = database.prepare(`
    SELECT c.conversation_id,c.run_id,c.tool_call_id,c.state,c.detail_code,
           tr.record_id,tr.payload_sha256
    FROM tool_calls c
    JOIN tool_records tr
      ON tr.conversation_id=c.conversation_id
     AND tr.run_id=c.run_id
     AND tr.tool_call_id=c.tool_call_id
     AND tr.phase='result'
    WHERE c.synthetic_result=0
      AND c.duration_ms IS NULL
      AND c.detail_code IS NOT NULL
      AND (c.detail_code IN ('recovered_after_writer_restart','writer_shutdown') OR c.detail_code GLOB 'run_*')
      AND NOT EXISTS (
        SELECT 1 FROM artifact_refs a
        WHERE a.conversation_id=c.conversation_id AND a.run_id=c.run_id AND a.tool_call_id=c.tool_call_id
      )
  `).all() as Record<string, unknown>[];
  for (const candidate of candidates) {
    const state = stringField(candidate, "state");
    const detailCode = stringField(candidate, "detail_code");
    const expected = boundedPayload({ state, reason: detailCode }, RESULT_MAX_BYTES);
    if (candidate.payload_sha256 !== expected.sha256) continue;
    database.prepare(`
      UPDATE tool_calls SET synthetic_result=1
      WHERE conversation_id=? AND run_id=? AND tool_call_id=?
    `).run(
      stringField(candidate, "conversation_id"),
      stringField(candidate, "run_id"),
      stringField(candidate, "tool_call_id"),
    );
    const candidateBinding = runBinding(
      database,
      stringField(candidate, "conversation_id"),
      stringField(candidate, "run_id"),
    );
    resolveLifecycleIncidents(
      database,
      candidateBinding,
      stringField(candidate, "tool_call_id"),
      "result",
    );
  }
}

function sanitizePersistedWriterStatDetails(database: DatabaseSync): void {
  const policy = database.prepare("SELECT value FROM metadata WHERE key='writer_stat_detail_policy'")
    .get() as Record<string, unknown> | undefined;
  if (policy?.value === WRITER_STAT_DETAIL_POLICY_VERSION) return;

  const select = database.prepare(`
    SELECT key,last_detail FROM writer_stats
    WHERE last_detail IS NOT NULL AND key > ?
    ORDER BY key LIMIT 256
  `);
  const update = database.prepare("UPDATE writer_stats SET last_detail=? WHERE key=?");
  let afterKey = "";
  for (;;) {
    const rows = select.all(afterKey) as Record<string, unknown>[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const key = stringField(row, "key");
      const detail = typeof row.last_detail === "string" ? writerStatDetail(row.last_detail) : null;
      if (detail !== row.last_detail) update.run(detail, key);
      afterKey = key;
    }
  }
  database.prepare("INSERT OR REPLACE INTO metadata (key,value) VALUES ('writer_stat_detail_policy',?)")
    .run(WRITER_STAT_DETAIL_POLICY_VERSION);
}

function migrateLegacyIncidentKeys(database: DatabaseSync): void {
  const legacy = database.prepare(`
    SELECT key,value,last_detail,updated_at_ms FROM writer_stats
    WHERE key GLOB 'write_failures:sth1_*'
       OR key GLOB 'idempotency_conflicts:sth1_*'
    ORDER BY key
  `).all() as Record<string, unknown>[];
  const migrate = database.prepare(`
    INSERT OR IGNORE INTO writer_stats (key,value,last_detail,updated_at_ms) VALUES (?,?,?,?)
  `);
  const remove = database.prepare("DELETE FROM writer_stats WHERE key=?");
  for (const incident of legacy) {
    const key = stringField(incident, "key");
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator) as "write_failures" | "idempotency_conflicts";
    const recordId = key.slice(separator + 1);
    const record = database.prepare(`
      SELECT conversation_id,run_id,tool_call_id,phase FROM tool_records WHERE record_id=?
    `).get(recordId) as Record<string, unknown> | undefined;
    if (record !== undefined) {
      const phase = stringField(record, "phase");
      if (phase === "invocation" || phase === "result") {
        const scopedKey = `${kind}:${lifecycleIncidentKey(
          {
            conversationId: stringField(record, "conversation_id"),
            runId: stringField(record, "run_id"),
          },
          stringField(record, "tool_call_id"),
          phase,
        )}`;
        migrate.run(
          scopedKey,
          Number(incident.value),
          typeof incident.last_detail === "string" ? writerStatDetail(incident.last_detail) : null,
          Number(incident.updated_at_ms),
        );
      }
    }
    // A pre-scope incident without a surviving canonical record has no
    // attributable conversation/run identity and can never be authorized for
    // retry or reset. Drop that obsolete diagnostic instead of leaving a
    // permanent, globally unremovable failure marker.
    remove.run(key);
  }
}

async function acquireOwner(path: string, ceilingMs: number): Promise<{ release(): void }> {
  const deadline = performance.now() + ceilingMs;
  let attempt = 0;
  let lastOwner = "unknown";
  for (;;) {
    let database: DatabaseSync | undefined;
    try {
      assertSecureFile(path);
      database = new DatabaseSync(path);
      database.exec("PRAGMA journal_mode=MEMORY");
      database.exec("PRAGMA busy_timeout=0");
      database.exec("CREATE TABLE IF NOT EXISTS writer_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL, acquired_at_ms INTEGER NOT NULL)");
      try {
        const prior = database.prepare("SELECT pid,token FROM writer_owner WHERE singleton=1").get() as Record<string, unknown> | undefined;
        if (prior !== undefined) {
          const pid = Number(prior.pid);
          lastOwner = `${String(pid)}:${isProcessAlive(pid) ? "live" : "dead"}`;
        }
      } catch { /* ownership detail is diagnostic only */ }
      database.exec("BEGIN IMMEDIATE");
      const token = randomBytes(24).toString("hex");
      database.prepare("INSERT OR REPLACE INTO writer_owner (singleton,pid,token,acquired_at_ms) VALUES (1,?,?,?)")
        .run(process.pid, token, Date.now());
      database.exec("COMMIT");
      // Token interposition fence: the committed row is not ownership until the
      // same claimant immediately retakes the kernel lock and verifies it.
      database.exec("BEGIN IMMEDIATE");
      const committed = database.prepare("SELECT pid,token FROM writer_owner WHERE singleton=1").get() as Record<string, unknown>;
      if (Number(committed.pid) !== process.pid || committed.token !== token) {
        database.exec("ROLLBACK");
        database.close();
        database = undefined;
        throw new WorkerHistoryError("history_owner_interposed", "Another writer interposed during ownership acquisition.");
      }
      assertSecureFile(path);
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try {
            database?.prepare("DELETE FROM writer_owner WHERE singleton=1 AND token=?").run(token);
            database?.exec("COMMIT");
          } catch {
            try { database?.exec("ROLLBACK"); } catch { /* close releases the kernel lock */ }
          }
          try { database?.close(); } catch { /* no reuse */ }
          database = undefined;
        },
      };
    } catch (error) {
      try { database?.close(); } catch { /* retry */ }
      if (!isBusy(error) && !(error instanceof WorkerHistoryError && error.code === "history_owner_interposed")) throw error;
      if (performance.now() >= deadline) {
        throw new WorkerHistoryError(
          "history_writer_in_use",
          `Tool history writer remained owned beyond ${String(ceilingMs / 1_000)} seconds (recorded owner ${lastOwner}).`,
        );
      }
      attempt += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(250, 50 * attempt)));
    }
  }
}

interface BoundedPayload {
  readonly json: string;
  readonly sha256: string;
  readonly searchText: string;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
}

function boundedPayload(value: unknown, maxBytes: number): BoundedPayload {
  // Redaction must run over bounded work. Complete small values are retained so
  // key-aware and content-aware redaction sees their original structure. Any
  // value that cannot fit is replaced wholesale before redaction; retaining a
  // raw prefix could split a credential and leak the unmatched fragment.
  const preprocessed = securelyPreprocessPayload(value);
  // Never stringify the caller-owned graph. For a wholly admitted payload this
  // is the exact pre-redaction JSON size; once preprocessing omits anything the
  // count deliberately saturates above both persistence limits instead of
  // doing unbounded serialization merely to produce diagnostics metadata.
  const preprocessedJsonBytes = Buffer.byteLength(safeJson(preprocessed.value), "utf8");
  const originalBytes = preprocessed.truncated
    ? Math.max(preprocessedJsonBytes, PRE_REDACTION_MAX_STRING_BYTES + 1)
    : preprocessedJsonBytes;
  const redacted = redactJsonValue(preprocessed.value, STRING_MAX_BYTES, {
    contentPatternRedaction: true,
    visibleTextSanitization: {
      omitFilesystemPaths: true,
      omission: "[tool payload omitted because it contained a private host path]",
    },
  });
  const full = safeJson(redacted);
  let json = full;
  let truncated = preprocessed.truncated || originalBytes > maxBytes
    || /\[(?:max-(?:nodes|items|keys|depth)|circular)\]|…\[truncated \d+ bytes\]/u.test(full);
  if (Buffer.byteLength(full, "utf8") > maxBytes) {
    truncated = true;
    let preview = utf8Prefix(full, Math.max(1, maxBytes - 128));
    json = JSON.stringify({ preview, truncated: true, originalBytes });
    while (Buffer.byteLength(json, "utf8") > maxBytes && preview.length > 0) {
      preview = utf8Prefix(preview, Math.max(0, Buffer.byteLength(preview, "utf8") - 128));
      json = JSON.stringify({ preview, truncated: true, originalBytes });
    }
  }
  const retainedBytes = Buffer.byteLength(json, "utf8");
  return {
    json,
    sha256: createHash("sha256").update(json).digest("hex"),
    searchText: utf8Prefix(json.toLowerCase(), SEARCH_TEXT_MAX_BYTES),
    originalBytes,
    retainedBytes,
    truncated,
  };
}

interface SecurePreprocessBudget {
  remainingNodes: number;
  remainingStringBytes: number;
  truncated: boolean;
  readonly seen: WeakSet<object>;
}

function securelyPreprocessPayload(value: unknown): { readonly value: unknown; readonly truncated: boolean } {
  const budget: SecurePreprocessBudget = {
    remainingNodes: PRE_REDACTION_MAX_NODES,
    remainingStringBytes: PRE_REDACTION_MAX_STRING_BYTES,
    truncated: false,
    seen: new WeakSet<object>(),
  };
  const bounded = securePayloadValue(value, budget, 0);
  return { value: bounded, truncated: budget.truncated };
}

function securePayloadValue(value: unknown, budget: SecurePreprocessBudget, depth: number): unknown {
  if (budget.remainingNodes <= 0 || depth >= 24) {
    budget.truncated = true;
    return PRE_REDACTION_OMISSION;
  }
  budget.remainingNodes -= 1;
  if (typeof value === "string") return securePayloadString(value, budget);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return securePayloadString(value.toString(), budget);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (typeof value !== "object") return "[unserializable]";
  if (budget.seen.has(value)) {
    budget.truncated = true;
    return "[circular]";
  }
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const retained: unknown[] = [];
      const limit = Math.min(value.length, PRE_REDACTION_MAX_COLLECTION_ITEMS);
      for (let index = 0; index < limit && budget.remainingNodes > 0; index += 1) {
        retained.push(securePayloadValue(value[index], budget, depth + 1));
      }
      if (limit < value.length || budget.remainingNodes <= 0) {
        budget.truncated = true;
        retained.push(PRE_REDACTION_OMISSION);
      }
      return retained;
    }
    const retained: Record<string, unknown> = {};
    let retainedItems = 0;
    const source = value as Record<string, unknown>;
    for (const rawKey in source) {
      if (!Object.prototype.hasOwnProperty.call(source, rawKey)) continue;
      if (retainedItems >= PRE_REDACTION_MAX_COLLECTION_ITEMS || budget.remainingNodes <= 0) {
        budget.truncated = true;
        defineSecurePayloadProperty(retained, "__preprocessing_omitted__", PRE_REDACTION_OMISSION);
        break;
      }
      // UTF-8 bytes are never fewer than JavaScript code units. Reject an
      // obviously oversized key before asking Buffer to inspect all of it.
      const keyBytes = rawKey.length > PRE_REDACTION_MAX_KEY_BYTES
        || rawKey.length > budget.remainingStringBytes
        ? undefined
        : Buffer.byteLength(rawKey, "utf8");
      const key = keyBytes === undefined
        || keyBytes > PRE_REDACTION_MAX_KEY_BYTES
        || keyBytes > budget.remainingStringBytes
        ? `__oversized_key_${String(retainedItems)}__`
        : rawKey;
      if (key !== rawKey) budget.truncated = true;
      else budget.remainingStringBytes -= keyBytes!;
      defineSecurePayloadProperty(
        retained,
        key,
        securePayloadValue(source[rawKey], budget, depth + 1),
      );
      retainedItems += 1;
    }
    return retained;
  } finally {
    budget.seen.delete(value);
  }
}

function defineSecurePayloadProperty(
  target: Record<string, unknown>,
  requestedKey: string,
  value: unknown,
): void {
  let key = requestedKey;
  for (let ordinal = 2; Object.prototype.hasOwnProperty.call(target, key); ordinal += 1) {
    key = `${requestedKey} [key-${String(ordinal)}]`;
    if (ordinal > PRE_REDACTION_MAX_COLLECTION_ITEMS + 1) {
      throw new WorkerHistoryError("history_payload_invalid", "Tool history payload keys could not be bounded safely.");
    }
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function securePayloadString(value: string, budget: SecurePreprocessBudget): string {
  // This O(1) code-unit guard prevents TextEncoder/Buffer from traversing a
  // multi-MiB string that is already known not to fit the byte budget.
  if (value.length > budget.remainingStringBytes) {
    budget.truncated = true;
    return PRE_REDACTION_OMISSION;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > budget.remainingStringBytes) {
    budget.truncated = true;
    return PRE_REDACTION_OMISSION;
  }
  budget.remainingStringBytes -= bytes;
  return value;
}

function persistence(
  recordId: string,
  sequence: number,
  bounded: BoundedPayload,
  artifacts: readonly { readonly id: string; readonly available: boolean }[] = [],
): RuntimeToolLifecyclePersistence {
  return {
    recordId,
    sequence,
    persistence: "persisted",
    truncated: bounded.truncated,
    originalBytes: bounded.originalBytes,
    retainedBytes: bounded.retainedBytes,
    ...(artifacts.length === 0 ? {} : { artifactReferences: artifacts }),
  };
}

function persistenceFromRow(
  row: Record<string, unknown>,
  artifacts: readonly { readonly id: string; readonly available: boolean }[] = [],
): RuntimeToolLifecyclePersistence {
  return {
    recordId: stringField(row, "record_id"),
    sequence: Number(row.seq),
    persistence: "persisted",
    truncated: Number(row.truncated) === 1,
    originalBytes: Number(row.original_bytes),
    retainedBytes: Number(row.retained_bytes),
    ...(artifacts.length === 0 ? {} : { artifactReferences: artifacts }),
  };
}

function artifactRefs(database: DatabaseSync, binding: ToolHistoryRunBinding, toolCallId: string): { id: string; available: boolean }[] {
  const rows = database.prepare(`SELECT artifact_id,host_path FROM artifact_refs WHERE conversation_id=? AND run_id=? AND tool_call_id=? ORDER BY artifact_id`)
    .all(binding.conversationId, binding.runId, toolCallId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: stringField(row, "artifact_id"),
    available: toolHistoryArtifactAvailable(
      stringField(row, "host_path"),
      artifactRoot,
      binding.runId,
    ),
  }));
}

function transaction<T>(database: DatabaseSync, operation: () => T, afterCommit?: () => void): T {
  const preparedJournalCreated = prepareSecureJournal();
  try {
    database.exec("BEGIN IMMEDIATE");
    const value = operation();
    database.exec("COMMIT");
    try { afterCommit?.(); } catch (error) { incrementStat(database, "maintenance_failures", 1, reasonOf(error)); }
    removeEmptyPreparedJournal();
    return value;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* close/recovery remains authoritative */ }
    if (preparedJournalCreated) removeEmptyPreparedJournal();
    throw error;
  }
}

function lifecycleTransaction<T>(database: DatabaseSync, operation: () => T, afterCommit?: () => void): T {
  try {
    return transaction(database, operation, afterCommit);
  } catch (error) {
    if (error instanceof RunBindingConflictError) {
      try {
        transaction(database, () => {
          recordIncident(database, "idempotency_conflicts", error.incidentKey, error.detail);
        });
      } catch {
        // The binding conflict remains the authoritative failure when the
        // database cannot persist its own diagnostic.
      }
    }
    throw error;
  }
}

function recordWriteFailure(database: DatabaseSync, payload: unknown): void {
  const value = recordOf(payload);
  const binding = bindingOf(value.binding);
  const phase = value.phase;
  const detail = `${boundedCode(typeof value.code === "string" ? value.code : "history_write_failed")}:${reasonOf(value.message)}`;
  transaction(database, () => {
    if (phase === "invocation" || phase === "result") {
      const toolCallId = normalizeId(value.toolCallId, "toolCallId");
      const recordId = toolHistoryRecordId(binding.conversationId, binding.runId, toolCallId, phase);
      const persisted = database.prepare("SELECT 1 FROM tool_records WHERE record_id=?").get(recordId);
      if (persisted === undefined) {
        recordIncident(database, "write_failures", lifecycleIncidentKey(binding, toolCallId, phase), detail);
      } else {
        resolveLifecycleIncidents(database, binding, toolCallId, phase);
      }
      return;
    }
    if (phase === "finish_run") {
      const status = typeof value.status === "string" ? value.status : "interrupted";
      const incidentKey = finishRunIncidentKey(binding);
      const row = database.prepare(`
        SELECT status,terminal_at_ms FROM runs WHERE conversation_id=? AND run_id=?
      `).get(binding.conversationId, binding.runId) as Record<string, unknown> | undefined;
      if (row?.status === status && row.terminal_at_ms !== null && row.terminal_at_ms !== undefined) {
        clearIncident(database, "write_failures", incidentKey);
      } else {
        recordIncident(database, "write_failures", incidentKey, detail);
      }
      return;
    }
    throw new WorkerHistoryError("history_phase_invalid", "Unsupported tool history write-failure phase.");
  });
}

function runBindingIncidentKey(binding: Pick<ToolHistoryRunBinding, "conversationId" | "runId">): string {
  return hashedIncidentKey("run_binding", [binding.conversationId, binding.runId]);
}

function finishRunIncidentKey(binding: Pick<ToolHistoryRunBinding, "conversationId" | "runId">): string {
  return hashedIncidentKey("finish_run", [binding.conversationId, binding.runId]);
}

function hashedIncidentKey(kind: string, identity: readonly string[]): string {
  return `${kind}_${createHash("sha256").update(JSON.stringify(identity)).digest("base64url")}`;
}

function prepareSecureJournal(): boolean {
  // SQLite creates the DELETE journal at the first write inside a transaction.
  // Materialize it with its final mode before BEGIN so doctor and a concurrent
  // owner acquisition can never observe SQLite's process-default creation mode.
  const created = !existsSync(journalPath);
  const descriptor = openSync(
    journalPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  assertSecureFile(journalPath);
  return created;
}

function removeEmptyPreparedJournal(): void {
  if (!existsSync(journalPath)) return;
  try {
    const info = lstatSync(journalPath);
    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === 0) {
      unlinkSync(journalPath);
    }
  } catch {
    // A surviving journal remains visible to the next writer and doctor, which
    // fail closed unless a live owner can account for it.
  }
}

function incrementStat(database: DatabaseSync, key: string, amount: number, detail?: string): void {
  database.prepare(`
    INSERT INTO writer_stats (key,value,last_detail,updated_at_ms) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=value+excluded.value,last_detail=excluded.last_detail,updated_at_ms=excluded.updated_at_ms
  `).run(key, amount, writerStatDetail(detail, key), Date.now());
}

function recordIncident(
  database: DatabaseSync,
  kind: "write_failures" | "idempotency_conflicts",
  incidentKey: string,
  detail?: string,
): void {
  database.prepare(`
    INSERT INTO writer_stats (key,value,last_detail,updated_at_ms) VALUES (?,1,?,?)
    ON CONFLICT(key) DO UPDATE SET value=1,last_detail=excluded.last_detail,updated_at_ms=excluded.updated_at_ms
  `).run(`${kind}:${incidentKey}`, writerStatDetail(detail, kind), Date.now());
}

function writerStatDetail(detail: string | undefined, fallbackClass = "writer_detail"): string | null {
  if (detail === undefined) return null;
  if (detail.length > WRITER_STAT_DETAIL_MAX_INSPECTION_CODE_UNITS) {
    const detailClass = /^([a-z][a-z0-9_-]{0,63}):/iu.exec(detail)?.[1] ?? fallbackClass;
    return `${detailClass}: ${WRITER_STAT_DETAIL_OVERSIZED_OMISSION}`;
  }
  return sanitizeVisibleText(detail, {
    omitFilesystemPaths: true,
    omission: WRITER_STAT_DETAIL_OMISSION,
    maxBytes: WRITER_STAT_DETAIL_MAX_BYTES,
  });
}

function clearIncident(
  database: DatabaseSync,
  kind: "write_failures" | "idempotency_conflicts",
  incidentKey: string,
): void {
  database.prepare("DELETE FROM writer_stats WHERE key=?").run(`${kind}:${incidentKey}`);
}

function clearStat(database: DatabaseSync, key: string): void {
  database.prepare("DELETE FROM writer_stats WHERE key=?").run(key);
}

function lifecycleIncidentKey(
  binding: Pick<ToolHistoryRunBinding, "conversationId" | "runId">,
  toolCallId: string,
  phase: "invocation" | "result",
): string {
  return `${runIncidentScope(binding.conversationId, binding.runId)}:${toolHistoryRecordId(
    binding.conversationId,
    binding.runId,
    toolCallId,
    phase,
  )}`;
}

function runIncidentScope(conversationId: string, runId: string): string {
  return hashedIncidentKey("run_scope", [conversationId, runId]);
}

function clearLifecycleIncidents(
  database: DatabaseSync,
  conversationId: string,
  runId: string,
  toolCallId: string,
  phase: "invocation" | "result",
): void {
  const binding = { conversationId, runId };
  const legacyRecordId = toolHistoryRecordId(conversationId, runId, toolCallId, phase);
  for (const kind of ["write_failures", "idempotency_conflicts"] as const) {
    clearIncident(database, kind, lifecycleIncidentKey(binding, toolCallId, phase));
    // v2 stores created before incident scoping used the opaque record id alone.
    clearIncident(database, kind, legacyRecordId);
  }
}

function resolveLifecycleIncidents(
  database: DatabaseSync,
  binding: ToolHistoryRunBinding,
  toolCallId: string,
  phase: "invocation" | "result",
): void {
  clearLifecycleIncidents(database, binding.conversationId, binding.runId, toolCallId, phase);
}

function clearRunIncidents(database: DatabaseSync, conversationId: string, runId: string): void {
  const calls = database.prepare(`
    SELECT tool_call_id FROM tool_calls WHERE conversation_id=? AND run_id=?
    UNION
    SELECT tool_call_id FROM tombstones WHERE conversation_id=? AND run_id=?
    ORDER BY tool_call_id
  `).all(conversationId, runId, conversationId, runId) as Record<string, unknown>[];
  for (const call of calls) {
    const toolCallId = stringField(call, "tool_call_id");
    clearLifecycleIncidents(database, conversationId, runId, toolCallId, "invocation");
    clearLifecycleIncidents(database, conversationId, runId, toolCallId, "result");
  }
  const scope = runIncidentScope(conversationId, runId);
  database.prepare(`
    DELETE FROM writer_stats
    WHERE key GLOB ? OR key GLOB ?
  `).run(`write_failures:${scope}:*`, `idempotency_conflicts:${scope}:*`);
  clearIncident(database, "idempotency_conflicts", runBindingIncidentKey({ conversationId, runId }));
  clearIncident(database, "write_failures", finishRunIncidentKey({ conversationId, runId }));
}

function statValue(database: DatabaseSync, key: string): number {
  const row = database.prepare("SELECT value FROM writer_stats WHERE key=?").get(key) as Record<string, unknown> | undefined;
  return Number(row?.value ?? 0);
}

function incidentStatValue(database: DatabaseSync, kind: "write_failures" | "idempotency_conflicts"): number {
  const row = database.prepare("SELECT coalesce(sum(value),0) value FROM writer_stats WHERE key=? OR key GLOB ?")
    .get(kind, `${kind}:*`) as Record<string, unknown>;
  return Number(row.value ?? 0);
}

function workerStats(database: DatabaseSync): Record<string, unknown> {
  const counts = database.prepare(`
    SELECT
      (SELECT count(*) FROM tool_calls) calls,
      (SELECT count(*) FROM tool_records) records,
      (SELECT count(*) FROM tombstones) tombstones,
      (SELECT count(*) FROM tool_calls WHERE end_seq IS NULL) dangling,
      (SELECT count(*) FROM tool_calls WHERE synthetic_start=1) orphanResults,
      (SELECT count(*) FROM tool_calls WHERE recovered=1) recovered,
      (SELECT coalesce(sum(retained_bytes),0) FROM tool_records) retainedBytes
  `).get() as Record<string, unknown>;
  return {
    ...counts,
    writeFailures: incidentStatValue(database, "write_failures"),
    idempotencyConflicts: incidentStatValue(database, "idempotency_conflicts"),
    maintenanceFailures: statValue(database, "maintenance_failures"),
    recoveryFailures: statValue(database, "recovery_failures"),
    bytes: pragmaNumber(database, "page_count") * pragmaNumber(database, "page_size"),
    journalPresent: existsSync(journalPath),
    limits: retention,
  };
}

function runBinding(database: DatabaseSync, conversationId: string, runId: string): ToolHistoryRunBinding {
  const row = database.prepare("SELECT logical_id,isolated FROM runs WHERE conversation_id=? AND run_id=?")
    .get(conversationId, runId) as Record<string, unknown>;
  return {
    conversationId,
    logicalConversationId: stringField(row, "logical_id"),
    runId,
    isolated: Number(row.isolated) === 1,
  };
}

function bindingOf(value: unknown): ToolHistoryRunBinding {
  const record = recordOf(value);
  return {
    conversationId: normalizeId(record.conversationId, "conversationId"),
    logicalConversationId: normalizeId(record.logicalConversationId, "logicalConversationId"),
    runId: normalizeId(record.runId, "runId"),
    isolated: record.isolated === true,
  };
}

function lifecyclePayload(value: unknown): LifecyclePayload {
  const record = recordOf(value);
  const event = record.event;
  if (typeof event !== "object" || event === null || Array.isArray(event)) throw new TypeError("lifecycle event must be an object.");
  return { binding: bindingOf(record.binding), event: event as RuntimeToolLifecycleEvent };
}

function normalizeFailureKind(state: RuntimeToolLifecycleTerminalState, value: string | undefined): string | null {
  if (isKnownArtifactFailureKind(value)) return value;
  switch (state) {
    case "success": return null;
    case "signal": return "process_death";
    case "cancelled": return "cancelled";
    case "interrupted": return "process_death";
    default: return "runtime_error";
  }
}

function terminalStateForRunStatus(status: string): RuntimeToolLifecycleTerminalState {
  if (status.includes("cancel")) return "cancelled";
  if (status.includes("fail") || status.includes("error")) return "error";
  return "interrupted";
}

function normalizeRetention(value: ToolHistoryRetentionOptions | undefined): Required<ToolHistoryRetentionOptions> {
  return {
    maxCompletedCalls: nonNegativeInteger(value?.maxCompletedCalls ?? DEFAULT_RETENTION.maxCompletedCalls),
    maxAgeMs: nonNegativeInteger(value?.maxAgeMs ?? DEFAULT_RETENTION.maxAgeMs),
    maxBytes: nonNegativeInteger(value?.maxBytes ?? DEFAULT_RETENTION.maxBytes),
    maxTombstones: nonNegativeInteger(value?.maxTombstones ?? DEFAULT_RETENTION.maxTombstones),
    tombstoneMaxAgeMs: nonNegativeInteger(value?.tombstoneMaxAgeMs ?? DEFAULT_RETENTION.tombstoneMaxAgeMs),
  };
}

function ensureSecureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  else {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Tool history root ${path} must be a non-symlink directory.`);
    assertOwner(info.uid, path);
  }
  chmodSync(path, 0o700);
  assertSecureDirectory(path);
}

function secureDirectoryPath(path: string): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const info = lstatSync(current);
    if (info.isSymbolicLink()) {
      const uid = process.getuid?.();
      if (uid === undefined || info.uid !== 0 || uid === 0) throw new Error(`Tool history path ${current} must not be a user-controlled symlink.`);
      continue;
    }
    if (!info.isDirectory()) throw new Error(`Tool history path ${current} must be a directory.`);
  }
  chmodSync(absolute, 0o700);
  assertSecureDirectory(absolute);
}

function ensureSecureFile(path: string): void {
  if (!existsSync(path)) {
    const descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try { fchmodSync(descriptor, 0o600); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } else {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Tool history path ${path} must be a non-symlink regular file.`);
    assertOwner(info.uid, path);
    if (info.nlink !== 1) throw new Error(`Tool history file ${path} must have exactly one hard link.`);
  }
  chmodSync(path, 0o600);
  assertSecureFile(path);
}

function assertSecureDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Tool history root ${path} must be a non-symlink directory.`);
  assertOwner(info.uid, path);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) throw new Error(`Tool history root ${path} must have owner-only mode 0700.`);
}

function assertSecureFile(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Tool history path ${path} must be a non-symlink regular file.`);
  assertOwner(info.uid, path);
  if (info.nlink !== 1) throw new Error(`Tool history file ${path} must have exactly one hard link.`);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) throw new Error(`Tool history file ${path} must have owner-only mode 0600.`);
}

function assertOwner(uid: number, path: string): void {
  const current = process.getuid?.();
  if (current !== undefined && uid !== current) throw new Error(`Tool history path ${path} must be owned by the current user.`);
}

function assertToolDirectoryEntries(): void {
  assertSecureDirectory(toolDirectory);
  for (const name of readdirSync(toolDirectory)) {
    if (!TOOL_DIR_ALLOWED.has(name)) {
      throw new WorkerHistoryError("history_entry_unsupported", `Tool history directory contains unsupported entry ${name}.`);
    }
    const path = join(toolDirectory, name);
    if (name.endsWith("-wal") || name.endsWith("-shm")) {
      throw new WorkerHistoryError("history_journal_unsupported", `Tool history must not contain ${name}.`);
    }
    assertSecureFile(path);
  }
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Number(Object.values(row)[0]);
}

function respond(id: number, value: unknown): void {
  parentPort?.postMessage({ id, ok: true, value });
}

function respondError(id: number, code: string, error: string): void {
  parentPort?.postMessage({ id, ok: false, code, error });
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? JSON.stringify("[unserializable]"); }
  catch { return JSON.stringify("[unserializable]"); }
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function normalizeId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 4 * 1024
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty control-free string no larger than 4096 bytes.`);
  }
  return value.trim();
}

function boundedCode(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/gu, "_").slice(0, 160) || "unknown";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Tool history row is missing ${key}.`);
  return value;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Tool history payload must be an object.");
  return value as Record<string, unknown>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Tool history retention limits must be non-negative integers.");
  return value;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ERR_SQLITE_ERROR" && /busy|locked/u.test(reasonOf(error).toLocaleLowerCase());
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
