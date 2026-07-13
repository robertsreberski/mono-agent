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
  if (providerKind !== "ollama" && providerKind !== "lmstudio" && providerKind !== "openai") {
    throw new Error(
      `unsupported MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER "${providerKind}" (expected "ollama", "lmstudio", or "openai")`,
    );
  }
  const model = env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL?.trim()
    || (providerKind === "lmstudio"
      ? "text-embedding-nomic-embed-text-v1.5"
      : "nomic-embed-text:v1.5");
  const endpoint = env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT?.trim();
  const apiKeyEnv = env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV?.trim();
  const namedApiKey = apiKeyEnv ? env[apiKeyEnv]?.trim() : undefined;
  if (apiKeyEnv && !namedApiKey) {
    throw new Error(
      `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV declares ${apiKeyEnv}, but that variable has no non-empty value`,
    );
  }
  const apiKey = apiKeyEnv
    ? namedApiKey
    : env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY?.trim();
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
