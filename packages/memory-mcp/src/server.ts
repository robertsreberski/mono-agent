import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import type { BujoMemoryStore } from "@mono-agent/memory-bujo";
import { createOllamaLlm } from "@mono-agent/memory-bujo";
import { createEmbeddingProvider } from "@mono-agent/memory-search";
import type { EmbeddingProviderConfig } from "@mono-agent/memory-search";
import * as z from "zod/v4";

import { createMemoryTools, type MemoryToolDeps } from "./tools.js";

// Write tools must reject whitespace-only text: the store trims before serializing, so a blank
// note would otherwise be written and indexed as an empty bullet (recall noise, hard to clean up).
const nonBlankText = z.string().min(1).refine((s) => s.trim().length > 0, "must not be empty or whitespace-only");

export function createMemoryMcpServer(deps: MemoryToolDeps): McpServer {
  const tools = createMemoryTools(deps);
  const server = new McpServer({ name: "agent-memory", version: "0.2.2" });

  server.registerTool(
    "memory_recall",
    {
      title: "Recall from memory",
      description: "Hybrid (keyword + semantic) search over long-term memory. Use to recall facts, decisions, and context.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language description of what to recall."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)."),
      },
    },
    async (args) => tools.recall(args),
  );

  server.registerTool(
    "memory_capture",
    {
      title: "Capture a memory",
      description: "Intelligently store a turn or fact: distil → reconcile (add/update/supersede) → extract entities. Requires the bujo tier.",
      inputSchema: { text: nonBlankText.describe("The text to remember (a fact, decision, or turn).") },
    },
    async (args) => tools.capture(args),
  );

  server.registerTool(
    "memory_note",
    {
      title: "Quick note to memory",
      description: "Append a quick deterministic note (rapid-log) to today's daily file. No LLM required.",
      inputSchema: { text: nonBlankText.describe("The note to record (one line).") },
    },
    async (args) => tools.note(args),
  );

  return server;
}

/** Embeddings config extended with optional vector dimension (separate from EmbeddingProviderConfig). */
export interface MemoryMcpEmbeddingsConfig extends EmbeddingProviderConfig {
  /** Embedding vector dimension (default 768 for nomic-embed-text). */
  readonly dim?: number;
}

export interface MemoryMcpServerConfig {
  readonly root: string;
  readonly embeddings?: MemoryMcpEmbeddingsConfig;
  readonly llm?: { readonly model: string; readonly endpoint?: string };
}

/** Build a server (and its backing store) from resolved config. Returns both so the caller can close the store. */
export function createMemoryMcpServerFromConfig(config: MemoryMcpServerConfig): { server: McpServer; store: BujoMemoryStore } {
  const store = createBujoMemoryStore({
    root: config.root,
    ...(config.embeddings !== undefined && {
      embeddings: createEmbeddingProvider(config.embeddings),
      dim: config.embeddings.dim ?? 768,
    }),
    ...(config.llm !== undefined && {
      llm: createOllamaLlm({
        model: config.llm.model,
        ...(config.llm.endpoint !== undefined && { endpoint: config.llm.endpoint }),
      }),
    }),
  });
  const server = createMemoryMcpServer({ store });
  return { server, store };
}
