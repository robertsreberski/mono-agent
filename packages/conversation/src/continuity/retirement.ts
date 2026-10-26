import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, any>;
export const RETIRED_IDENTITY_LIMIT = 65536;
const TUPLE_BYTES = 17, CHUNK_TUPLES = Math.floor(128 * 1024 / TUPLE_BYTES);
// Low two bits count actual/conservatively uncertain offers; upper bits preserve
// existing eligibility. No broader re-eligibility policy is enabled here.
const STATES = ["represented", "analyzed", "reofferable", "unrepresented", "available", "lost", "oversized", "failed"] as const;
export interface RetiredOffer { readonly ordinal: number; readonly start: number; readonly end: number; readonly count: number; readonly state: string }
export const geometryKey = (s: Pick<RetiredOffer, "ordinal" | "start" | "end">) => `${s.ordinal}:${s.start}:${s.end}`;
const compare = (a: RetiredOffer, b: RetiredOffer) => a.ordinal - b.ordinal || a.start - b.start || a.end - b.end;
function byte(s: RetiredOffer): number {
  const state = STATES.indexOf(s.state as typeof STATES[number]);
  if (state < 0 || !Number.isInteger(s.count) || s.count < 0 || s.count > 2) throw new Error("upkeep_retirement_state");
  return state * 4 + s.count;
}
function validate(s: RetiredOffer): void {
  if (!Number.isSafeInteger(s.ordinal) || s.ordinal < 1 || !Number.isInteger(s.start) || !Number.isInteger(s.end)
    || s.start < 0 || s.end <= s.start || s.end > 1024 * 1024) throw new Error("upkeep_retirement_geometry");
  byte(s);
}
export function readRetired(db: DatabaseSync, logical: string, physical: string): RetiredOffer[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_retired'").get()) return [];
  const result: RetiredOffer[] = [];
  const rows = db.prepare("SELECT version,incarnation,CASE WHEN length(data)<=131072 THEN data ELSE NULL END data FROM continuity_upkeep_retired WHERE logical_id=? AND conversation_id=? ORDER BY chunk LIMIT 10").all(logical, physical) as Row[];
  if (rows.length > 9) throw new Error("upkeep_retirement_encoding");
  const scope = rows.length ? db.prepare("SELECT incarnation FROM continuity_upkeep_scopes WHERE logical_id=? AND conversation_id=?").get(logical, physical) as Row | undefined : undefined;
  for (const row of rows) {
    if (!(row.data instanceof Uint8Array) || row.incarnation !== scope?.incarnation) throw new Error("upkeep_retirement_encoding");
    const data = Buffer.from(row.data);
    if (row.version !== 1 || !data.length || data.length > 128 * 1024 || data.length % TUPLE_BYTES) throw new Error("upkeep_retirement_encoding");
    for (let i = 0; i < data.length; i += TUPLE_BYTES) {
      const flag = data[i + 16]!, s = { ordinal: Number(data.readBigUInt64BE(i)), start: data.readUInt32BE(i + 8), end: data.readUInt32BE(i + 12), count: flag & 3, state: STATES[flag >> 2] ?? "invalid" };
      validate(s);
      if (result.length && compare(result.at(-1)!, s) >= 0) throw new Error("upkeep_retirement_order");
      result.push(s); if (result.length > RETIRED_IDENTITY_LIMIT) throw new Error("upkeep_progress_capacity");
    }
  }
  return result;
}
export function writeRetired(db: DatabaseSync, logical: string, physical: string, incarnation: string, entries: readonly RetiredOffer[], ledger: string | null): void {
  if (entries.length > RETIRED_IDENTITY_LIMIT) throw new Error("upkeep_progress_capacity");
  const sorted = [...entries].sort(compare);
  db.prepare("DELETE FROM continuity_upkeep_retired WHERE logical_id=? AND conversation_id=?").run(logical, physical);
  for (let base = 0; base < sorted.length; base += CHUNK_TUPLES) {
    const part = sorted.slice(base, base + CHUNK_TUPLES), data = Buffer.alloc(part.length * TUPLE_BYTES);
    part.forEach((s, i) => { validate(s); if (base + i && compare(sorted[base + i - 1]!, s) >= 0) throw new Error("upkeep_retirement_order");
      data.writeBigUInt64BE(BigInt(s.ordinal), i * TUPLE_BYTES); data.writeUInt32BE(s.start, i * TUPLE_BYTES + 8); data.writeUInt32BE(s.end, i * TUPLE_BYTES + 12); data[i * TUPLE_BYTES + 16] = byte(s); });
    db.prepare("INSERT INTO continuity_upkeep_retired VALUES (?,?,?,?,1,?,?)").run(logical, physical, incarnation, base / CHUNK_TUPLES, data, ledger);
  }
}
/** Pure SQLite rewriting also works for a delete issued by an older binary or an
 * independent connection: no connection-local UDF is required for privacy. */
