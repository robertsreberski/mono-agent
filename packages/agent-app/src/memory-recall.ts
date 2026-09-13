import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CircuitBreakerEmbeddingOptions,
  EmbeddingProvider,
  EmbeddingProviderConfig,
} from "@mono-agent/memory/search";
import type { MemoryStatus, MemoryType } from "@mono-agent/memory/store";
import { isConversationRelativeQuery } from "@mono-agent/memory/bujo";
import * as z from "zod/v4";

import type {
  MemoryRecallEmbeddings,
  MemoryRecallSettings,
  MemoryRecallSupermemorySettings,
} from "./memory-recall-settings.js";
import { loadSupermemoryPlugin } from "./supermemory-plugin.js";

export { resolveMemoryRecallSettings } from "./memory-recall-settings.js";
export type {
  MemoryRecallBujoSettings,
  MemoryRecallEmbeddings,
  MemoryRecallEmbeddingsCircuitBreaker,
  MemoryRecallSettings,
  MemoryRecallSupermemory,
  MemoryRecallSupermemorySettings,
  ResolveMemoryRecallSettingsOptions,
} from "./memory-recall-settings.js";

/**
 * Read-only memory recall, wired from the SINGLE `config.memory` block.
 *
 * When memory is configured and `config.memory.recallTool.enabled` is not explicitly false, the app exposes a `MemoryRecall` MCP tool
 * (server name {@link MEMORY_RECALL_MCP_SERVER_NAME}) to the agent. The normal app path registers
 * the tool against the request-scoped shared retrieval service in `memory-retrieval.ts`, so
 * automatic recall and explicit tool calls use the same store and per-turn cache. Recall needs only
 * embeddings + FTS — no chat LLM — and still serves FTS-only (lexical) results when embeddings are
 * absent. Capture stays in-app (unchanged); this module never touches it.
 *
 * MCP tools are not gated by `tools.allowedTools`, so no allowlist entry is required.
 */

export const MEMORY_RECALL_MCP_SERVER_NAME = "mono-agent-memory";

/** Read-only recall surface the MCP server formats. Both backend stores satisfy it structurally. */
export interface RecallCapableStore {
  recall(
    query: string,
    options?: { readonly topK?: number; readonly trackAccess?: boolean },
  ): Promise<readonly {
    readonly score: number;
    readonly record: {
      readonly id: string;
      readonly text: string;
      readonly type?: MemoryType;
      readonly status?: MemoryStatus;
      readonly isInsight?: boolean;
    };
  }[]>;
  /** Optional deterministic one-hop expansion, used only by the explicit tool. */
  expandGraph?(
    query: string,
    directHits: Awaited<ReturnType<RecallCapableStore["recall"]>>,
    options?: { readonly topK?: number },
  ): Awaited<ReturnType<RecallCapableStore["recall"]>> | Promise<Awaited<ReturnType<RecallCapableStore["recall"]>>>;
  /** Explicit capability check for stores whose graph method is tier-dependent. */
  supportsGraphExpansion?(): boolean;
  /** Record only the final hits actually served by the tool. */
  recordAccess?(ids: readonly string[]): void;
  flush?(): Promise<void>;
  close(): Promise<void>;
}

function isSupermemorySettings(settings: MemoryRecallSettings): settings is MemoryRecallSupermemorySettings {
  return "supermemory" in settings;
}

export interface MemoryRecallRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
}

/**
 * Bound embeddings calls in the recall store so a slow/cold backend cannot stall a turn for the
 * provider default. Mirrors the in-app `createConfiguredMemory` host default (agent-host).
 */
export const DEFAULT_RECALL_EMBEDDINGS_TIMEOUT_MS = 10_000;

/**
 * Build a RECALL-ONLY store: embeddings + FTS, no chat LLM (recall needs none, so capture/reflect
 * stay disabled here). With no embeddings (lite tier / explicit FTS-only opt-in) the store is built
 * without an embedding provider and serves FTS-only recall.
 *
 * The embedding provider is wrapped with the SAME resilience as the in-app store
 * (`createConfiguredMemory`): a bounded per-call timeout (default
 * {@link DEFAULT_RECALL_EMBEDDINGS_TIMEOUT_MS}) keeps a slow backend from stalling recall, and a
 * circuit breaker fast-fails after repeated failures so a sustained outage stops blocking it.
 */
export async function createRecallStore(settings: MemoryRecallSettings): Promise<RecallCapableStore> {
  // Backend packages load lazily so importing the settings/type surface never pulls the
  // SQLite/BuJo stack or Supermemory client into the main process. Only a recall command or the
  // injected tool pays for the backend it actually serves.
  if (isSupermemorySettings(settings)) {
    const { createSupermemoryStore } = await loadSupermemoryPlugin();
    const sm = settings.supermemory;
    return createSupermemoryStore({
      baseUrl: sm.baseUrl,
      container: sm.container,
      ...(sm.apiKey === undefined ? {} : { apiKey: sm.apiKey }),
      ...(sm.timeoutMs === undefined ? {} : { timeoutMs: sm.timeoutMs }),
    });
  }
  const { createBujoMemoryStore, resolveActiveMemoryDbPath } = await import("@mono-agent/memory/bujo");
  const dbPath = settings.dbPath ?? await resolveActiveMemoryDbPath(settings.root);
  const { embeddings } = settings;
  if (embeddings === undefined) {
    // FTS-only recall: no embedding provider, no dim (mirrors the lite-tier store shape).
    return createBujoMemoryStore({
      root: settings.root,
      dbPath,
      readOnly: true,
      ...(settings.tier === undefined ? {} : { tier: settings.tier }),
      ...(settings.ftsOnlyFallback === true ? { allowFtsFallback: true } : {}),
    });
  }
  const provider = await createMemoryEmbeddingProvider(embeddings);
  return createBujoMemoryStore({
    root: settings.root,
    dbPath,
    readOnly: true,
    ...(settings.tier === undefined ? {} : { tier: settings.tier }),
    embeddings: provider,
    dim: embeddings.dim ?? 768,
  });
}

