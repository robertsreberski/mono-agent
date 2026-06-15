import BetterSqlite3, { type Database } from "better-sqlite3";

import { migrations } from "./schema.js";
import { loadVec } from "./vec.js";
import {
  DEFAULT_DECAY_GAMMA,
  DEFAULT_RRF_K,
  DEFAULT_WEIGHTS,
  type MemoryDbOptions,
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

  close(): void {
    this.db.close();
  }
}

export function openMemoryDb(options: MemoryDbOptions): MemoryDb {
  return new MemoryDb(options);
}
