import type { DatabaseSync } from "node:sqlite";
import type { LedgerGeneration } from "./ledger.js";
import type { LedgerCursor, LedgerProgress } from "../tool-history/continuity-contracts.js";
type Row = Record<string, any>;

/** Only content-free identity/state survives a purge; queued content-bound RPCs fail closed. */
const scrubOperations = (where: string) => `UPDATE continuity_upkeep_operations SET
  reservation=json_set(json_remove(reservation,'$.progress'),'$.manifest',operation_id,'$.legacy_opaque',coalesce(json_extract(reservation,'$.legacy_opaque'),CASE WHEN json_type(reservation,'$.progress') IS NULL THEN 1 ELSE 0 END),'$.purged',1),selection_key=operation_id WHERE ${where};`;
export function createProgressSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS continuity_upkeep_progress (
    logical_id TEXT NOT NULL,conversation_id TEXT NOT NULL,incarnation TEXT NOT NULL,cursor TEXT NOT NULL,
    PRIMARY KEY(logical_id,conversation_id));
    CREATE TABLE IF NOT EXISTS continuity_upkeep_offers (
    logical_id TEXT NOT NULL,conversation_id TEXT NOT NULL,incarnation TEXT NOT NULL,
    span_key TEXT NOT NULL,ordinal INTEGER NOT NULL,source_digest TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,
    operation_id TEXT NOT NULL,state TEXT NOT NULL,ledger_id TEXT,
    PRIMARY KEY(logical_id,conversation_id,span_key));
    CREATE INDEX IF NOT EXISTS continuity_upkeep_offers_scope ON continuity_upkeep_offers(logical_id,conversation_id,ordinal);`);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_records'").get() && db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) {
    const scope = "(logical_id,conversation_id) IN (SELECT logical_id,conversation_id FROM continuity_generations WHERE generation_id=OLD.generation_id UNION SELECT logical_id,conversation_id FROM continuity_upkeep_offers WHERE ordinal=OLD.ordinal)";
    const erase = `${scrubOperations(scope)}
      UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.digest','','$.offset',0,'$.ordinal',min(json_extract(cursor,'$.ordinal'),OLD.ordinal)) WHERE ${scope};
      DELETE FROM continuity_upkeep_offers WHERE ordinal=OLD.ordinal AND state<>'uncertain';
      UPDATE continuity_upkeep_offers SET span_key=operation_id||':'||ordinal||':'||start,source_digest='',ledger_id=NULL WHERE ordinal=OLD.ordinal AND state='uncertain';`;
    const generationScope = "logical_id=OLD.logical_id AND conversation_id=OLD.conversation_id";
    const generationOrdinals = "ordinal IN (SELECT ordinal FROM continuity_records WHERE generation_id=OLD.generation_id)";
    db.exec(`CREATE TRIGGER IF NOT EXISTS continuity_upkeep_privacy_generation BEFORE DELETE ON continuity_generations
      WHEN EXISTS (SELECT 1 FROM continuity_records WHERE generation_id=OLD.generation_id) BEGIN
      ${scrubOperations(generationScope)}
      UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.digest','','$.offset',0) WHERE ${generationScope};
      DELETE FROM continuity_upkeep_offers WHERE ${generationOrdinals} AND state<>'uncertain';
      UPDATE continuity_upkeep_offers SET span_key=operation_id||':'||ordinal||':'||start,source_digest='',ledger_id=NULL WHERE ${generationOrdinals} AND state='uncertain'; END;
      CREATE TRIGGER IF NOT EXISTS continuity_upkeep_privacy_delete BEFORE DELETE ON continuity_records BEGIN ${erase} END;
      CREATE TRIGGER IF NOT EXISTS continuity_upkeep_privacy_update BEFORE UPDATE OF retained_text,text_sha256 ON continuity_records
        WHEN OLD.retained_text IS NOT NULL AND (NEW.retained_text IS NULL OR NEW.retained_text<>OLD.retained_text OR NEW.text_sha256<>OLD.text_sha256) BEGIN ${erase} END;
      CREATE TRIGGER IF NOT EXISTS continuity_upkeep_privacy_tombstone AFTER UPDATE OF retained_text ON continuity_records
        WHEN NEW.retained_text IS NULL BEGIN UPDATE continuity_records SET text_sha256='',source_json='{}',summary_json=NULL WHERE ordinal=NEW.ordinal; END;`);
  }
}
export function purgeUpkeepProgress(db: DatabaseSync, kind: "logical" | "physical", id: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return;
  const column = kind === "logical" ? "logical_id" : "conversation_id";
  db.prepare(scrubOperations(`${column}=?`)).run(id);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_progress'").get()) return;
  db.prepare(`UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.digest','','$.offset',0) WHERE ${column}=?`).run(id);
  db.prepare(`DELETE FROM continuity_upkeep_offers WHERE ${column}=? AND state<>'uncertain'`).run(id);
  db.prepare(`UPDATE continuity_upkeep_offers SET span_key=operation_id||':'||ordinal||':'||start,source_digest='',ledger_id=NULL WHERE ${column}=? AND state='uncertain'`).run(id);
}
/** Keep live anti-repurchase/representation evidence. Reclaim only proof-obsolete offers
 * and the terminal journal tail; unknown operations and the separate marker never expire. */
