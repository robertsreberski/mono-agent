import { readProgress, offeredKeys } from "../continuity/progress.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CONTINUITY_CHUNK_MAX_BYTES,
  type ContinuityGetInput, type ContinuityGetResult, type ContinuityRecordMetadata,
  type ContinuityScope, type ContinuitySearchInput, type ContinuitySearchPage,
  type ContinuitySnapshotInput, type ContinuitySnapshot, type ContinuitySnapshotRecord,
} from "./continuity-contracts.js";
import { hasContinuitySchema } from "./continuity-storage.js";
import { normalizeId } from "./paths.js";
import { utf8Prefix } from "./payload.js";

type Row = Record<string, unknown>;
// A pending purge suppresses the old physical owner's evidence even across an
// acknowledgement crash. An unpublished reset can safely restore it by discard.
const VISIBLE = `g.logical_id=? AND g.state='committed' AND r.finalized=1 AND NOT EXISTS
  (SELECT 1 FROM continuity_generations pending WHERE pending.conversation_id=g.conversation_id
    AND pending.state='prepared' AND pending.action IN ('reset','delete'))`;

export function searchContinuity(database: DatabaseSync, input: ContinuitySearchInput): ContinuitySearchPage {
  validateScope(input);
  if (!hasContinuitySchema(database)) return { available: false, items: [] };
  const limit = input.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new TypeError("Continuity search limit must be 1 through 10.");
  const clauses = [VISIBLE, "r.retained_text IS NOT NULL"];
  const values: (string | number)[] = [input.logicalConversationId];
  if (input.query !== undefined) {
    if (input.query.trim().length === 0 || Buffer.byteLength(input.query) > 512) throw new TypeError("Continuity query must be 1 through 512 bytes.");
    // SQLite's built-in lower() folds ASCII only. Match the query's Unicode
    // lowercasing without a second retained-text copy or schema migration.
    database.function("continuity_lower", { deterministic: true }, (value) => typeof value === "string" ? value.toLowerCase() : "");
    for (const term of [...new Set(input.query.toLowerCase().trim().split(/\s+/u))].slice(0, 16)) {
      clauses.push("instr(continuity_lower(r.retained_text),?)>0"); values.push(term);
    }
  }
  if (input.before !== undefined) {
    if (!Number.isSafeInteger(input.before) || input.before < 1) throw new TypeError("Invalid continuity search offset.");
    clauses.push("r.ordinal<?"); values.push(input.before);
  }
  const rows = database.prepare(`SELECT r.*,g.conversation_id FROM continuity_records r
    JOIN continuity_generations g USING(generation_id) WHERE ${clauses.join(" AND ")}
    ORDER BY r.ordinal DESC LIMIT ?`).all(...values, limit + 1) as Row[];
  const selected = rows.slice(0, limit);
  return {
    available: true,
    items: selected.map((row) => ({ ...metadata(row), preview: utf8Prefix(text(row), 512) })),
    ...(rows.length > limit ? { next: Number(selected.at(-1)!.ordinal) } : {}),
  };
}

