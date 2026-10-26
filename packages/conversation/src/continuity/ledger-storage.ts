import { createProgressSchema, representProgress } from "./progress.js";
import { LedgerError } from "./ledger-error.js";
import type { DatabaseSync } from "node:sqlite";
import { ledgerHash, spanKey, normalizeLedger, LEDGER_PAYLOAD_BYTES, LEDGER_LINEAGE_BYTES, type LedgerGeneration } from "./ledger.js";
import type { ContinuityScope } from "../tool-history/continuity-contracts.js";

type Row = Record<string, unknown>;
export function ledgerBytes(database: DatabaseSync): number {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_ledger'").get()) return 0;
  return Number((database.prepare("SELECT coalesce(sum(bytes),0) n FROM continuity_ledger").get() as Row).n);
}
export function createLedgerSchema(database: DatabaseSync): void {
  createProgressSchema(database);
  database.exec(`CREATE TABLE IF NOT EXISTS continuity_ledger (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, logical_id TEXT NOT NULL,
    parent TEXT, manifest TEXT NOT NULL, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS continuity_ledger_inputs (
      generation_id TEXT NOT NULL REFERENCES continuity_ledger(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL REFERENCES continuity_records(record_id) ON DELETE CASCADE,
      digest TEXT NOT NULL, PRIMARY KEY(generation_id,record_id));
    CREATE TRIGGER IF NOT EXISTS continuity_ledger_source_delete AFTER DELETE ON continuity_ledger_inputs
      BEGIN DELETE FROM continuity_ledger WHERE id=OLD.generation_id; END;
    CREATE TRIGGER IF NOT EXISTS continuity_ledger_source_update AFTER UPDATE OF retained_text,text_sha256 ON continuity_records
      WHEN NEW.retained_text IS NULL OR NEW.text_sha256<>OLD.text_sha256 OR NEW.retained_text<>OLD.retained_text
      BEGIN DELETE FROM continuity_ledger WHERE id IN
        (SELECT generation_id FROM continuity_ledger_inputs WHERE record_id=NEW.record_id); END;
    CREATE TRIGGER IF NOT EXISTS continuity_upkeep_representation_delete AFTER DELETE ON continuity_ledger
      BEGIN UPDATE continuity_upkeep_offers SET state='unrepresented',ledger_id=NULL WHERE ledger_id=OLD.id AND state='represented'; END;`);
}

/** Validate all inherited input links, not only citations. Latest-only storage
 * carries the union of ancestry inputs, so old-binary B1 purge/cascade also
 * removes every descendant. No indefinite source pins or hidden prompt copy. */
