import { join } from "node:path";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-md";
import { openMemoryDb, type MemoryDb, type MemoryRecord } from "@mono-agent/memory-store";

import { appendBullet, dailyFilePath } from "./daily.js";
import { createIdFactory } from "./ids.js";
import { composeRecallBlock } from "./recall.js";
import type { Bullet, BujoOptions } from "./types.js";

export class BujoMemoryStore implements MemoryStore {
  private readonly root: string;
  private readonly db: MemoryDb;
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly nextId: () => string;

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
      text: summary.trim(),
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
      source: { session: conversationId, file: dailyFilePath(this.root, now).replace(`${this.root}/`, "") },
    };
    await this.db.upsert(record);
    return { conversationId, source: path, bytesWritten: Buffer.byteLength(summary, "utf8") };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function createBujoMemoryStore(options: BujoOptions): BujoMemoryStore {
  return new BujoMemoryStore(options);
}
