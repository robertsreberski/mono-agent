import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CONTINUITY_CHUNK_MAX_BYTES,
  type ContinuityGetInput, type ContinuityGetResult, type ContinuityRecordMetadata,
  type ContinuityScope, type ContinuitySearchInput, type ContinuitySearchPage,
} from "./continuity-contracts.js";
import { hasContinuitySchema } from "./continuity-storage.js";
import { normalizeId } from "./paths.js";
import { utf8Prefix } from "./payload.js";

type Row = Record<string, unknown>;
const VISIBLE = "g.logical_id=? AND g.state='committed' AND r.finalized=1";

export function searchContinuity(database: DatabaseSync, input: ContinuitySearchInput): ContinuitySearchPage {
  validateScope(input);
  if (!hasContinuitySchema(database)) return { available: false, items: [] };
  const limit = input.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new TypeError("Continuity search limit must be 1 through 10.");
  const clauses = [VISIBLE, "r.retained_text IS NOT NULL"];
  const values: (string | number)[] = [input.logicalConversationId];
  if (input.query !== undefined) {
    if (input.query.trim().length === 0 || Buffer.byteLength(input.query) > 512) throw new TypeError("Continuity query must be 1 through 512 bytes.");
    for (const term of [...new Set(input.query.toLowerCase().trim().split(/\s+/u))].slice(0, 16)) {
      clauses.push("instr(lower(r.retained_text),?)>0"); values.push(term);
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
  const row = database.prepare(`SELECT r.*,g.conversation_id FROM continuity_records r
    JOIN continuity_generations g USING(generation_id) JOIN continuity_pins p USING(record_id)
    WHERE ${VISIBLE} AND r.kind='summary' AND r.retained_text IS NOT NULL
      AND p.owner_kind='summary' AND p.owner_id=? ORDER BY r.ordinal DESC LIMIT 1`)
    .get(scope.logicalConversationId, scope.logicalConversationId) as Row | undefined;
  return row === undefined ? undefined : metadata(row);
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
