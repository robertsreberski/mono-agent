import { legacyEmbeddingIdentity, type EmbeddingIdentityConfig } from "@mono-agent/memory/search";

/**
 * Audit option that keeps accepting an index built before embedding
 * instruction presets (only for the default `auto` instructions).
 */
export function legacyEmbeddingModelOption(
  embeddings: EmbeddingIdentityConfig,
): { readonly configuredLegacyEmbeddingModel?: string } {
  const legacy = legacyEmbeddingIdentity(embeddings);
  return legacy === undefined ? {} : { configuredLegacyEmbeddingModel: legacy };
}