export function getContinuity(database: DatabaseSync, input: ContinuityGetInput): ContinuityGetResult {
  validateScope(input);
  if (!hasContinuitySchema(database)) return { status: "unavailable", untrusted: true };
  if (!/^chr1_[A-Za-z0-9_-]{43}$/u.test(input.recordId)) return { status: "unavailable", untrusted: true };
  const row = database.prepare(`SELECT r.*,g.conversation_id FROM continuity_records r
    JOIN continuity_generations g USING(generation_id) WHERE ${VISIBLE} AND r.record_id=?`)
    .get(input.logicalConversationId, input.recordId) as Row | undefined;
  if (!row) return { status: "unavailable", untrusted: true };
  if (row.retained_text === null) return {
    status: "tombstoned", untrusted: true,
    tombstone: { recordId: row.record_id as string, reason: row.tombstone_reason as string, removedAtMs: Number(row.removed_at_ms) },
  };
  const retained = text(row);
  const encoded = Buffer.from(retained, "utf8");
  const offset = input.chunkOffset ?? 0;
  const bytes = input.chunkBytes ?? 4096;
  if (!Number.isSafeInteger(bytes) || bytes < 4 || bytes > CONTINUITY_CHUNK_MAX_BYTES
    || !Number.isSafeInteger(offset) || offset < 0 || offset > encoded.length
    || isContinuation(encoded[offset])) throw new TypeError("Invalid continuity UTF-8 chunk boundary or size.");
  let end = Math.min(encoded.length, offset + bytes);
  while (end > offset && isContinuation(encoded[end])) end -= 1;
  return {
    status: "available", untrusted: true, record: metadata(row), chunk: encoded.subarray(offset, end).toString("utf8"),
    ...(end < encoded.length ? { nextOffset: end } : {}),
  };
}

export function latestContinuitySummary(database: DatabaseSync, scope: ContinuityScope): ContinuityRecordMetadata | undefined {
  validateScope(scope);
  if (!hasContinuitySchema(database)) return undefined;
  const row = latestSummaryRow(database, scope);
  return row === undefined ? undefined : metadata(row);
}
function latestSummaryRow(database: DatabaseSync, scope: ContinuityScope, columns = "r.*,g.conversation_id"): Row | undefined {
  return database.prepare(`SELECT ${columns} FROM continuity_records r
    JOIN continuity_generations g USING(generation_id) JOIN continuity_pins p USING(record_id)
    WHERE ${VISIBLE} AND r.kind='summary' AND r.retained_text IS NOT NULL
      AND p.owner_kind='summary' AND p.owner_id=? ORDER BY r.ordinal DESC LIMIT 1`)
    .get(scope.logicalConversationId, scope.logicalConversationId) as Row | undefined;
}

/** One bounded visibility query; immutable record identities/digests must all survive. */
export function continuitySnapshotVisible(database: DatabaseSync, scope: ContinuitySnapshotInput, snapshot: ContinuitySnapshot): boolean {
  validateScope(scope);
  if (!hasContinuitySchema(database) || snapshot.records.length > 512) return false;
  if (snapshot.records.length === 0) return true;
  const rows = database.prepare(`SELECT r.record_id,r.text_sha256 FROM continuity_records r
    JOIN continuity_generations g USING(generation_id) WHERE ${VISIBLE} AND g.conversation_id=? AND r.run_id<>?
    AND r.retained_text IS NOT NULL AND r.record_id IN (${snapshot.records.map(() => "?").join(",")})
    AND (r.kind<>'summary' OR EXISTS (SELECT 1 FROM continuity_pins p WHERE p.record_id=r.record_id AND p.owner_kind='summary' AND p.owner_id=?))`)
    .all(scope.logicalConversationId, scope.currentConversationId, scope.currentRunId, ...snapshot.records.map(record => record.recordId), scope.logicalConversationId) as Row[];
  const visible = new Map(rows.map(row => [row.record_id, row.text_sha256]));
  return rows.length === snapshot.records.length && snapshot.records.every(record => visible.get(record.recordId) === record.sha256);
}

