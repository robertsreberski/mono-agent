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
  DEFAULT_VEC_DIM,
  DEFAULT_WEIGHTS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type EntityRecord,
  type EntityRelationRecord,
  type MemoryEntityAssociation,
  type ContentHashRecord,
  type IndexMetadata,
  type MemoryDbOptions,
  type MemoryStoreStats,
  type MemoryStoreAudit,
  type MemoryStoreStatsOptions,
  type MemoryRecord,
  type RecallHit,
  type RecallOptions,
  type RecallWeights,
  type SimilarHit,
} from "./types.js";
import type { EmbeddingProvider } from "../search/index.js";

const MIN_SEMANTIC_SIMILARITY = 0.5;
const VECTOR_CANDIDATE_SCAN_CAP = 4_096;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
const RECALL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from",
  "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "that", "the",
  "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with",
]);

export class MemoryDb {
  protected readonly db: Database;
  protected readonly embeddings: EmbeddingProvider | undefined;
  protected readonly dim: number;
  protected readonly k: number;
  protected readonly weights: RecallWeights;
  protected readonly decayGamma: number;
  protected readonly clock: () => Date;

  constructor(options: MemoryDbOptions) {
    // Validate dim only when explicitly provided; absent → default 768 for the vec table DDL.
    if (options.dim !== undefined && (!Number.isInteger(options.dim) || options.dim <= 0)) {
      throw new Error("MemoryDb: dim must be a positive integer.");
    }
    const vecDim = options.dim ?? DEFAULT_VEC_DIM;
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new BetterSqlite3(options.path, options.readOnly === true
      ? { readonly: true, fileMustExist: true }
      : undefined);
    if (options.readOnly !== true) this.db.pragma("journal_mode = WAL");
    // WAL gives concurrent readers + a single writer. better-sqlite3 (v11) already defaults
    // busy_timeout to 5000ms, so a second connection (e.g. the bundled recall-tool child opening
    // the same db next to the live in-app store) retries on a locked db instead of throwing
    // SQLITE_BUSY. open.test.ts pins this
    // invariant — if an upgrade ever drops the default, the test fails and we set it explicitly here.
    loadVec(this.db);
    if (options.readOnly !== true) {
      for (const statement of migrations(vecDim)) this.db.exec(statement);
    }
    this.embeddings = options.embeddings;
    this.dim = vecDim;
    this.k = options.k ?? DEFAULT_RRF_K;
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.decayGamma = options.decayGamma ?? DEFAULT_DECAY_GAMMA;
    this.clock = options.clock ?? (() => new Date());
  }

  vecVersion(): string {
    const row = this.db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
    return row?.v ?? "";
  }

  /** Configured busy_timeout in ms — how long a blocked writer waits before SQLITE_BUSY. */
  busyTimeoutMs(): number {
    return Number(this.db.pragma("busy_timeout", { simple: true }));
  }

  /**
   * Guard that an embedding vector matches the configured `dim` before it reaches sqlite-vec.
   * Surfaces a clear error (e.g. when the embedding model changed but `dim` was left stale) instead
   * of the opaque sqlite-vec failure on INSERT/MATCH.
   */
  protected assertVectorDim(vector: readonly number[], context: string): void {
    if (vector.length !== this.dim) {
      throw new Error(
        `memory-store: embedding dimension mismatch in ${context} — expected ${this.dim}, got ${vector.length}. ` +
          "Ensure the embedding model matches the configured `dim`.",
      );
    }
  }

  async upsert(record: MemoryRecord): Promise<void> {
    await this.upsertMany([record]);
  }

  /**
   * Persist the lexical row immediately without calling an embedding service.
   * Journal uses this on the response path, then upgrades the row with a vector
   * from its bounded background queue.
   */
  upsertLexical(record: MemoryRecord, contentHash?: string): void {
    this.persistRecords([record], [undefined], true);
    if (contentHash !== undefined && record.source.file !== undefined) this.recordContentHash({
      contentHash,
      memoryId: record.id,
      sourceFile: record.source.file,
      createdAt: record.createdAt,
    });
  }

  /**
   * Atomically reserve a Journal content hash and make its lexical row visible.
   * The unique hash is the cross-process dedupe authority.
   */
  insertJournalLexical(record: MemoryRecord, contentHash: string): { inserted: boolean; memoryId: string } {
    if (record.source.file === undefined) {
      throw new Error("memory-store: journal content hashes require source.file provenance.");
    }
    const tx = this.db.transaction((): { inserted: boolean; memoryId: string } => {
      const existing = this.db.prepare(
        `SELECT memory_id FROM content_hashes WHERE content_hash = ?`,
      ).get(contentHash) as { memory_id: string } | undefined;
      if (existing !== undefined) return { inserted: false, memoryId: existing.memory_id };
      this.persistRecordsUnsafe([record], [undefined], true);
      this.db.prepare(
        `INSERT INTO content_hashes (content_hash, memory_id, source_file, created_at) VALUES (?, ?, ?, ?)`,
      ).run(contentHash, record.id, record.source.file, record.createdAt);
      return { inserted: true, memoryId: record.id };
    });
    return tx();
  }

