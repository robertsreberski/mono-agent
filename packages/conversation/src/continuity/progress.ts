import type { DatabaseSync } from "node:sqlite";
import type { LedgerGeneration } from "./ledger.js";
import type { LedgerCursor, LedgerProgress } from "../tool-history/continuity-contracts.js";
type Row = Record<string, any>;

/** Invalidate publication for affected evidence, preserving opaque accounting identity. */
const scrubOperations = (where: string) => `UPDATE continuity_upkeep_operations SET
  reservation=json_set(json_remove(reservation,'$.progress','$.legacy_opaque'),'$.manifest',operation_id,'$.purged',1),selection_key=operation_id WHERE ${where};`;
export function createProgressSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS continuity_upkeep_progress (
    logical_id TEXT NOT NULL,conversation_id TEXT NOT NULL,incarnation TEXT NOT NULL,cursor TEXT NOT NULL,
    PRIMARY KEY(logical_id,conversation_id));
    CREATE TABLE IF NOT EXISTS continuity_upkeep_offers (
    logical_id TEXT NOT NULL,conversation_id TEXT NOT NULL,incarnation TEXT NOT NULL,
    span_key TEXT NOT NULL,ordinal INTEGER NOT NULL,source_digest TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,
    operation_id TEXT NOT NULL,state TEXT NOT NULL,ledger_id TEXT,attempt INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(logical_id,conversation_id,span_key));
    CREATE INDEX IF NOT EXISTS continuity_upkeep_offers_scope ON continuity_upkeep_offers(logical_id,conversation_id,ordinal);
    CREATE TABLE IF NOT EXISTS continuity_upkeep_migrations (version INTEGER PRIMARY KEY);`);
  if (!(db.prepare("PRAGMA table_info(continuity_upkeep_offers)").all() as Row[]).some(row => row.name === "attempt")) {
    db.exec("ALTER TABLE continuity_upkeep_offers ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0; UPDATE continuity_upkeep_offers SET state='analyzed' WHERE state='reofferable'");
  }
  db.exec("UPDATE continuity_upkeep_offers SET state='lost' WHERE state='unrepresented' AND attempt>=1");
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return;
  if (!db.prepare("SELECT 1 FROM continuity_upkeep_migrations WHERE version=2").get()) {
    db.exec(scrubOperations("json_type(reservation,'$.progress') IS NULL"));
    db.exec("INSERT INTO continuity_upkeep_migrations VALUES (2)");
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_records'").get() && !db.prepare("SELECT 1 FROM continuity_upkeep_migrations WHERE version=3").get()) {
    const scope = "(logical_id,conversation_id) IN (SELECT logical_id,conversation_id FROM continuity_generations WHERE generation_id=OLD.generation_id UNION SELECT logical_id,conversation_id FROM continuity_upkeep_offers WHERE ordinal=OLD.ordinal)";
    const active = `(EXISTS (SELECT 1 FROM continuity_upkeep_progress WHERE ${scope}) OR EXISTS (SELECT 1 FROM continuity_upkeep_offers WHERE ordinal=OLD.ordinal))`;
    const affected = "operation_id IN (SELECT operation_id FROM continuity_upkeep_operations o,json_each(o.reservation,'$.progress.spans') s WHERE json_extract(s.value,'$.ordinal')=OLD.ordinal)";
    const erase = `${scrubOperations(affected)}
      UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.digest','','$.offset',0) WHERE ${scope} AND json_extract(cursor,'$.ordinal')=OLD.ordinal;
      DELETE FROM continuity_upkeep_offers WHERE ordinal=OLD.ordinal AND state<>'uncertain';
      UPDATE continuity_upkeep_offers SET span_key=operation_id||':'||ordinal||':'||start,source_digest='',ledger_id=NULL WHERE ordinal=OLD.ordinal AND state='uncertain';`;
    const generationScope = "logical_id=OLD.logical_id AND conversation_id=OLD.conversation_id";
    const generationOrdinals = "ordinal IN (SELECT ordinal FROM continuity_records WHERE generation_id=OLD.generation_id)";
    db.exec(`DROP TRIGGER IF EXISTS continuity_upkeep_privacy_generation; DROP TRIGGER IF EXISTS continuity_upkeep_privacy_delete;
      DROP TRIGGER IF EXISTS continuity_upkeep_privacy_update; DROP TRIGGER IF EXISTS continuity_upkeep_privacy_tombstone;
      CREATE TRIGGER continuity_upkeep_privacy_generation BEFORE DELETE ON continuity_generations
      WHEN EXISTS (SELECT 1 FROM continuity_upkeep_progress WHERE ${generationScope}) OR EXISTS (SELECT 1 FROM continuity_upkeep_offers WHERE ${generationOrdinals}) BEGIN
      ${scrubOperations("operation_id IN (SELECT operation_id FROM continuity_upkeep_operations o,json_each(o.reservation,'$.progress.spans') s JOIN continuity_records r ON r.ordinal=json_extract(s.value,'$.ordinal') WHERE r.generation_id=OLD.generation_id)")}
      UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.digest','','$.offset',0) WHERE ${generationScope} AND json_extract(cursor,'$.ordinal') IN (SELECT ordinal FROM continuity_records WHERE generation_id=OLD.generation_id);
      DELETE FROM continuity_upkeep_offers WHERE ${generationOrdinals} AND state<>'uncertain';
      UPDATE continuity_upkeep_offers SET span_key=operation_id||':'||ordinal||':'||start,source_digest='',ledger_id=NULL WHERE ${generationOrdinals} AND state='uncertain'; END;
      CREATE TRIGGER continuity_upkeep_privacy_delete BEFORE DELETE ON continuity_records WHEN ${active} BEGIN ${erase} END;
      CREATE TRIGGER continuity_upkeep_privacy_update BEFORE UPDATE OF retained_text,text_sha256 ON continuity_records
        WHEN ${active} AND OLD.retained_text IS NOT NULL AND (NEW.retained_text IS NULL OR NEW.retained_text<>OLD.retained_text OR NEW.text_sha256<>OLD.text_sha256) BEGIN ${erase} END;
      CREATE TRIGGER continuity_upkeep_privacy_tombstone AFTER UPDATE OF retained_text ON continuity_records
        WHEN ${active} AND NEW.retained_text IS NULL BEGIN UPDATE continuity_records SET text_sha256='',source_json='{}',summary_json=NULL WHERE ordinal=NEW.ordinal; END;
      INSERT INTO continuity_upkeep_migrations VALUES (3);`);
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
    AND (json_type(reservation,'$.progress') IS NOT NULL OR json_extract(reservation,'$.purged')=1)
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
  const floor = Number((cursor as Row | undefined)?.retiredThrough ?? 0);
  if (cursor && floor >= cursor.ordinal) cursor = { ...cursor, ordinal: floor + 1, offset: 0, digest: "" };
  const rewind = db.prepare(`SELECT min(o.ordinal) ordinal FROM continuity_upkeep_offers o JOIN continuity_records r ON r.ordinal=o.ordinal AND r.text_sha256=o.source_digest AND r.retained_text IS NOT NULL
    WHERE o.logical_id=? AND o.conversation_id=? AND o.ordinal>? AND (o.state='unrepresented' AND o.attempt=0 OR o.state='available' OR o.state='reofferable' AND ?)`)
    .get(...args, floor, Number(!!cursor && cursor.ordinal > watermark)) as Row;
  if (rewind.ordinal !== null && cursor && rewind.ordinal <= cursor.ordinal) cursor = { ...cursor, ordinal: rewind.ordinal, offset: 0, digest: "" };
  const failed = Number((db.prepare(`SELECT count(*) n FROM continuity_upkeep_offers o JOIN continuity_records r ON r.ordinal=o.ordinal AND r.text_sha256=o.source_digest
    WHERE o.logical_id=? AND o.conversation_id=? AND (o.state IN ('failed','uncertain','pending','pending_retry','reofferable','oversized','analyzed','lost') OR o.state='unrepresented' AND o.attempt>=1) AND r.retained_text IS NOT NULL`).get(...args) as Row).n);
  return { cursor, failed: failed + Number(floor > 0) };
}
export function offeredKeys(db: DatabaseSync, logicalId: string, conversationId: string, ordinals: readonly number[]): string[] {
  if (!ordinals.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_offers'").get()) return [];
  return (db.prepare(`SELECT span_key FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND (state NOT IN ('unrepresented','available','reofferable') OR state='unrepresented' AND attempt>=1) AND ordinal IN (${ordinals.map(() => "?").join(",")})`).all(logicalId, conversationId, ...ordinals) as Row[]).map(row => row.span_key);
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
    const old = db.prepare("SELECT state,operation_id,attempt FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND span_key=?").get(r.logicalId, r.conversationId, span.key) as Row | undefined;
    if (old?.state === state && old.operation_id === r.operationId) continue;
    if (old && (!["unrepresented", "available", "reofferable"].includes(old.state) || old.state === "unrepresented" && old.attempt >= 1)) throw new Error("upkeep_progress_repeat");
    db.prepare("INSERT INTO continuity_upkeep_offers VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(logical_id,conversation_id,span_key) DO UPDATE SET operation_id=excluded.operation_id,state=excluded.state,ledger_id=NULL,attempt=excluded.attempt").run(r.logicalId, r.conversationId, r.incarnation, span.key, span.ordinal, span.digest, span.start, span.end, r.operationId, state, Number(old?.attempt ?? 0) + Number(old?.state === "reofferable" || old?.state === "unrepresented"));
  }
  if (advance) db.prepare("INSERT INTO continuity_upkeep_progress VALUES (?,?,?,?) ON CONFLICT(logical_id,conversation_id) DO UPDATE SET incarnation=excluded.incarnation,cursor=json_set(excluded.cursor,'$.retiredThrough',coalesce(json_extract(continuity_upkeep_progress.cursor,'$.retiredThrough'),0))").run(r.logicalId, r.conversationId, r.incarnation, JSON.stringify({ ...cursor, touchedAt: Date.now() }));
}
export function representProgress(db: DatabaseSync, generation: LedgerGeneration, key: (span: LedgerGeneration["spans"][number]) => string, operationId?: string): void {
  for (const span of generation.spans) if (generation.coveredSpans?.includes(span.id)) {
    db.prepare("UPDATE continuity_upkeep_offers SET state='represented',ledger_id=? WHERE logical_id=? AND conversation_id=? AND span_key=?").run(generation.id, generation.logicalId, generation.conversationId, key(span));
  }
  if (operationId) {
    db.prepare("UPDATE continuity_upkeep_offers SET state=CASE WHEN state='pending_retry' AND attempt=0 THEN 'reofferable' ELSE 'analyzed' END WHERE operation_id=? AND state IN ('pending','pending_retry')").run(operationId);
    reclaimProgress(db, generation.logicalId, generation.conversationId);
  }
}

/** Logical retained bytes, including UTF-8 metadata and fixed per-row overhead. */
export function upkeepBytes(db: DatabaseSync): number {
  let bytes = 0;
  for (const [table, columns, fixed] of [
    ["continuity_upkeep_operations", "operation_id,logical_id,conversation_id,incarnation,owner_token,reservation,selection_key,budget,state,outcome", 72],
    ["continuity_upkeep_offers", "logical_id,conversation_id,incarnation,span_key,source_digest,operation_id,state,ledger_id", 96],
    ["continuity_upkeep_progress", "logical_id,conversation_id,incarnation,cursor", 64],
  ] as const) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) continue;
    const size = columns.split(",").map(column => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
    bytes += Number((db.prepare(`SELECT coalesce(sum(${fixed}+${size}),0) n FROM ${table}`).get() as Row).n);
  }
  return bytes;
}
/** Retire inactive working sets in LRU order. A content-free ordinal floor prevents
 * reclamation from making previously purchased evidence eligible again. */
export function reclaimUpkeepQuota(db: DatabaseSync, fits: () => boolean): void {
  if (fits() || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return;
  const progress = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_progress'").get();
  const offers = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_offers'").get();
  const candidates = progress ? `SELECT logical_id,conversation_id,cursor FROM continuity_upkeep_progress UNION ALL
    SELECT DISTINCT logical_id,conversation_id,NULL FROM continuity_upkeep_operations o WHERE NOT EXISTS
    (SELECT 1 FROM continuity_upkeep_progress p WHERE p.logical_id=o.logical_id AND p.conversation_id=o.conversation_id)`
    : "SELECT DISTINCT logical_id,conversation_id,NULL cursor FROM continuity_upkeep_operations";
  const scopes = db.prepare(`SELECT p.* FROM (${candidates}) p WHERE
    NOT EXISTS (SELECT 1 FROM continuity_upkeep_operations o WHERE o.logical_id=p.logical_id AND o.conversation_id=p.conversation_id AND o.state NOT IN ('terminal','released')) AND
    ${offers ? "NOT EXISTS (SELECT 1 FROM continuity_upkeep_offers o WHERE o.logical_id=p.logical_id AND o.conversation_id=p.conversation_id AND o.state IN ('uncertain','pending','pending_retry'))" : "1"}
    ORDER BY coalesce(json_extract(p.cursor,'$.touchedAt'),0),p.logical_id,p.conversation_id`).all() as Row[];
  for (const scope of scopes) {
    if (fits()) break;
    const args = [scope.logical_id, scope.conversation_id], cursor = scope.cursor ? JSON.parse(scope.cursor) : undefined;
    const last = offers ? Number((db.prepare("SELECT coalesce(max(ordinal),0) n FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=?").get(...args) as Row).n) : 0;
    if (cursor) {
      const floor = Math.max(cursor.retiredThrough ?? 0, cursor.ordinal - 1, last);
      db.prepare("UPDATE continuity_upkeep_progress SET cursor=? WHERE logical_id=? AND conversation_id=?").run(JSON.stringify({ ...cursor, ordinal: Math.max(cursor.ordinal, floor + 1), offset: 0, digest: "", retiredThrough: floor }), ...args);
    }
    if (offers) db.prepare("DELETE FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND state<>'uncertain'").run(...args);
    db.prepare("DELETE FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? AND state IN ('terminal','released')").run(...args);
  }
}
