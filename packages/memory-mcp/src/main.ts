import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { EmbeddingProviderKind } from "@mono-agent/memory-search";

import { createMemoryMcpServerFromConfig } from "./server.js";
import type { MemoryMcpEmbeddingsConfig } from "./server.js";

function readEmbeddings(): MemoryMcpEmbeddingsConfig | undefined {
  const provider = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER?.trim();
  if (provider !== "ollama" && provider !== "openai") return undefined;
  const model = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL?.trim() || "nomic-embed-text:v1.5";
  const endpoint = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT?.trim();
  const apiKey = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY?.trim();
  const dimStr = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM?.trim();
  const dim = dimStr !== undefined && dimStr !== "" ? parseInt(dimStr, 10) : undefined;
  return {
    provider: provider as EmbeddingProviderKind,
    model,
    ...(endpoint ? { endpoint } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(dim !== undefined && Number.isFinite(dim) ? { dim } : {}),
  };
}

function readLlm(): { model: string; endpoint?: string } | undefined {
  const model = process.env.MONO_AGENT_MEMORY_LLM_MODEL?.trim();
  if (!model) return undefined;
  const endpoint = process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT?.trim();
  return { model, ...(endpoint ? { endpoint } : {}) };
}

async function main(): Promise<void> {
  const root = process.env.MONO_AGENT_MEMORY_PATH?.trim();
  if (!root) {
    process.stderr.write("memory-mcp: MONO_AGENT_MEMORY_PATH is required.\n");
    process.exitCode = 1;
    return;
  }
  const embeddings = readEmbeddings();
  const llm = readLlm();
  const { server, store } = createMemoryMcpServerFromConfig({
    root,
    ...(embeddings !== undefined && { embeddings }),
    ...(llm !== undefined && { llm }),
  });
  // Registering these listeners overrides Node's default terminate-on-signal, so we must exit
  // explicitly. store.close() drains the serialized capture queue (flush) before closing the db.
  const shutdown = (): void => {
    void store.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`memory-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