export function reclaimProgress(db: DatabaseSync, logicalId: string, conversationId: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return;
  db.prepare(`DELETE FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? AND state IN ('terminal','released')
    AND coalesce(json_extract(reservation,'$.legacy_opaque'),0)<>1 AND (json_type(reservation,'$.progress') IS NOT NULL OR json_extract(reservation,'$.purged')=1)
    AND operation_id NOT IN (SELECT operation_id FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 64)`)
    .run(logicalId, conversationId, logicalId, conversationId);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_records'").get()) return;
  db.prepare(`DELETE FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND state<>'uncertain' AND NOT EXISTS
    (SELECT 1 FROM continuity_records r WHERE r.ordinal=continuity_upkeep_offers.ordinal AND r.retained_text IS NOT NULL AND r.text_sha256=continuity_upkeep_offers.source_digest)`)
    .run(logicalId, conversationId);
}
export function readProgress(db: DatabaseSync, logicalId: string, conversationId: string, watermark: number): { cursor?: LedgerCursor | undefined; failed: number } {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_progress'").get()) return { failed: 0 };
  const args = [logicalId, conversationId];
  const row = db.prepare("SELECT cursor FROM continuity_upkeep_progress WHERE logical_id=? AND conversation_id=?").get(...args) as Row | undefined;
  let cursor: LedgerCursor | undefined = row ? JSON.parse(row.cursor) : undefined;
  const rewind = db.prepare(`SELECT min(o.ordinal) ordinal FROM continuity_upkeep_offers o JOIN continuity_records r ON r.ordinal=o.ordinal AND r.text_sha256=o.source_digest AND r.retained_text IS NOT NULL
    WHERE o.logical_id=? AND o.conversation_id=? AND (o.state='unrepresented' OR o.state='reofferable' AND ?)`)
    .get(...args, Number(!!cursor && cursor.ordinal > watermark)) as Row;
  if (rewind.ordinal !== null && cursor && rewind.ordinal <= cursor.ordinal) cursor = { ...cursor, ordinal: rewind.ordinal, offset: 0, digest: "" };
  const failed = Number((db.prepare(`SELECT count(*) n FROM continuity_upkeep_offers o JOIN continuity_records r ON r.ordinal=o.ordinal AND r.text_sha256=o.source_digest
    WHERE o.logical_id=? AND o.conversation_id=? AND o.state IN ('failed','uncertain','pending','reofferable','oversized') AND r.retained_text IS NOT NULL`).get(...args) as Row).n);
  return { cursor, failed };
}
export function offeredKeys(db: DatabaseSync, logicalId: string, conversationId: string, ordinals: readonly number[]): string[] {
  if (!ordinals.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_offers'").get()) return [];
  return (db.prepare(`SELECT span_key FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND state NOT IN ('unrepresented','reofferable') AND ordinal IN (${ordinals.map(() => "?").join(",")})`).all(logicalId, conversationId, ...ordinals) as Row[]).map(row => row.span_key);
}
export function dispatchProgress(db: DatabaseSync, r: { logicalId: string; conversationId: string; incarnation: string; operationId: string; progress?: LedgerProgress }, state = "uncertain", advance = true): void {
  if (!r.progress) return;
  const { cursor, spans } = r.progress;
  if (!Number.isSafeInteger(cursor.ordinal) || cursor.ordinal < 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.watermark) || cursor.watermark < 0 || !(cursor.offset === 0 && cursor.digest === "" || /^[a-f0-9]{64}$/u.test(cursor.digest)) || spans.length > 256) throw new Error("upkeep_progress_bounds");
  const n = Number((db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=?").get(r.logicalId, r.conversationId) as Row).n);
  if (n + spans.length > 65536) throw new Error("upkeep_progress_capacity");
  for (const span of spans) {
    if (!/^[a-f0-9]{64}$/u.test(span.digest) || !/^[a-f0-9]{64}$/u.test(span.key) || !Number.isSafeInteger(span.ordinal) || span.ordinal < 1 || span.ordinal > cursor.watermark || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start) throw new Error("upkeep_progress_bounds");
    const source = db.prepare("SELECT r.text_sha256 FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE r.ordinal=? AND g.logical_id=? AND g.conversation_id=? AND g.state='committed' AND r.retained_text IS NOT NULL").get(span.ordinal, r.logicalId, r.conversationId) as Row | undefined;
    if (source?.text_sha256 !== span.digest) throw new Error("upkeep_progress_source_changed");
    const old = db.prepare("SELECT state,operation_id FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND span_key=?").get(r.logicalId, r.conversationId, span.key) as Row | undefined;
    if (old?.state === state && old.operation_id === r.operationId) continue;
    if (old && !["unrepresented", "reofferable"].includes(old.state)) throw new Error("upkeep_progress_repeat");
    db.prepare("INSERT INTO continuity_upkeep_offers VALUES (?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(logical_id,conversation_id,span_key) DO UPDATE SET operation_id=excluded.operation_id,state=excluded.state,ledger_id=NULL").run(r.logicalId, r.conversationId, r.incarnation, span.key, span.ordinal, span.digest, span.start, span.end, r.operationId, state);
  }
  if (advance) db.prepare("INSERT INTO continuity_upkeep_progress VALUES (?,?,?,?) ON CONFLICT(logical_id,conversation_id) DO UPDATE SET incarnation=excluded.incarnation,cursor=excluded.cursor").run(r.logicalId, r.conversationId, r.incarnation, JSON.stringify(cursor));
}
export function representProgress(db: DatabaseSync, generation: LedgerGeneration, key: (span: LedgerGeneration["spans"][number]) => string, operationId?: string): void {
  for (const span of generation.spans) if (generation.coveredSpans?.includes(span.id)) {
    db.prepare("UPDATE continuity_upkeep_offers SET state='represented',ledger_id=? WHERE logical_id=? AND conversation_id=? AND span_key=?").run(generation.id, generation.logicalId, generation.conversationId, key(span));
  }
  if (operationId) {
    db.prepare("UPDATE continuity_upkeep_offers SET state='reofferable' WHERE operation_id=? AND state='pending'").run(operationId);
    reclaimProgress(db, generation.logicalId, generation.conversationId);
  }
}
