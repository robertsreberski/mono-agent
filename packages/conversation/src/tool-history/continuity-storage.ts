import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sanitizeVisibleText } from "@mono-agent/observability";
import type { ToolHistoryRetentionOptions } from "./contracts.js";
import {
  CONTINUITY_GENERATION_MAX_BYTES, CONTINUITY_GENERATION_MAX_RECORDS,
  type ContinuityPin, type ContinuityPreparation, type ContinuityPublication,
  type ContinuityReceipt, type ContinuityReconciliation, type ContinuityReconciliationResult,
  type ContinuityRecordInput, type ContinuityStats,
} from "./continuity-contracts.js";
import { retainContinuityText } from "./continuity-payload.js";
import { ToolHistoryWriterError } from "./errors.js";
import { normalizeId } from "./paths.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const RECORD_ID = /^chr1_[A-Za-z0-9_-]{43}$/u;
const GENERATION_ID = /^chg1_[a-f0-9]{32}$/u;

export function continuityRecordId(conversationId: string, sourceId: string): string {
  return `chr1_${createHash("sha256").update(JSON.stringify([conversationId, sourceId])).digest("base64url")}`;
}
export function continuityGenerationId(): string {
  return `chg1_${randomBytes(16).toString("hex")}`;
}

/** All mutating functions in this module run inside the sidecar worker's FULL transaction. */
export function createContinuitySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS continuity_generations (
      generation_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      logical_id TEXT NOT NULL,
      before_digest TEXT,
      after_digest TEXT NOT NULL,
      preparation_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','committed')),
      latest_summary_record_id TEXT,
      created_at_ms INTEGER NOT NULL,
      committed_at_ms INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS continuity_prepared_owner_idx
      ON continuity_generations(conversation_id) WHERE state='prepared';
    CREATE INDEX IF NOT EXISTS continuity_generation_scope_idx
      ON continuity_generations(logical_id,conversation_id,state);
    CREATE TABLE IF NOT EXISTS continuity_records (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL UNIQUE,
      generation_id TEXT NOT NULL REFERENCES continuity_generations(generation_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      input_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('owner','other-user','assistant','summary','tool')),
      seq INTEGER NOT NULL,
      finalized INTEGER NOT NULL DEFAULT 0 CHECK(finalized IN (0,1)),
      retained_text TEXT,
      text_sha256 TEXT NOT NULL,
      original_bytes INTEGER NOT NULL,
      retained_bytes INTEGER NOT NULL,
      redacted INTEGER NOT NULL CHECK(redacted IN (0,1)),
      truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
      provenance TEXT NOT NULL CHECK(provenance IN ('host-owner','other-user','assistant','generated','tool','unknown')),
      source_json TEXT NOT NULL,
      summary_json TEXT,
      created_at_ms INTEGER NOT NULL,
      tombstone_reason TEXT,
      removed_at_ms INTEGER,
      UNIQUE(generation_id,seq)
    );
    CREATE INDEX IF NOT EXISTS continuity_record_generation_idx ON continuity_records(generation_id,ordinal);
    CREATE INDEX IF NOT EXISTS continuity_record_retention_idx ON continuity_records(created_at_ms,ordinal);
    CREATE TABLE IF NOT EXISTS continuity_pins (
      record_id TEXT NOT NULL REFERENCES continuity_records(record_id),
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('ledger','summary','checkpoint','handoff')),
      owner_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(record_id,owner_kind,owner_id)
    );
  `);
}

export function assertContinuitySchema(database: DatabaseSync): void {
  const required = {
    continuity_generations: ["generation_id", "conversation_id", "logical_id", "before_digest", "after_digest", "preparation_digest", "state", "latest_summary_record_id", "created_at_ms", "committed_at_ms"],
    continuity_records: ["ordinal", "record_id", "generation_id", "run_id", "input_id", "kind", "seq", "finalized", "retained_text", "text_sha256", "original_bytes", "retained_bytes", "redacted", "truncated", "provenance", "source_json", "summary_json", "created_at_ms", "tombstone_reason", "removed_at_ms"],
    continuity_pins: ["record_id", "owner_kind", "owner_id", "created_at_ms"],
  };
  for (const [table, names] of Object.entries(required)) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    if (names.some((name) => !columns.some((column) => column.name === name))) {
      fail("history_integrity_failed", "Continuity schema is damaged; restore a consistent backup rather than repairing it online.");
    }
  }
}

export function hasContinuitySchema(database: DatabaseSync): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuity_records'").get() !== undefined;
}

export function prepareContinuity(
  database: DatabaseSync, input: ContinuityPreparation, limits: Required<ToolHistoryRetentionOptions>,
  reserve: (bytes: number, records: number) => void,
): ContinuityReceipt {
  validateContinuityPreparation(input);
  const records = input.records.map((record) => ({ record, retained: retainContinuityText(record.text) }));
  // Digest the selected, validated representation, never arbitrary caller properties.
  const preparationDigest = createHash("sha256").update(JSON.stringify([
    input.conversationId, input.logicalConversationId, input.beforeDigest, input.afterDigest,
    input.latestSummaryRecordId ?? null,
    records.map(({ record: r, retained }) => [r.recordId, r.runId, r.inputId ?? null, r.kind, r.sequence,
      r.provenance, r.source ?? {}, r.summary ?? null, retained]),
  ])).digest("hex");
  const existing = database.prepare("SELECT * FROM continuity_generations WHERE generation_id=?")
    .get(input.generationId) as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    if (existing.preparation_digest !== preparationDigest) fail("continuity_conflict", "Continuity generation changed after preparation.");
    return { generationId: input.generationId, status: existing.state as "prepared" | "committed", recordIds: input.records.map((r) => r.recordId) };
  }
  if (database.prepare("SELECT 1 FROM continuity_generations WHERE conversation_id=? AND state='prepared'").get(input.conversationId)) {
    fail("continuity_reconciliation_required", "An unresolved continuity publication must be reconciled under its conversation owner before mutation.");
  }
  const bytes = records.reduce((sum, row) => sum + row.retained.retainedBytes, 0);
  reserve(bytes, records.length);
  const count = Number((database.prepare("SELECT count(*) count FROM continuity_records WHERE retained_text IS NOT NULL").get() as Record<string, unknown>).count);
  if (continuityRetainedBytes(database) + toolRetainedBytes(database) + bytes > limits.maxBytes || count + records.length > limits.maxCompletedCalls) {
    fail("continuity_quota_exhausted", "Continuity retention capacity is exhausted; continuity is degraded and new reductions must be declined.");
  }
  database.prepare("DELETE FROM metadata WHERE key='continuity_degraded'").run();
  const now = Date.now();
  database.prepare(`INSERT INTO continuity_generations
    (generation_id,conversation_id,logical_id,before_digest,after_digest,preparation_digest,state,latest_summary_record_id,created_at_ms)
    VALUES (?,?,?,?,?,?,'prepared',?,?)`).run(input.generationId, input.conversationId, input.logicalConversationId,
      input.beforeDigest, input.afterDigest, preparationDigest, input.latestSummaryRecordId ?? null, now);
  for (const { record: r, retained: t } of records) {
    database.prepare(`INSERT INTO continuity_records
      (record_id,generation_id,run_id,input_id,kind,seq,retained_text,text_sha256,original_bytes,retained_bytes,
       redacted,truncated,provenance,source_json,summary_json,created_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.recordId, input.generationId, r.runId, r.inputId ?? null,
        r.kind, r.sequence, t.text, t.sha256, t.originalBytes, t.retainedBytes, t.redacted ? 1 : 0,
        t.truncated ? 1 : 0, r.provenance, JSON.stringify(r.source ?? {}), r.summary === undefined ? null : JSON.stringify(r.summary), now);
  }
  return { generationId: input.generationId, status: "prepared", recordIds: records.map((r) => r.record.recordId) };
}

