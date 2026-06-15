import type { EmbeddingProvider } from "@mono-agent/memory-search";
import type { MemoryStatus, MemoryType } from "@mono-agent/memory-store";

/** One parsed markdown bullet line: a visible part + structured metadata from the trailing comment. */
export interface Bullet {
  readonly id: string;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly text: string;
  readonly salience: number;
  readonly isInsight: boolean;
  readonly createdAt: string;
  readonly refs: readonly string[];
  readonly dueAt?: string;
}

export interface BujoOptions {
  readonly root: string;
  readonly embeddings: EmbeddingProvider;
  readonly dim: number;
  readonly maxBytes?: number;
  readonly clock?: () => Date;
}
