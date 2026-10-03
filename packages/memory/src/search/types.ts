import type { EmbeddingInstructionsSetting } from "./instructions.js";

export type MemorySearchErrorCode =
  | "invalid_embedding_options"
  | "embedding_request_failed"
  | "embedding_response_invalid"
  | "embedding_circuit_open";

/** Turns text into dense vectors. Implementations: Ollama (default), LM Studio, OpenAI. */
export interface EmbeddingProvider {
  /**
   * Stable index identity (e.g. "ollama:nomic-embed-text"). A
   * `#instructions=<preset>` suffix selects the query/document prefixes.
   */
  readonly id: string;
  /**
   * Pre-preset identity an existing index built by this model may keep
   * serving with the historical prefixes (set only for `instructions: "auto"`).
   */
  readonly legacyId?: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export type EmbeddingProviderKind = "ollama" | "lmstudio" | "openai";

export interface EmbeddingProviderConfig {
  readonly provider: EmbeddingProviderKind;
  readonly model: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Query/document instruction preset; default `auto` (per-model). */
  readonly instructions?: EmbeddingInstructionsSetting;
}
