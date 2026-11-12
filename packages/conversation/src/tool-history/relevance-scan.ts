import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContinuityRecordMetadata, ContinuitySearchInput, ContinuitySearchPage, ContinuityRelevanceContinuation } from "./continuity-contracts.js";
import { matchedPreview, relevanceMatch, relevanceQuery } from "./relevance.js";

type Row = Record<string, unknown>;
type Descriptor = { record_id: string; generation_id: string; ordinal: number; text_sha256: string; retained_bytes: number };
type Candidate = { descriptor: Descriptor; score: number; position: number; end: number };
const MAX_RECORDS = 100_000, MAX_BYTES = 256 * 1024 * 1024, MAX_RECORD_BYTES = 1024 * 1024;
const NOT_PURGING = `NOT EXISTS (SELECT 1 FROM continuity_generations p WHERE p.conversation_id=g.conversation_id AND p.state='prepared' AND p.action<>'checkpoint' AND p.action IN ('reset','delete'))`;
const compare = (a: { score: number; ordinal: number; recordId: string }, b: { score: number; ordinal: number; recordId: string }) =>
  b.score - a.score || b.ordinal - a.ordinal || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
const key = (c: Candidate) => ({ score: c.score, ordinal: c.descriptor.ordinal, recordId: c.descriptor.record_id });
const identity = (d: Descriptor) => JSON.stringify([d.generation_id, d.ordinal, d.record_id, d.text_sha256, d.retained_bytes]) + "\n";
interface Reader { metadata(row: Row): ContinuityRecordMetadata; text(row: Row): string }
/** Internal deterministic barriers/clock for race and capacity tests, never tool input. */
interface ScanHooks { now?: () => number; afterManifest?: () => void; afterBatch?: () => void; beforeFinal?: () => void; afterMetadataPage?: (rows: number) => void; afterTextBatch?: (records: number, bytes: number) => void }

/** Three ordered membership manifests, no all-record descriptor array or SQL text
 * sort. Scoped covering-index generation pages and generation-index record pages
 * keep unrelated conversations out of each query. Bodies live for one batch only.
 * Five seconds is a cooperative deadline, not a SQLite interrupt guarantee. */
