import type { DatabaseSync } from "node:sqlite";
import type { LedgerGeneration } from "./ledger.js";
import type { LedgerCursor, LedgerProgress } from "../tool-history/continuity-contracts.js";
import { compactRetired, eraseRetiredSql, geometryKey, readRetired, writeRetired, representationDeleteSql, RETIRED_IDENTITY_LIMIT } from "./retirement.js";
import { advanceFrontier, progressKey, progressSource, validateProgressSpan } from "./frontier.js";
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
  if (!(db.prepare("PRAGMA table_info(continuity_upkeep_offers)").all() as Row[]).some(row => row.name === "offer_count")) {
    db.exec(`ALTER TABLE continuity_upkeep_offers ADD COLUMN offer_count INTEGER NOT NULL DEFAULT 0;
      UPDATE continuity_upkeep_offers SET offer_count=CASE WHEN state='oversized' THEN 0 WHEN attempt>=1 THEN 2 WHEN state='available' THEN 0 ELSE 1 END;
      UPDATE continuity_upkeep_offers SET state='analyzed' WHERE state IN ('available','reofferable') AND offer_count>=2;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS continuity_upkeep_retired (
    logical_id TEXT NOT NULL,conversation_id TEXT NOT NULL,incarnation TEXT NOT NULL,chunk INTEGER NOT NULL,
    version INTEGER NOT NULL,data BLOB NOT NULL,ledger_id TEXT,PRIMARY KEY(logical_id,conversation_id,chunk));`);
  db.exec("UPDATE continuity_upkeep_offers SET state='lost' WHERE state='unrepresented' AND offer_count>=2");
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return;
  if (!db.prepare("SELECT 1 FROM continuity_upkeep_migrations WHERE version=2").get()) {
    db.exec(scrubOperations("json_type(reservation,'$.progress') IS NULL"));
    db.exec("INSERT INTO continuity_upkeep_migrations VALUES (2)");
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_records'").get() && !db.prepare("SELECT 1 FROM continuity_upkeep_migrations WHERE version=6").get()) {
    const scope = "(logical_id,conversation_id) IN (SELECT logical_id,conversation_id FROM continuity_generations WHERE generation_id=OLD.generation_id UNION SELECT logical_id,conversation_id FROM continuity_upkeep_offers WHERE ordinal=OLD.ordinal)";
    const active = `(EXISTS (SELECT 1 FROM continuity_upkeep_progress WHERE ${scope}) OR EXISTS (SELECT 1 FROM continuity_upkeep_offers WHERE ordinal=OLD.ordinal) OR EXISTS (SELECT 1 FROM continuity_upkeep_retired WHERE ${scope}))`;
    const affected = "operation_id IN (SELECT operation_id FROM continuity_upkeep_operations o,json_each(o.reservation,'$.progress.spans') s WHERE json_extract(s.value,'$.ordinal')=OLD.ordinal)";
    const recordScope = "logical_id=(SELECT logical_id FROM continuity_generations WHERE generation_id=OLD.generation_id) AND conversation_id=(SELECT conversation_id FROM continuity_generations WHERE generation_id=OLD.generation_id)";
    const erase = `${eraseRetiredSql(recordScope, "$ordinal=printf('%016X',OLD.ordinal)")}${scrubOperations(affected)}
      UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.digest','','$.offset',0) WHERE ${scope} AND json_extract(cursor,'$.ordinal')=OLD.ordinal;
      DELETE FROM continuity_upkeep_offers WHERE ordinal=OLD.ordinal AND state<>'uncertain';
      UPDATE continuity_upkeep_offers SET span_key=operation_id||':'||rowid,source_digest='',ledger_id=NULL,ordinal=0,start=0,end=0 WHERE ordinal=OLD.ordinal AND state='uncertain';`;
    const generationScope = "logical_id=OLD.logical_id AND conversation_id=OLD.conversation_id";
    const generationOrdinals = "ordinal IN (SELECT ordinal FROM continuity_records WHERE generation_id=OLD.generation_id)";
    db.exec(`DROP TRIGGER IF EXISTS continuity_upkeep_privacy_generation; DROP TRIGGER IF EXISTS continuity_upkeep_privacy_delete;
      DROP TRIGGER IF EXISTS continuity_upkeep_privacy_update; DROP TRIGGER IF EXISTS continuity_upkeep_privacy_tombstone;
      CREATE TRIGGER continuity_upkeep_privacy_generation BEFORE DELETE ON continuity_generations
      WHEN EXISTS (SELECT 1 FROM continuity_upkeep_progress WHERE ${generationScope}) OR EXISTS (SELECT 1 FROM continuity_upkeep_offers WHERE ${generationOrdinals}) OR EXISTS (SELECT 1 FROM continuity_upkeep_retired WHERE ${generationScope}) BEGIN
      ${eraseRetiredSql(generationScope, "$ordinal IN (SELECT printf('%016X',ordinal) FROM continuity_records WHERE generation_id=OLD.generation_id)")}
      ${scrubOperations("operation_id IN (SELECT operation_id FROM continuity_upkeep_operations o,json_each(o.reservation,'$.progress.spans') s JOIN continuity_records r ON r.ordinal=json_extract(s.value,'$.ordinal') WHERE r.generation_id=OLD.generation_id)")}
      UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.digest','','$.offset',0) WHERE ${generationScope} AND json_extract(cursor,'$.ordinal') IN (SELECT ordinal FROM continuity_records WHERE generation_id=OLD.generation_id);
      DELETE FROM continuity_upkeep_offers WHERE ${generationOrdinals} AND state<>'uncertain';
      UPDATE continuity_upkeep_offers SET span_key=operation_id||':'||rowid,source_digest='',ledger_id=NULL,ordinal=0,start=0,end=0 WHERE ${generationOrdinals} AND state='uncertain'; END;
      CREATE TRIGGER continuity_upkeep_privacy_delete BEFORE DELETE ON continuity_records WHEN ${active} BEGIN ${erase} END;
      CREATE TRIGGER continuity_upkeep_privacy_update BEFORE UPDATE OF retained_text,text_sha256 ON continuity_records
        WHEN ${active} AND OLD.retained_text IS NOT NULL AND (NEW.retained_text IS NULL OR NEW.retained_text<>OLD.retained_text OR NEW.text_sha256<>OLD.text_sha256) BEGIN ${erase} END;
      CREATE TRIGGER continuity_upkeep_privacy_tombstone AFTER UPDATE OF retained_text ON continuity_records
        WHEN ${active} AND NEW.retained_text IS NULL BEGIN UPDATE continuity_records SET text_sha256='',source_json='{}',summary_json=NULL WHERE ordinal=NEW.ordinal; END;
      INSERT INTO continuity_upkeep_migrations VALUES (6);`);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_ledger'").get()) db.exec(representationDeleteSql());
  }
}
export function purgeUpkeepProgress(db: DatabaseSync, kind: "logical" | "physical", id: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return;
  const column = kind === "logical" ? "logical_id" : "conversation_id";
  db.prepare(scrubOperations(`${column}=?`)).run(id);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_progress'").get()) return;
  db.prepare(`UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.digest','','$.offset',0) WHERE ${column}=?`).run(id);
  db.prepare(`DELETE FROM continuity_upkeep_retired WHERE ${column}=?`).run(id);
  db.prepare(`DELETE FROM continuity_upkeep_offers WHERE ${column}=? AND state<>'uncertain'`).run(id);
  db.prepare(`UPDATE continuity_upkeep_offers SET span_key=operation_id||':'||rowid,source_digest='',ledger_id=NULL,ordinal=0,start=0,end=0 WHERE ${column}=? AND state='uncertain'`).run(id);
}
/** Keep live anti-repurchase/representation evidence. Reclaim only proof-obsolete offers
 * and the terminal journal tail; unknown operations and the separate marker never expire. */