function text(row: Row): string {
  if (typeof row.retained_text !== "string" || createHash("sha256").update(row.retained_text).digest("hex") !== row.text_sha256) {
    throw new TypeError("Retained continuity digest mismatch.");
  }
  return row.retained_text;
}
function metadata(row: Row): ContinuityRecordMetadata {
  return {
    recordId: row.record_id as string, generationId: row.generation_id as string, conversationId: row.conversation_id as string,
    runId: row.run_id as string, ...(row.input_id === null ? {} : { inputId: row.input_id as string }),
    kind: row.kind as ContinuityRecordMetadata["kind"], sequence: Number(row.seq), ordinal: Number(row.ordinal),
    sha256: row.text_sha256 as string, originalBytes: Number(row.original_bytes), retainedBytes: Number(row.retained_bytes),
    redacted: Number(row.redacted) === 1, truncated: Number(row.truncated) === 1,
    provenance: row.provenance as ContinuityRecordMetadata["provenance"], source: JSON.parse(row.source_json as string),
    ...(row.summary_json === null ? {} : { summary: JSON.parse(row.summary_json as string) }), untrusted: true,
  };
}
function validateScope(scope: ContinuityScope): void {
  normalizeId(scope.logicalConversationId, "logicalConversationId");
  normalizeId(scope.currentConversationId, "currentConversationId");
  normalizeId(scope.currentRunId, "currentRunId");
}
function isContinuation(byte: number | undefined): boolean { return byte !== undefined && (byte & 0xc0) === 0x80; }

/** Oldest evidence wins. Both materialization and total bytes are bounded; counts
 * disclose everything not selected. The caller holds a SQLite read transaction. */
