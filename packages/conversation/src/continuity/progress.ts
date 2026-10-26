import type { DatabaseSync } from "node:sqlite";
import type { LedgerGeneration } from "./ledger.js";

import type { LedgerCursor, LedgerProgress } from "../tool-history/continuity-contracts.js";
type Row = Record<string, any>;
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
}
export function readProgress(db: DatabaseSync, logicalId: string, conversationId: string): { cursor?: LedgerCursor | undefined; failed: number } {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_progress'").get()) return { failed: 0 };
  const args = [logicalId, conversationId];
  const row = db.prepare("SELECT cursor FROM continuity_upkeep_progress WHERE logical_id=? AND conversation_id=?").get(...args) as Row | undefined;
  let cursor: LedgerCursor | undefined = row ? JSON.parse(row.cursor) : undefined;
  const rewind = db.prepare("SELECT min(o.ordinal) ordinal FROM continuity_upkeep_offers o JOIN continuity_records r ON r.ordinal=o.ordinal AND r.text_sha256=o.source_digest AND r.retained_text IS NOT NULL WHERE o.logical_id=? AND o.conversation_id=? AND o.state='unrepresented'").get(...args) as Row;
  if (rewind.ordinal !== null && cursor && rewind.ordinal <= cursor.ordinal) cursor = { ...cursor, ordinal: rewind.ordinal, offset: 0, digest: "" };
  const failed = Number((db.prepare("SELECT count(*) n FROM continuity_upkeep_offers o JOIN continuity_records r ON r.ordinal=o.ordinal AND r.text_sha256=o.source_digest WHERE o.logical_id=? AND o.conversation_id=? AND o.state IN ('failed','uncertain') AND r.retained_text IS NOT NULL").get(...args) as Row).n);
  return { cursor, failed };
}
export function offeredKeys(db: DatabaseSync, logicalId: string, conversationId: string, ordinals: readonly number[]): string[] {
  if (!ordinals.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_offers'").get()) return [];
  return (db.prepare(`SELECT span_key FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND state<>'unrepresented' AND ordinal IN (${ordinals.map(() => "?").join(",")})`).all(logicalId, conversationId, ...ordinals) as Row[]).map(row => row.span_key);
}
export function dispatchProgress(db: DatabaseSync, r: { logicalId: string; conversationId: string; incarnation: string; operationId: string; progress?: LedgerProgress }): void {
  if (!r.progress) return;
  const { cursor, spans } = r.progress;
  if (!Number.isSafeInteger(cursor.ordinal) || cursor.ordinal < 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.watermark) || cursor.watermark < 0 || !(cursor.offset === 0 && cursor.digest === "" || /^[a-f0-9]{64}$/u.test(cursor.digest)) || spans.length > 256) throw new Error("upkeep_progress_bounds");
  const n = Number((db.prepare("SELECT count(*) n FROM continuity_upkeep_offers").get() as Row).n);
  if (n + spans.length > 65536) throw new Error("upkeep_progress_capacity");
  for (const span of spans) {
    if (!/^[a-f0-9]{64}$/u.test(span.digest) || !/^[a-f0-9]{64}$/u.test(span.key) || !Number.isSafeInteger(span.ordinal) || span.ordinal < 1 || span.ordinal > cursor.watermark || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start) throw new Error("upkeep_progress_bounds");
    const source = db.prepare("SELECT r.text_sha256 FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE r.ordinal=? AND g.logical_id=? AND g.conversation_id=? AND g.state='committed' AND r.retained_text IS NOT NULL").get(span.ordinal, r.logicalId, r.conversationId) as Row | undefined;
    if (source?.text_sha256 !== span.digest) throw new Error("upkeep_progress_source_changed");
    const old = db.prepare("SELECT state FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND span_key=?").get(r.logicalId, r.conversationId, span.key) as Row | undefined;
    if (old && old.state !== "unrepresented") throw new Error("upkeep_progress_repeat");
    db.prepare("INSERT INTO continuity_upkeep_offers VALUES (?,?,?,?,?,?,?,?,?, 'uncertain',NULL) ON CONFLICT(logical_id,conversation_id,span_key) DO UPDATE SET operation_id=excluded.operation_id,state='uncertain',ledger_id=NULL").run(r.logicalId, r.conversationId, r.incarnation, span.key, span.ordinal, span.digest, span.start, span.end, r.operationId);
  }
  db.prepare("INSERT INTO continuity_upkeep_progress VALUES (?,?,?,?) ON CONFLICT(logical_id,conversation_id) DO UPDATE SET incarnation=excluded.incarnation,cursor=excluded.cursor").run(r.logicalId, r.conversationId, r.incarnation, JSON.stringify(cursor));
}
export function representProgress(db: DatabaseSync, generation: LedgerGeneration, key: (span: LedgerGeneration["spans"][number]) => string): void {
  for (const span of generation.spans) if (generation.coveredSpans?.includes(span.id)) {
    db.prepare("UPDATE continuity_upkeep_offers SET state='represented',ledger_id=? WHERE logical_id=? AND conversation_id=? AND span_key=?").run(generation.id, generation.logicalId, generation.conversationId, key(span));
  }
}
