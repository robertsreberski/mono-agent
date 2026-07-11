import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/agent-contracts";
import type { RecallHit } from "../store/index.js";
import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../store/index.js";

import {
  appendAuditBullet,
  appendBullet,
  auditFilePath,
  dailyFilePath,
  normalizedContentHash,
  withJournalWriteLock,
} from "./daily.js";
import { parseDailyFile } from "./grammar.js";
import { serializeBullet } from "./grammar.js";
import { createIdFactory } from "./ids.js";
import type { LlmComplete } from "./llm.js";
import { captureTurn } from "./capture.js";
import { composeRecallBlock } from "./recall.js";
import { reflect as reflectFn, type ReflectResult } from "./reflect.js";
import { migrate as migrateFn, type MigrateResult } from "./migrate.js";
import { consolidateBujoMemory, type ConsolidateResult } from "./consolidate.js";
import { writeFutureLog, writeIndex } from "./projections.js";
import type { Bullet, BujoLogger, BujoOptions, BujoTier } from "./types.js";
import { BoundedBatchQueue, type BackgroundQueueSnapshot, type QueueJob } from "./queue.js";

// Cap the recall query so an attachment turn's inlined document text (the user message can carry
// up to a few KB of extracted file content) cannot drown the FTS/embedding signal.
const MAX_RECALL_QUERY_CHARS = 4_000;
const JOURNAL_QUEUE_MAX_ITEMS = 256;
const JOURNAL_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const CAPTURE_QUEUE_MAX_ITEMS = 32;
const CAPTURE_QUEUE_MAX_BYTES = 1024 * 1024;
const JOURNAL_RETRY_DELAY_MS = 1_000;
const JOURNAL_RETRY_MAX_DELAY_MS = 30_000;
const JOURNAL_WRITE_CHAINS = new Map<string, Promise<void>>();

interface IndexJob extends QueueJob {
  readonly record: MemoryRecord;
}

interface CaptureJob extends QueueJob {
  readonly conversationId: string;
  readonly text: string;
}

export interface BujoQueueSnapshot {
  readonly index?: BackgroundQueueSnapshot & {
    readonly remainingBacklog: number;
    readonly recoveryFilesRemaining: number;
    readonly recoveryPaused: boolean;
    /** Delay of the retry that is currently scheduled; zero when none is scheduled. */
    readonly retryDelayMs: number;
    /** Delay the following failure would schedule after the current retry. */
    readonly nextRetryDelayMs: number;
    /** Rows materialized by bounded missing-vector refill queries. */
    readonly recoveryRowsScanned: number;
    /** Missing-vector refill queries issued since startup. */
    readonly recoveryRefillQueries: number;
    readonly nextRetryAt?: string;
  };
  readonly capture?: BackgroundQueueSnapshot;
}

export class BujoMemoryStore implements MemoryStore {
  private readonly root: string;
  private readonly db: MemoryDb;
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly nextId: () => string;
  private readonly llm?: LlmComplete;
  private readonly _tier: BujoTier;
  private readonly logger: BujoLogger;
  private indexQueue?: BoundedBatchQueue<IndexJob>;
  private captureQueue?: BoundedBatchQueue<CaptureJob>;
  private journalRecoveryPaused = false;
  private journalRecoveryFiles: string[] = [];
  private journalRecoveryCursor = 0;
  private journalRecoveryPromise: Promise<void> = Promise.resolve();
  private resolveJournalRecovery: (() => void) | undefined;
  private journalRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private journalRetryAttempt = 0;
  private currentJournalRetryDelayMs = 0;
  private nextJournalRetryAt: Date | undefined;
  private journalRecoveryRowsScanned = 0;
  private journalRecoveryRefillQueries = 0;
  private closing = false;

