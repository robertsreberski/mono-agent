import { join, relative } from "node:path";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-md";
import { openMemoryDb, type MemoryDb, type MemoryRecord } from "@mono-agent/memory-store";

import { appendBullet, dailyFilePath } from "./daily.js";
import { serializeBullet } from "./grammar.js";
import { createIdFactory } from "./ids.js";
import type { LlmComplete } from "./llm.js";
import { captureTurn } from "./capture.js";
import { composeRecallBlock } from "./recall.js";
import type { Bullet, BujoOptions } from "./types.js";

export class BujoMemoryStore implements MemoryStore {
  private readonly root: string;
  private readonly db: MemoryDb;
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly nextId: () => string;
  private readonly llm?: LlmComplete;

  constructor(options: BujoOptions) {
    this.root = options.root;
    this.maxBytes = options.maxBytes ?? 8_000;
    this.clock = options.clock ?? (() => new Date());
    this.nextId = createIdFactory({ clock: this.clock });
    this.db = openMemoryDb({
      path: join(options.root, "memory.db"),
      embeddings: options.embeddings,
      dim: options.dim,
    });
    if (options.llm !== undefined) {
      this.llm = options.llm;
    }
  }

  async load(conversationId: string): Promise<MemoryBlock | undefined> {
    // Phase 1: prime with recent high-salience memories. The query is the conversation id
    // as a coarse seed; richer session-aware priming arrives with reflection (P3).
    return composeRecallBlock(this.db, conversationId, { topK: 8, maxBytes: this.maxBytes });
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

  async close(): Promise<void> {
    this.db.close();
  }
}

export function createBujoMemoryStore(options: BujoOptions): BujoMemoryStore {
  return new BujoMemoryStore(options);
}
