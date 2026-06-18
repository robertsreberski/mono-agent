import process from "node:process";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import type { BujoMemoryStore } from "@mono-agent/memory-bujo";
import { createEmbeddingProvider } from "@mono-agent/memory-search";
import type { EmbeddingProviderConfig } from "@mono-agent/memory-search";
import type { MonoAgentConfig } from "@mono-agent/config";
import * as z from "zod/v4";

/**
 * Read-only memory recall, wired from the SINGLE `config.memory` block.
 *
 * When `config.memory.recallTool.enabled` is true and embeddings are configured, the app exposes a
 * `memory_recall` MCP tool (server name {@link MEMORY_RECALL_MCP_SERVER_NAME}) to the agent. Recall
 * needs only embeddings + FTS — no chat LLM — so the recall server is built with embeddings alone.
 * Capture stays in-app (unchanged); this module never touches it.
 *
 * This mirrors the self-capabilities runtime extension: a stdio MCP server is injected purely as an
 * `mcpServers` entry via the per-request runtime options. MCP tools are not gated by
 * `tools.allowedTools`, so no allowlist entry is required.
 */

export const MEMORY_RECALL_MCP_SERVER_NAME = "mono-agent-memory";

/** Embeddings the recall server needs. Mirrors the resolved `config.memory.embeddings` slice. */
export interface MemoryRecallEmbeddings {
  readonly provider: "ollama" | "openai";
  readonly model: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly dim?: number;
}

export interface MemoryRecallSettings {
  /** Memory root directory (config.memory.path). */
  readonly root: string;
  readonly embeddings: MemoryRecallEmbeddings;
}

export interface MemoryRecallRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
}

/**
 * Resolve recall settings from the single in-app memory block. Returns `undefined` (recall off) when
 * memory is unconfigured, the recall tool is disabled, or embeddings are absent — recall can only
 * rank semantically with an embedding provider.
 */
export function resolveMemoryRecallSettings(config: MonoAgentConfig): MemoryRecallSettings | undefined {
  const memory = config.memory;
  if (memory === undefined) {
    return undefined;
  }
  if (memory.recallTool?.enabled !== true) {
    return undefined;
  }
  const embeddings = memory.embeddings;
  if (embeddings === undefined) {
    return undefined;
  }
  return {
    root: memory.path,
    embeddings: {
      provider: embeddings.provider,
      model: embeddings.model,
      ...(embeddings.endpoint === undefined ? {} : { endpoint: embeddings.endpoint }),
      ...(embeddings.apiKey === undefined ? {} : { apiKey: embeddings.apiKey }),
      ...(embeddings.dim === undefined ? {} : { dim: embeddings.dim }),
    },
  };
}

/** Re-read recall settings from the recall server's own environment (the stdio child process). */
export function memoryRecallSettingsFromEnv(env: Record<string, string | undefined>): MemoryRecallSettings {
  const root = optionalString(env.MONO_AGENT_MEMORY_PATH);
  const provider = optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER);
  const model = optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL);
  if (root === undefined || provider === undefined || model === undefined) {
    throw new Error(
      "memory-recall: missing required environment (MONO_AGENT_MEMORY_PATH, MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER, MONO_AGENT_MEMORY_EMBEDDINGS_MODEL).",
    );
  }
  if (provider !== "ollama" && provider !== "openai") {
    throw new Error(`memory-recall: unsupported MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER "${provider}" (expected "ollama" or "openai").`);
  }
  const endpoint = optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT);
  const apiKey = optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY);
  const dim = parseDim(optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM));
  return {
    root,
    embeddings: {
      provider,
      model,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(dim === undefined ? {} : { dim }),
    },
  };
}

/** Env passed to the recall stdio child. Reuses the MONO_AGENT_MEMORY_* names the old memory-mcp used. */
export function memoryRecallMcpEnv(settings: MemoryRecallSettings): Record<string, string> {
  const { embeddings } = settings;
  return {
    MONO_AGENT_MEMORY_PATH: settings.root,
    MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: embeddings.provider,
    MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: embeddings.model,
    ...(embeddings.endpoint === undefined ? {} : { MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: embeddings.endpoint }),
    ...(embeddings.apiKey === undefined ? {} : { MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: embeddings.apiKey }),
    ...(embeddings.dim === undefined ? {} : { MONO_AGENT_MEMORY_EMBEDDINGS_DIM: String(embeddings.dim) }),
  };
}

export function memoryRecallMcpServerSpec(settings: MemoryRecallSettings, cwd: string): Record<string, unknown> {
  return {
    type: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./memory-recall-main.js", import.meta.url))],
    cwd,
    env: memoryRecallMcpEnv(settings),
  };
}

/**
 * Build the per-request runtime extension that injects the recall server. The cleanup is a no-op:
 * the stdio child owns its store lifecycle and drains on signal (see memory-recall-main).
 */
export function createMemoryRecallRuntimeExtension(
  settings: MemoryRecallSettings,
  cwd: string,
): () => Promise<MemoryRecallRuntimeExtension> {
  return async () => ({
    runtimeOptions: {
      mcpServers: {
        [MEMORY_RECALL_MCP_SERVER_NAME]: memoryRecallMcpServerSpec(settings, cwd),
      },
    },
    cleanup: async () => {},
  });
}

/**
 * Build a RECALL-ONLY store: embeddings + FTS, no chat LLM (recall needs none, so capture/reflect
 * stay disabled here). With no embeddings (lite tier) the store still serves FTS-only recall.
 */
export function createRecallStore(settings: MemoryRecallSettings): BujoMemoryStore {
  const { embeddings } = settings;
  const providerConfig: EmbeddingProviderConfig = {
    provider: embeddings.provider,
    model: embeddings.model,
    ...(embeddings.endpoint === undefined ? {} : { endpoint: embeddings.endpoint }),
    ...(embeddings.apiKey === undefined ? {} : { apiKey: embeddings.apiKey }),
  };
  return createBujoMemoryStore({
    root: settings.root,
    embeddings: createEmbeddingProvider(providerConfig),
    dim: embeddings.dim ?? 768,
  });
}

/** Register the single read-only `memory_recall` tool against a store. */
export function createMemoryRecallServer(store: BujoMemoryStore): McpServer {
  const server = new McpServer({ name: "agent-memory", version: "0.3.0" });
  server.registerTool(
    "memory_recall",
    {
      title: "Recall from memory",
      description: "Read-only hybrid (keyword + semantic) search over long-term memory. Use to recall facts, decisions, and context.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language description of what to recall."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)."),
      },
    },
    async (args) => {
      const topK = clampLimit(args.limit, 8);
      const hits = await store.recall(args.query, { topK });
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No memories matched "${args.query}".` }], structuredContent: { hits: [] } };
      }
      const text = hits.map((hit) => `${hit.score.toFixed(3)}  ${hit.record.text}`).join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { hits: hits.map((hit) => ({ id: hit.record.id, score: hit.score, text: hit.record.text })) },
      };
    },
  );
  return server;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(50, Math.max(1, Math.trunc(limit)));
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseDim(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`memory-recall: invalid MONO_AGENT_MEMORY_EMBEDDINGS_DIM "${raw}" (expected a positive integer).`);
  }
  return parsed;
}
