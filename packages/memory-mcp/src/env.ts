import type { EmbeddingProviderKind } from "@mono-agent/memory-search";

import type { MemoryMcpEmbeddingsConfig } from "./server.js";

/**
 * Resolve the embeddings config from environment.
 *
 * - Unset/empty `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` → `undefined` (embeddings off, FTS-only recall).
 * - A set-but-unsupported provider is a misconfiguration: throw rather than silently disabling
 *   embeddings, which is hard to diagnose.
 */
export function readEmbeddings(env: NodeJS.ProcessEnv = process.env): MemoryMcpEmbeddingsConfig | undefined {
  const provider = env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER?.trim();
  if (provider === undefined || provider === "") return undefined;
  if (provider !== "ollama" && provider !== "openai") {
    throw new Error(
      `memory-mcp: unsupported MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER "${provider}" (expected "ollama" or "openai").`,
    );
  }
  const model = env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL?.trim() || "nomic-embed-text:v1.5";
  const endpoint = env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT?.trim();
  const apiKey = env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY?.trim();
  const dimStr = env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM?.trim();
  const dim = dimStr !== undefined && dimStr !== "" ? parseInt(dimStr, 10) : undefined;
  return {
    provider: provider as EmbeddingProviderKind,
    model,
    ...(endpoint ? { endpoint } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(dim !== undefined && Number.isFinite(dim) ? { dim } : {}),
  };
}

/** Resolve the chat-LLM config from environment. Unset model → `undefined` (no LLM = no bujo tier). */
export function readLlm(env: NodeJS.ProcessEnv = process.env): { model: string; endpoint?: string } | undefined {
  const model = env.MONO_AGENT_MEMORY_LLM_MODEL?.trim();
  if (!model) return undefined;
  const endpoint = env.MONO_AGENT_MEMORY_LLM_ENDPOINT?.trim();
  return { model, ...(endpoint ? { endpoint } : {}) };
}
