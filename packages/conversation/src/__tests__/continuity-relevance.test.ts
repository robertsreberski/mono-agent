import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createContinuitySchema, continuityRecordId } from "../tool-history/continuity-storage.js";
import { getContinuity, searchContinuity } from "../tool-history/continuity-reader.js";
import { searchRelevantContinuity } from "../tool-history/relevance-scan.js";
import { matchedPreview, relevanceMatch, relevanceQuery } from "../tool-history/relevance.js";
const scope = { logicalConversationId: "fiction", currentConversationId: "fiction#today", currentRunId: "reader" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const db = new DatabaseSync(":memory:"); createContinuitySchema(db);
  let n = 0;
  const add = (text: string, state = "committed", logical = scope.logicalConversationId) => {
    const gen = `gen-${++n}`, id = continuityRecordId(logical, gen);
    db.prepare("INSERT INTO continuity_generations(generation_id,conversation_id,logical_id,action,preparation_digest,state,created_at_ms) VALUES(?,?,?,'publish','fixture',?,0)").run(gen, `${logical}#today`, logical, state);
    db.prepare("INSERT INTO continuity_records(record_id,generation_id,run_id,kind,seq,finalized,retained_text,text_sha256,original_bytes,retained_bytes,redacted,truncated,provenance,source_json,created_at_ms) VALUES(?,?,'old','assistant',0,?,?,?,?,?,0,0,'assistant','{}',0)").run(id, gen, state === "committed" ? 1 : 0, text, sha(text), Buffer.byteLength(text), Buffer.byteLength(text));
    return { id, gen };
  };
  const reader = {
    text: (row: Record<string, unknown>) => { const text = row.retained_text; if (typeof text !== "string" || sha(text) !== row.text_sha256) throw new TypeError("digest mismatch"); return text; },
    metadata: (row: Record<string, unknown>) => getContinuity(db, { ...scope, recordId: row.record_id as string }).record!,
  };
  const search = (query: string, limit = 5) => searchContinuity(db, { ...scope, query, limit, mode: "relevance" });
  return { db, add, search, reader };
}

