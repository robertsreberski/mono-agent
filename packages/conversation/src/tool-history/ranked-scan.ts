import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContinuitySnapshot, ContinuitySnapshotInput, ContinuitySnapshotRecord } from "./continuity-contracts.js";
import { hasContinuitySchema } from "./continuity-storage.js";
import { normalizeId } from "./paths.js";
import { readProgress } from "../continuity/progress.js";
import { readRetired, geometryKey } from "../continuity/retirement.js";
import { ledgerWindows } from "../continuity/span-geometry.js";
import { ledgerHash, spanKey } from "../continuity/ledger.js";
import { RankedQueue, signalScore } from "../continuity/ranking.js";
type Row = Record<string, any>;
const DEFAULT = { rows: 4096, bytes: 32 * 1024 * 1024, windows: 65536, ms: 5000 };
const VISIBLE = `g.logical_id=? AND g.conversation_id=? AND g.state='committed' AND r.finalized=1 AND r.run_id<>?
  AND NOT EXISTS (SELECT 1 FROM continuity_generations p WHERE p.conversation_id=g.conversation_id AND p.state='prepared' AND p.action IN ('reset','delete'))`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function record(row: Row, physical: string): ContinuitySnapshotRecord {
  if (typeof row.retained_text !== "string" || digest(row.retained_text) !== row.text_sha256 || typeof row.source_json !== "string") throw new Error("source_changed");
  return { recordId: row.record_id, generationId: row.generation_id, conversationId: physical, runId: row.run_id,
    ...(row.input_id === null ? {} : { inputId: row.input_id }), kind: row.kind, provenance: row.provenance, ordinal: row.ordinal, sequence: row.seq,
    text: row.retained_text, sha256: row.text_sha256, originalBytes: row.original_bytes, retainedBytes: row.retained_bytes,
    redacted: !!row.redacted, truncated: !!row.truncated, source: JSON.parse(row.source_json), untrusted: true,
    ...(row.summary_json === null ? {} : { summary: JSON.parse(row.summary_json) }) };
}
/** Complete the bounded scan before buying any ranked subset. Each page owns its
 * own read transaction; a frozen watermark excludes inter-page appends. */