  constructor(options: BujoOptions) {
    this.root = options.root;
    this.maxBytes = options.maxBytes ?? 8_000;
    this.clock = options.clock ?? (() => new Date());
    this.nextId = createIdFactory({ clock: this.clock });
    const derivedTier = options.embeddings === undefined
      ? "lite"
      : options.llm === undefined
        ? "journal"
        : "bujo";
    this._tier = options.tier ?? derivedTier;
    assertTierPrerequisites(this._tier, options);
    this.db = openMemoryDb({
      path: join(options.root, "memory.db"),
      ...(options.embeddings !== undefined && { embeddings: options.embeddings }),
      ...(options.dim !== undefined && { dim: options.dim }),
      clock: this.clock,
    });
    if (options.llm !== undefined) {
      this.llm = options.llm;
    }
    this.logger = options.logger ?? { warn: () => {} };
    if (this._tier !== "lite") this.db.assertEmbeddingIdentity();
    if (this._tier === "journal") this.initializeJournalIndexing();
    if (this._tier === "bujo") this.initializeCaptureQueue();
  }

  /** The effective tier of this store (lite / journal / bujo). */
  tier(): BujoTier {
    return this._tier;
  }

  async load(conversationId: string, query?: string): Promise<MemoryBlock | undefined> {
    // Recall against what the user actually said. Legacy callers pass no query, so fall back to the
    // conversation id as a coarse seed; an explicit empty query carries no usable signal, so skip
    // recall rather than surface near-random hits.
    let recallQuery: string;
    if (query === undefined) {
      recallQuery = conversationId;
    } else {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return undefined;
      }
      recallQuery = trimmed.slice(0, MAX_RECALL_QUERY_CHARS);
    }
    return composeRecallBlock(this.db, recallQuery, { topK: 8, maxBytes: this.maxBytes });
  }

  /** Query-based hybrid recall (text + score). Used by the MCP and any deliberate recall surface. */
  async recall(query: string, options: { topK?: number; trackAccess?: boolean } = {}): Promise<RecallHit[]> {
    return this.db.recall(query, {
      ...(options.topK !== undefined && { topK: options.topK }),
      ...(options.trackAccess !== undefined && { trackAccess: options.trackAccess }),
    });
  }

  /** Whether this strict tier may expose graph expansion to explicit MemoryRecall. */
  supportsGraphExpansion(): boolean {
    return this._tier === "bujo";
  }

  /** Deterministically expand already-fetched direct hits for explicit MemoryRecall only. */
  expandGraph(
    query: string,
    directHits: readonly RecallHit[],
    options: { readonly topK?: number } = {},
  ): RecallHit[] {
    const topK = Math.max(1, Math.min(options.topK ?? 8, 50));
    if (this._tier !== "bujo" || directHits.length === 0) return directHits.slice(0, topK);
    const seeds = directHits.slice(0, 3);
    const additions = this.db.expandEntityRelations(seeds.map((hit) => hit.record.id), {
      query,
      seedLimit: 3,
      maxAdditions: 5,
    });
    if (additions.length === 0) return directHits.slice(0, topK);
    const seedFloor = Math.min(...seeds.map((hit) => hit.score));
    const merged = new Map(directHits.map((hit) => [hit.record.id, hit]));
    for (const [index, record] of additions.entries()) {
      const score = Math.max(0, seedFloor * 0.95 - index * 1e-6);
      const existing = merged.get(record.id);
      // The raw cache is intentionally a 50-hit superset. A graph target may
      // already sit below the requested topK there; promote it instead of
      // treating presence in the superset as a reason to discard the path.
      if (existing === undefined || score > existing.score) merged.set(record.id, { record, score });
    }
    const sorted = [...merged.values()]
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, topK);
    const bestGraphId = additions[0]?.id;
    if (bestGraphId !== undefined && !sorted.some((hit) => hit.record.id === bestGraphId)) {
      const graphHit = merged.get(bestGraphId);
      if (graphHit !== undefined) {
        sorted.splice(Math.max(0, sorted.length - 1), 1, graphHit);
        sorted.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
      }
    }
    return sorted;
  }

  /** Record served recall hits as telemetry without re-running retrieval. */
  recordAccess(ids: readonly string[]): void {
    this.db.recordAccess(ids);
  }

  async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
    const now = this.clock();
    const text = summary.trim().replace(/\s+/gu, " ");
    const hash = normalizedContentHash(text);
    const bullet: Bullet = {
      id: this._tier === "journal" ? `J-${hash}` : this.nextId(),
      type: "note",
      status: "open",
      // Collapse whitespace/newlines to a single line: a bullet is one markdown line, and
      // serializeBullet rejects newlines. The harness emits multi-line summaries; P2's distiller
      // will split these into multiple atomic memories — for P1 we store one normalized line.
      text,
      salience: 0.5,
      isInsight: false,
      createdAt: now.toISOString(),
      refs: [`sha256:${hash}`],
    };
    if (this._tier === "bujo") {
      const path = auditFilePath(this.root, now);
      appendAuditBullet(this.root, bullet, now);
      return {
        conversationId,
        source: path,
        bytesWritten: Buffer.byteLength(`${serializeBullet(bullet)}\n`, "utf8"),
      };
    }
    const path = dailyFilePath(this.root, now);
    const record: MemoryRecord = {
      id: bullet.id,
      type: bullet.type,
      status: bullet.status,
      text: bullet.text,
      salience: bullet.salience,
      isInsight: bullet.isInsight,
      createdAt: bullet.createdAt,
      accessCount: 0,
      tags: [],
      source: { session: conversationId, file: relative(this.root, path) },
    };
    if (this._tier === "journal") {
      // Recovery is deliberately off the successful-turn path. Both new writes
      // and legacy backfill converge on J-<content-hash>, so whichever runs first
      // reserves the same canonical representation without waiting for history.
      return await serializeJournalWrite(this.root, async () => await withJournalWriteLockRetry(
        this.root,
        this.db.busyTimeoutMs(),
        () => {
          const reserved = this.db.contentHashRecord(hash);
          if (reserved !== undefined) {
            const existing = this.db.get(reserved.memoryId);
            if (existing !== undefined && !this.db.hasVector(existing.id)) this.enqueueIndex(existing);
            return { conversationId, source: path, bytesWritten: 0 };
          }
          appendBullet(this.root, bullet, now);
          const outcome = this.db.insertJournalLexical(record, hash);
          if (outcome.inserted) this.enqueueIndex(record);
          return {
            conversationId,
            source: path,
            bytesWritten: Buffer.byteLength(`${serializeBullet(bullet)}\n`, "utf8"),
          };
        },
      ));
    }

    appendBullet(this.root, bullet, now);
    this.db.upsertLexical(record);
    // bytesWritten reflects the bullet line actually appended to the daily file, not the raw summary.
    return { conversationId, source: path, bytesWritten: Buffer.byteLength(`${serializeBullet(bullet)}\n`, "utf8") };
  }

  /**
   * Run the nightly reflection ritual: decay salience, synthesize insights from top memories,
   * and surface due intentions. Also writes future-log.md + index.md.
   *
   * Returns `undefined` when no `llm` was configured (matches `capture()` pattern).
   */
  async reflect(): Promise<ReflectResult | undefined> {
    if (this.llm === undefined) return undefined;
    const r = await reflectFn({
      db: this.db,
      root: this.root,
      llm: this.llm,
      nextId: this.nextId,
      now: this.clock,
    });
    writeFutureLog(this.root, this.db, this.clock());
    writeIndex(this.root, this.db, this.clock());
    return r;
  }

  /**
   * Run the monthly BuJo migration ritual: review aging open memories and apply LLM decisions
   * (promote / reschedule / cluster / forget). Also writes future-log.md.
   *
   * Returns `undefined` when no `llm` was configured (matches `capture()` pattern).
   */
  async migrate(): Promise<MigrateResult | undefined> {
    if (this.llm === undefined) return undefined;
    const m = await migrateFn({
      db: this.db,
      root: this.root,
      llm: this.llm,
      nextId: this.nextId,
      now: this.clock,
    });
    writeFutureLog(this.root, this.db, this.clock());
    return m;
  }

  /**
   * Enqueue a best-effort intelligent capture. Returns immediately. Captures run strictly
   * one-at-a-time (serialized across all channels sharing this store), and a failure is caught +
   * logged so it never breaks the chain, the reply, or the process. No-op without an llm.
   */
  scheduleCapture(conversationId: string, text: string): void {
    if (this.captureQueue === undefined) return;
    const outcome = this.captureQueue.enqueue({
      key: `${conversationId}:${normalizedContentHash(text)}`,
      bytes: Buffer.byteLength(text, "utf8"),
      conversationId,
      text,
    });
    if (outcome === "dropped") {
      this.safeWarn("bujo capture queue is full; the compact raw host audit was preserved, but this turn was not curated.");
    }
  }

  /** Await all captures queued before this call (graceful shutdown / one-shot exit). */
  async flush(): Promise<void> {
    await this.journalRecoveryPromise;
    await this.indexQueue?.flush();
    await this.captureQueue?.flush();
  }

  queueSnapshot(): BujoQueueSnapshot {
    return {
      ...(this.indexQueue === undefined ? {} : {
        index: {
          ...this.indexQueue.snapshot(),
          remainingBacklog: this.db.countMissingVectors(),
          recoveryFilesRemaining: Math.max(0, this.journalRecoveryFiles.length - this.journalRecoveryCursor),
          recoveryPaused: this.journalRecoveryPaused,
          retryDelayMs: this.currentJournalRetryDelayMs,
          nextRetryDelayMs: this.currentJournalRetryDelayMs === 0 ? 0 : retryDelayMs(this.journalRetryAttempt),
          recoveryRowsScanned: this.journalRecoveryRowsScanned,
          recoveryRefillQueries: this.journalRecoveryRefillQueries,
          ...(this.nextJournalRetryAt === undefined ? {} : { nextRetryAt: this.nextJournalRetryAt.toISOString() }),
        },
      }),
      ...(this.captureQueue === undefined ? {} : { capture: this.captureQueue.snapshot() }),
    };
  }

  /**
   * LLM-backed intelligent capture: distills the turn text into atomic candidate memories,
   * reconciles them against the existing index (ADD / UPDATE / SUPERSEDE / NOOP), and extracts
   * typed entities into the canonical graph.
   *
   * Returns `undefined` when no `llm` was configured — use `appendHostSummary` as the always-on
   * deterministic rapid-log (P1 path). `capture()` is the intelligent path invoked by P3
   * reflection/cron and future session hooks; it is safe to call on every turn when an LLM is
   * present, and a no-op when one is not.
   */
  async capture(conversationId: string, text: string): Promise<{ actions: number; entities: number } | undefined> {
    if (this.llm === undefined) return undefined;
    const res = await captureTurn(text, {
      db: this.db,
      root: this.root,
      llm: this.llm,
      nextId: this.nextId,
      now: this.clock,
    });
    return { actions: res.actions.length, entities: res.entities };
  }

  /**
   * Apply salience decay to all memories in the store.
   *
   * Usable in all tiers (lite, journal, bujo) — no LLM required. In the `journal` and `bujo`
   * tiers this is the primary maintenance call; in the `lite` tier it still runs harmlessly.
   */
  async decay(): Promise<{ decayed: number }> {
    return this.db.applyDecay(this.clock());
  }

  /** Run deterministic, no-LLM BuJo consolidation in every tier. */
  async consolidate(): Promise<ConsolidateResult> {
    return consolidateBujoMemory({
      root: this.root,
      db: this.db,
      now: this.clock(),
    });
  }

  async close(): Promise<void> {
    // Drain any queued captures before closing the db handle, so a caller that omits flush()
    // (e.g. the MCP's signal handler) doesn't strand an in-flight capture against a closed db.
    this.closing = true;
    if (this.journalRetryTimer !== undefined) clearTimeout(this.journalRetryTimer);
    await this.flush();
    this.db.close();
  }

  private initializeJournalIndexing(): void {
    this.indexQueue = new BoundedBatchQueue<IndexJob>({
      maxItems: JOURNAL_QUEUE_MAX_ITEMS,
      maxBytes: JOURNAL_QUEUE_MAX_BYTES,
      batchSize: 32,
      process: async (jobs) => {
        try {
          await this.db.indexVectors(jobs.map((job) => job.record), { batchSize: 32 });
          this.journalRecoveryPaused = false;
          this.journalRetryAttempt = 0;
          this.currentJournalRetryDelayMs = 0;
          this.nextJournalRetryAt = undefined;
        } catch (error) {
          this.journalRecoveryPaused = true;
          this.scheduleJournalRetry();
          throw error;
        }
      },
      onBatchSettled: () => {
        if (!this.journalRecoveryPaused) this.refillJournalQueue();
      },
      onError: (error) => this.safeWarn(`journal indexing failed: ${reasonOf(error)}`),
    });
    this.initializeJournalRecoveryCursor();
  }

  private initializeCaptureQueue(): void {
    this.captureQueue = new BoundedBatchQueue<CaptureJob>({
      maxItems: CAPTURE_QUEUE_MAX_ITEMS,
      maxBytes: CAPTURE_QUEUE_MAX_BYTES,
      batchSize: 1,
      process: async (jobs) => {
        for (const job of jobs) await this.capture(job.conversationId, job.text);
      },
      onError: (error) => this.safeWarn(`bujo capture failed: ${reasonOf(error)}`),
    });
  }

  private enqueueIndex(record: MemoryRecord): void {
    const outcome = this.indexQueue?.enqueue({
      key: record.id,
      bytes: Buffer.byteLength(record.text, "utf8"),
      record,
    });
    if (outcome === "dropped") this.safeWarn("journal index queue is full; lexical memory is durable and semantic indexing remains backlogged.");
  }

  private refillJournalQueue(): void {
    if (this.indexQueue === undefined || this.journalRecoveryPaused) return;
    const before = this.indexQueue.snapshot();
    const availableItems = before.capacity.items - before.queued - before.inFlight;
    const availableBytes = before.capacity.bytes - before.queuedBytes - before.inFlightBytes;
    if (availableItems <= 0 || availableBytes <= 0) return;
    this.journalRecoveryRefillQueries += 1;
    const records = this.db.recordsMissingVectors(availableItems, this.indexQueue.activeKeyList());
    this.journalRecoveryRowsScanned += records.length;
    for (const record of records) {
      // Internal recovery polling is not a duplicate user enqueue. Skip active
      // ids before calling enqueue so `coalesced` remains truthful and we avoid
      // repeatedly cycling queued records through queue accounting.
      if (this.indexQueue.hasKey(record.id)) continue;
      const snapshot = this.indexQueue.snapshot();
      const bytes = Buffer.byteLength(record.text, "utf8");
      if (
        snapshot.queued + snapshot.inFlight >= snapshot.capacity.items
        || snapshot.queuedBytes + snapshot.inFlightBytes + bytes > snapshot.capacity.bytes
      ) break;
      this.enqueueIndex(record);
    }
  }

  private initializeJournalRecoveryCursor(): void {
    const dailyDir = join(this.root, "daily");
    try {
      this.journalRecoveryFiles = readdirSync(dailyDir).filter((file) => file.endsWith(".md")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.journalRecoveryFiles = [];
        return;
      }
      throw error;
    }
    if (this.journalRecoveryFiles.length === 0) return;
    this.journalRecoveryPromise = new Promise<void>((resolve) => { this.resolveJournalRecovery = resolve; });
    setImmediate(() => this.scanNextJournalFile());
  }

  private scanNextJournalFile(): void {
    const file = this.journalRecoveryFiles[this.journalRecoveryCursor];
    if (file === undefined) {
      this.resolveJournalRecovery?.();
      this.resolveJournalRecovery = undefined;
      this.refillJournalQueue();
      return;
    }
    try {
      const dailyDir = join(this.root, "daily");
      const parsed = parseDailyFile(readFileSync(join(dailyDir, file), "utf8"));
      for (const line of parsed.lines) {
        const bullet = line.bullet;
        if (bullet === undefined) continue;
        const hash = normalizedContentHash(bullet.text);
        const record: MemoryRecord = {
          // Journal's canonical index identity is content-derived. Legacy ids
          // remain untouched in Markdown but cannot create competing recall rows.
          id: `J-${hash}`,
          type: bullet.type,
          status: bullet.status,
          text: bullet.text,
          salience: bullet.salience,
          isInsight: bullet.isInsight,
          createdAt: bullet.createdAt,
          accessCount: 0,
          tags: [],
          source: { file: `daily/${file}`, line: line.lineNumber },
          ...(bullet.dueAt === undefined ? {} : { dueAt: bullet.dueAt }),
        };
        this.db.recoverJournalLexical(record, hash, bullet.id);
      }
    } catch (error) {
      this.safeWarn(`journal startup recovery skipped ${file}: ${reasonOf(error)}`);
    } finally {
      this.journalRecoveryCursor += 1;
      this.refillJournalQueue();
      setImmediate(() => this.scanNextJournalFile());
    }
  }

  private scheduleJournalRetry(): void {
    if (this.closing || this.journalRetryTimer !== undefined) return;
    const delay = retryDelayMs(this.journalRetryAttempt);
    this.currentJournalRetryDelayMs = delay;
    this.journalRetryAttempt += 1;
    this.nextJournalRetryAt = new Date(Date.now() + delay);
    this.journalRetryTimer = setTimeout(() => {
      this.journalRetryTimer = undefined;
      this.nextJournalRetryAt = undefined;
      this.currentJournalRetryDelayMs = 0;
      if (this.closing) return;
      this.journalRecoveryPaused = false;
      this.refillJournalQueue();
    }, delay);
    this.journalRetryTimer.unref?.();
  }

  private safeWarn(message: string): void {
    try {
      this.logger.warn(message);
    } catch {
      // A logger failure cannot poison memory queues or provider turns.
    }
  }
}

