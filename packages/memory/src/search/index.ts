export {
  createEmbeddingProvider,
  LmStudioEmbeddingProvider,
  MemorySearchError,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from "./embeddings.js";
export {
  CircuitBreakerEmbeddingProvider,
  createCircuitBreakerEmbeddingProvider,
} from "./circuit-breaker.js";
export type { CircuitBreakerEmbeddingOptions } from "./circuit-breaker.js";
export { createVectorMemoryIndex, VectorMemoryIndex } from "./vector-index.js";
export { gatherMemoryChunks } from "./chunks.js";
export type { EntityLike } from "./chunks.js";
export type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingProviderKind,
  MemoryChunk,
  MemorySearchErrorCode,
  SearchHit,
  VectorMemoryIndexOptions,
} from "./types.js";