export function scanLedgerHistory(db: DatabaseSync, input: ContinuitySnapshotInput): ContinuitySnapshot {
  for (const id of [input.logicalConversationId, input.currentConversationId, input.currentRunId]) normalizeId(id, "scope");
  if (!hasContinuitySchema(db)) return { records: [], omitted: 0, gaps: 1, degradedReason: "unavailable" };
  const budget = { ...DEFAULT };
  for (const name of Object.keys(budget) as (keyof typeof DEFAULT)[]) if (input.scanBudget?.[name] !== undefined) {
    const value = input.scanBudget[name]!; if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT[name]) throw new TypeError("Invalid scan budget"); budget[name] = value;
  }
  if ((input.priorCovered?.length ?? 0) > 1024 || input.priorCovered?.some(key => !/^[a-f0-9]{64}$/u.test(key))) throw new TypeError("Invalid prior coverage");
  const represented = new Set(input.priorCovered);
  const started = performance.now(), deadline = started + budget.ms;
  const stats = { limits: { ...budget }, complete: false, rows: 0, bytes: 0, windows: 0, pages: 0, bindingQueries: 0, bindings: 0, elapsedMs: 0, excluded: 0, materializationSkipped: 0, deadline };
  const args = [input.logicalConversationId, input.currentConversationId, input.currentRunId] as const;
  const table = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
  let watermark = 0, total = 0, gaps = 0, progress: ReturnType<typeof readProgress> = { failed: 0 }, summary = "";
  const history = new Map<string, { count: number; state: string }>(), queue = new RankedQueue();
  const calls = new Map<string, Row>(), boundRuns = new Set<string>(), info = new Map<number, { recordId: string; sha256: string; bytes: number; operation?: string }>();
  const check = () => { if (performance.now() >= deadline) throw new Error("scan_capacity"); };
  const transaction = <T>(fn: () => T): T => { db.exec("BEGIN"); try { return fn(); } finally { db.exec("COMMIT"); } };
  const eligible = "(r.kind IN ('owner','user','other-user','imported','tool') OR r.record_id=?)";
  try {
    check();
    transaction(() => {
      const head = db.prepare(`SELECT coalesce(max(r.ordinal),0) n FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE ${VISIBLE}`).get(...args) as Row;
      watermark = head.n;
      if (input.historyBoundary !== undefined) {
        const bound = db.prepare(`SELECT max(r.ordinal) n FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE g.logical_id=? AND g.conversation_id=? AND g.state='committed' AND r.finalized=1 AND r.run_id=?`).get(args[0], args[1], input.historyBoundary) as Row;
        if (bound.n === null) throw new Error("boundary_unavailable"); watermark = Math.min(watermark, bound.n);
      }
      summary = (db.prepare(`SELECT r.record_id FROM continuity_records r JOIN continuity_generations g USING(generation_id) JOIN continuity_pins p USING(record_id) WHERE ${VISIBLE} AND r.kind='summary' AND p.owner_kind='summary' AND p.owner_id=? ORDER BY r.ordinal DESC LIMIT 1`).get(...args, args[0]) as Row | undefined)?.record_id ?? "";
      total = (db.prepare(`SELECT count(*) n FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE ${VISIBLE} AND r.ordinal<=? AND r.retained_text IS NOT NULL AND ${eligible}`).get(...args, watermark, summary) as Row).n;
      gaps = (db.prepare("SELECT count(*) n FROM continuity_generations WHERE logical_id=? AND conversation_id=? AND state='abandoned'").get(args[0], args[1]) as Row).n;
      progress = readProgress(db, args[0], args[1], watermark);
      if (table("continuity_upkeep_offers")) for (const s of db.prepare("SELECT ordinal,start,end,offer_count count,state FROM continuity_upkeep_offers WHERE logical_id=? AND conversation_id=?").all(args[0], args[1]) as Row[]) history.set(geometryKey({ ordinal: s.ordinal, start: s.start, end: s.end }), { count: s.count, state: s.state });
      for (const s of readRetired(db, args[0], args[1])) history.set(geometryKey(s), { count: s.count, state: s.state });
    });
    if (total > budget.rows) throw new Error("scan_capacity");
    let after = 0;
    while (after < watermark) {
      check(); let size = 0;
      const page = transaction(() => {
        const metadata = db.prepare(`SELECT r.record_id,r.ordinal,length(CAST(r.retained_text AS BLOB))+length(CAST(r.source_json AS BLOB)) bytes FROM continuity_records r JOIN continuity_generations g USING(generation_id)
          WHERE ${VISIBLE} AND r.ordinal>? AND r.ordinal<=? AND r.retained_text IS NOT NULL AND ${eligible} ORDER BY r.ordinal LIMIT 64`).all(...args, after, watermark, summary) as Row[];
        if (!metadata.length) return [];
        const chosen: Row[] = [];
        for (const row of metadata) { if (chosen.length && size + row.bytes > 4 * 1024 * 1024) break; size += row.bytes; chosen.push(row); }
        if (stats.bytes + size > budget.bytes || stats.rows + chosen.length > budget.rows) throw new Error("scan_capacity");
        const rows = db.prepare(`SELECT r.*,CASE WHEN length(CAST(source_json AS BLOB))<=65536 THEN source_json ELSE NULL END source_json FROM continuity_records r WHERE record_id IN (${chosen.map(() => "?").join(",")}) ORDER BY ordinal`).all(...chosen.map(r => r.record_id)) as Row[];
        const runs = [...new Set(rows.filter(r => r.kind === "tool").map(r => r.run_id))].filter(run => !boundRuns.has(run));
        if (runs.length) {
          stats.bindingQueries++;
          const bindings = db.prepare(`SELECT c.run_id,c.tool_call_id,c.tool_name,c.state,i.record_id invocation_id,i.payload_sha256,i.retained_bytes,
            length(CAST(i.payload_json AS BLOB)) argument_bytes,o.record_id result_id FROM tool_calls c
            JOIN tool_records i ON i.conversation_id=c.conversation_id AND i.run_id=c.run_id AND i.tool_call_id=c.tool_call_id AND i.phase='invocation'
            LEFT JOIN tool_records o ON o.conversation_id=c.conversation_id AND o.run_id=c.run_id AND o.tool_call_id=c.tool_call_id AND o.phase='result'
            WHERE c.conversation_id=? AND c.run_id IN (${runs.map(() => "?").join(",")}) AND c.end_seq IS NOT NULL LIMIT 4097`).all(args[1], ...runs) as Row[];
          if ((stats.bindings += bindings.length) > 4096) throw new Error("scan_capacity");
          for (const run of runs) boundRuns.add(run);
          for (const call of bindings) calls.set(`tool:${ledgerHash(JSON.stringify([args[1], call.run_id, call.tool_call_id]))}`, call);
        }
        return rows;
      });
      if (!page.length) break;
      stats.pages++; stats.rows += page.length; stats.bytes += size;
      for (const row of page) {
        check(); const source = record(row, args[1]), call = source.kind === "tool" ? calls.get(source.source.operationId ?? "") : undefined;
        if (source.kind === "tool" && !call) throw new Error("source_unavailable");
        info.set(source.ordinal, { recordId: source.recordId, sha256: source.sha256, bytes: Buffer.byteLength(source.text) + Number(call?.argument_bytes ?? 0), ...(call ? { operation: source.source.operationId! } : {}) });
        const withTool = call ? { ...source, tool: { name: call.tool_name, state: call.state, arguments: "", invocationId: call.invocation_id } } : source;
        const owner = source.kind === "owner" && source.provenance === "host-owner" && !!source.inputId && source.inputId === source.source.attestation?.inputId;
        for (const s of ledgerWindows(source.text, owner)) {
          if (++stats.windows > budget.windows) throw new Error("scan_capacity"); check();
          const old = history.get(geometryKey({ ordinal: source.ordinal, ...s }));
          if (source.ordinal <= ((progress.cursor as Row | undefined)?.retiredThrough ?? 0) || old && (old.count >= 2 || !["available", "unrepresented", "reofferable", "analyzed"].includes(old.state))) { stats.excluded++; continue; }
          const key = spanKey({ id: "", recordId: source.recordId, sha256: source.sha256, start: s.start, end: s.end, digest: ledgerHash(s.text), owner, kind: source.kind, ...(call ? { toolName: call.tool_name } : {}) });
          if (represented.has(key)) { stats.excluded++; continue; }
          queue.offer({ key, ordinal: source.ordinal, start: s.start, end: s.end, score: signalScore(withTool, s.start, s.text) + (old?.state === "unrepresented" ? 64 : 0), offers: old?.count ?? 0 });
        }
      }
      after = page.at(-1)!.ordinal;
    }
    check(); const candidates = queue.finish(), wanted = [...new Set(candidates.map(s => s.ordinal))];
    const records: ContinuitySnapshotRecord[] = [];
    transaction(() => {
      let bytes = 0;
      const chosen = wanted.filter(ordinal => {
        const size = info.get(ordinal)!.bytes;
        if (bytes + size > 4 * 1024 * 1024) { stats.materializationSkipped++; return false; }
        bytes += size; return true;
      });
      const ids = chosen.map(ordinal => info.get(ordinal)!.recordId);
      const rows = ids.length ? db.prepare(`SELECT r.* FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE ${VISIBLE} AND r.retained_text IS NOT NULL AND r.record_id IN (${ids.map(() => "?").join(",")})`).all(...args, ...ids) as Row[] : [];
      if (rows.length !== ids.length) throw new Error("source_changed");
      const invocations = chosen.flatMap(ordinal => { const op = info.get(ordinal)!.operation; return op ? [calls.get(op)!.invocation_id] : []; });
      const payloads = new Map((invocations.length ? db.prepare(`SELECT record_id,payload_json,payload_sha256 FROM tool_records WHERE record_id IN (${invocations.map(() => "?").join(",")}) AND length(CAST(payload_json AS BLOB))<=4194304`).all(...invocations) as Row[] : []).map(row => [row.record_id, row]));
      for (const row of rows) {
        check(); const source = record(row, args[1]);
        if (source.sha256 !== info.get(source.ordinal)!.sha256) throw new Error("source_changed");
        if (source.kind === "tool") {
          const bound = calls.get(source.source.operationId ?? ""), payload = payloads.get(bound?.invocation_id);
          if (!bound || !payload || digest(payload.payload_json) !== bound.payload_sha256 || payload.payload_sha256 !== bound.payload_sha256) throw new Error("source_unavailable");
          records.push({ ...source, tool: { name: bound.tool_name, state: bound.state, arguments: JSON.stringify(JSON.parse(payload.payload_json)), invocationId: bound.invocation_id, ...(bound.result_id ? { resultId: bound.result_id } : {}) } });
        } else records.push(source);
      }
    });
    check(); stats.complete = true; stats.elapsedMs = performance.now() - started;
    return { records, omitted: Math.max(0, total - records.length), gaps: gaps + progress.failed,
      upkeep: { cursor: progress.cursor, watermark, excluded: [], candidates: candidates.filter(c => records.some(r => r.ordinal === c.ordinal)), scan: stats } };
  } catch (error) {
    stats.elapsedMs = performance.now() - started;
    const reason = error instanceof Error && error.message === "scan_capacity" ? "scan_capacity" : "source_unavailable";
    return { records: [], omitted: total, gaps: gaps + 1, degradedReason: reason, upkeep: { watermark, excluded: [], candidates: [], scan: stats } };
  }
}