/** Build the configured embedding provider used by recall and safe index maintenance. */
export async function createMemoryEmbeddingProvider(
  embeddings: MemoryRecallEmbeddings,
): Promise<EmbeddingProvider> {
  if (embeddings.apiKeyEnv !== undefined && embeddings.apiKey === undefined) {
    throw new Error(
      `memory.embeddings.apiKeyEnv ${embeddings.apiKeyEnv} is declared but has no resolved value; ` +
      `set ${embeddings.apiKeyEnv} before using semantic memory.`,
    );
  }
  const providerConfig: EmbeddingProviderConfig = {
    provider: embeddings.provider,
    model: embeddings.model,
    ...(embeddings.endpoint === undefined ? {} : { endpoint: embeddings.endpoint }),
    ...(embeddings.apiKey === undefined ? {} : { apiKey: embeddings.apiKey }),
    timeoutMs: embeddings.timeoutMs ?? DEFAULT_RECALL_EMBEDDINGS_TIMEOUT_MS,
  };
  const breakerOptions: CircuitBreakerEmbeddingOptions = {
    ...(embeddings.circuitBreaker?.failureThreshold === undefined
      ? {}
      : { failureThreshold: embeddings.circuitBreaker.failureThreshold }),
    ...(embeddings.circuitBreaker?.cooldownMs === undefined ? {} : { cooldownMs: embeddings.circuitBreaker.cooldownMs }),
  };
  const { createCircuitBreakerEmbeddingProvider, createEmbeddingProvider } = await import("@mono-agent/memory/search");
  return createCircuitBreakerEmbeddingProvider(createEmbeddingProvider(providerConfig), breakerOptions);
}

/** Register the single read-only `MemoryRecall` tool against a store (bujo or external backend). */
export function createMemoryRecallServer(store: RecallCapableStore): McpServer {
  const server = new McpServer({ name: "agent-memory", version: "0.3.0" });
  server.registerTool(
    "MemoryRecall",
    {
      title: "Recall from memory",
      description: "Read-only hybrid (keyword + semantic) targeted search over intentionally captured durable preferences, facts, decisions, and qualified archived history. For a broad retrospective over an explicit period, use MemoryJournal when available; its curated chronology is distinct from targeted search and exact execution evidence. For a request to pick up, continue, or recover interrupted work, do not search MemoryRecall: call RunHistory with {} first when that tool is available, because exact prior-run evidence does not belong to durable memory. Do not use MemoryRecall for unqualified questions about what you or the user just said or sent in the current or last message; use the active conversation history for those questions.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language description of what to recall."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)."),
      },
    },
    async (args) => {
      if (isConversationRelativeQuery(args.query)) {
        const guidance = "This question refers to the active conversation, not long-term memory. Use the current conversation history to identify the last message.";
        return {
          content: [{ type: "text", text: guidance }],
          structuredContent: { hits: [], conversationRelative: true, guidance },
        };
      }
      const topK = clampLimit(args.limit, 8);
      let hits: Awaited<ReturnType<RecallCapableStore["recall"]>>;
      try {
        const graphEnabled = store.expandGraph !== undefined && store.supportsGraphExpansion?.() !== false;
        const direct = await store.recall(args.query, {
          topK: graphEnabled ? 50 : topK,
          // The bundled recall process opens the active generation read-only.
          // Never ask a store to mutate access telemetry on this path.
          trackAccess: false,
        });
        hits = !graphEnabled || store.expandGraph === undefined
          ? direct.slice(0, topK)
          : await store.expandGraph(args.query, direct, { topK });
        // Record only the final served set. Read-only BuJo recall stores make
        // this a no-op; shared writable stores retain their access telemetry.
        store.recordAccess?.(hits.map((hit) => hit.record.id));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Memory recall is temporarily unavailable: ${reason}` }],
          structuredContent: { hits: [], degraded: true, reason },
        };
      }
      if (hits.length === 0) {
        const guidance = "If this request is to pick up, continue, or recover interrupted work and RunHistory is available, call RunHistory with {} first. Do not keep rephrasing MemoryRecall queries for exact prior-run evidence.";
        return {
          content: [{ type: "text", text: `No memories matched "${args.query}". ${guidance}` }],
          structuredContent: {
            hits: [],
            navigation: {
              guidance,
              relatedTools: [{
                tool: "RunHistory",
                description: "Discover settled prior runs before asking for missing interrupted-work context.",
                arguments: {},
              }],
            },
          },
        };
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