export function commitContinuity(database: DatabaseSync, input: ContinuityPublication): void {
  normalizeId(input.conversationId, "conversationId");
  validateGenerationId(input.generationId);
  validateDigest(input.canonicalDigest, true);
  const row = database.prepare("SELECT * FROM continuity_generations WHERE generation_id=? AND conversation_id=?")
    .get(input.generationId, input.conversationId) as Record<string, unknown> | undefined;
  if (!row || row.after_digest !== input.canonicalDigest) fail("continuity_publication_mismatch", "Canonical publication does not match the prepared continuity target.");
  if (row.state === "committed") return;
  database.prepare("UPDATE continuity_generations SET state='committed',committed_at_ms=? WHERE generation_id=?")
    .run(Date.now(), input.generationId);
  database.prepare("UPDATE continuity_records SET finalized=1 WHERE generation_id=?").run(input.generationId);
  if (typeof row.latest_summary_record_id === "string") {
    // The current logical summary is a durable reference, not a TTL lease.
    database.prepare(`DELETE FROM continuity_pins WHERE owner_kind='summary' AND owner_id=?
      AND record_id IN (SELECT r.record_id FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE g.logical_id=?)`)
      .run(row.logical_id as string, row.logical_id as string);
    database.prepare("INSERT INTO continuity_pins(record_id,owner_kind,owner_id,created_at_ms) VALUES (?,'summary',?,?)")
      .run(row.latest_summary_record_id, row.logical_id as string, Date.now());
  }
}

