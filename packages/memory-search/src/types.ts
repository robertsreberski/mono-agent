export type MemorySearchErrorCode =
  | "invalid_embedding_options"
  | "embedding_request_failed"
  | "embedding_response_invalid"
  | "embedding_circuit_open"
  | "invalid_index_options"
  | "index_read_failed"
  | "index_write_failed";

/** Turns text into dense vectors. Implementations: Ollama (default), OpenAI. */
export interface EmbeddingProvider {
  /** Stable identifier for diagnostics (e.g. "ollama:nomic-embed-text"). */
  readonly id: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** A unit of indexable memory (a journal section or an entity summary). */
export interface MemoryChunk {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly day?: string;
}

export interface SearchHit {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly score: number;
  readonly day?: string;
}

export type EmbeddingProviderKind = "ollama" | "openai";

export interface EmbeddingProviderConfig {
  readonly provider: EmbeddingProviderKind;
  readonly model: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export interface VectorMemoryIndexOptions {
  /** JSONL file holding the embedding records (e.g. `<root>/index/embeddings.jsonl`). */
  readonly path: string;
  readonly embeddings: EmbeddingProvider;
  /** Prefix applied to documents before embedding (nomic-embed-text convention). */
  readonly documentPrefix?: string;
  /** Prefix applied to queries before embedding (nomic-embed-text convention). */
  readonly queryPrefix?: string;
  /** Embedding batch size (default 32). */
  readonly batchSize?: number;
}