function rewrite(where: string, expression: string): string {
  return `UPDATE continuity_upkeep_retired SET data=(WITH RECURSIVE slots(i) AS
    (SELECT 1 UNION ALL SELECT i+17 FROM slots WHERE i+17<=length(data))
    SELECT unhex(coalesce(group_concat(fragment,'' ORDER BY i),'')) FROM
      (SELECT i,${expression} fragment FROM slots)) WHERE ${where};
    DELETE FROM continuity_upkeep_retired WHERE length(data)=0;`;
}
export function eraseRetiredSql(where: string, ordinalHexPredicate: string): string {
  return rewrite(where, `CASE WHEN ${ordinalHexPredicate.replaceAll("$ordinal", "hex(substr(data,i,8))")} THEN '' ELSE hex(substr(data,i,17)) END`);
}
function invalidateRetiredRepresentationSql(): string {
  return rewrite("ledger_id=OLD.id", `hex(substr(data,i,16))||CASE hex(substr(data,i+16,1)) WHEN '01' THEN '0D' WHEN '02' THEN '16' ELSE hex(substr(data,i+16,1)) END`)
    + "UPDATE continuity_upkeep_retired SET ledger_id=NULL WHERE ledger_id=OLD.id;";
}
/** Shared by fresh schema creation and the ordered-rewrite migration. */
export function representationDeleteSql(): string {
  return `DROP TRIGGER IF EXISTS continuity_upkeep_representation_delete;
    CREATE TRIGGER continuity_upkeep_representation_delete AFTER DELETE ON continuity_ledger
    BEGIN UPDATE continuity_upkeep_offers SET state=CASE WHEN offer_count<2 THEN 'unrepresented' ELSE 'lost' END,ledger_id=NULL WHERE ledger_id=OLD.id AND state='represented'; ${invalidateRetiredRepresentationSql()} END;`;
}
/** Compact only a settled scope. Keeping representation's opaque ledger binding
 * permits exact reconstruction after later invalidation, including after restart. */
export function compactRetired(db: DatabaseSync, logical: string, physical: string): void {
  const args = [logical, physical];
  if (db.prepare("SELECT 1 FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=? AND state IN ('uncertain','pending','pending_retry')").get(...args)) return;
  const rows = db.prepare("SELECT * FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=?").all(...args) as Row[];
  const entries = readRetired(db, logical, physical);
  for (const row of rows) entries.push({ ordinal: row.ordinal, start: row.start, end: row.end, count: row.offer_count, state: row.state });
  const scope = db.prepare("SELECT incarnation FROM continuity_upkeep_scopes WHERE logical_id=? AND conversation_id=?").get(...args) as Row | undefined;
  const ledger = db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_ledger'").get()
    ? (db.prepare("SELECT id FROM continuity_ledger WHERE logical_id=? AND conversation_id=?").get(...args) as Row | undefined)?.id ?? null : null;
  writeRetired(db, logical, physical, scope?.incarnation ?? rows[0]?.incarnation ?? "", entries, ledger);
  db.prepare("DELETE FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=?").run(...args);
}
