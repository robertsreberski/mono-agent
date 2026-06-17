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
  // A set-but-invalid dim (non-integer, 0, negative) is a misconfiguration — fail here with an
  // actionable message rather than forwarding a bad value into a later, opaque MemoryDb error.
  const dimStr = env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM?.trim();
  let dim: number | undefined;
  if (dimStr !== undefined && dimStr !== "") {
    const parsed = Number(dimStr);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `memory-mcp: invalid MONO_AGENT_MEMORY_EMBEDDINGS_DIM "${dimStr}" (expected a positive integer).`,
      );
    }
    dim = parsed;
  }
  return {
    provider: provider as EmbeddingProviderKind,
    model,
    ...(endpoint ? { endpoint } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(dim !== undefined ? { dim } : {}),
  };
}

/** Resolve the chat-LLM config from environment. Unset model → `undefined` (no LLM = no bujo tier). */
export function readLlm(
  env: NodeJS.ProcessEnv = process.env,
): { model: string; endpoint?: string; timeoutMs?: number } | undefined {
  const model = env.MONO_AGENT_MEMORY_LLM_MODEL?.trim();
  if (!model) return undefined;
  const endpoint = env.MONO_AGENT_MEMORY_LLM_ENDPOINT?.trim();
  // Per-call timeout for the chat LLM. The capture pipeline issues several sequential calls and
  // local models can be slow, so this is overridable; a set-but-invalid value is a misconfiguration
  // — fail with an actionable message rather than forwarding a bad timeout into the LLM client.
  const timeoutStr = env.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS?.trim();
  let timeoutMs: number | undefined;
  if (timeoutStr !== undefined && timeoutStr !== "") {
    const parsed = Number(timeoutStr);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `memory-mcp: invalid MONO_AGENT_MEMORY_LLM_TIMEOUT_MS "${timeoutStr}" (expected a positive integer of milliseconds).`,
      );
    }
    timeoutMs = parsed;
  }
  return { model, ...(endpoint ? { endpoint } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}