export function snapshotContinuity(database: DatabaseSync, input: ContinuitySnapshotInput): ContinuitySnapshot {
  validateScope(input);
  if (!hasContinuitySchema(database)) return { records: [], omitted: 0, gaps: 0, degradedReason: "unavailable" };
  const clauses = [VISIBLE, "g.conversation_id=?", "r.run_id<>?"];
  const values: (string | number)[] = [input.logicalConversationId, input.currentConversationId, input.currentRunId];
  // Rollover deliberately does not inherit yesterday's pack: canonical replay
  // is physical-bucket scoped, even though explicit retrieval is logical scoped.
  if (input.historyBoundary !== undefined) {
    const boundary = database.prepare(`SELECT max(r.ordinal) ordinal FROM continuity_records r
      JOIN continuity_generations g USING(generation_id) WHERE ${VISIBLE} AND g.conversation_id=?
      AND r.run_id=? AND r.kind IN ('owner','user','other-user','imported','assistant')`)
      .get(input.logicalConversationId, input.currentConversationId, input.historyBoundary) as Row;
    if (boundary.ordinal === null) return { records: [], omitted: 0, gaps: 1, degradedReason: "boundary_unavailable" };
    clauses.push("r.ordinal<=?"); values.push(Number(boundary.ordinal));
  }
  const watermark = input.selection === "upkeep" ? Number((database.prepare(`SELECT coalesce(max(r.ordinal),0) n FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE ${clauses.join(" AND ")}`).get(...values) as Row).n) : 0;
  const progress = input.selection === "upkeep" ? readProgress(database, input.logicalConversationId, input.currentConversationId, watermark) : undefined;
  if (progress) {
    clauses.push("r.ordinal>=?", "r.ordinal<=?"); values.push(progress.cursor?.ordinal ?? 1, watermark);
  }
  const where = clauses.join(" AND ");
  const gaps = Number((database.prepare("SELECT count(*) count FROM continuity_generations WHERE logical_id=? AND conversation_id=? AND state='abandoned'")
    .get(input.logicalConversationId, input.currentConversationId) as Row).count);
  const pinnedSummaryId = latestSummaryRow(database, input, "r.record_id")?.record_id as string | undefined;
  const total = Number((database.prepare(`SELECT count(*) count FROM continuity_records r
    JOIN continuity_generations g USING(generation_id) WHERE ${where}
    AND (r.kind IN ('owner','user','other-user','imported','tool') OR r.record_id=?)`).get(...values, pinnedSummaryId ?? '') as Row).count);
  // Select metadata first, never materialize an unbounded retained-text query.
  const candidates = database.prepare(`SELECT r.record_id,length(CAST(r.retained_text AS BLOB)) snapshot_bytes,r.kind,r.ordinal FROM continuity_records r
    JOIN continuity_generations g USING(generation_id) WHERE ${where} AND r.retained_text IS NOT NULL
    AND (r.kind IN ('owner','user','other-user','imported','tool') OR r.record_id=?)
    ORDER BY ${progress ? "r.ordinal" : "CASE WHEN r.kind='owner' AND r.provenance='host-owner' THEN 0 WHEN r.kind='tool' THEN 1 WHEN r.kind='summary' THEN 2 ELSE 3 END"}, r.ordinal ASC LIMIT 513`).all(...values, pinnedSummaryId ?? '') as Row[];
  const records: ContinuitySnapshotRecord[] = [];
  let bytes = 0, bounded = candidates.length > 512, unavailable = false;
  for (const candidate of candidates.slice(0, 512)) {
    const size = Number(candidate.snapshot_bytes);
    if (bytes + size > 4 * 1024 * 1024) { bounded = true; if (progress) break; continue; }
    bytes += size;
    try {
      const row = database.prepare(`SELECT r.*,g.conversation_id FROM continuity_records r
        JOIN continuity_generations g USING(generation_id) WHERE r.record_id=?`).get(candidate.record_id as string) as Row;
      const record = { ...metadata(row), text: text(row) };
      if (record.kind === "tool") {
        // B1's finalized text identity is hash(physical bucket, run, tool call).
        // Join only that exact lifecycle, not a similar tool name or result body.
        database.function("continuity_tool_operation", { deterministic: true }, (conversation, run, call) =>
          `tool:${createHash("sha256").update(JSON.stringify([conversation, run, call])).digest("hex")}`);
        const call = database.prepare(`SELECT c.tool_name,c.state,length(CAST(i.payload_json AS BLOB)) payload_bytes,CASE WHEN length(CAST(i.payload_json AS BLOB))<=? THEN i.payload_json ELSE NULL END payload_json,i.payload_sha256,i.record_id invocation_id,o.record_id result_id
          FROM tool_calls c JOIN tool_records i ON i.conversation_id=c.conversation_id AND i.run_id=c.run_id
            AND i.tool_call_id=c.tool_call_id AND i.phase='invocation'
          LEFT JOIN tool_records o ON o.conversation_id=c.conversation_id AND o.run_id=c.run_id
            AND o.tool_call_id=c.tool_call_id AND o.phase='result'
          WHERE c.conversation_id=? AND c.run_id=? AND c.end_seq IS NOT NULL
            AND continuity_tool_operation(c.conversation_id,c.run_id,c.tool_call_id)=?
            LIMIT 1`)
          .get(4 * 1024 * 1024 - bytes, record.conversationId, record.runId, record.source.operationId ?? "") as Row | undefined;
        if (call && Number(call.payload_bytes) > 4 * 1024 * 1024 - bytes && progress) { bounded = true; break; }
        if (!call || typeof call.payload_json !== "string" || createHash("sha256").update(call.payload_json).digest("hex") !== call.payload_sha256) { unavailable = true; if (progress) break; continue; }
        bytes += Buffer.byteLength(call.payload_json);
        if (bytes > 4 * 1024 * 1024) { bounded = true; if (progress) break; continue; }
        records.push({ ...record, tool: { name: call.tool_name as string, state: call.state as string,
          arguments: JSON.stringify(JSON.parse(call.payload_json)), invocationId: call.invocation_id as string,
          ...(typeof call.result_id === "string" ? { resultId: call.result_id } : {}) } });
      } else records.push(record);
    } catch { unavailable = true; if (progress) break; } // A malformed record cannot discard its healthy siblings.
  }
  return { records, omitted: Math.max(0, total - records.length), gaps: gaps + (progress?.failed ?? 0),
    ...(progress ? { upkeep: { cursor: progress.cursor, watermark, excluded: offeredKeys(database, input.logicalConversationId, input.currentConversationId, records.map(record => record.ordinal)) } } : {}),
    ...(bounded ? { degradedReason: "snapshot_bounds" as const } : unavailable ? { degradedReason: "source_unavailable" as const } : {}) };
}