  /** Embed and persist records in provider-sized batches (default 32). */
  async upsertMany(
    records: readonly MemoryRecord[],
    options: { readonly batchSize?: number } = {},
  ): Promise<{ indexed: number; embeddingCalls: number }> {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE, 256));
    let embeddingCalls = 0;
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const batch = records.slice(offset, offset + batchSize);
      let vectors: Array<readonly number[] | undefined>;
      if (this.embeddings === undefined) {
        vectors = batch.map(() => undefined);
      } else {
        const embedded = await this.embeddings.embed(batch.map((record) => `search_document: ${record.text}`));
        embeddingCalls += 1;
        if (embedded.length !== batch.length) {
          throw new Error(
            `memory-store: embedding provider returned ${embedded.length} vectors for ${batch.length} records.`,
          );
        }
        vectors = embedded.map((vector) => {
          this.assertVectorDim(vector, "upsertMany");
          return vector;
        });
      }
      this.persistRecords(batch, vectors, true);
    }
    return { indexed: records.length, embeddingCalls };
  }

  /**
   * Prepare one provider batch before a caller mutates canonical source files.
   * BuJo capture uses the returned vectors with commitPreparedUpserts so an
   * embedding outage cannot leave a newly edited source pretending success.
   */
  async prepareUpsertVectors(
    records: readonly MemoryRecord[],
  ): Promise<readonly (readonly number[] | undefined)[]> {
    if (this.embeddings === undefined) return records.map(() => undefined);
    if (records.length === 0) return [];
    const vectors = await this.embeddings.embed(records.map((record) => `search_document: ${record.text}`));
    if (vectors.length !== records.length) {
      throw new Error(`memory-store: embedding provider returned ${vectors.length} vectors for ${records.length} records.`);
    }
    vectors.forEach((vector) => this.assertVectorDim(vector, "prepareUpsertVectors"));
    return vectors;
  }

  /** Persist records with vectors prepared by this DB's configured provider. */
  commitPreparedUpserts(
    records: readonly MemoryRecord[],
    vectors: readonly (readonly number[] | undefined)[],
  ): void {
    this.persistRecords(records, vectors, true);
  }

  /**
   * Add/refresh vectors without replaying a queued record snapshot over newer
   * status, source, or access telemetry.
   */
  async indexVectors(
    records: readonly Pick<MemoryRecord, "id" | "text">[],
    options: { readonly batchSize?: number; readonly abortSignal?: AbortSignal } = {},
  ): Promise<{ indexed: number; skipped: number; embeddingCalls: number }> {
    if (this.embeddings === undefined || records.length === 0) {
      return { indexed: 0, skipped: records.length, embeddingCalls: 0 };
    }
    const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE, 256));
    let indexed = 0;
    let skipped = 0;
    let embeddingCalls = 0;
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const batch = records.slice(offset, offset + batchSize);
      const vectors = await this.embeddings.embed(batch.map((record) => `search_document: ${record.text}`));
      options.abortSignal?.throwIfAborted();
      embeddingCalls += 1;
      if (vectors.length !== batch.length) {
        throw new Error(`memory-store: embedding provider returned ${vectors.length} vectors for ${batch.length} records.`);
      }
      vectors.forEach((vector) => this.assertVectorDim(vector, "indexVectors"));
      const current = this.db.prepare(`SELECT seq, text FROM memories WHERE id = ?`);
      const deleteVec = this.db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`);
      const insertVec = this.db.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)`);
      const markIdentity = this.db.prepare(`UPDATE memories SET embedding_model = ?, dim = ? WHERE id = ?`);
      const tx = this.db.transaction(() => {
        for (const [index, record] of batch.entries()) {
          const row = current.get(record.id) as { seq: number; text: string } | undefined;
          if (row === undefined || row.text !== record.text) {
            skipped += 1;
            continue;
          }
          deleteVec.run(BigInt(row.seq));
          insertVec.run(BigInt(row.seq), toBlob(vectors[index]!));
          markIdentity.run(this.embeddings!.id, this.dim, record.id);
          indexed += 1;
        }
      });
      tx();
    }
    return { indexed, skipped, embeddingCalls };
  }

  private persistRecords(
    records: readonly MemoryRecord[],
    vectors: readonly (readonly number[] | undefined)[],
    clearMissingVector: boolean,
  ): void {
    if (records.length !== vectors.length) {
      throw new Error("memory-store: record/vector batch length mismatch.");
    }
    const tx = this.db.transaction(() => this.persistRecordsUnsafe(records, vectors, clearMissingVector));
    tx();
  }

  private persistRecordsUnsafe(
    records: readonly MemoryRecord[],
    vectors: readonly (readonly number[] | undefined)[],
    clearMissingVector: boolean,
  ): void {
    const upsertMemory = this.db.prepare(
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
    );
    const deleteFts = this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`);
    const insertFts = this.db.prepare(`INSERT INTO memories_fts (id, text) VALUES (?, ?)`);
    const deleteVec = this.db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`);
    const insertVec = this.db.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)`);
    for (const [index, record] of records.entries()) {
      const vector = vectors[index];
      // seq is computed inside the caller's tx so concurrent new ids cannot collide.
      const seq = this.nextSeq(record.id);
      upsertMemory.run(this.toRow(record, seq));
      deleteFts.run(record.id);
      insertFts.run(record.id, record.text);
      if (vector !== undefined || clearMissingVector) {
        deleteVec.run(BigInt(seq));
      }
      if (vector !== undefined) {
        insertVec.run(BigInt(seq), toBlob(vector));
      }
    }
  }

  hasVector(id: string): boolean {
    return this.db.prepare(
      `SELECT 1 AS present FROM memories m JOIN memories_vec v ON v.rowid = m.seq WHERE m.id = ? LIMIT 1`,
    ).get(id) !== undefined;
  }

  recordsMissingVectors(limit = 512, excludeIds: readonly string[] = []): MemoryRecord[] {
    const normalized = Math.max(0, Math.min(Math.trunc(limit), 4_096));
    const excluded = [...new Set(excludeIds)].slice(0, 256);
    const exclusion = excluded.length === 0
      ? ""
      : ` AND m.id NOT IN (${excluded.map(() => "?").join(",")})`;
    const rows = this.db.prepare(
      `SELECT m.* FROM memories m LEFT JOIN memories_vec v ON v.rowid = m.seq
       WHERE v.rowid IS NULL AND m.status NOT IN ('invalidated','dropped')${exclusion}
       ORDER BY m.seq ASC LIMIT ?`,
    ).all(...excluded, normalized) as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }

  countMissingVectors(): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM memories m LEFT JOIN memories_vec v ON v.rowid = m.seq
       WHERE v.rowid IS NULL AND m.status NOT IN ('invalidated','dropped')`,
    ).get() as { n: number }).n;
  }

  hasContentHash(contentHash: string): boolean {
    return this.db.prepare(`SELECT 1 AS present FROM content_hashes WHERE content_hash = ?`).get(contentHash) !== undefined;
  }

  contentHashRecord(contentHash: string): ContentHashRecord | undefined {
    const row = this.db.prepare(
      `SELECT content_hash, memory_id, source_file, created_at FROM content_hashes WHERE content_hash = ?`,
    ).get(contentHash) as {
      content_hash: string;
      memory_id: string;
      source_file: string;
      created_at: string;
    } | undefined;
    return row === undefined ? undefined : {
      contentHash: row.content_hash,
      memoryId: row.memory_id,
      sourceFile: row.source_file,
      createdAt: row.created_at,
    };
  }

  recordContentHash(record: ContentHashRecord): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO content_hashes (content_hash, memory_id, source_file, created_at) VALUES (?, ?, ?, ?)`,
    ).run(record.contentHash, record.memoryId, record.sourceFile, record.createdAt);
  }

  /**
   * Canonicalize one legacy Journal bullet onto its content-derived id without
   * rewriting the Markdown source. The lexicographically earliest source
   * location is the deterministic representative, independent of scan/process
   * ordering; any old source id is retained only as a dropped, non-recallable
   * row when it already existed in an older index.
   */
  recoverJournalLexical(record: MemoryRecord, contentHash: string, sourceId: string): void {
    if (record.source.file === undefined || record.source.line === undefined) {
      throw new Error("memory-store: Journal recovery requires source file and line provenance.");
    }
    const tx = this.db.transaction(() => {
      const existing = this.get(record.id);
      const sourceKey = journalSourceKey(record);
      const existingSourceKey = existing === undefined ? undefined : journalSourceKey(existing);
      const recordWins = (
        existing === undefined
        || existingSourceKey === undefined
        || sourceKey < existingSourceKey
        || (sourceKey === existingSourceKey && journalRecordChanged(existing, record))
      );
      if (recordWins) {
        this.persistRecordsUnsafe([record], [undefined], true);
      }
      const representative = recordWins ? record : existing;
      const priorAtSource = this.db.prepare(
        `SELECT id FROM memories WHERE source_file = ? AND source_line = ? AND id <> ?`,
      ).all(record.source.file, record.source.line, record.id) as { id: string }[];
      for (const prior of priorAtSource) {
        this.db.prepare(`UPDATE memories SET status = 'dropped' WHERE id = ?`).run(prior.id);
        this.db.prepare(`DELETE FROM content_hashes WHERE memory_id = ?`).run(prior.id);
      }
      this.db.prepare(
        `INSERT INTO content_hashes (content_hash, memory_id, source_file, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET
           memory_id = excluded.memory_id,
           source_file = excluded.source_file,
           created_at = excluded.created_at`,
      ).run(contentHash, representative.id, representative.source.file, representative.createdAt);
      if (sourceId !== record.id) {
        this.db.prepare(`UPDATE memories SET status = 'dropped' WHERE id = ?`).run(sourceId);
        this.db.prepare(`DELETE FROM content_hashes WHERE memory_id = ? AND content_hash <> ?`).run(sourceId, contentHash);
      }
    });
    tx();
  }

  deleteContentHashesForMemory(memoryId: string): void {
    this.db.prepare(`DELETE FROM content_hashes WHERE memory_id = ?`).run(memoryId);
  }

  countContentHashes(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM content_hashes`).get() as { n: number }).n;
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.fromRow(row);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
  }

  stats(options: MemoryStoreStatsOptions = {}): MemoryStoreStats {
    const topEntitiesLimit = normalizeNonNegativeInteger(
      options.topEntitiesLimit ?? 10,
      "memory-store: stats topEntitiesLimit must be a non-negative integer.",
    );
    const countsByStatus = Object.fromEntries(MEMORY_STATUSES.map((status) => [status, 0])) as Record<
      (typeof MEMORY_STATUSES)[number],
      number
    >;
    const countsByType = Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0])) as Record<
      (typeof MEMORY_TYPES)[number],
      number
    >;

    const totalMemories = (this.db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
    const liveMemories = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status NOT IN ('invalidated','dropped')`).get() as { n: number }
    ).n;

    const statusRows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM memories GROUP BY status`).all() as {
      status: MemoryRecord["status"];
      n: number;
    }[];
    for (const row of statusRows) countsByStatus[row.status] = row.n;

    const typeRows = this.db.prepare(`SELECT type, COUNT(*) AS n FROM memories GROUP BY type`).all() as {
      type: MemoryRecord["type"];
      n: number;
    }[];
    for (const row of typeRows) countsByType[row.type] = row.n;

    const latestCreatedRow = this.db.prepare(
      `SELECT * FROM memories ORDER BY created_at DESC, id ASC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    const latestAccessedRow = this.db.prepare(
      `SELECT * FROM memories WHERE last_accessed_at IS NOT NULL ORDER BY last_accessed_at DESC, created_at DESC, id ASC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    const entityRows = this.db.prepare(
      `SELECT * FROM entities ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC, name ASC, id ASC LIMIT ?`,
    ).all(topEntitiesLimit) as Record<string, unknown>[];

    return {
      totalMemories,
      liveMemories,
      countsByStatus,
      countsByType,
      ...(latestCreatedRow !== undefined && { latestCreatedMemory: this.fromRow(latestCreatedRow) }),
      ...(latestAccessedRow !== undefined && { latestAccessedMemory: this.fromRow(latestAccessedRow) }),
      topEntities: entityRows.map((row) => this.entityFromRow(row)),
    };
  }

  /** Aggregate-only health metrics for `mono-agent memory audit --json`. */
  audit(): MemoryStoreAudit {
    const counts = this.db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status NOT IN ('invalidated','dropped') THEN 1 ELSE 0 END) AS live,
         SUM(CASE WHEN status NOT IN ('invalidated','dropped') THEN access_count ELSE 0 END) AS total_access,
         SUM(CASE WHEN status NOT IN ('invalidated','dropped') AND access_count > 0 THEN 1 ELSE 0 END) AS accessed
       FROM memories`,
    ).get() as { total: number; live: number | null; total_access: number | null; accessed: number | null };
    const duplicate = this.db.prepare(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(n - 1), 0) AS redundant
       FROM (
         SELECT COUNT(*) AS n
         FROM memories
         WHERE status NOT IN ('invalidated','dropped')
         GROUP BY lower(trim(text))
         HAVING COUNT(*) > 1
       )`,
    ).get() as { groups: number; redundant: number };
    const vectors = this.db.prepare(
      `SELECT
         COUNT(*) AS indexed,
         SUM(CASE WHEN m.status NOT IN ('invalidated','dropped') THEN 1 ELSE 0 END) AS live_indexed
       FROM memories_vec v
       JOIN memories m ON m.seq = v.rowid`,
    ).get() as { indexed: number; live_indexed: number | null };
    const entities = (this.db.prepare(`SELECT COUNT(*) AS n FROM entities`).get() as { n: number }).n;
    const entityRelations = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM entity_relations`).get() as { n: number }
    ).n;
    const hasMemoryEntities = this.tableExists("memory_entities");
    const memoryEntityAssociations = hasMemoryEntities
      ? (this.db.prepare(`SELECT COUNT(*) AS n FROM memory_entities`).get() as { n: number }).n
      : 0;
    const orphanedAssociations = hasMemoryEntities ? this.orphanedAssociationCount() : 0;
    const live = counts.live ?? 0;
    const totalAccess = counts.total_access ?? 0;
    const concentrationRows = this.db.prepare(
      `SELECT access_count FROM memories
       WHERE status NOT IN ('invalidated','dropped')
       ORDER BY access_count DESC, id ASC LIMIT ?`,
    ).all(Math.max(1, Math.ceil(live * 0.01))) as Array<{ access_count: number }>;
    const concentrated = concentrationRows.reduce((sum, row) => sum + row.access_count, 0);
    const liveIndexed = vectors.live_indexed ?? 0;
    return {
      counts: {
        total: counts.total,
        live,
        entities,
        entityRelations,
        memoryEntityAssociations,
        orphanedAssociations,
      },
      duplicates: {
        groups: duplicate.groups,
        redundantRecords: duplicate.redundant,
        ratio: live === 0 ? 0 : duplicate.redundant / live,
      },
      vectors: {
        indexed: vectors.indexed,
        liveIndexed,
        liveCoverage: live === 0 ? 1 : liveIndexed / live,
      },
      access: {
        totalCount: totalAccess,
        accessedMemories: counts.accessed ?? 0,
        topOnePercentShare: totalAccess === 0 ? 0 : concentrated / totalAccess,
      },
    };
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
    const topK = options.topK ?? 8;
    const candidates = options.candidates ?? Math.max(topK * 4, 20);
    const now = options.now ?? this.clock();

    const ftsIds = this.keywordCandidates(query, candidates, options.includeInvalid === true, now);
    const vecCandidates = this.embeddings !== undefined
      ? await this.vectorCandidates(query, candidates, options.includeInvalid === true, now)
      : [];
    const vecIds = vecCandidates.map((candidate) => candidate.id);
    const vectorSimilarity = new Map(vecCandidates.map((candidate) => [candidate.id, candidate.similarity]));
    const retrieverCount = Number(vecIds.length > 0) + Number(ftsIds.length > 0);
    // When embeddings are absent, fuse only the FTS list (RRF of one list still re-ranks correctly).
    const fused = rrfFuse([vecIds, ftsIds], this.k);
    if (fused.length === 0) return [];

    const byId = new Map(fused.map((f) => [f.id, f.rrfScore]));
    const placeholders = fused.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...fused.map((f) => f.id)) as Record<string, unknown>[];

    const scored: RecallHit[] = [];
    const queryTokens = relevanceTokens(query);
    for (const row of rows) {
      const record = this.fromRow(row);
      if (!options.includeInvalid && (record.status === "invalidated" || record.status === "dropped")) continue;
      if (!options.includeInvalid && record.validTo !== undefined && new Date(record.validTo) < now) continue;
      const lexical = lexicalEvidence(queryTokens, record.text);
      const semanticSimilarity = vectorSimilarity.get(record.id) ?? 0;
      const semantic = semanticSimilarity >= MIN_SEMANTIC_SIMILARITY ? semanticSimilarity : 0;
      const evidence = Math.min(1, Math.max(lexical, semantic) + (lexical > 0 && semantic > 0 ? 0.05 : 0));
      // Normalize the small RRF value into a bounded rank hint. It may break ties,
      // but cannot make a no-evidence vector neighbour look relevant.
      const fusedRank = Math.min(1, ((byId.get(record.id) ?? 0) * (this.k + 1)) / retrieverCount);
      const relevance = evidence === 0 ? fusedRank * 0.05 : evidence * 0.9 + fusedRank * 0.1;
      const score = reScore(
        {
          rrfScore: relevance,
          salience: record.salience,
          isInsight: record.isInsight,
        },
        this.weights,
        this.decayGamma,
        now,
      );
      scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));
    const top = scored.slice(0, topK);
    if (options.trackAccess === false) {
      return top;
    }
    this.bumpAccess(top.map((h) => h.record.id), now);
    return top.map((h) => ({ ...h, record: { ...h.record, accessCount: h.record.accessCount + 1, lastAccessedAt: now.toISOString() } }));
  }

  protected async vectorCandidates(
    query: string,
    limit: number,
    includeInvalid = false,
    now = this.clock(),
  ): Promise<Array<{ id: string; similarity: number }>> {
    if (this.embeddings === undefined) return [];
    const [vector] = await this.embeddings.embed([`search_query: ${query}`]);
    if (vector === undefined) return [];
    this.assertVectorDim(vector, "recall");
    const validity = includeInvalid
      ? ""
      : " AND m.status NOT IN ('invalidated','dropped') AND (m.valid_to IS NULL OR m.valid_to >= ?)";
    const statement = this.db.prepare(
      `SELECT m.id AS id, v.distance AS distance
       FROM memories_vec v JOIN memories m ON m.seq = v.rowid
       WHERE v.embedding MATCH ? AND k = ?${validity}
       ORDER BY v.distance`,
    );
    const totalVectors = includeInvalid
      ? limit
      : (this.db.prepare(`SELECT COUNT(*) AS n FROM memories_vec`).get() as { n: number }).n;
    const maxScan = Math.min(totalVectors, Math.max(limit, VECTOR_CANDIDATE_SCAN_CAP));
    let scan = Math.min(totalVectors, Math.max(1, limit));
    let rows: Array<{ id: string; distance: number }> = [];
    do {
      rows = statement.all(toBlob(vector), scan, ...(includeInvalid ? [] : [now.toISOString()])) as Array<{
        id: string;
        distance: number;
      }>;
      if (rows.length >= limit || scan >= maxScan) break;
      scan = Math.min(maxScan, scan * 2);
    } while (scan > 0);
    return rows.slice(0, limit)
      .map((row) => ({ id: row.id, similarity: Math.max(-1, Math.min(1, 1 - row.distance)) }));
  }

  protected keywordCandidates(query: string, limit: number, includeInvalid = false, now = this.clock()): string[] {
    const match = ftsQuery(query);
    if (match.length === 0) return [];
    const rows = includeInvalid
      ? this.db
        .prepare(`SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`)
        .all(match, limit) as { id: string }[]
      : this.db
        .prepare(
          `SELECT memories_fts.id AS id
           FROM memories_fts JOIN memories m ON m.id = memories_fts.id
           WHERE memories_fts MATCH ?
             AND m.status NOT IN ('invalidated','dropped')
             AND (m.valid_to IS NULL OR m.valid_to >= ?)
           ORDER BY bm25(memories_fts) LIMIT ?`,
        )
        .all(match, now.toISOString(), limit) as { id: string }[];
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
    this.markSuperseded(oldId, replacement.id, now);
  }

  markSuperseded(oldId: string, replacementId: string, at = this.clock().toISOString()): void {
    if (oldId === replacementId) {
      throw new Error("memory-store: supersede requires a replacement with a distinct id.");
    }
    if (this.get(oldId) === undefined) {
      throw new Error(`memory-store: cannot supersede unknown memory "${oldId}".`);
    }
    if (this.get(replacementId) === undefined) {
      throw new Error(`memory-store: cannot supersede with unknown replacement "${replacementId}".`);
    }
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE memories SET status = 'invalidated', superseded_by = ?, superseded_at = ?, valid_to = ? WHERE id = ?`,
      ).run(replacementId, at, at, oldId);
      this.db.prepare(
        `INSERT OR IGNORE INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'supersedes', 1.0, ?)`,
      ).run(oldId, replacementId, at);
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

  async findSimilar(text: string, k = 5): Promise<SimilarHit[]> {
    return (await this.findSimilarMany([text], k))[0] ?? [];
  }

  /** One provider batch for all capture candidates, then bounded local KNN per candidate. */
  async findSimilarMany(texts: readonly string[], k = 5): Promise<SimilarHit[][]> {
    if (this.embeddings === undefined || texts.length === 0) return texts.map(() => []);
    const vectors = await this.embeddings.embed(texts.map((text) => `search_document: ${text}`));
    if (vectors.length !== texts.length) {
      throw new Error(`memory-store: embedding provider returned ${vectors.length} vectors for ${texts.length} similarity queries.`);
    }
    return vectors.map((vector) => this.findSimilarVector(vector, k));
  }

  private findSimilarVector(vector: readonly number[], k: number): SimilarHit[] {
    this.assertVectorDim(vector, "findSimilarMany");
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, v.distance AS distance FROM memories_vec v JOIN memories m ON m.seq = v.rowid WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`,
      )
      .all(toBlob(vector), k + 8) as { id: string; distance: number }[]; // over-fetch, filter, then trim
    const out: SimilarHit[] = [];
    for (const row of rows) {
      const record = this.get(row.id);
      if (record === undefined) continue;
      if (record.status === "invalidated" || record.status === "dropped") continue;
      out.push({ record, distance: row.distance });
      if (out.length >= k) break;
    }
    return out;
  }

  /**
   * Wipe the index and rebuild it from the supplied records (used by rebuild-from-files). No LLM.
   * Wipes ALL index tables — including entities/entity_relations — so the caller is responsible for
   * repopulating the entity graph afterwards (memory-bujo's rebuildFromMarkdown re-ingests graph.jsonl).
   * Not atomic across records: the wipe is transactional, but if a re-upsert throws mid-way the index
   * is left partially rebuilt. Since the index is rebuildable from canonical files, callers should
   * treat a thrown rebuild as "index dirty — re-run" rather than relying on all-or-nothing semantics.
   */
  async rebuild(records: readonly MemoryRecord[]): Promise<{ indexed: number }> {
    const tx = this.db.transaction(() => {
      this.db.exec(
        `DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM memories_vec; DELETE FROM edges;
         DELETE FROM memory_entities; DELETE FROM entities; DELETE FROM entity_relations;
         DELETE FROM content_hashes; DELETE FROM index_metadata;`,
      );
    });
    tx();
    return await this.upsertMany(records);
  }

  protected bumpAccess(ids: readonly string[], now: Date): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(now.toISOString(), id);
    });
    tx();
  }

  /** Record served hits as telemetry. Access metadata never participates in ranking. */
  recordAccess(ids: readonly string[], now = this.clock()): void {
    this.bumpAccess(ids, now);
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
      embedding_model: record.embeddingModel ?? this.embeddings?.id ?? null,
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

  upsertEntity(entity: EntityRecord): void {
    this.db.prepare(
      `INSERT INTO entities (id, name, type, summary, created_at, updated_at)
       VALUES (@id, @name, @type, @summary, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = COALESCE(excluded.type, entities.type),
         summary = COALESCE(excluded.summary, entities.summary),
         updated_at = COALESCE(excluded.updated_at, entities.updated_at)`,
    ).run({
      id: entity.id,
      name: entity.name,
      type: entity.type ?? null,
      summary: entity.summary ?? null,
      created_at: entity.createdAt,
      updated_at: entity.updatedAt ?? null,
    });
  }

  getEntity(id: string): EntityRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.entityFromRow(row);
  }

  countEntities(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM entities`).get() as { n: number }).n;
  }

  /** All entities ordered by name, for index projections. */
  listEntities(limit = 50): EntityRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM entities ORDER BY name LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.entityFromRow(r));
  }

  addEntityRelation(src: string, dst: string, relation: string, createdAt = this.clock().toISOString()): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO entity_relations (src, dst, relation, created_at) VALUES (?, ?, ?, ?)`,
    ).run(src, dst, relation, createdAt);
  }

  relationsFor(src: string): EntityRelationRecord[] {
    const rows = this.db
      .prepare(`SELECT src, dst, relation, created_at FROM entity_relations WHERE src = ?`)
      .all(src) as { src: string; dst: string; relation: string; created_at: string }[];
    return rows.map((r) => ({ src: r.src, dst: r.dst, relation: r.relation, createdAt: r.created_at }));
  }

  relationsTouching(entityId: string): EntityRelationRecord[] {
    const rows = this.db
      .prepare(`SELECT src, dst, relation, created_at FROM entity_relations WHERE src = ? OR dst = ?`)
      .all(entityId, entityId) as { src: string; dst: string; relation: string; created_at: string }[];
    return rows.map((row) => ({
      src: row.src,
      dst: row.dst,
      relation: row.relation,
      createdAt: row.created_at,
    }));
  }

  associateMemory(record: MemoryEntityAssociation): void {
    if (this.get(record.memoryId) === undefined) {
      throw new Error(`memory-store: cannot associate unknown memory "${record.memoryId}".`);
    }
    if (this.getEntity(record.entityId) === undefined) {
      throw new Error(`memory-store: cannot associate unknown entity "${record.entityId}".`);
    }
    this.db.prepare(
      `INSERT INTO memory_entities (memory_id, entity_id, provenance, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id, entity_id) DO UPDATE SET
         provenance = CASE
           WHEN memory_entities.provenance = 'capture' THEN memory_entities.provenance
           ELSE excluded.provenance
         END`,
    ).run(record.memoryId, record.entityId, record.provenance, record.createdAt);
  }

  associationsForMemory(memoryId: string): MemoryEntityAssociation[] {
    const rows = this.db.prepare(
      `SELECT memory_id, entity_id, provenance, created_at FROM memory_entities WHERE memory_id = ? ORDER BY entity_id`,
    ).all(memoryId) as Array<{ memory_id: string; entity_id: string; provenance: MemoryEntityAssociation["provenance"]; created_at: string }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      entityId: row.entity_id,
      provenance: row.provenance,
      createdAt: row.created_at,
    }));
  }

  /**
   * Deterministic one-relation expansion for the explicit MemoryRecall tool.
   * Both relation directions are traversed, but never more than one relation.
   */
  expandEntityRelations(
    seedIds: readonly string[],
    options: { readonly query: string; readonly seedLimit?: number; readonly maxAdditions?: number; readonly now?: Date },
  ): MemoryRecord[] {
    const seedLimit = Math.max(1, Math.min(options.seedLimit ?? 3, 3));
    const maxAdditions = Math.max(0, Math.min(options.maxAdditions ?? 5, 5));
    if (maxAdditions === 0) return [];
    const seeds = new Set(seedIds.slice(0, seedLimit));
    const seedEntities = new Set<string>();
    for (const seedId of seeds) {
      for (const association of this.associationsForMemory(seedId)) seedEntities.add(association.entityId);
    }
    if (seedEntities.size === 0) return [];

    const queryTokens = relevanceTokens(options.query);
    const queryEntityIds = this.entityIdsMentionedInQuery(options.query);
    const relatedEntities = new Map<string, number>();
    for (const entityId of seedEntities) {
      for (const relation of this.relationsTouching(entityId)) {
        if (relation.src === relation.dst) continue;
        const relatedId = relation.src === entityId ? relation.dst : relation.src;
        const seedEntity = this.getEntity(entityId);
        const relatedEntity = this.getEntity(relatedId);
        if (seedEntity === undefined || relatedEntity === undefined) continue;
        // The seed name is deliberately excluded from path evidence. A query
        // about Morgan is not permission to traverse every relation Morgan has.
        const relationPhrases = normalizedRelationPhrases(relation.relation);
        if (relationPhrases.length === 0) continue;
        const relationTokens = new Set(relationPhrases.flat());
        const relatedTokens = relevanceTokens(relatedEntity.name);
        const overlap = tokenOverlap(queryTokens, relationTokens) + tokenOverlap(queryTokens, relatedTokens);
        if (overlap === 0 || !relationDirectionMatches(
          options.query,
          seedEntity.name,
          relatedEntity.name,
          relation.relation,
          relation.src === entityId,
          entityId,
          relatedId,
          (id, words) => this.entityReferenceIsUnique(id, words),
          queryEntityIds,
        )) continue;
        relatedEntities.set(relatedId, Math.max(relatedEntities.get(relatedId) ?? 0, overlap));
      }
    }
    if (relatedEntities.size === 0) return [];

    const entities = [...relatedEntities.keys()];
    const placeholders = entities.map(() => "?").join(",");
    const now = (options.now ?? this.clock()).toISOString();
    const rows = this.db.prepare(
      `SELECT m.*, me.entity_id AS graph_entity_id
       FROM memory_entities me
       JOIN memories m ON m.id = me.memory_id
       JOIN entities e ON e.id = me.entity_id
       WHERE me.entity_id IN (${placeholders})
         AND m.status NOT IN ('invalidated','dropped')
         AND (m.valid_to IS NULL OR m.valid_to >= ?)
       ORDER BY m.created_at DESC, m.id ASC`,
    ).all(...entities, now) as Array<Record<string, unknown> & { graph_entity_id: string }>;
    const ranked = new Map<string, { record: MemoryRecord; score: number }>();
    for (const row of rows) {
      const record = this.fromRow(row);
      if (seeds.has(record.id)) continue;
      const pathScore = relatedEntities.get(String(row.graph_entity_id)) ?? 0;
      const lexical = lexicalEvidence(queryTokens, record.text);
      const score = pathScore + lexical;
      const prior = ranked.get(record.id);
      if (prior === undefined || score > prior.score) ranked.set(record.id, { record, score });
    }
    return [...ranked.values()]
      .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id))
      .slice(0, maxAdditions)
      .map((entry) => entry.record);
  }

  /** Resolve one query-local entity spelling without materializing the entity catalog. */
  private entityReferenceIsUnique(entityId: string, words: readonly string[]): boolean {
    if (words.length === 0) return false;
    const phrase = words.join(" ");
    const rows = this.db.prepare(
      `SELECT id, name FROM entities
       WHERE id = ?
          OR lower(name) = (SELECT lower(name) FROM entities WHERE id = ?)
          OR lower(name) = ?
          OR lower(name) LIKE ?
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
       LIMIT 3`,
    ).all(entityId, entityId, phrase, `% ${phrase}`, entityId) as Array<{ id: string; name: string }>;
    const key = words.join("\u0000");
    const owners = rows.filter((row) => entityNameVariants(row.name).some((variant) => variant.join("\u0000") === key));
    return owners.length === 1 && owners[0]?.id === entityId;
  }

  /** Resolve only capitalized/type-qualified query-local names; never scan/materialize the catalog. */
  private entityIdsMentionedInQuery(query: string): ReadonlySet<string> {
    const rawWords = query.normalize("NFKC").match(/[\p{L}\p{N}-]+/gu) ?? [];
    const candidates = new Map<string, string[]>();
    for (let index = 0; index < rawWords.length;) {
      if (!startsUppercase(rawWords[index] ?? "")) {
        index += 1;
        continue;
      }
      const group: string[] = [];
      while (index < rawWords.length && startsUppercase(rawWords[index] ?? "")) {
        group.push(rawWords[index] ?? "");
        index += 1;
      }
      while (group.length > 0 && QUERY_NAME_PREFIXES.has((group[0] ?? "").toLocaleLowerCase("en-US"))) group.shift();
      const words = group.flatMap((word) => canonicalWords(word));
      if (words.length > 0) candidates.set(words.join("\u0000"), words);
    }
    const canonical = canonicalWords(query);
    for (let index = 0; index < canonical.length - 1; index += 1) {
      if (!GENERIC_ENTITY_PREFIXES.has(canonical[index] ?? "")) continue;
      const words = canonical.slice(index, index + 2);
      candidates.set(words.join("\u0000"), words);
    }
    const ids = new Set<string>();
    for (const words of candidates.values()) {
      for (const id of this.entityIdsForReference(words)) ids.add(id);
    }
    return ids;
  }

  private entityIdsForReference(words: readonly string[]): string[] {
    if (words.length === 0) return [];
    const phrase = words.join(" ");
    const rows = this.db.prepare(
      `SELECT id, name FROM entities
       WHERE lower(name) = ? OR lower(name) LIKE ?
       ORDER BY id
       LIMIT 4`,
    ).all(phrase, `% ${phrase}`) as Array<{ id: string; name: string }>;
    const key = words.join("\u0000");
    return rows
      .filter((row) => entityNameVariants(row.name).some((variant) => variant.join("\u0000") === key))
      .map((row) => row.id);
  }

  orphanedAssociationCount(): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM memory_entities me
       LEFT JOIN memories m ON m.id = me.memory_id
       LEFT JOIN entities e ON e.id = me.entity_id
       WHERE m.id IS NULL OR e.id IS NULL`,
    ).get() as { n: number }).n;
  }

  setIndexMetadata(metadata: IndexMetadata): void {
    const entries: Array<[string, string]> = [
      ["schemaVersion", String(metadata.schemaVersion)],
      ["policyVersion", metadata.policyVersion],
      ["tier", metadata.tier],
      ["sourceFingerprint", metadata.sourceFingerprint],
      ["generation", metadata.generation],
      ["createdAt", metadata.createdAt],
      ...(metadata.embeddingModel === undefined ? [] : [["embeddingModel", metadata.embeddingModel] as [string, string]]),
      ...(metadata.dimension === undefined ? [] : [["dimension", String(metadata.dimension)] as [string, string]]),
      ...(metadata.skippedRawRecords === undefined ? [] : [["skippedRawRecords", String(metadata.skippedRawRecords)] as [string, string]]),
      ...(metadata.skippedUnstructuredRecords === undefined ? [] : [["skippedUnstructuredRecords", String(metadata.skippedUnstructuredRecords)] as [string, string]]),
      ...(metadata.skippedMissingIdentityRecords === undefined ? [] : [["skippedMissingIdentityRecords", String(metadata.skippedMissingIdentityRecords)] as [string, string]]),
      ...(metadata.missingIdentityLocations === undefined ? [] : [["missingIdentityLocations", JSON.stringify(metadata.missingIdentityLocations)] as [string, string]]),
      ...(metadata.skippedLegacySourceRecords === undefined ? [] : [["skippedLegacySourceRecords", String(metadata.skippedLegacySourceRecords)] as [string, string]]),
      ...(metadata.legacySourceLocations === undefined ? [] : [["legacySourceLocations", JSON.stringify(metadata.legacySourceLocations)] as [string, string]]),
      ...(metadata.skippedJournalDuplicateRecords === undefined ? [] : [["skippedJournalDuplicateRecords", String(metadata.skippedJournalDuplicateRecords)] as [string, string]]),
      ...(metadata.parsedSourceItems === undefined ? [] : [["parsedSourceItems", String(metadata.parsedSourceItems)] as [string, string]]),
      ...(metadata.derivedLegacyAssociations === undefined ? [] : [["derivedLegacyAssociations", String(metadata.derivedLegacyAssociations)] as [string, string]]),
    ];
    const statement = this.db.prepare(
      `INSERT INTO index_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM index_metadata`).run();
      for (const entry of entries) statement.run(...entry);
    });
    tx();
  }

  indexMetadata(): IndexMetadata | undefined {
    if (!this.tableExists("index_metadata")) return undefined;
    const rows = this.db.prepare(`SELECT key, value FROM index_metadata`).all() as Array<{ key: string; value: string }>;
    if (rows.length === 0) return undefined;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const schemaVersion = Number(values.get("schemaVersion"));
    const policyVersion = values.get("policyVersion");
    const tier = values.get("tier");
    const sourceFingerprint = values.get("sourceFingerprint");
    const generation = values.get("generation");
    const createdAt = values.get("createdAt");
    if (!Number.isInteger(schemaVersion) || policyVersion === undefined
      || (tier !== "lite" && tier !== "journal" && tier !== "bujo")
      || sourceFingerprint === undefined || generation === undefined || createdAt === undefined) {
      throw new Error("memory-store: index metadata is incomplete or corrupt.");
    }
    const embeddingModel = values.get("embeddingModel");
    const dimensionRaw = values.get("dimension");
    const dimension = dimensionRaw === undefined ? undefined : Number(dimensionRaw);
    if (dimension !== undefined && (!Number.isInteger(dimension) || dimension <= 0)) {
      throw new Error("memory-store: index metadata dimension is invalid.");
    }
    const optionalCount = (key: string): number | undefined => {
      const raw = values.get(key);
      if (raw === undefined) return undefined;
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 0) throw new Error(`memory-store: index metadata ${key} is invalid.`);
      return count;
    };
    const skippedRawRecords = optionalCount("skippedRawRecords");
    const skippedUnstructuredRecords = optionalCount("skippedUnstructuredRecords");
    const skippedMissingIdentityRecords = optionalCount("skippedMissingIdentityRecords");
    let missingIdentityLocations: string[] | undefined;
    const missingIdentityLocationsRaw = values.get("missingIdentityLocations");
    if (missingIdentityLocationsRaw !== undefined) {
      try {
        const parsed = JSON.parse(missingIdentityLocationsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.some((location) => typeof location !== "string")) throw new Error();
        missingIdentityLocations = parsed;
      } catch {
        throw new Error("memory-store: index metadata missingIdentityLocations is invalid.");
      }
    }
    const skippedLegacySourceRecords = optionalCount("skippedLegacySourceRecords");
    let legacySourceLocations: string[] | undefined;
    const legacySourceLocationsRaw = values.get("legacySourceLocations");
    if (legacySourceLocationsRaw !== undefined) {
      try {
        const parsed = JSON.parse(legacySourceLocationsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.some((location) => typeof location !== "string")) throw new Error();
        legacySourceLocations = parsed;
      } catch {
        throw new Error("memory-store: index metadata legacySourceLocations is invalid.");
      }
    }
    const skippedJournalDuplicateRecords = optionalCount("skippedJournalDuplicateRecords");
    const parsedSourceItems = optionalCount("parsedSourceItems");
    const derivedLegacyAssociations = optionalCount("derivedLegacyAssociations");
    return {
      schemaVersion,
      policyVersion,
      tier,
      sourceFingerprint,
      generation,
      createdAt,
      ...(embeddingModel === undefined ? {} : { embeddingModel }),
      ...(dimension === undefined ? {} : { dimension }),
      ...(skippedRawRecords === undefined ? {} : { skippedRawRecords }),
      ...(skippedUnstructuredRecords === undefined ? {} : { skippedUnstructuredRecords }),
      ...(skippedMissingIdentityRecords === undefined ? {} : { skippedMissingIdentityRecords }),
      ...(missingIdentityLocations === undefined ? {} : { missingIdentityLocations }),
      ...(skippedLegacySourceRecords === undefined ? {} : { skippedLegacySourceRecords }),
      ...(legacySourceLocations === undefined ? {} : { legacySourceLocations }),
      ...(skippedJournalDuplicateRecords === undefined ? {} : { skippedJournalDuplicateRecords }),
      ...(parsedSourceItems === undefined ? {} : { parsedSourceItems }),
      ...(derivedLegacyAssociations === undefined ? {} : { derivedLegacyAssociations }),
    };
  }

  integrityCheck(): string {
    return String(this.db.pragma("integrity_check", { simple: true }));
  }

  vectorCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memories_vec`).get() as { n: number }).n;
  }

  /** Dimension encoded in the actual vec0 DDL, including an empty vector table. */
  vectorDimension(): number {
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_vec'`,
    ).get() as { sql: string } | undefined;
    const match = row?.sql.match(/embedding\s+float\[(\d+)\]/iu);
    const dimension = Number(match?.[1]);
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("memory-store: memories_vec DDL has no valid vector dimension.");
    }
    return dimension;
  }

  /** Closed-candidate validation counters; every value is derived without mutating the DB. */
  validationSnapshot(): {
    readonly memories: number;
    readonly ftsRows: number;
    readonly ftsMismatches: number;
    readonly vectors: number;
    readonly vectorOrphans: number;
    readonly contentHashes: number;
    readonly contentHashOrphans: number;
    readonly entities: number;
    readonly relations: number;
    readonly relationOrphans: number;
    readonly associations: number;
    readonly associationOrphans: number;
    readonly embeddingModels: readonly string[];
  } {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    const embeddingModels = (this.db.prepare(
      `SELECT DISTINCT embedding_model AS model FROM memories
       WHERE embedding_model IS NOT NULL ORDER BY embedding_model`,
    ).all() as Array<{ model: string }>).map((row) => row.model);
    return {
      memories: count(`SELECT COUNT(*) AS n FROM memories`),
      ftsRows: count(`SELECT COUNT(*) AS n FROM memories_fts`),
      ftsMismatches: count(
        `SELECT COUNT(*) AS n FROM (
           SELECT id, text FROM memories EXCEPT SELECT id, text FROM memories_fts
           UNION ALL
           SELECT id, text FROM memories_fts EXCEPT SELECT id, text FROM memories
         )`,
      ),
      vectors: count(`SELECT COUNT(*) AS n FROM memories_vec`),
      vectorOrphans: count(`SELECT COUNT(*) AS n FROM memories_vec v LEFT JOIN memories m ON m.seq = v.rowid WHERE m.id IS NULL`),
      contentHashes: count(`SELECT COUNT(*) AS n FROM content_hashes`),
      contentHashOrphans: count(
        `SELECT COUNT(*) AS n FROM content_hashes h LEFT JOIN memories m ON m.id = h.memory_id WHERE m.id IS NULL`,
      ),
      entities: count(`SELECT COUNT(*) AS n FROM entities`),
      relations: count(`SELECT COUNT(*) AS n FROM entity_relations`),
      relationOrphans: count(
        `SELECT COUNT(*) AS n FROM entity_relations r
         LEFT JOIN entities s ON s.id = r.src LEFT JOIN entities d ON d.id = r.dst
         WHERE s.id IS NULL OR d.id IS NULL`,
      ),
      associations: count(`SELECT COUNT(*) AS n FROM memory_entities`),
      associationOrphans: count(
        `SELECT COUNT(*) AS n FROM memory_entities a
         LEFT JOIN memories m ON m.id = a.memory_id LEFT JOIN entities e ON e.id = a.entity_id
         WHERE m.id IS NULL OR e.id IS NULL`,
      ),
      embeddingModels,
    };
  }

  contentHashRecords(): ContentHashRecord[] {
    const rows = this.db.prepare(
      `SELECT content_hash, memory_id, source_file, created_at FROM content_hashes ORDER BY content_hash`,
    ).all() as Array<{ content_hash: string; memory_id: string; source_file: string; created_at: string }>;
    return rows.map((row) => ({
      contentHash: row.content_hash,
      memoryId: row.memory_id,
      sourceFile: row.source_file,
      createdAt: row.created_at,
    }));
  }

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  async backupTo(path: string): Promise<void> {
    await this.db.backup(path);
  }

  private tableExists(name: string): boolean {
    return this.db.prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(name) !== undefined;
  }

  assertEmbeddingIdentity(): void {
    if (this.embeddings === undefined) return;
    const ddlDimension = this.vectorDimension();
    if (ddlDimension !== this.dim) {
      throw new Error(
        `memory-store: active index vector dimension ${ddlDimension} does not match configured ${this.dim}; `
        + "run the safe memory rebuild before writing or recalling semantically.",
      );
    }
    const rows = this.db.prepare(
      `SELECT DISTINCT m.embedding_model AS model, m.dim AS dim
       FROM memories m JOIN memories_vec v ON v.rowid = m.seq`,
    ).all() as Array<{ model: string | null; dim: number | null }>;
    for (const row of rows) {
      if (row.dim === null || row.model === null) {
        throw new Error(
          "memory-store: active index contains vectors without complete embedding model/dimension identity; "
          + "run the safe memory rebuild before writing or recalling semantically.",
        );
      }
      if (row.dim !== this.dim) {
        throw new Error(
          `memory-store: active index dimension ${row.dim} does not match configured ${this.dim}; run the safe memory rebuild.`,
        );
      }
      if (row.model !== this.embeddings.id) {
        throw new Error(
          `memory-store: active index model "${row.model}" does not match configured "${this.embeddings.id}"; run the safe memory rebuild.`,
        );
      }
    }
  }

  protected entityFromRow(row: Record<string, unknown>): EntityRecord {
    const str = (v: unknown): string => String(v);
    return {
      id: str(row.id),
      name: str(row.name),
      ...(row.type != null && { type: str(row.type) }),
      ...(row.summary != null && { summary: str(row.summary) }),
      createdAt: str(row.created_at),
      ...(row.updated_at != null && { updatedAt: str(row.updated_at) }),
    };
  }

  /** Open memories with a due date at/under `now`, soonest first (the future-log queue). */
  dueItems(now: Date, limit = 50): MemoryRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE status IN ('open','scheduled') AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at LIMIT ?`,
    ).all(now.toISOString(), limit) as Record<string, unknown>[];
    return rows.map((r) => this.fromRow(r));
  }

  /** Live, low-salience, old, infrequently-accessed open memories — migration candidates. */
  agingOpen(now: Date, opts: { olderThanDays?: number; maxSalience?: number; limit?: number } = {}): MemoryRecord[] {
    const olderThan = new Date(now.getTime() - (opts.olderThanDays ?? 30) * 86_400_000).toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE status = 'open' AND created_at <= ? AND salience <= ? ORDER BY salience ASC, created_at ASC LIMIT ?`,
    ).all(olderThan, opts.maxSalience ?? 0.4, opts.limit ?? 50) as Record<string, unknown>[];
    return rows.map((r) => this.fromRow(r));
  }

  /** Highest-salience live memories (for promotion / always-in-context / index). */
  topSalient(limit = 20): MemoryRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE status NOT IN ('invalidated','dropped') ORDER BY salience DESC, created_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.fromRow(r));
  }

  /** Decay salience toward `floor` by age (half-life in days). Access telemetry is deliberately ignored. */
  applyDecay(now: Date, opts: { halfLifeDays?: number; floor?: number } = {}): { decayed: number } {
    const halfLife = opts.halfLifeDays ?? 30;
    const floor = opts.floor ?? 0.05;
    const rows = this.db.prepare(
      `SELECT id, salience, created_at AS ref FROM memories WHERE status NOT IN ('invalidated','dropped')`,
    ).all() as { id: string; salience: number; ref: string }[];
    const stmt = this.db.prepare(`UPDATE memories SET salience = ? WHERE id = ?`);
    let decayed = 0;
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        const days = Math.max(0, (now.getTime() - new Date(r.ref).getTime()) / 86_400_000);
        const factor = 0.5 ** (days / halfLife);
        const next = Math.max(floor, r.salience * factor);
        if (Math.abs(next - r.salience) > 1e-9) { stmt.run(next, r.id); decayed += 1; }
      }
    });
    tx();
    return { decayed };
  }

  close(): void {
    this.db.close();
  }
}

