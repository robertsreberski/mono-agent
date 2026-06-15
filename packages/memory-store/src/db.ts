import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";

import { ftsQuery } from "./fts.js";
import { rrfFuse, reScore } from "./ranking.js";
import { migrations } from "./schema.js";
import { loadVec, toBlob } from "./vec.js";
import {
  DEFAULT_DECAY_GAMMA,
  DEFAULT_RRF_K,
  DEFAULT_WEIGHTS,
  type MemoryDbOptions,
  type MemoryRecord,
  type RecallHit,
  type RecallOptions,
  type RecallWeights,
} from "./types.js";
import type { EmbeddingProvider } from "@mono-agent/memory-search";

export class MemoryDb {
  protected readonly db: Database;
  protected readonly embeddings: EmbeddingProvider;
  protected readonly dim: number;
  protected readonly k: number;
  protected readonly weights: RecallWeights;
  protected readonly decayGamma: number;
  protected readonly clock: () => Date;

  constructor(options: MemoryDbOptions) {
    if (!Number.isInteger(options.dim) || options.dim <= 0) {
      throw new Error("MemoryDb: dim must be a positive integer.");
    }
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new BetterSqlite3(options.path);
    this.db.pragma("journal_mode = WAL");
    loadVec(this.db);
    for (const statement of migrations(options.dim)) {
      this.db.exec(statement);
    }
    this.embeddings = options.embeddings;
    this.dim = options.dim;
    this.k = options.k ?? DEFAULT_RRF_K;
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.decayGamma = options.decayGamma ?? DEFAULT_DECAY_GAMMA;
    this.clock = options.clock ?? (() => new Date());
  }

  vecVersion(): string {
    const row = this.db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
    return row?.v ?? "";
  }

