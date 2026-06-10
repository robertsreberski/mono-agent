export {
  createEmbeddingProvider,
  MemorySearchError,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from "./embeddings.js";
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
