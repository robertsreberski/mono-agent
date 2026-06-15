import type { EmbeddingProvider } from "@mono-agent/memory-search";

export type MemoryType = "task" | "event" | "note";

export type MemoryStatus =
  | "open"
  | "done"
  | "scheduled"
  | "migrated"
  | "dropped"
  | "invalidated";

export interface MemorySource {
  readonly session?: string;
  readonly file?: string;
  readonly line?: number;
}

export interface MemoryRecord {
  readonly id: string;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly text: string;
  readonly salience: number;
  readonly isInsight: boolean;
  readonly createdAt: string;
  readonly lastAccessedAt?: string;
  readonly accessCount: number;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersededBy?: string;
  readonly supersededAt?: string;
  readonly dueAt?: string;
  readonly tags: readonly string[];
  readonly collection?: string;
  readonly source: MemorySource;
  readonly embeddingModel?: string;
  readonly dim?: number;
}

export type MemoryEdgeKind = "thread" | "about" | "supports" | "supersedes";

export interface RecallHit {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface RecallWeights {
  readonly rrf: number;
  readonly recency: number;
  readonly salience: number;
  readonly insight: number;
}

export interface RecallOptions {
  readonly topK?: number;
  readonly candidates?: number;
  readonly expandHops?: number;
  readonly includeInvalid?: boolean;
  readonly now?: Date;
}

export interface MemoryDbOptions {
  readonly path: string;
  readonly embeddings: EmbeddingProvider;
  readonly dim: number;
  readonly k?: number;
  readonly weights?: Partial<RecallWeights>;
  readonly decayGamma?: number;
  readonly clock?: () => Date;
}

export const DEFAULT_WEIGHTS: RecallWeights = {
  rrf: 1.0,
  recency: 0.3,
  salience: 0.3,
  insight: 0.2,
};
export const DEFAULT_RRF_K = 60;
export const DEFAULT_DECAY_GAMMA = 0.995;