export function reconcileContinuity(database: DatabaseSync, input: ContinuityReconciliation): ContinuityReconciliationResult {
  normalizeId(input.conversationId, "conversationId");
  validateDigest(input.canonicalDigest, true);
  const row = database.prepare("SELECT * FROM continuity_generations WHERE conversation_id=? AND state='prepared'")
    .get(input.conversationId) as Record<string, unknown> | undefined;
  if (!row) return { status: "clean" };
  const generationId = row.generation_id as string;
  if (row.after_digest === input.canonicalDigest) {
    commitContinuity(database, { ...input, generationId });
    return { status: "committed", generationId };
  }
  if (row.before_digest === input.canonicalDigest) {
    database.prepare("DELETE FROM continuity_pins WHERE record_id IN (SELECT record_id FROM continuity_records WHERE generation_id=?)").run(generationId);
    database.prepare("DELETE FROM continuity_generations WHERE generation_id=?").run(generationId);
    return { status: "discarded", generationId };
  }
  fail("continuity_publication_ambiguous", "Continuity publication is ambiguous; preserve evidence and reconcile before any further canonical mutation.");
}

export function pinContinuity(database: DatabaseSync, pin: ContinuityPin): void {
  validatePin(pin);
  const record = database.prepare(`SELECT r.retained_text,g.state FROM continuity_records r
    JOIN continuity_generations g USING(generation_id) WHERE r.record_id=? AND g.logical_id=?`)
    .get(pin.recordId, pin.logicalConversationId) as Record<string, unknown> | undefined;
  if (!record || record.retained_text === null) fail("continuity_record_unavailable", "Cannot pin unavailable continuity evidence.");
  database.prepare("INSERT OR IGNORE INTO continuity_pins(record_id,owner_kind,owner_id,created_at_ms) VALUES (?,?,?,?)")
    .run(pin.recordId, pin.ownerKind, pin.ownerId, Date.now());
}
export function unpinContinuity(database: DatabaseSync, pin: ContinuityPin): void {
  validatePin(pin);
  database.prepare(`DELETE FROM continuity_pins WHERE record_id=? AND owner_kind=? AND owner_id=?
    AND record_id IN (SELECT r.record_id FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE g.logical_id=?)`)
    .run(pin.recordId, pin.ownerKind, pin.ownerId, pin.logicalConversationId);
}

export function resetContinuity(database: DatabaseSync, logicalId: string): void {
  normalizeId(logicalId, "logicalConversationId");
  database.prepare(`DELETE FROM continuity_pins WHERE record_id IN
    (SELECT r.record_id FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE g.logical_id=?)`).run(logicalId);
  database.prepare("DELETE FROM continuity_generations WHERE logical_id=?").run(logicalId);
}

export function continuityRetainedBytes(database: DatabaseSync): number {
  return Number((database.prepare("SELECT coalesce(sum(retained_bytes),0) bytes FROM continuity_records WHERE retained_text IS NOT NULL").get() as Record<string, unknown>).bytes);
}
export function toolRetainedBytes(database: DatabaseSync): number {
  return Number((database.prepare("SELECT coalesce(sum(retained_bytes),0) bytes FROM tool_records").get() as Record<string, unknown>).bytes);
}