export function createBujoMemoryStore(options: BujoOptions): BujoMemoryStore {
  return new BujoMemoryStore(options);
}

function assertTierPrerequisites(tier: BujoTier, options: BujoOptions): void {
  if (tier === "lite") {
    if (options.embeddings !== undefined || options.llm !== undefined || options.dim !== undefined) {
      throw new Error("memory-bujo: lite tier is lexical-only and rejects embeddings, dimensions, and capture LLMs.");
    }
    return;
  }
  if (options.embeddings === undefined || options.dim === undefined) {
    throw new Error(`memory-bujo: ${tier} tier requires embeddings and an explicit vector dimension.`);
  }
  if (tier === "journal") {
    if (options.llm !== undefined) {
      throw new Error("memory-bujo: journal tier rejects capture LLMs; select bujo for curated capture.");
    }
    return;
  }
  if (options.llm === undefined) {
    throw new Error("memory-bujo: bujo tier requires a capture LLM.");
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function serializeJournalWrite<T>(root: string, write: () => T | Promise<T>): Promise<T> {
  const prior = JOURNAL_WRITE_CHAINS.get(root) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => mine);
  JOURNAL_WRITE_CHAINS.set(root, tail);
  await prior;
  try {
    return await write();
  } finally {
    release();
    if (JOURNAL_WRITE_CHAINS.get(root) === tail) JOURNAL_WRITE_CHAINS.delete(root);
  }
}

async function withJournalWriteLockRetry<T>(root: string, timeoutMs: number, write: () => T): Promise<T> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      return withJournalWriteLock(root, write);
    } catch (error) {
      if (!/journal write lock is held/iu.test(reasonOf(error)) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(JOURNAL_RETRY_MAX_DELAY_MS, JOURNAL_RETRY_DELAY_MS * (2 ** Math.min(attempt, 10)));
}
