import { join, relative } from "node:path";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/agent-contracts";
import type { RecallHit } from "../store/index.js";
import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../store/index.js";

import { appendBullet, dailyFilePath } from "./daily.js";
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

// Cap the recall query so an attachment turn's inlined document text (the user message can carry
// up to a few KB of extracted file content) cannot drown the FTS/embedding signal.
const MAX_RECALL_QUERY_CHARS = 4_000;

export class BujoMemoryStore implements MemoryStore {
  private readonly root: string;
  private readonly db: MemoryDb;
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly nextId: () => string;
  private readonly llm?: LlmComplete;
  private readonly _tier: BujoTier;
  private readonly logger: BujoLogger;
  private captureChain: Promise<void> = Promise.resolve();

  constructor(options: BujoOptions) {
    this.root = options.root;
    this.maxBytes = options.maxBytes ?? 8_000;
    this.clock = options.clock ?? (() => new Date());
    this.nextId = createIdFactory({ clock: this.clock });
    this.db = openMemoryDb({
      path: join(options.root, "memory.db"),
      ...(options.embeddings !== undefined && { embeddings: options.embeddings }),
      ...(options.dim !== undefined && { dim: options.dim }),
      clock: this.clock,
    });
    if (options.llm !== undefined) {
      this.llm = options.llm;
    }
    this._tier =
      options.tier ??
      (options.embeddings === undefined
        ? "lite"
        : options.llm === undefined
          ? "journal"
          : "bujo");
    this.logger = options.logger ?? { warn: () => {} };
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
  async recall(query: string, options: { topK?: number } = {}): Promise<RecallHit[]> {
    return this.db.recall(query, { ...(options.topK !== undefined && { topK: options.topK }) });
  }

  async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
    const now = this.clock();
    const bullet: Bullet = {
      id: this.nextId(),
      type: "note",
      status: "open",
      // Collapse whitespace/newlines to a single line: a bullet is one markdown line, and
      // serializeBullet rejects newlines. The harness emits multi-line summaries; P2's distiller
      // will split these into multiple atomic memories — for P1 we store one normalized line.
      text: summary.trim().replace(/\s+/gu, " "),
      salience: 0.5,
      isInsight: false,
      createdAt: now.toISOString(),
      refs: [],
    };
    const path = dailyFilePath(this.root, now);
    appendBullet(this.root, bullet, now);
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
    await this.db.upsert(record);
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
    if (this.llm === undefined) return;
    this.captureChain = this.captureChain
      .then(async () => {
        try {
          await this.capture(conversationId, text);
        } catch (error) {
          this.logger.warn(`bujo capture failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      // Terminal guard: if even the logging path throws, the chain must not settle rejected —
      // otherwise every future scheduleCapture would silently stop (`.then` skips a rejected promise).
      .catch(() => undefined);
  }

  /** Await all captures queued before this call (graceful shutdown / one-shot exit). */
  async flush(): Promise<void> {
    await this.captureChain;
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
    await this.flush();
    this.db.close();
  }
}

export function createBujoMemoryStore(options: BujoOptions): BujoMemoryStore {
  return new BujoMemoryStore(options);
}