function journalSourceKey(record: MemoryRecord): string {
  const file = record.source.file ?? "\uffff";
  const line = String(record.source.line ?? Number.MAX_SAFE_INTEGER).padStart(12, "0");
  return `${file}\u0000${line}`;
}

function journalRecordChanged(current: MemoryRecord, next: MemoryRecord): boolean {
  return current.text !== next.text
    || current.status !== next.status
    || current.type !== next.type
    || current.salience !== next.salience
    || current.isInsight !== next.isInsight
    || current.dueAt !== next.dueAt;
}

function relevanceTokens(text: string): ReadonlySet<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  return new Set(tokens
    .filter((token) => token.length > 1 && !RECALL_STOP_WORDS.has(token))
    .map(canonicalRelevanceToken));
}

function canonicalRelevanceToken(token: string): string {
  if (token === "decision" || token === "decided" || token === "decides" || token === "deciding") return "decide";
  if (token === "preferences" || token === "preferred" || token === "prefers") return "prefer";
  if (token === "manager" || token === "managers" || token === "managed" || token === "manages" || token === "managing") return "manage";
  if (token === "leader" || token === "leaders" || token === "led" || token === "leads" || token === "leading") return "lead";
  if (token === "base" || token === "based" || token === "live" || token === "located" || token === "location" || token === "lived" || token === "lives" || token === "living") return "locate";
  if (token === "mentored" || token === "mentors" || token === "mentoring") return "mentor";
  return token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
}

function tokenOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap;
}

/**
 * Require an oriented relation phrase in the query. For active relation
 * labels, `seed ... relation` asks for an outgoing edge and `relation ...
 * seed` asks for an incoming edge. When both endpoints are named, the query
 * must preserve the stored src -> relation -> dst order. This intentionally
 * rejects ambiguous/passive phrasing rather than reversing graph semantics.
 */
function relationDirectionMatches(
  query: string,
  seedName: string,
  relatedName: string,
  relation: string,
  seedIsSource: boolean,
  seedId: string,
  relatedId: string,
  referenceIsUnique: (entityId: string, words: readonly string[]) => boolean,
  queryEntityIds: ReadonlySet<string>,
): boolean {
  if (DISALLOWED_RELATION_LANGUAGE.test(query.normalize("NFKC"))) return false;
  const queryWords = canonicalWords(query);
  const seedMatch = entityPhraseMatch(queryWords, seedId, seedName, referenceIsUnique);
  if (seedMatch === undefined) return false;
  const seedPosition = seedMatch.position;
  const relationPhrases = normalizedRelationPhrases(relation);
  if (relationPhrases.length === 0) return false;
  const relationTokens = new Set(relationPhrases.flat());
  const relationMatch = firstPhraseMatch(queryWords, relationPhrases);
  if (relationMatch === undefined) return false;
  const relationPosition = relationMatch.position;
  if ([...queryEntityIds].some((id) => id !== seedId && id !== relatedId)) return false;
  const relatedPosition = entityPhrasePosition(queryWords, relatedId, relatedName, referenceIsUnique);
  const possessiveRole = possessiveRoleAfter(queryWords, seedMatch);
  if (possessiveRole !== undefined) {
    // `Morgan's manager/mentor/lead` asks for the incoming role-holder.
    // Other predicates later in the question (for example `based`) describe
    // the related memory and must not authorize an unrelated seed edge.
    if (relatedPosition < 0 && (
      hasMismatchedPossessiveSubject(queryWords, seedMatch)
      || !possessiveTailIsOpen(queryWords.slice(possessiveRole.position + 1))
    )) return false;
    return relationTokens.has(possessiveRole.token) && !seedIsSource;
  }
  if (relatedPosition < 0 && hasMismatchedUnresolvedEndpoint(queryWords, relationMatch, seedIsSource)) return false;

  if (relatedPosition >= 0) {
    return seedIsSource
      ? seedPosition < relationPosition && relationPosition < relatedPosition
      : relatedPosition < relationPosition && relationPosition < seedPosition;
  }
  return seedIsSource ? seedPosition < relationPosition : relationPosition < seedPosition;
}

function canonicalWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/gu) ?? []).map(canonicalRelevanceToken);
}

const GENERIC_ENTITY_PREFIXES = new Set(["company", "concept", "org", "organization", "person", "project", "team"]);
const QUERY_NAME_PREFIXES = new Set([
  "can", "could", "did", "do", "does", "how", "is", "show", "what", "when", "where", "which", "who", "why", "would",
]);

const DISALLOWED_RELATION_LANGUAGE = /\b(?:no|not|never|no\s+longer|cannot|did|former|formerly|previously|historically|once|used\s+to|may|might|could|would|should|possibly|perhaps)\b|\b(?:doesn|isn|didn|can|couldn|wouldn|shouldn|wasn|weren|hasn|haven|hadn|won|don)[’']?t\b/iu;
const RELATION_AUXILIARIES = new Set(["a", "an", "are", "did", "do", "does", "is", "the", "was", "were"]);
const POLAR_QUERY_AUXILIARIES = new Set(["am", "are", "do", "does", "has", "have", "is", "was", "were"]);
const OPEN_ENDPOINT_QUESTION_WORDS = new Set(["what", "which", "who"]);
const OPEN_ENDPOINT_WORDS = new Set([
  "a", "an", "any", "anybody", "anyone", "company", "concept", "entity", "org", "organization", "person", "project", "somebody", "someone", "team", "the", "what", "which", "who",
]);

function normalizedRelationPhrases(relation: string): string[][] {
  const normalized = relation.normalize("NFKC");
  if (DISALLOWED_RELATION_LANGUAGE.test(normalized)) return [];
  const phrase = canonicalWords(normalized).filter((word) => !RELATION_AUXILIARIES.has(word));
  if (phrase.length === 0) return [];
  // Location questions conventionally omit the stored preposition:
  // `lives in` / `based in` may be queried as `Where does X live?`.
  if (phrase.length === 2 && phrase[0] === "locate" && phrase[1] === "in") return [phrase, ["locate"]];
  return [phrase];
}

function hasMismatchedUnresolvedEndpoint(
  queryWords: readonly string[],
  relation: { readonly position: number; readonly length: number },
  seedIsSource: boolean,
): boolean {
  const possibleEndpoint = seedIsSource
    ? queryWords.slice(relation.position + relation.length)
    : queryWords.slice(POLAR_QUERY_AUXILIARIES.has(queryWords[0] ?? "") ? 1 : 0, relation.position);
  if (possibleEndpoint.length === 0 || possibleEndpoint.some((word) => OPEN_ENDPOINT_QUESTION_WORDS.has(word))) return false;
  return possibleEndpoint.some((word) => !OPEN_ENDPOINT_WORDS.has(word));
}

function entityPhraseMatch(
  queryWords: readonly string[],
  entityId: string,
  name: string,
  referenceIsUnique: (entityId: string, words: readonly string[]) => boolean,
): { readonly position: number; readonly length: number } | undefined {
  for (const variant of entityNameVariants(name)) {
    const position = phrasePosition(queryWords, variant);
    if (position < 0) continue;
    if (referenceIsUnique(entityId, variant)) return { position, length: variant.length };
  }
  return undefined;
}

function entityPhrasePosition(
  queryWords: readonly string[],
  entityId: string,
  name: string,
  referenceIsUnique: (entityId: string, words: readonly string[]) => boolean,
): number {
  return entityPhraseMatch(queryWords, entityId, name, referenceIsUnique)?.position ?? -1;
}

const POSSESSIVE_INCOMING_ROLES = new Set(["lead", "manage", "mentor"]);
const POSSESSIVE_PROPERTY_STARTERS = new Set([
  "choose", "decide", "have", "know", "leave", "like", "locate", "need", "own", "plan", "prefer", "report", "start", "use", "want", "work",
]);
const POSSESSIVE_PROPERTY_MODIFIERS = new Set(["currently", "now"]);

function possessiveRoleAfter(
  queryWords: readonly string[],
  seed: { readonly position: number; readonly length: number },
): { readonly token: string; readonly position: number } | undefined {
  const possessive = seed.position + seed.length;
  if (queryWords[possessive] !== "s") return undefined;
  for (let position = possessive + 1; position < Math.min(queryWords.length, possessive + 6); position += 1) {
    const token = queryWords[position] ?? "";
    if (POSSESSIVE_INCOMING_ROLES.has(token)) return { token, position };
  }
  return undefined;
}

function possessiveTailIsOpen(tail: readonly string[]): boolean {
  let index = 0;
  while (POSSESSIVE_PROPERTY_MODIFIERS.has(tail[index] ?? "")) index += 1;
  const first = tail[index];
  return first === undefined || POSSESSIVE_PROPERTY_STARTERS.has(first);
}

function hasMismatchedPossessiveSubject(
  queryWords: readonly string[],
  seed: { readonly position: number; readonly length: number },
): boolean {
  if (!POLAR_QUERY_AUXILIARIES.has(queryWords[0] ?? "")) return false;
  return queryWords.slice(1, seed.position).some((word) => !OPEN_ENDPOINT_WORDS.has(word));
}

function entityNameVariants(name: string): string[][] {
  const full = canonicalWords(name);
  if (full.length <= 1 || !GENERIC_ENTITY_PREFIXES.has(full[0] ?? "")) return full.length === 0 ? [] : [full];
  return [full, full.slice(1)];
}

function phrasePosition(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) return index;
  }
  return -1;
}

function firstPhraseMatch(
  words: readonly string[],
  phrases: readonly (readonly string[])[],
): { readonly position: number; readonly length: number } | undefined {
  return phrases
    .map((phrase) => ({ position: phrasePosition(words, phrase), length: phrase.length }))
    .filter((match) => match.position >= 0)
    .sort((left, right) => left.position - right.position || right.length - left.length)[0];
}

function startsUppercase(value: string): boolean {
  const first = value[0];
  return first !== undefined && first === first.toLocaleUpperCase("en-US") && first !== first.toLocaleLowerCase("en-US");
}

function lexicalEvidence(queryTokens: ReadonlySet<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const documentTokens = relevanceTokens(text);
  let matches = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) matches += 1;
  }
  // Two distinct meaningful terms are enough for full lexical confidence; a
  // one-term query still requires that exact term.
  return Math.min(1, matches / Math.min(2, queryTokens.size));
}

export function openMemoryDb(options: MemoryDbOptions): MemoryDb {
  return new MemoryDb(options);
}

function normalizeNonNegativeInteger(value: number, message: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(message);
  }
  return value;
}