/** Never removes pinned or prepared evidence, even if the configured quota shrinks. */
export function retainContinuity(database: DatabaseSync, limits: Required<ToolHistoryRetentionOptions>, now: number, reservedBytes = 0, reservedRecords = 0): void {
  const eligible = `retained_text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM continuity_pins p WHERE p.record_id=continuity_records.record_id)
    AND generation_id IN (SELECT generation_id FROM continuity_generations WHERE state='committed')`;
  database.prepare(`UPDATE continuity_records SET retained_text=NULL,tombstone_reason='age',removed_at_ms=?
    WHERE ${eligible} AND created_at_ms<?`).run(now, now - limits.maxAgeMs);
  const countOverflow = Math.max(0, Number((database.prepare("SELECT count(*) count FROM continuity_records WHERE retained_text IS NOT NULL").get() as Record<string, unknown>).count)
    + reservedRecords - limits.maxCompletedCalls);
  database.prepare(`UPDATE continuity_records SET retained_text=NULL,tombstone_reason='count',removed_at_ms=? WHERE record_id IN
    (SELECT record_id FROM continuity_records WHERE ${eligible} ORDER BY ordinal LIMIT ?)`).run(now, countOverflow);
  while (continuityRetainedBytes(database) + toolRetainedBytes(database) + reservedBytes > limits.maxBytes) {
    const row = database.prepare(`SELECT record_id FROM continuity_records WHERE ${eligible} ORDER BY ordinal LIMIT 1`).get() as Record<string, unknown> | undefined;
    if (!row) break;
    database.prepare("UPDATE continuity_records SET retained_text=NULL,tombstone_reason='bytes',removed_at_ms=? WHERE record_id=?").run(now, row.record_id as string);
  }
  database.prepare(`DELETE FROM continuity_records WHERE retained_text IS NULL AND
    (removed_at_ms<? OR record_id IN (SELECT record_id FROM continuity_records WHERE retained_text IS NULL ORDER BY removed_at_ms DESC,ordinal DESC LIMIT -1 OFFSET ?))`)
    .run(now - limits.tombstoneMaxAgeMs, limits.maxTombstones);
  database.prepare(`DELETE FROM continuity_generations WHERE state='committed' AND NOT EXISTS
    (SELECT 1 FROM continuity_records r WHERE r.generation_id=continuity_generations.generation_id)`)
    .run();
}

export function readContinuityStats(database: DatabaseSync): ContinuityStats {
  const row = database.prepare(`SELECT
    (SELECT count(*) FROM continuity_records WHERE retained_text IS NOT NULL) records,
    (SELECT count(*) FROM continuity_generations) generations,
    (SELECT count(*) FROM continuity_generations WHERE state='prepared') prepared,
    (SELECT count(*) FROM continuity_pins) pins,
    (SELECT count(*) FROM continuity_records WHERE retained_text IS NULL) tombstones`).get() as Record<string, unknown>;
  return { records: Number(row.records), generations: Number(row.generations), prepared: Number(row.prepared),
    pins: Number(row.pins), tombstones: Number(row.tombstones), retainedBytes: continuityRetainedBytes(database),
    degraded: database.prepare("SELECT 1 FROM metadata WHERE key='continuity_degraded'").get() !== undefined };
}

