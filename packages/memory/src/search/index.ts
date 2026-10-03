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
export {
  adoptEmbeddingIndexIdentity,
  configuredEmbeddingIdentity,
  EMBEDDING_INSTRUCTION_PRESETS,
  effectiveEmbeddingIdentity,
  embeddingIdentity,
  embeddingPrefixesForIdentity,
  isEmbeddingInstructionsSetting,
  legacyEmbeddingIdentity,
  modelInstructionPreset,
  resolveEmbeddingInstructionPreset,
} from "./instructions.js";
export type {
  EmbeddingIdentityConfig,
  EmbeddingInstructionPreset,
  EmbeddingInstructionsSetting,
  EmbeddingPrefixes,
} from "./instructions.js";
export type { CircuitBreakerEmbeddingOptions } from "./circuit-breaker.js";
export type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingProviderKind,
  MemorySearchErrorCode,
} from "./types.js";
