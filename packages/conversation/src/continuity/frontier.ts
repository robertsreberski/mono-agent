import type { DatabaseSync } from "node:sqlite";
import type { LedgerCursor, LedgerOffer } from "../tool-history/continuity-contracts.js";
import { ledgerHash, spanKey } from "./ledger.js";
import { ledgerWindows } from "./span-geometry.js";
import { geometryKey, type RetiredOffer } from "./retirement.js";
type Row = Record<string, any>;
export function progressSource(db: DatabaseSync, logical: string, physical: string, ordinal: number, toolBinding = true): Row {
  const row = db.prepare(`SELECT r.* FROM continuity_records r JOIN continuity_generations g USING(generation_id)
    WHERE r.ordinal=? AND g.logical_id=? AND g.conversation_id=? AND g.state='committed' AND r.finalized=1 AND r.retained_text IS NOT NULL AND length(CAST(r.retained_text AS BLOB))<=1048576 AND length(CAST(r.source_json AS BLOB))<=65536
    AND NOT EXISTS (SELECT 1 FROM continuity_generations pending WHERE pending.conversation_id=g.conversation_id AND pending.state='prepared' AND pending.action IN ('reset','delete'))`).get(ordinal, logical, physical) as Row | undefined;
  if (!row || ledgerHash(row.retained_text) !== row.text_sha256) throw new Error("upkeep_progress_source_changed");
  const source = JSON.parse(row.source_json);
  row.owner = row.kind === "owner" && row.provenance === "host-owner" && !!row.input_id && source.attestation?.inputId === row.input_id;
  if (toolBinding && row.kind === "tool") {
    db.function("continuity_tool_operation", { deterministic: true }, (conversation, run, call) => `tool:${ledgerHash(JSON.stringify([conversation, run, call]))}`);
    const call = db.prepare(`SELECT tool_name FROM tool_calls WHERE conversation_id=? AND run_id=? AND end_seq IS NOT NULL
      AND continuity_tool_operation(conversation_id,run_id,tool_call_id)=? LIMIT 1`).get(physical, row.run_id, source.operationId ?? "") as Row | undefined;
    if (!call) throw new Error("upkeep_progress_source_changed");
    row.toolName = call.tool_name;
  }
  return row;
}
export function progressKey(row: Row, span: Pick<LedgerOffer, "start" | "end">): string {
  return spanKey({ id: "", recordId: row.record_id, sha256: row.text_sha256, start: span.start, end: span.end,
    digest: ledgerHash(Buffer.from(row.retained_text).subarray(span.start, span.end)), owner: row.owner, kind: row.kind,
    ...(row.toolName ? { toolName: row.toolName } : {}) });
}
export function validateProgressSpan(row: Row, span: LedgerOffer): void {
  if (row.text_sha256 !== span.digest || progressKey(row, span) !== span.key) throw new Error("upkeep_progress_source_changed");
  for (const s of ledgerWindows(row.retained_text, row.owner)) if (s.start === span.start && s.end === span.end) return;
  throw new Error("upkeep_progress_source_changed");
}
const before = (a: LedgerCursor, b: LedgerCursor) => a.ordinal < b.ordinal || a.ordinal === b.ordinal && a.offset < b.offset;
/** The request cursor is an upper bound, NOT evidence of a contiguous prefix.
 * Derive advancement from canonical geometry and acknowledged/oversized identities.
 * Bounded verification may under-advance, never skip an unpaid hole. */
export function advanceFrontier(db: DatabaseSync, logical: string, physical: string, bound: LedgerCursor, retired: readonly RetiredOffer[]): void {
  const args = [logical, physical], old = db.prepare("SELECT cursor FROM continuity_upkeep_progress WHERE logical_id=? AND conversation_id=?").get(...args) as Row | undefined;
  const previous = old ? JSON.parse(old.cursor) : { ordinal: 1, offset: 0, digest: "", watermark: 0 };
  let cursor: LedgerCursor = { ...previous, watermark: Math.max(previous.watermark, bound.watermark) };
  if ((previous.retiredThrough ?? 0) >= cursor.ordinal) cursor = { ...cursor, ordinal: previous.retiredThrough + 1, offset: 0, digest: "" };
  const evidence = new Set(retired.filter(s => s.count > 0 || s.state === "oversized").map(geometryKey));
  for (const s of db.prepare("SELECT ordinal,start,end FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND (offer_count>0 OR state='oversized')").all(...args) as Row[]) evidence.add(geometryKey({ ordinal: s.ordinal, start: s.start, end: s.end }));
  if (before(cursor, bound)) {
    const records = db.prepare(`SELECT r.ordinal,length(CAST(r.retained_text AS BLOB)) bytes FROM continuity_records r JOIN continuity_generations g USING(generation_id)
      WHERE g.logical_id=? AND g.conversation_id=? AND g.state='committed' AND r.finalized=1 AND r.retained_text IS NOT NULL
      AND r.ordinal>=? AND r.ordinal<=? AND r.ordinal<=? AND (r.kind IN ('owner','user','other-user','imported','tool') OR
      r.kind='summary' AND EXISTS (SELECT 1 FROM continuity_pins p WHERE p.record_id=r.record_id AND p.owner_kind='summary' AND p.owner_id=?)) ORDER BY r.ordinal LIMIT 512`)
      .all(...args, cursor.ordinal, bound.ordinal, bound.watermark, logical) as Row[];
    let bytes = 0, windows = 0;
    outer: for (const record of records) {
      if ((bytes += record.bytes) > 4 * 1024 * 1024) break;
      const row = progressSource(db, logical, physical, record.ordinal, false);
      const resume = cursor.ordinal === row.ordinal && cursor.digest === row.text_sha256 ? cursor.offset : 0;
      for (const s of ledgerWindows(row.retained_text, row.owner)) {
        if (++windows > 65536) break outer;
        if (s.start < resume) continue;
        const position = { ordinal: row.ordinal, offset: s.start, digest: row.text_sha256, watermark: cursor.watermark };
        if (!before(position, bound)) break outer;
        if (!evidence.has(geometryKey({ ordinal: row.ordinal, ...s }))) { cursor = position; break outer; }
        const data = Buffer.from(row.retained_text); let offset = s.end;
        if (offset < data.length) { if (data.subarray(offset, offset + 2).toString() === "\n\n") offset += 2;
          else { offset -= 256; while ((data[offset]! & 0xc0) === 0x80) offset++; } }
        cursor = { ordinal: row.ordinal + Number(s.end >= data.length), offset: s.end >= data.length ? 0 : offset,
          digest: s.end >= data.length ? "" : row.text_sha256, watermark: cursor.watermark };
      }
    }
  }
  db.prepare("INSERT INTO continuity_upkeep_progress VALUES (?,?,?,?) ON CONFLICT(logical_id,conversation_id) DO UPDATE SET cursor=excluded.cursor")
    .run(logical, physical, (db.prepare("SELECT incarnation FROM continuity_upkeep_scopes WHERE logical_id=? AND conversation_id=?").get(...args) as Row).incarnation, JSON.stringify({ ...cursor, ...(previous.retiredThrough === undefined ? {} : { retiredThrough: previous.retiredThrough }), touchedAt: Date.now() }));
}