describe("bounded relevance discovery", () => {
  it("ranks partial Unicode coverage, phrases and proximity without repetition inflation, keeping legacy AND/default order", () => {
    const f = fixture();
    try {
      const phrase = f.add("ŻÓŁTY observatory cobalt correction.");
      const partial = f.add("The observatory pending item.");
      f.add("cobalt ".repeat(100)); f.add("ŻÓŁTY observatory cobalt", "prepared"); f.add("ŻÓŁTY observatory cobalt", "committed", "foreign");
      expect(f.search("żółty observatory cobalt").items[0]!.recordId).toBe(phrase.id);
      expect(f.search("observatory cobalt").items.map(r => r.recordId)).toContain(partial.id);
      expect(searchContinuity(f.db, { ...scope, query: "observatory cobalt" }).items.map(r => r.recordId)).toEqual([phrase.id]);
      expect(searchContinuity(f.db, { ...scope }).items[0]!.preview).toBe("cobalt ".repeat(100).slice(0, 512));
      expect(relevanceMatch("cobalt cobalt cobalt", relevanceQuery("cobalt"))!.score).toBe(relevanceMatch("cobalt", relevanceQuery("cobalt"))!.score);
      expect(f.search("obj:survey-17").items).toEqual([]);
      const identifier = f.add("obj:survey-17 revision"); expect(f.search("obj:survey-17").items[0]!.recordId).toBe(identifier.id);
    } finally { f.db.close(); }
  });
  it("does not award short-token coverage inside unrelated words or larger numbers", () => {
    const f = fixture(); try {
      const exact = f.add("a reference: 80 cobalt");
      const partial = f.add("metadata 1800 cobalt");
      expect(f.search("a 80 cobalt").items.map(item => item.recordId)).toEqual([exact.id, partial.id]);
      expect(relevanceMatch("metadata 1800", relevanceQuery("a 80"))).toBeUndefined();
      const text = "metadata contains a";
      expect(relevanceMatch(text, relevanceQuery("a"))!.position).toBe(text.lastIndexOf("a"));
    } finally { f.db.close(); }
  });
  it.each([
    ["ACT-77 gpt-6.1", "ACT-77 gpt-6.1", true],
    ["ACT-770 gpt-6.10", "ACT-77 gpt-6.1", false],
    ["pact-77", "ACT-77", false],
    ["観測台ACT-77東京都gpt-6.1観測台", "ACT-77 gpt-6.1", true],
    ["東京都の観測台", "東京 観測", true],
    ["หอดูดาว", "ดาว", true],
    ["ดู", "ด", false],
    ["التجربة الحالية", "التجربة", true],
    ["حالتجربةالحالية", "تجربة", false],
    ["αλφα", "α", false],
    ["жa漢", "a", true],
    ["a\u0301", "a", false],
    ["1800", "80", false],
    ["س80س", "80", false],
  ] as const)("uses script-aware token edges for %j / %j", (text, query, matches) => {
    expect(relevanceMatch(text, relevanceQuery(query)) !== undefined).toBe(matches);
  });
  it("uses explicitly literal chronological punctuation matching, never match-all", () => {
    const f = fixture();
    try {
      f.add("no punctuation"); const first = f.add('a " quotation'); const last = f.add('another " quotation');
      const page = f.search('"'); expect(page.mode).toBe("literal"); expect(page.items.map(r => r.recordId)).toEqual([last.id, first.id]);
      expect(f.search("!!!").items).toEqual([]); expect(() => f.search("  ")).toThrow();
    } finally { f.db.close(); }
  });
  it("returns exact UTF-8 matched ranges near record ends with qualification and clipping", () => {
    const f = fixture();
    try {
      const text = "🔷 İ background. ".repeat(1500) + "\nNot approved: observatory cobalt remains hypothetical, not a decision.";
      f.add(text); const item = f.search("observatory cobalt").items[0]!;
      expect(item.preview).toContain("Not approved"); expect(item.preview).toContain("hypothetical");
      expect(Buffer.byteLength(item.preview)).toBeLessThanOrEqual(512); expect(item.preview).not.toContain("�");
      expect(item.previewRange).toMatchObject({ clippedBefore: true, clippedAfter: false, complete: false });
      expect(Buffer.from(text).subarray(item.previewRange!.start, item.previewRange!.end).toString()).toBe(item.preview);
      const unicode = matchedPreview("İ".repeat(300) + "cobalt", 300); expect(unicode.preview).toContain("cobalt");
    } finally { f.db.close(); }
  });
  it("selects two complementary windows with separate exact ranges, preserving negation and hypothetical context", () => {
    const f = fixture(); try {
      const text = "Morgan's observatory report: the referent is the fictional delivery. " + "Background 🔷. ".repeat(100) + "\nNot approved: cobalt day 18 remains hypothetical, not a decision.";
      const useful = f.add(text); f.add("observatory cobalt unrelated current echo");
      const page = f.search("observatory cobalt"), item = page.items[1]!;
      expect(item.recordId).toBe(useful.id);
      const windows = [item, ...item.additionalPreviews!];
      expect(windows).toHaveLength(2);
      expect(windows[0]!.preview).toContain("referent");
      expect(windows[1]!.preview).toContain("Not approved"); expect(windows[1]!.preview).toContain("hypothetical");
      expect(windows.reduce((total, window) => total + Buffer.byteLength(window.preview), 0)).toBeLessThanOrEqual(512);
      for (const window of windows) {
        expect(window.previewRange!.complete).toBe(false); expect(window.preview).not.toContain("�");
        expect(Buffer.from(text).subarray(window.previewRange!.start, window.previewRange!.end).toString()).toBe(window.preview);
      }
      expect(windows[0]!.previewRange!.end).toBeLessThan(windows[1]!.previewRange!.start);
      expect(page.resumeAfter![1]!.anchor.recordId).toBe(useful.id);
      expect(page.continuation).toBeUndefined();
      const rest = searchContinuity(f.db, { ...scope, query: "observatory cobalt", mode: "relevance", limit: 5, continuation: page.resumeAfter![0]! });
      expect(rest.items.map(row => row.recordId)).toEqual([useful.id]);
    } finally { f.db.close(); }
  });
  it.each([0, 11, Number.MAX_SAFE_INTEGER, 1.5, NaN, Infinity])("keeps lower-level search limits strict (%s)", limit => {
    const f = fixture(); try { expect(() => f.search("cobalt", limit)).toThrow("limit"); } finally { f.db.close(); }
  });
  it.each(["cobalt" + " ".repeat(410) + "observatory", "a" + " ".repeat(510) + "b", '"'.repeat(500)])("covers the entire long matched span within 512 bytes (%j)", phrase => {
    const f = fixture(); try {
      const text = "🔷 background. ".repeat(100) + "Not approved: " + phrase + " remains hypothetical.";
      f.add(text); const item = f.search(phrase).items[0]!;
      expect(item.preview).toContain(phrase); expect(Buffer.byteLength(item.preview)).toBeLessThanOrEqual(512);
      expect(item.previewRange!.matchClipped).toBeUndefined(); expect(item.preview).not.toContain("�");
      expect(Buffer.from(text).subarray(item.previewRange!.start, item.previewRange!.end).toString()).toBe(item.preview);
    } finally { f.db.close(); }
  });
  it("discloses clipping when Unicode case folding makes the matched span exceed 512 bytes", () => {
    const f = fixture(); try {
      const query = "k ".repeat(199) + "k", phrase = "K ".repeat(199) + "K";
      expect(Buffer.byteLength(query)).toBeLessThanOrEqual(512); expect(Buffer.byteLength(phrase)).toBeGreaterThan(512);
      f.add("background. " + phrase + " still hypothetical"); const item = f.search(query).items[0]!;
      expect(Buffer.byteLength(item.preview)).toBeLessThanOrEqual(512); expect(item.preview).not.toContain("�");
      expect(item.previewRange).toMatchObject({ matchClipped: true, clippedAfter: true, complete: false });
    } finally { f.db.close(); }
  });
  it.each([undefined, null, 42, {}, [], true].map(recordId => ({ recordId })))("rejects non-string cursor anchor IDs (%j)", ({ recordId }) => {
    const f = fixture(); try {
      f.add("cobalt first"); f.add("cobalt second");
      const cursor = f.search("cobalt", 1).continuation!;
      const page = searchContinuity(f.db, { ...scope, query: "cobalt", mode: "relevance", limit: 1,
        continuation: { ...cursor, anchor: { ...cursor.anchor, recordId: recordId as unknown as string } } });
      expect(page).toMatchObject({ items: [], degradedReason: "invalid_cursor", scan: { complete: false, records: 0 } });
    } finally { f.db.close(); }
  });
  it("paginates ranked ties without duplicates and excludes later insertions above the watermark", () => {
    const f = fixture();
    try {
      for (let n = 0; n < 8; n++) f.add(`cobalt observatory entry ${n}`);
      const first = f.search("cobalt observatory", 3); const inserted = f.add("cobalt observatory later");
      const second = searchContinuity(f.db, { ...scope, query: "cobalt observatory", limit: 3, mode: "relevance", continuation: first.continuation! });
      expect(second.degradedReason).toBeUndefined(); expect(second.items).toHaveLength(3);
      const third = searchContinuity(f.db, { ...scope, query: "cobalt observatory", limit: 3, mode: "relevance", continuation: second.continuation! });
      expect(third.items).toHaveLength(2); expect(new Set([...first.items, ...second.items, ...third.items].map(r => r.recordId)).size).toBe(8);
      expect([...second.items, ...third.items].map(r => r.recordId)).not.toContain(inserted.id);
      expect(third.continuation).toBeUndefined();
    } finally { f.db.close(); }
  });
  it.each(["publication", "retention", "purge", "anchor"])("invalidates continuations after %s below the watermark", change => {
    const f = fixture();
    try {
      const prepared = f.add("cobalt unpublished", "prepared"); for (let n = 0; n < 5; n++) f.add("cobalt published");
      const page = f.search("cobalt", 2);
      if (change === "publication") { f.db.prepare("UPDATE continuity_generations SET state='committed' WHERE generation_id=?").run(prepared.gen); f.db.prepare("UPDATE continuity_records SET finalized=1 WHERE record_id=?").run(prepared.id); }
      if (change === "retention") f.db.prepare("UPDATE continuity_records SET retained_text=NULL WHERE record_id=?").run(f.search("cobalt").items.at(-1)!.recordId);
      if (change === "anchor") f.db.prepare("DELETE FROM continuity_records WHERE record_id=?").run(page.items.at(-1)!.recordId);
      if (change === "purge") { f.db.exec("UPDATE continuity_generations SET action='delete' WHERE state='prepared'"); }
      const next = searchContinuity(f.db, { ...scope, mode: "relevance", query: "cobalt", limit: 2, continuation: page.continuation! });
      expect(next.items).toEqual([]); expect(next.degradedReason).toBe("invalid_cursor");
    } finally { f.db.close(); }
  });
  it.each(["publication", "retention", "purge"])("rejects %s between bounded text batches", change => {
    const f = fixture();
    try {
      const prepared = f.add("cobalt prepared", "prepared"); for (let n = 0; n < 40; n++) f.add("cobalt published");
      let changed = false;
      const page = searchRelevantContinuity(f.db, { ...scope, query: "cobalt" }, f.reader, { afterBatch() {
        if (changed) return; changed = true;
        if (change === "publication") { f.db.prepare("UPDATE continuity_generations SET state='committed' WHERE generation_id=?").run(prepared.gen); f.db.prepare("UPDATE continuity_records SET finalized=1 WHERE record_id=?").run(prepared.id); }
        if (change === "retention") f.db.exec("UPDATE continuity_records SET retained_text=NULL WHERE ordinal=20");
        if (change === "purge") f.db.exec("UPDATE continuity_generations SET action='reset' WHERE state='prepared'");
      } });
      expect(changed).toBe(true); expect(page.items).toEqual([]); expect(page.degradedReason).toBe("source_changed"); expect(page.scan!.complete).toBe(false);
    } finally { f.db.close(); }
  });
  it("rechecks final membership and selected digests; capacity is an empty incomplete page", () => {
    const f = fixture();
    try {
      f.add("cobalt one");
      const changed = searchRelevantContinuity(f.db, { ...scope, query: "cobalt" }, f.reader, { beforeFinal() { f.db.exec("UPDATE continuity_records SET retained_text=NULL"); } });
      expect(changed.degradedReason).toBe("source_changed"); expect(changed.items).toEqual([]);
      let clock = 0;
      const capacity = searchRelevantContinuity(f.db, { ...scope, query: "cobalt" }, f.reader, { now: () => clock += 1000 });
      expect(capacity).toMatchObject({ items: [], degradedReason: "scan_capacity", scan: { complete: false } });
      f.add("cobalt two"); f.db.exec("UPDATE continuity_records SET retained_bytes=268435457 WHERE ordinal=2");
      expect(f.search("cobalt").degradedReason).toBe("scan_capacity");
    } finally { f.db.close(); }
  });
  it("fails closed on digest tampering even when the record would not match", () => {
    const f = fixture(); try {
      f.add("original"); f.db.exec("UPDATE continuity_records SET retained_text='tampered'");
      expect(() => f.search("absent")).toThrow("digest");
    } finally { f.db.close(); }
  });
  it.each([16, 128 * 1024])("keeps metadata at 256 rows and text at 32 records/2 MiB (body=%s)", size => {
    const f = fixture(); try {
      const first = f.add("cobalt" + "x".repeat(size - 6)); for (let n = 1; n < 80; n++) f.add("cobalt" + "x".repeat(size - 6));
      f.db.prepare("UPDATE continuity_records SET seq=ordinal,generation_id=?").run(first.gen);
      const batches: number[] = [];
      const page = searchRelevantContinuity(f.db, { ...scope, query: "cobalt" }, f.reader, {
        afterMetadataPage(rows) { expect(rows).toBeLessThanOrEqual(256); },
        afterTextBatch(records, bytes) { expect(records).toBeLessThanOrEqual(32); expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024); batches.push(records); },
      });
      expect(page.scan!.complete).toBe(true); expect(page.scan!.records).toBe(80);
      expect(Math.max(...batches)).toBe(size === 16 ? 32 : 16);
    } finally { f.db.close(); }
  });
  it("enforces the 100k record ceiling without returning an allegedly complete subset", () => {
    const f = fixture(); try {
      const first = f.add("cobalt");
      f.db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
        INSERT INTO continuity_records(record_id,generation_id,run_id,kind,seq,finalized,retained_text,text_sha256,original_bytes,retained_bytes,redacted,truncated,provenance,source_json,created_at_ms)
        SELECT 'fixture-'||x,?,'old','assistant',x,1,'cobalt',?,6,6,0,0,'assistant','{}',0 FROM n`).run(first.gen, sha("cobalt"));
      expect(f.search("cobalt")).toMatchObject({ items: [], degradedReason: "scan_capacity", scan: { complete: false, textBatches: 0 } });
    } finally { f.db.close(); }
  });
  it("never decodes an oversized/underreported body into a nominally bounded text batch", () => {
    const f = fixture(); try {
      f.add("cobalt"); f.db.prepare("UPDATE continuity_records SET retained_text=?,text_sha256=?").run("x".repeat(1024 * 1024), sha("x".repeat(1024 * 1024)));
      const text = vi.fn(f.reader.text);
      expect(() => searchRelevantContinuity(f.db, { ...scope, query: "cobalt" }, { ...f.reader, text })).toThrow(new TypeError("digest mismatch"));
      expect(text).toHaveBeenCalledWith(expect.objectContaining({ retained_bytes: 6, retained_text: null }));
    } finally { f.db.close(); }
  });
  it("rechecks selected text after a final-boundary tamper without changing its claimed digest", () => {
    const f = fixture(); try {
      f.add("cobalt");
      expect(() => searchRelevantContinuity(f.db, { ...scope, query: "cobalt" }, f.reader, { beforeFinal() {
        f.db.exec("UPDATE continuity_records SET retained_text='forged'");
      } })).toThrow("digest");
    } finally { f.db.close(); }
  });
  it("uses scoped indexes for the actual scanner queries, including pending-purge lookups, without sorting", () => {
    const f = fixture(); const original = f.db.prepare.bind(f.db), sqls = new Set<string>();
    const spy = vi.spyOn(f.db, "prepare").mockImplementation(sql => { sqls.add(sql); return original(sql); });
    try {
      f.add("cobalt"); f.search("cobalt"); spy.mockRestore();
      const scannerSql = [...sqls].filter(sql => sql.includes("INDEXED BY") || sql.includes("CROSS JOIN"));
      expect(scannerSql.length).toBeGreaterThanOrEqual(5);
      for (const sql of scannerSql) {
        const details = original(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: (sql.match(/\?/gu) ?? []).length }, () => "fiction")).map(row => String(row.detail));
        const plan = details.join("\n");
        expect(plan).toContain("SEARCH"); expect(plan).not.toContain("TEMP B-TREE");
        expect(details.filter(detail => /\bSCAN\b/u.test(detail) && !/\bSEARCH\b/u.test(detail))).toEqual([]);
        if (sql.includes("NOT EXISTS")) expect(plan).toContain("continuity_prepared_owner_idx");
      }
    } finally { spy.mockRestore(); f.db.close(); }
  });
});