export function reclaimProgress(db: DatabaseSync, logicalId: string, conversationId: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return;
  db.prepare(`DELETE FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? AND state IN ('terminal','released')
    AND fence<(SELECT fence FROM continuity_upkeep_scopes s WHERE s.logical_id=continuity_upkeep_operations.logical_id AND s.conversation_id=continuity_upkeep_operations.conversation_id)
    AND (json_type(reservation,'$.progress') IS NOT NULL OR json_extract(reservation,'$.purged')=1)
    AND operation_id NOT IN (SELECT operation_id FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 64)`)
    .run(logicalId, conversationId, logicalId, conversationId);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_records'").get() || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_offers'").get()) return;
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
    WHERE o.logical_id=? AND o.conversation_id=? AND o.ordinal>? AND o.offer_count<2 AND (o.state IN ('unrepresented','available') OR o.state='reofferable' AND ?)`)
    .get(...args, floor, Number(!!cursor && cursor.ordinal > watermark)) as Row;
  if (rewind.ordinal !== null && cursor && rewind.ordinal <= cursor.ordinal) cursor = { ...cursor, ordinal: rewind.ordinal, offset: 0, digest: "" };
  const failed = Number((db.prepare(`SELECT count(*) n FROM continuity_upkeep_offers o JOIN continuity_records r ON r.ordinal=o.ordinal AND r.text_sha256=o.source_digest
    WHERE o.logical_id=? AND o.conversation_id=? AND (o.state IN ('failed','uncertain','pending','pending_retry','reofferable','oversized','analyzed','lost') OR o.state='unrepresented' AND o.offer_count>=2) AND r.retained_text IS NOT NULL`).get(...args) as Row).n);
  const retired = readRetired(db, logicalId, conversationId);
  const eligible = retired.filter(s => s.ordinal > floor && s.count < 2 && (s.state === "unrepresented" || s.state === "available" || s.state === "reofferable" && !!cursor && cursor.ordinal > watermark));
  const first = eligible.reduce((n, s) => Math.min(n, s.ordinal), Infinity);
  if (cursor && first <= cursor.ordinal) cursor = { ...cursor, ordinal: first, offset: 0, digest: "" };
  return { cursor, failed: failed + retired.filter(s => !['represented','available','unrepresented'].includes(s.state)).length + Number(floor > 0) };
}
export function offeredKeys(db: DatabaseSync, logicalId: string, conversationId: string, ordinals: readonly number[]): string[] {
  if (!ordinals.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_offers'").get()) return [];
  const keys = (db.prepare(`SELECT span_key FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND (state NOT IN ('unrepresented','available','reofferable','analyzed') OR offer_count>=2) AND ordinal IN (${ordinals.map(() => "?").join(",")})`).all(logicalId, conversationId, ...ordinals) as Row[]).map(row => row.span_key);
  const sources = new Map<number, Row>();
  for (const s of readRetired(db, logicalId, conversationId)) if (ordinals.includes(s.ordinal) && (!['unrepresented','available','reofferable','analyzed'].includes(s.state) || s.count >= 2)) {
    let source = sources.get(s.ordinal);
    if (!source) { source = progressSource(db, logicalId, conversationId, s.ordinal); sources.set(s.ordinal, source); }
    keys.push(progressKey(source, s));
  }
  return keys;
}
export function dispatchProgress(db: DatabaseSync, r: { logicalId: string; conversationId: string; incarnation: string; operationId: string; progress?: LedgerProgress }, state = "uncertain", advance = true): void {
  if (!r.progress) return;
  const { cursor, spans } = r.progress, args = [r.logicalId, r.conversationId] as const;
  if (!Number.isSafeInteger(cursor.ordinal) || cursor.ordinal < 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.watermark) || cursor.watermark < 0 || !(cursor.offset === 0 && cursor.digest === "" || /^[a-f0-9]{64}$/u.test(cursor.digest)) || spans.length > 256) throw new Error("upkeep_progress_bounds");
  const saved = db.prepare("SELECT cursor FROM continuity_upkeep_progress WHERE logical_id=? AND conversation_id=?").get(...args) as Row | undefined;
  const floor = saved ? Number(JSON.parse(saved.cursor).retiredThrough ?? 0) : 0;
  const retired = readRetired(db, ...args), remaining = new Map(retired.map(s => [geometryKey(s), s]));
  const identities = new Set([...retired.map(geometryKey), ...(db.prepare("SELECT ordinal,start,end FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=?").all(...args) as Row[]).map(s => geometryKey({ ordinal: s.ordinal, start: s.start, end: s.end }))]);
  const sources = new Map<number, Row>(); let bytes = 0;
  for (const span of spans) {
    if (!/^[a-f0-9]{64}$/u.test(span.digest) || !/^[a-f0-9]{64}$/u.test(span.key) || !Number.isSafeInteger(span.ordinal) || span.ordinal < 1 || span.ordinal > cursor.watermark || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > 1024 * 1024) throw new Error("upkeep_progress_bounds");
    if (span.ordinal <= floor) throw new Error("upkeep_progress_repeat");
    let source = sources.get(span.ordinal);
    if (!source) { source = progressSource(db, r.logicalId, r.conversationId, span.ordinal); sources.set(span.ordinal, source); bytes += Buffer.byteLength(source.retained_text); }
    if (bytes > 4 * 1024 * 1024) throw new Error("upkeep_progress_bounds");
    validateProgressSpan(source, span);
    const identity = geometryKey(span), compact = remaining.get(identity);
    const working = db.prepare("SELECT * FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND (span_key=? OR ordinal=? AND start=? AND end=?)").get(...args, span.key, span.ordinal, span.start, span.end) as Row | undefined;
    if (working && working.span_key !== span.key) throw new Error("upkeep_progress_source_changed");
    if (working?.state === state && working.operation_id === r.operationId) continue;
    const old = working ?? (compact ? { state: compact.state, offer_count: compact.count } : undefined);
    if (old && (!['unrepresented','available','reofferable','analyzed'].includes(old.state) || old.offer_count >= 2)) throw new Error("upkeep_progress_repeat");
    identities.add(identity); if (identities.size > RETIRED_IDENTITY_LIMIT) throw new Error("upkeep_progress_capacity");
    remaining.delete(identity);
    const count = Number(old?.offer_count ?? 0) + Number(state !== "oversized");
    db.prepare(`INSERT INTO continuity_upkeep_offers VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(logical_id,conversation_id,span_key)
      DO UPDATE SET operation_id=excluded.operation_id,state=excluded.state,ledger_id=NULL,attempt=excluded.attempt,offer_count=excluded.offer_count`)
      .run(...args, r.incarnation, span.key, span.ordinal, span.digest, span.start, span.end, r.operationId, state, Math.max(0, count - 1), count);
  }
  if (remaining.size !== retired.length) {
    const ledger = db.prepare("SELECT ledger_id FROM continuity_upkeep_retired WHERE logical_id=? AND conversation_id=? LIMIT 1").get(...args) as Row;
    writeRetired(db, r.logicalId, r.conversationId, r.incarnation, [...remaining.values()], ledger.ledger_id);
  }
  // Even an oversized-only request is verified against earlier holes; a late
  // oversized tuple cannot move or rewind a frontier on its own.
  if (advance) advanceFrontier(db, r.logicalId, r.conversationId, cursor, [...remaining.values()]);
}
export function representProgress(db: DatabaseSync, generation: LedgerGeneration, key: (span: LedgerGeneration["spans"][number]) => string, operationId?: string): void {
  for (const span of generation.spans) if (generation.coveredSpans?.includes(span.id)) {
    db.prepare("UPDATE continuity_upkeep_offers SET state='represented',ledger_id=? WHERE logical_id=? AND conversation_id=? AND span_key=?").run(generation.id, generation.logicalId, generation.conversationId, key(span));
  }
  if (operationId) {
    db.prepare("UPDATE continuity_upkeep_offers SET state=CASE WHEN state='pending_retry' AND offer_count<2 THEN 'reofferable' ELSE 'analyzed' END WHERE operation_id=? AND state IN ('pending','pending_retry')").run(operationId);
    reclaimProgress(db, generation.logicalId, generation.conversationId);
  }
}

/** Logical retained bytes, including UTF-8 metadata and fixed per-row overhead. */
export function upkeepBytes(db: DatabaseSync): number {
  let bytes = 0;
  for (const [table, columns, fixed] of [
    ["continuity_upkeep_operations", "operation_id,logical_id,conversation_id,incarnation,owner_token,reservation,selection_key,budget,state,outcome", 72],
    ["continuity_upkeep_offers", "logical_id,conversation_id,incarnation,span_key,source_digest,operation_id,state,ledger_id", 104],
    ["continuity_upkeep_progress", "logical_id,conversation_id,incarnation,cursor", 64],
    ["continuity_upkeep_retired", "logical_id,conversation_id,incarnation,data,ledger_id", 80],
  ] as const) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) continue;
    const size = columns.split(",").map(column => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
    bytes += Number((db.prepare(`SELECT coalesce(sum(${fixed}+${size}),0) n FROM ${table}`).get() as Row).n);
  }
  return bytes;
}
/** Compact inactive working sets in LRU order. Exact sparse identities retain
 * count/state without retiring unpaid holes or extending inherited legacy floors. */
export function reclaimUpkeepQuota(db: DatabaseSync, fits: () => boolean): void {
  if (fits() || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_operations'").get()) return;
  const progress = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_progress'").get();
  const offers = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_offers'").get();
  const candidates = `SELECT s.logical_id,s.conversation_id,${progress ? "p.cursor" : "NULL"} cursor FROM
    (${progress ? "SELECT logical_id,conversation_id FROM continuity_upkeep_progress UNION " : ""}
      SELECT logical_id,conversation_id FROM continuity_upkeep_operations
      ${offers ? "UNION SELECT logical_id,conversation_id FROM continuity_upkeep_offers" : ""}) s
    ${progress ? "LEFT JOIN continuity_upkeep_progress p USING(logical_id,conversation_id)" : ""}`;
  const scopes = db.prepare(`SELECT p.* FROM (${candidates}) p WHERE
    NOT EXISTS (SELECT 1 FROM continuity_upkeep_operations o WHERE o.logical_id=p.logical_id AND o.conversation_id=p.conversation_id AND o.state NOT IN ('terminal','released')) AND
    ${offers ? "NOT EXISTS (SELECT 1 FROM continuity_upkeep_offers o WHERE o.logical_id=p.logical_id AND o.conversation_id=p.conversation_id AND o.state IN ('uncertain','pending','pending_retry'))" : "1"}
    ORDER BY coalesce(json_extract(p.cursor,'$.touchedAt'),0),p.logical_id,p.conversation_id`).all() as Row[];
  for (const scope of scopes) {
    if (fits()) break;
    const args = [scope.logical_id, scope.conversation_id];
    if (offers) {
      // Decode before any scope mutation. Corrupt scope evidence stays closed to
      // admission, but must not prevent unrelated retention/source eviction.
      try { readRetired(db, scope.logical_id, scope.conversation_id); }
      catch (error) {
        if (!(error instanceof Error) || !/^upkeep_(?:retirement_|progress_capacity$)/u.test(error.message)) throw error;
        process.emitWarning("Skipping upkeep compaction for invalid retirement state.", { code: "UPKEEP_RETIREMENT_CORRUPT" });
        continue;
      }
      reclaimProgress(db, scope.logical_id, scope.conversation_id);
    }
    const working = offers && !!db.prepare("SELECT 1 FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=?").get(...args);
    if (offers) compactRetired(db, scope.logical_id, scope.conversation_id);
    const removed = db.prepare("DELETE FROM continuity_upkeep_operations WHERE logical_id=? AND conversation_id=? AND state IN ('terminal','released')").run(...args).changes;
    // Packed tuples intentionally carry no operation IDs. Expire the settled
    // owner before forgetting its journal, so a delayed reserve+dispatch replay
    // cannot recreate a purchase under the same fence after compaction.
    if (offers && (working || removed)) db.prepare("UPDATE continuity_upkeep_scopes SET fence=fence+1,owner_token='' WHERE logical_id=? AND conversation_id=?").run(...args);
  }
}