export function readLedger(database: DatabaseSync, scope: ContinuityScope): { generation: LedgerGeneration; retainedBytes: number; payloadBytes: number; records: { recordId: string; text: string; tool?: { name: string } }[] } | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_ledger'").get()) return undefined;
  const row = database.prepare("SELECT id,manifest,payload_sha256,CASE WHEN length(CAST(payload AS BLOB))<=131072 THEN payload ELSE NULL END payload FROM continuity_ledger WHERE conversation_id=? AND logical_id=?").get(scope.currentConversationId, scope.logicalConversationId) as Row | undefined;
  if (!row) return undefined;
  if (typeof row.payload !== "string") throw new Error("ledger_payload_bounds");
  if (ledgerHash(row.payload as string) !== row.payload_sha256) throw new Error("ledger_payload_digest");
  const generation = JSON.parse(row.payload as string) as LedgerGeneration;
  if (generation.id !== row.id || generation.conversationId !== scope.currentConversationId || generation.logicalId !== scope.logicalConversationId
    || !Array.isArray(generation.inputs) || !Array.isArray(generation.spans) || generation.spans.length > 1024
    || !Array.isArray(generation.entries) || generation.entries.length > 64 || generation.manifest !== row.manifest || ledgerHash(JSON.stringify(generation.spans)) !== row.manifest) throw new Error("ledger_payload");
  const { records, retainedBytes } = verifyInputs(database, generation);
  const normalized = normalizeLedger({ ...generation, spans: generation.spans.map(span => ({ ...span, ordinal: Number(records.get(span.recordId)!.ordinal) })) })!;
  return { generation: normalized, retainedBytes, payloadBytes: Buffer.byteLength(row.payload as string), records: [...records].map(([recordId, row]) => ({ recordId, text: row.retained_text as string })) };
}
function verifyInputs(database: DatabaseSync, generation: LedgerGeneration): { records: Map<string, Row>; retainedBytes: number } {
  const records = new Map<string, Row>(); let bytes = 0;
  for (const input of generation.inputs) {
    const row = database.prepare(`SELECT r.ordinal,r.record_id,r.text_sha256,r.retained_text,r.kind,r.provenance,r.input_id,
      CASE WHEN length(CAST(r.source_json AS BLOB))<=65536 THEN r.source_json ELSE NULL END source_json,g.logical_id,g.conversation_id FROM continuity_records r JOIN continuity_generations g USING(generation_id)
      WHERE r.record_id=? AND g.logical_id=? AND g.conversation_id=? AND g.state='committed' AND r.finalized=1 AND r.retained_text IS NOT NULL AND length(CAST(r.retained_text AS BLOB))<=?`)
      .get(input.recordId, generation.logicalId, generation.conversationId, LEDGER_LINEAGE_BYTES - bytes) as Row | undefined;
    if (!row || row.text_sha256 !== input.sha256 || ledgerHash(row.retained_text as string) !== input.sha256) throw new Error("ledger_source_changed");
    bytes += Buffer.byteLength(row.retained_text as string);
    if (bytes > LEDGER_LINEAGE_BYTES) throw new Error("ledger_lineage_bounds");
    records.set(input.recordId, row);
  }
  for (const span of generation.spans) {
    const row = records.get(span.recordId), text = row?.retained_text as string | undefined;
    if (text === undefined || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start) throw new Error("ledger_span");
    const bytes = Buffer.from(text), slice = bytes.subarray(span.start, span.end);
    if (span.end > bytes.length || span.sha256 !== row!.text_sha256 || ledgerHash(slice) !== span.digest || !Buffer.from(slice.toString("utf8")).equals(slice)) throw new Error("ledger_span");
    if (span.owner) {
      const source = JSON.parse(row!.source_json as string) as { attestation?: { inputId?: string } };
      if (row!.kind !== "owner" || row!.provenance !== "host-owner" || !row!.input_id || source.attestation?.inputId !== row!.input_id
        || span.start > 0 && bytes.subarray(0, span.start).toString().slice(-2) !== "\n\n"
        || span.end < bytes.length && bytes.subarray(span.end).toString().slice(0, 2) !== "\n\n") throw new Error("ledger_owner_span");
    }
  }
  return { records, retainedBytes: bytes };
}

/** Called in the existing writer transaction, never around network I/O. */
export function publishLedger(database: DatabaseSync, generation: LedgerGeneration, maxBytes: number, existingBytes: number, operationId?: string): void {
  const payload = JSON.stringify(generation), bytes = Buffer.byteLength(payload);
  if (!generation.id || !generation.conversationId || !generation.logicalId || bytes > LEDGER_PAYLOAD_BYTES
    || generation.spans.length > 1024 || generation.entries.length > 64 || ledgerHash(JSON.stringify(generation.spans)) !== generation.manifest) throw new LedgerError("publish_bounds");
  createLedgerSchema(database);
  const old = database.prepare("SELECT id,bytes,payload FROM continuity_ledger WHERE conversation_id=?").get(generation.conversationId) as Row | undefined;
  if ((old?.id ?? null) !== generation.parent) throw new LedgerError("publish_cas");
  if (old) {
    const parent = normalizeLedger(JSON.parse(old.payload as string) as LedgerGeneration)!;
    if (parent.inputs.some(input => !generation.inputs.some(next => next.recordId === input.recordId && next.sha256 === input.sha256))
      || parent.entries.some(entry => !generation.entries.some(next => JSON.stringify(next) === JSON.stringify(entry)))
      || parent.spans.filter(span => parent.entries.some(entry => entry.sources.includes(span.id))).some(span => !generation.spans.some(next => next.id === span.id && spanKey(next) === spanKey(span)))) throw new LedgerError("publish_source_changed");
  }
  if (existingBytes - Number(old?.bytes ?? 0) + bytes > maxBytes) throw new LedgerError("publish_quota");
  try { verifyInputs(database, generation); } catch { throw new LedgerError("publish_source_changed"); }
  // Transfer prior representation before replacing the latest row; rollback is atomic.
  database.prepare("UPDATE continuity_upkeep_offers SET ledger_id=? WHERE ledger_id=? AND state='represented'").run(generation.id, String(old?.id ?? ""));
  database.prepare("DELETE FROM continuity_ledger WHERE conversation_id=?").run(generation.conversationId);
  database.prepare("INSERT INTO continuity_ledger VALUES (?,?,?,?,?,?,?,?)").run(generation.id, generation.conversationId, generation.logicalId, generation.parent, generation.manifest, payload, ledgerHash(payload), bytes);
  representProgress(database, generation, spanKey, operationId);
  for (const input of generation.inputs) database.prepare("INSERT INTO continuity_ledger_inputs VALUES (?,?,?)").run(generation.id, input.recordId, input.sha256);
}