export function searchRelevantContinuity(db: DatabaseSync, input: ContinuitySearchInput, reader: Reader, hooks: ScanHooks = {}): ContinuitySearchPage {
  const now = hooks.now ?? (() => performance.now()), started = now(), deadline = started + 5000;
  const query = relevanceQuery(input.query!.trim()), limit = input.limit ?? 5, cursor = input.continuation;
  const stats = { complete: false, records: 0, bytes: 0, elapsedMs: 0, maxBatchMs: 0, metadataPages: 0, textBatches: 0 };
  const top: Candidate[] = [];
  let watermark = cursor?.watermark ?? Number.MAX_SAFE_INTEGER, observedWatermark = 0, anchorSeen = cursor === undefined;
  const check = () => { if (now() >= deadline) throw new Error("scan_capacity"); };
  const tx = <T>(fn: () => T): T => {
    check(); const start = now(); db.exec("BEGIN");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { stats.maxBatchMs = Math.max(stats.maxBatchMs, now() - start); }
  };
  // All ORDER BY clauses are served by existing scoped indexes, never a global
  // ordinal scan or an unbounded sort. Physical buckets are enumerated first.
  const physical = db.prepare(`SELECT DISTINCT conversation_id FROM continuity_generations INDEXED BY continuity_generation_scope_idx WHERE logical_id=? AND conversation_id>? ORDER BY conversation_id LIMIT 256`);
  const generations = db.prepare(`SELECT generation_id,rowid position FROM continuity_generations g INDEXED BY continuity_generation_scope_idx WHERE logical_id=? AND conversation_id=? AND state='committed' AND rowid>? AND ${NOT_PURGING} ORDER BY rowid LIMIT 256`);
  const records = db.prepare(`SELECT record_id,generation_id,ordinal,text_sha256,retained_bytes FROM continuity_records INDEXED BY continuity_record_generation_idx WHERE generation_id=? AND ordinal>? AND ordinal<=? AND finalized=1 AND retained_text IS NOT NULL ORDER BY ordinal LIMIT 256`);
  const walk = (transactional: boolean, visit: (page: Descriptor[]) => void) => {
    const read = <T>(fn: () => T): T => transactional ? tx(fn) : (check(), fn());
    let bucketAfter = "";
    for (;;) {
      const buckets = read(() => physical.all(input.logicalConversationId, bucketAfter)) as Row[];
      if (!buckets.length) break;
      for (const bucket of buckets) {
        const physicalId = bucket.conversation_id as string;
        let generationAfter = 0;
        for (;;) {
          const page = read(() => generations.all(input.logicalConversationId, physicalId, generationAfter)) as Row[];
          if (!page.length) break;
          for (const generation of page) {
            let after = 0;
            for (;;) {
              const rows = read(() => records.all(generation.generation_id as string, after, watermark)) as Descriptor[];
              stats.metadataPages++; hooks.afterMetadataPage?.(rows.length);
              if (!rows.length) break;
              visit(rows); after = rows.at(-1)!.ordinal;
            }
          }
          generationAfter = Number(page.at(-1)!.position);
        }
      }
      bucketAfter = buckets.at(-1)!.conversation_id as string;
    }
  };
  const manifest = () => {
    const hash = createHash("sha256"); let count = 0, bytes = 0;
    walk(false, page => { for (const d of page) {
      check();
      if (!Number.isSafeInteger(d.retained_bytes) || d.retained_bytes < 0) throw new Error("source_changed");
      count++; bytes += d.retained_bytes; observedWatermark = Math.max(observedWatermark, d.ordinal);
      if (count > MAX_RECORDS || bytes > MAX_BYTES || d.retained_bytes > MAX_RECORD_BYTES) throw new Error("scan_capacity");
      hash.update(identity(d));
    } });
    return hash.digest("hex");
  };
  try {
    if (cursor && (cursor.version !== 2 || cursor.rankingVersion !== 1 || cursor.query !== input.query!.trim() || cursor.limit !== limit
      || !Number.isSafeInteger(watermark) || watermark < 0 || !/^[a-f0-9]{64}$/u.test(cursor.manifest)
      || !cursor.anchor || typeof cursor.anchor.recordId !== "string" || !Number.isSafeInteger(cursor.anchor.score) || !Number.isSafeInteger(cursor.anchor.ordinal))) throw new Error("invalid_cursor");
    const initial = tx(manifest);
    // Compute the initial watermark from bounded metadata pages in the same
    // snapshot, rather than an uninterruptible all-scoped-record max() query.
    if (!cursor) watermark = observedWatermark;
    if (cursor && initial !== cursor.manifest) throw new Error("invalid_cursor");
    hooks.afterManifest?.(); check();
    const examined = createHash("sha256");
    walk(true, page => {
      for (let offset = 0; offset < page.length;) {
        check(); let bytes = 0; const batch: Descriptor[] = [];
        while (offset < page.length && batch.length < 32) {
          const d = page[offset]!;
          if (batch.length && bytes + d.retained_bytes > 2 * 1024 * 1024) break;
          bytes += d.retained_bytes; batch.push(d); offset++;
        }
        if (stats.records + batch.length > MAX_RECORDS || stats.bytes + bytes > MAX_BYTES || batch.some(d => d.retained_bytes > MAX_RECORD_BYTES)) throw new Error("scan_capacity");
        const batchStarted = now();
        const rows = tx(() => db.prepare(`SELECT r.record_id,r.generation_id,r.ordinal,r.text_sha256,r.retained_bytes,
          CASE WHEN r.retained_bytes<=? AND length(CAST(r.retained_text AS BLOB))=r.retained_bytes THEN r.retained_text ELSE NULL END retained_text
          FROM continuity_records r CROSS JOIN continuity_generations g USING(generation_id) WHERE g.logical_id=? AND g.state='committed' AND r.finalized=1 AND ${NOT_PURGING} AND r.record_id IN (${batch.map(() => "?").join(",")})`)
          .all(MAX_RECORD_BYTES, input.logicalConversationId, ...batch.map(d => d.record_id))) as Row[];
        const byId = new Map(rows.map(row => [row.record_id, row]));
        for (const d of batch) {
          check(); const row = byId.get(d.record_id);
          if (!row || identity(row as Descriptor) !== identity(d)) throw new Error("source_changed");
          const text = reader.text(row);
          if (Buffer.byteLength(text) !== d.retained_bytes) throw new Error("source_changed");
          examined.update(identity(d)); stats.records++; stats.bytes += d.retained_bytes;
          const match = relevanceMatch(text, query);
          if (!match) continue;
          const score = query.mode === "literal" ? 1 : match.score;
          const rank = { score, ordinal: d.ordinal, recordId: d.record_id };
          if (cursor) {
            if (compare(rank, cursor.anchor) === 0) anchorSeen = true;
            if (compare(rank, cursor.anchor) <= 0) continue;
          }
          if (top.length === limit + 1 && compare(rank, key(top.at(-1)!)) >= 0) continue;
          if (top.length === limit + 1) top.pop();
          top.push({ descriptor: d, score, position: match.position, end: match.end });
          top.sort((a, b) => compare(key(a), key(b)));
        }
        stats.maxBatchMs = Math.max(stats.maxBatchMs, now() - batchStarted);
        stats.textBatches++; hooks.afterTextBatch?.(batch.length, bytes); hooks.afterBatch?.();
      }
    });
    if (examined.digest("hex") !== initial || !anchorSeen) throw new Error(cursor ? "invalid_cursor" : "source_changed");
    hooks.beforeFinal?.();
    const items = tx(() => {
      if (manifest() !== initial) throw new Error(cursor ? "invalid_cursor" : "source_changed");
      return top.slice(0, limit).map(candidate => {
        check(); const d = candidate.descriptor;
        const row = db.prepare(`SELECT r.record_id,r.generation_id,r.ordinal,r.text_sha256,r.retained_bytes,r.run_id,r.input_id,r.kind,r.seq,
          r.original_bytes,r.redacted,r.truncated,r.provenance,r.source_json,r.summary_json,g.conversation_id,
          CASE WHEN r.retained_bytes<=? AND length(CAST(r.retained_text AS BLOB))=r.retained_bytes THEN r.retained_text ELSE NULL END retained_text
          FROM continuity_records r CROSS JOIN continuity_generations g USING(generation_id) WHERE g.logical_id=? AND g.state='committed' AND r.finalized=1 AND ${NOT_PURGING} AND r.record_id=?`).get(MAX_RECORD_BYTES, input.logicalConversationId, d.record_id) as Row | undefined;
        if (!row || identity(row as Descriptor) !== identity(d)) throw new Error("source_changed");
        const text = reader.text(row); // Revalidate selected digest/visibility at disclosure.
        // Materialize previews only for emitted items, not candidates later
        // evicted from top. Bodies are bounded to 1 MiB and at most 10 are emitted.
        const preview = matchedPreview(text, candidate.position, candidate.end, query);
        check();
        return { ...reader.metadata(row), ...preview };
      });
    });
    check(); stats.complete = true; stats.elapsedMs = now() - started;
    const resumeAfter: ContinuityRelevanceContinuation[] = top.slice(0, limit).map(candidate => ({
      version: 2, rankingVersion: 1, query: input.query!.trim(), limit, watermark, manifest: initial, anchor: key(candidate),
    }));
    const continuation = top.length > limit ? resumeAfter.at(-1) : undefined;
    return { available: true, items, mode: query.mode, scan: stats, resumeAfter, ...(continuation ? { continuation } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason !== "scan_capacity" && reason !== "source_changed" && reason !== "invalid_cursor") throw error;
    stats.elapsedMs = now() - started;
    return { available: true, items: [], mode: query.mode, scan: stats, degradedReason: reason };
  }
}
