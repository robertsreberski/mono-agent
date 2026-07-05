import { createEmbeddingProvider } from "../search/index.js";
import type { EmbeddingProvider } from "../search/index.js";

/**
 * Resolve the embeddings provider from the same `MONO_AGENT_MEMORY_EMBEDDINGS_*` env vars the agent
 * and the MCP server use. Returns undefined when no provider is configured — embeddings are opt-in,
 * so lite-tier (FTS-only) recall/rebuild works without any embedding service (e.g. no Ollama running).
 */
export function readEmbeddings(
  env: NodeJS.ProcessEnv = process.env,
): { provider: EmbeddingProvider; dim: number } | undefined {
  const providerKind = env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER?.trim();
  if (!providerKind) return undefined;
  if (providerKind !== "ollama" && providerKind !== "openai") {
    throw new Error(`unsupported MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER "${providerKind}" (expected "ollama" or "openai")`);
  }
  const model = env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL?.trim() || "nomic-embed-text:v1.5";
  const endpoint = env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT?.trim();
  const apiKey = env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY?.trim();
  const dimStr = env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM?.trim();
  const dim = dimStr ? Number(dimStr) : 768;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`invalid MONO_AGENT_MEMORY_EMBEDDINGS_DIM "${dimStr ?? ""}" (expected a positive integer)`);
  }
  const provider = createEmbeddingProvider({
    provider: providerKind,
    model,
    ...(endpoint ? { endpoint } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  return { provider, dim };
}
