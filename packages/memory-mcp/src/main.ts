import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { EmbeddingProviderConfig, EmbeddingProviderKind } from "@worklab-ai/memory-search";

import { createMemoryMcpServerFromConfig } from "./server.js";

function readEmbeddingsConfig(): EmbeddingProviderConfig | undefined {
  const provider = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER?.trim();
  if (provider === undefined || provider.length === 0) {
    return undefined;
  }
  if (provider !== "ollama" && provider !== "openai") {
    process.stderr.write(`memory-mcp: unknown embeddings provider "${provider}"; semantic search disabled.\n`);
    return undefined;
  }
  const model = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL?.trim() || "nomic-embed-text";
  const endpoint = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT?.trim();
  const apiKey = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY?.trim();
  return {
    provider: provider as EmbeddingProviderKind,
    model,
    ...(endpoint === undefined || endpoint.length === 0 ? {} : { endpoint }),
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
  };
}

/**
 * Stdio entrypoint. Spawned by the runtime as an MCP server via the tool-policy
 * `mcpServers` config: `node <dist>/main.js`. Stdout is the MCP channel — only
 * diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const rootDir = process.env.MONO_AGENT_MEMORY_PATH?.trim();
  if (rootDir === undefined || rootDir.length === 0) {
    process.stderr.write("memory-mcp: MONO_AGENT_MEMORY_PATH is required.\n");
    process.exitCode = 1;
    return;
  }
  const graphPath = process.env.MONO_AGENT_MEMORY_GRAPH_PATH?.trim();
  const embeddings = readEmbeddingsConfig();
  const server = createMemoryMcpServerFromConfig({
    rootDir,
    ...(graphPath === undefined || graphPath.length === 0 ? {} : { graphPath }),
    ...(embeddings === undefined ? {} : { embeddings }),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`memory-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
