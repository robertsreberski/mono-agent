import type { EmbeddingProvider } from "@mono-agent/memory-search";
import type { MemoryStatus, MemoryType } from "@mono-agent/memory-store";

import type { LlmComplete } from "./llm.js";

export type { CandidateMemory } from "./distill.js";

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

export type BujoTier = "lite" | "journal" | "bujo";

/** Minimal logger sink for best-effort background work (capture queue). */
export interface BujoLogger {
  warn(message: string): void;
}

export interface BujoOptions {
  readonly root: string;
  /** Embedding provider. When absent, the store runs in `lite` tier (FTS-only recall). */
  readonly embeddings?: EmbeddingProvider;
  /** Vector dimension. Required when `embeddings` is provided; ignored in the `lite` tier. */
  readonly dim?: number;
  readonly maxBytes?: number;
  readonly clock?: () => Date;
  /** Optional LLM for the intelligent capture path (distill + reconcile + entity extraction).
   * When absent, `capture()` returns `undefined` and `appendHostSummary` is the only write path. */
  readonly llm?: LlmComplete;
  /** Explicit tier override. When absent, the tier is derived from the options:
   * no embeddings → `"lite"`; embeddings + no llm → `"journal"`; embeddings + llm → `"bujo"`. */
  readonly tier?: BujoTier;
  /** Optional sink for caught errors in the async capture queue. Defaults to a no-op. */
  readonly logger?: BujoLogger;
}
