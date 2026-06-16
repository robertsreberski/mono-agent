import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readEmbeddings, readLlm } from "./env.js";
import { createMemoryMcpServerFromConfig } from "./server.js";

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
    void store
      .close()
      .catch((error: unknown) => {
        // Don't let a failed drain/close become an unhandled rejection; log to stderr (stdout is
        // the MCP transport) and still exit so the signal isn't swallowed.
        process.stderr.write(`memory-mcp: shutdown close failed: ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => {
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