export function validateContinuityPreparation(input: ContinuityPreparation): void {
  if (Object.keys(input).some((k) => !["generationId", "conversationId", "logicalConversationId", "beforeDigest", "afterDigest", "records", "latestSummaryRecordId"].includes(k))) fail("continuity_invalid_preparation", "Unsupported continuity preparation fields.");
  validateGenerationId(input.generationId);
  normalizeId(input.conversationId, "conversationId");
  normalizeId(input.logicalConversationId, "logicalConversationId");
  validateDigest(input.beforeDigest, true);
  validateDigest(input.afterDigest);
  if (input.beforeDigest === input.afterDigest) fail("continuity_invalid_preparation", "Continuity publication must identify a distinct canonical target.");
  if (!Array.isArray(input.records) || input.records.length > CONTINUITY_GENERATION_MAX_RECORDS) fail("continuity_invalid_preparation", "Continuity generation exceeds the record bound.");
  let bytes = 0;
  for (const record of input.records) {
    validateRecord(record);
    if (record.text.length > CONTINUITY_GENERATION_MAX_BYTES - bytes) fail("continuity_invalid_preparation", "Continuity generation exceeds the input byte bound.");
    bytes += Buffer.byteLength(record.text, "utf8");
    if (bytes > CONTINUITY_GENERATION_MAX_BYTES) fail("continuity_invalid_preparation", "Continuity generation exceeds the input byte bound.");
  }
  if (new Set(input.records.map((r) => r.recordId)).size !== input.records.length
    || new Set(input.records.map((r) => r.sequence)).size !== input.records.length) fail("continuity_invalid_preparation", "Continuity record identities and sequences must be unique.");
  if (input.latestSummaryRecordId !== undefined && !input.records.some((r) => r.recordId === input.latestSummaryRecordId && r.kind === "summary")) {
    fail("continuity_invalid_preparation", "Latest summary must reference a summary in this generation.");
  }
}
function validateRecord(r: ContinuityRecordInput): void {
  if (Object.keys(r).some((k) => !["recordId", "runId", "inputId", "kind", "sequence", "text", "provenance", "source", "summary"].includes(k))) fail("continuity_invalid_record", "Unsupported continuity record fields.");
  if (!RECORD_ID.test(r.recordId)) fail("continuity_invalid_record", "Continuity record IDs must be opaque.");
  normalizeId(r.runId, "runId");
  if (r.inputId !== undefined) normalizeId(r.inputId, "inputId");
  if (!Number.isSafeInteger(r.sequence) || r.sequence < 0 || typeof r.text !== "string") fail("continuity_invalid_record", "Invalid continuity sequence or text.");
  const allowed = { owner: ["host-owner"], "other-user": ["other-user", "unknown"], assistant: ["assistant", "unknown"], summary: ["generated"], tool: ["tool"] };
  if (!(r.kind in allowed) || !allowed[r.kind].includes(r.provenance)) fail("continuity_invalid_provenance", "Continuity source kind and provenance disagree.");
  const source = r.source ?? {};
  const keys = Object.keys(source);
  if (keys.some((k) => !["epoch", "revision", "journalId", "operationId", "attestation"].includes(k))) fail("continuity_invalid_provenance", "Unsupported continuity source metadata.");
  for (const key of ["epoch", "journalId", "operationId"] as const) if (source[key] !== undefined) safeMetadata(source[key]!);
  if (source.revision !== undefined && (!Number.isSafeInteger(source.revision) || source.revision < 0)) fail("continuity_invalid_provenance", "Invalid continuity source revision.");
  if (r.kind === "owner") {
    if (!source.attestation || source.attestation.inputId !== r.inputId || !r.inputId) fail("continuity_invalid_provenance", "Owner evidence requires the exact staged input attestation.");
    validateDigest(source.attestation.requestDigest);
    if (Object.keys(source.attestation).some((k) => !["inputId", "requestDigest"].includes(k))) fail("continuity_invalid_provenance", "Unsupported input attestation.");
  } else if (source.attestation !== undefined) fail("continuity_invalid_provenance", "Only owner input may carry owner attestation.");
  if (r.kind === "summary") {
    const summary = r.summary;
    if (!summary || !["manual", "pre-turn", "reactive", "mid-run"].includes(summary.trigger)) fail("continuity_invalid_record", "Summary coverage is required.");
    safeMetadata(summary.model); safeMetadata(summary.operationId);
    validateDigest(summary.coverage.sourceDigest);
    for (const id of [summary.coverage.firstRecordId, summary.coverage.lastRecordId]) if (id !== undefined && !RECORD_ID.test(id)) fail("continuity_invalid_record", "Invalid summary coverage reference.");
    if (Object.keys(summary).some((k) => !["model", "operationId", "trigger", "coverage"].includes(k))
      || Object.keys(summary.coverage).some((k) => !["sourceDigest", "firstRecordId", "lastRecordId"].includes(k))) fail("continuity_invalid_record", "Unsupported summary metadata.");
  } else if (r.summary !== undefined) fail("continuity_invalid_record", "Only summaries may carry summary metadata.");
}
function validatePin(pin: ContinuityPin): void {
  normalizeId(pin.logicalConversationId, "logicalConversationId");
  if (!RECORD_ID.test(pin.recordId) || !["ledger", "summary", "checkpoint", "handoff"].includes(pin.ownerKind)) fail("continuity_invalid_pin", "Invalid continuity pin.");
  normalizeId(pin.ownerId, "ownerId");
}
function safeMetadata(value: string): void {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 512
    || sanitizeVisibleText(value, { omitFilesystemPaths: true }) !== value) fail("continuity_invalid_provenance", "Unsafe continuity metadata.");
}
function validateGenerationId(value: string): void {
  if (!GENERATION_ID.test(value)) fail("continuity_invalid_preparation", "Invalid continuity generation ID.");
}
function validateDigest(value: string | null, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !SHA256.test(value)) fail("continuity_invalid_preparation", "Invalid canonical continuity digest.");
}
function fail(code: string, message: string): never { throw new ToolHistoryWriterError(code, message); }