  async upsert(record: MemoryRecord): Promise<void> {
    const [vector] = await this.embeddings.embed([`search_document: ${record.text}`]);
    if (vector === undefined) {
      throw new Error("memory-store: embedding provider returned no vector for upsert.");
    }
    const tx = this.db.transaction(() => {
      // seq is computed inside the tx so concurrent upserts of new ids cannot collide on MAX(seq)+1.
      const seq = this.nextSeq(record.id);
      this.db.prepare(
        `INSERT INTO memories (
           id, seq, type, status, text, salience, is_insight, created_at, last_accessed_at,
           access_count, valid_from, valid_to, superseded_by, superseded_at, due_at, collection,
           source_session, source_file, source_line, embedding_model, dim, tags
         ) VALUES (
           @id, @seq, @type, @status, @text, @salience, @is_insight, @created_at, @last_accessed_at,
           @access_count, @valid_from, @valid_to, @superseded_by, @superseded_at, @due_at, @collection,
           @source_session, @source_file, @source_line, @embedding_model, @dim, @tags
         )
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type, status=excluded.status, text=excluded.text, salience=excluded.salience,
           is_insight=excluded.is_insight, last_accessed_at=excluded.last_accessed_at,
           access_count=excluded.access_count, valid_from=excluded.valid_from, valid_to=excluded.valid_to,
           superseded_by=excluded.superseded_by, superseded_at=excluded.superseded_at, due_at=excluded.due_at,
           collection=excluded.collection, source_session=excluded.source_session, source_file=excluded.source_file,
           source_line=excluded.source_line, embedding_model=excluded.embedding_model, dim=excluded.dim,
           tags=excluded.tags`,
      ).run(this.toRow(record, seq));
      this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(record.id);
      this.db.prepare(`INSERT INTO memories_fts (id, text) VALUES (?, ?)`).run(record.id, record.text);
      // NOTE (from Task 2 spike): sqlite-vec vec0 rejects float64-bound rowids — bind as BigInt.
      this.db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(BigInt(seq));
      this.db.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)`).run(BigInt(seq), toBlob(vector));
    });
    tx();
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.fromRow(row);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
    const topK = options.topK ?? 8;
    const candidates = options.candidates ?? Math.max(topK * 4, 20);
    const now = options.now ?? this.clock();

    const vecIds = await this.vectorCandidates(query, candidates);
    const ftsIds = this.keywordCandidates(query, candidates);
    const fused = rrfFuse([vecIds, ftsIds], this.k);
    if (fused.length === 0) return [];

    const byId = new Map(fused.map((f) => [f.id, f.rrfScore]));
    const placeholders = fused.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...fused.map((f) => f.id)) as Record<string, unknown>[];

    const scored: RecallHit[] = [];
    for (const row of rows) {
      const record = this.fromRow(row);
      if (!options.includeInvalid && (record.status === "invalidated" || record.status === "dropped")) continue;
      if (!options.includeInvalid && record.validTo !== undefined && new Date(record.validTo) < now) continue;
      const score = reScore(
        {
          rrfScore: byId.get(record.id) ?? 0,
          salience: record.salience,
          isInsight: record.isInsight,
          ...(record.lastAccessedAt !== undefined && { lastAccessedAt: record.lastAccessedAt }),
        },
        this.weights,
        this.decayGamma,
        now,
      );
      scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);
    this.bumpAccess(top.map((h) => h.record.id), now);
    return top.map((h) => ({ ...h, record: { ...h.record, accessCount: h.record.accessCount + 1, lastAccessedAt: now.toISOString() } }));
  }

  protected async vectorCandidates(query: string, limit: number): Promise<string[]> {
    const [vector] = await this.embeddings.embed([`search_query: ${query}`]);
    if (vector === undefined) return [];
    const rows = this.db
      .prepare(`SELECT m.id AS id FROM memories_vec v JOIN memories m ON m.seq = v.rowid WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`)
      .all(toBlob(vector), limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  protected keywordCandidates(query: string, limit: number): string[] {
    const match = ftsQuery(query);
    if (match.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`)
      .all(match, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  async supersede(oldId: string, replacement: MemoryRecord): Promise<void> {
    if (oldId === replacement.id) {
      throw new Error("memory-store: supersede requires a replacement with a distinct id.");
    }
    if (this.get(oldId) === undefined) {
      throw new Error(`memory-store: cannot supersede unknown memory "${oldId}".`);
    }
    const now = this.clock().toISOString();
    await this.upsert(replacement);
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE memories SET status = 'invalidated', superseded_by = ?, superseded_at = ?, valid_to = ? WHERE id = ?`,
      ).run(replacement.id, now, now, oldId);
      this.db.prepare(
        `INSERT OR IGNORE INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'supersedes', 1.0, ?)`,
      ).run(oldId, replacement.id, now);
    });
    tx();
  }

  edges(src: string): { src: string; dst: string; kind: string; weight: number }[] {
    return this.db.prepare(`SELECT src, dst, kind, weight FROM edges WHERE src = ?`).all(src) as {
      src: string; dst: string; kind: string; weight: number;
    }[];
  }

  addEdge(src: string, dst: string, kind: "thread" | "about" | "supports" | "supersedes", weight = 1.0): void {
    this.db.prepare(
      `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight`,
    ).run(src, dst, kind, weight, this.clock().toISOString());
  }

  expand(seedIds: readonly string[], hops = 1): MemoryRecord[] {
    const seeds = new Set(seedIds);
    let frontier = new Set(seedIds);
    const reached = new Set<string>();
    for (let hop = 0; hop < hops; hop += 1) {
      const next = new Set<string>();
      for (const id of frontier) {
        const rows = this.db
          .prepare(`SELECT dst FROM edges WHERE src = ? AND kind IN ('thread','about')`)
          .all(id) as { dst: string }[];
        for (const { dst } of rows) {
          if (!seeds.has(dst) && !reached.has(dst)) {
            next.add(dst);
            reached.add(dst);
          }
        }
      }
      frontier = next;
    }
    const ids = [...reached];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Wipe the index and rebuild it from the supplied records (used by rebuild-from-files). No LLM.
   * Not atomic across records: the wipe is transactional, but if a re-upsert throws mid-way the index
   * is left partially rebuilt. Since the index is rebuildable from canonical files, callers should
   * treat a thrown rebuild as "index dirty — re-run" rather than relying on all-or-nothing semantics.
   */
  async rebuild(records: readonly MemoryRecord[]): Promise<{ indexed: number }> {
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM memories_vec; DELETE FROM edges;`);
    });
    tx();
    for (const record of records) {
      await this.upsert(record);
    }
    return { indexed: records.length };
  }

  protected bumpAccess(ids: readonly string[], now: Date): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(now.toISOString(), id);
    });
    tx();
  }

  protected nextSeq(id: string): number {
    const existing = this.db.prepare(`SELECT seq FROM memories WHERE id = ?`).get(id) as { seq: number } | undefined;
    if (existing !== undefined) return existing.seq;
    const max = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM memories`).get() as { m: number };
    return max.m + 1;
  }

  protected toRow(record: MemoryRecord, seq: number): Record<string, unknown> {
    return {
      id: record.id,
      seq,
      type: record.type,
      status: record.status,
      text: record.text,
      salience: record.salience,
      is_insight: record.isInsight ? 1 : 0,
      created_at: record.createdAt,
      last_accessed_at: record.lastAccessedAt ?? null,
      access_count: record.accessCount,
      valid_from: record.validFrom ?? null,
      valid_to: record.validTo ?? null,
      superseded_by: record.supersededBy ?? null,
      superseded_at: record.supersededAt ?? null,
      due_at: record.dueAt ?? null,
      collection: record.collection ?? null,
      source_session: record.source.session ?? null,
      source_file: record.source.file ?? null,
      source_line: record.source.line ?? null,
      embedding_model: record.embeddingModel ?? this.embeddings.id,
      dim: record.dim ?? this.dim,
      tags: JSON.stringify(record.tags),
    };
  }

  protected fromRow(row: Record<string, unknown>): MemoryRecord {
    const str = (v: unknown): string => String(v);
    return {
      id: str(row.id),
      type: row.type as MemoryRecord["type"],
      status: row.status as MemoryRecord["status"],
      text: str(row.text),
      salience: Number(row.salience),
      isInsight: Number(row.is_insight) === 1,
      createdAt: str(row.created_at),
      ...(row.last_accessed_at != null && { lastAccessedAt: str(row.last_accessed_at) }),
      accessCount: Number(row.access_count),
      ...(row.valid_from != null && { validFrom: str(row.valid_from) }),
      ...(row.valid_to != null && { validTo: str(row.valid_to) }),
      ...(row.superseded_by != null && { supersededBy: str(row.superseded_by) }),
      ...(row.superseded_at != null && { supersededAt: str(row.superseded_at) }),
      ...(row.due_at != null && { dueAt: str(row.due_at) }),
      ...(row.collection != null && { collection: str(row.collection) }),
      source: {
        ...(row.source_session != null && { session: str(row.source_session) }),
        ...(row.source_file != null && { file: str(row.source_file) }),
        ...(row.source_line != null && { line: Number(row.source_line) }),
      },
      ...(row.embedding_model != null && { embeddingModel: str(row.embedding_model) }),
      ...(row.dim != null && { dim: Number(row.dim) }),
      tags: JSON.parse(str(row.tags ?? "[]")) as string[],
    };
  }

  close(): void {
    this.db.close();
  }
}

export function openMemoryDb(options: MemoryDbOptions): MemoryDb {
  return new MemoryDb(options);
}
