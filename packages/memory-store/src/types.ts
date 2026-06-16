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

export interface SimilarHit {
  readonly record: MemoryRecord;
  readonly distance: number; // cosine distance from sqlite-vec (0 = identical)
}

export interface EntityRecord {
  readonly id: string;       // slug, e.g. "person:robert"
  readonly name: string;
  readonly type?: string;    // person | project | org | concept | ...
  readonly summary?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface EntityRelationRecord {
  readonly src: string;
  readonly dst: string;
  readonly relation: string;
  readonly createdAt: string;
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
  readonly embeddings?: EmbeddingProvider;
  readonly dim?: number;
  readonly k?: number;
  readonly weights?: Partial<RecallWeights>;
  readonly decayGamma?: number;
  readonly clock?: () => Date;
}

/** Default vector dimension used for the `memories_vec` table DDL when no `dim` is provided. */
export const DEFAULT_VEC_DIM = 768;

/**
 * Re-score weights. `rrf` scales the (small, ~1/k) fused rank score; the others
 * are added on top. These are independent scalars, NOT a distribution that sums to 1.
 */
export const DEFAULT_WEIGHTS: RecallWeights = {
  rrf: 1.0,
  recency: 0.3,
  salience: 0.3,
  insight: 0.2,
};
export const DEFAULT_RRF_K = 60;
/** Exponential recency decay per day: score *= gamma^daysSinceLastAccess. 0.995 ≈ 16% weight after one year. */
export const DEFAULT_DECAY_GAMMA = 0.995;
