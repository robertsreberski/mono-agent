import process from "node:process";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveSupermemoryContainer } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import type {
  CircuitBreakerEmbeddingOptions,
  EmbeddingProvider,
  EmbeddingProviderConfig,
} from "@mono-agent/memory/search";
import type { MemoryStatus, MemoryType } from "@mono-agent/memory/store";
import { isConversationRelativeQuery } from "@mono-agent/memory/bujo";
import type { BujoTier } from "@mono-agent/memory/bujo";
import * as z from "zod/v4";

import { loadSupermemoryPlugin } from "./supermemory-plugin.js";

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
 * The child-process settings below remain as a standalone/compatibility surface. Their embeddings
 * path keeps parity with the in-app store (`createConfiguredMemory`): the recall child applies the
 * same per-call timeout and circuit breaker.
 *
 * Secret handling: the raw embeddings api key is NOT copied into the recall child's env. When the
 * key was sourced from a named environment variable (`apiKeyEnv`) we forward only the NAME and the
 * child re-reads the value from its inherited process env at runtime. An inline literal key (no
 * `apiKeyEnv`) still has to transit the child env as a value — that residual is documented on
 * {@link memoryRecallMcpEnv}.
 *
 * MCP tools are not gated by `tools.allowedTools`, so no allowlist entry is required.
 */

export const MEMORY_RECALL_MCP_SERVER_NAME = "mono-agent-memory";

/** Circuit-breaker tuning carried into the recall child. Mirrors `config.memory.embeddings.circuitBreaker`. */
export interface MemoryRecallEmbeddingsCircuitBreaker {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
}

/** Embeddings the recall server needs. Mirrors the resolved `config.memory.embeddings` slice. */
export interface MemoryRecallEmbeddings {
  readonly provider: "ollama" | "lmstudio" | "openai";
  readonly model: string;
  readonly endpoint?: string;
  /** Resolved key value. Only used as a last resort (inline apiKey, no apiKeyEnv). */
  readonly apiKey?: string;
  /** Name of the env var the key was read from; forwarded instead of the raw value when present. */
  readonly apiKeyEnv?: string;
  readonly dim?: number;
  /** Per-call embeddings timeout in ms; mirrors the host default when unset (see createRecallStore). */
  readonly timeoutMs?: number;
  /** Circuit-breaker overrides; unset fields fall back to the breaker defaults. */
  readonly circuitBreaker?: MemoryRecallEmbeddingsCircuitBreaker;
}

/**
 * Supermemory params the recall child needs to build its REST client (external backend). The key is
 * the RESOLVED value (the loader already turned any `apiKeyEnv` into a literal): unlike the embeddings
 * path, recall forwards the value — not an env-var name — into the child's spec env, because the
 * stdio child does NOT inherit the parent's full environment under every runtime (claude-sdk/codex-app
 * pass only a POSIX safe-list), so a name-only handoff would silently fail to authenticate.
 */
export interface MemoryRecallSupermemory {
  readonly baseUrl: string;
  readonly container: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

/** bujo recall: a memory root (+ optional embeddings for semantic ranking). */
export interface MemoryRecallBujoSettings {
  /** Memory root directory (config.memory.path). */
  readonly root: string;
  /** Configured strict tier; required to retain BuJo graph capability in read-only recall. */
  readonly tier?: BujoTier;
  /**
   * Optional exact managed-generation database path. Command paths resolve this
   * once so a semantic attempt and its FTS fallback cannot observe different
   * active generations. The child-process env deliberately omits it and
   * resolves the active generation after startup.
   */
  readonly dbPath?: string;
  /** Embeddings for semantic recall. Omitted for an FTS-only (lite) recall store. */
  readonly embeddings?: MemoryRecallEmbeddings;
  /** Explicit degraded path used only after a configured semantic recall failure. */
  readonly ftsOnlyFallback?: true;
}

/** supermemory recall: search the external instance over REST. */
export interface MemoryRecallSupermemorySettings {
  readonly supermemory: MemoryRecallSupermemory;
}

/**
 * Recall settings — discriminated structurally by the presence of `supermemory`. The bujo shape is
 * unchanged (root + optional embeddings) so existing configs and env round-trips stay byte-identical.
 */
export type MemoryRecallSettings = MemoryRecallBujoSettings | MemoryRecallSupermemorySettings;

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
 * Bound embeddings calls in the recall child so a slow/cold backend cannot stall a turn for the
 * provider default. Mirrors the in-app `createConfiguredMemory` host default (agent-host).
 */
export const DEFAULT_RECALL_EMBEDDINGS_TIMEOUT_MS = 10_000;

/**
 * Resolve recall settings from the single in-app memory block. Returns `undefined` (recall off) only
 * when memory is unconfigured or the recall tool is disabled. When the operator explicitly enables
 * recall on a no-embeddings store (lite tier), settings are returned WITHOUT embeddings so the child
 * serves FTS-only recall — the config layer deliberately supports this forced-on opt-in.
 */
export function resolveMemoryRecallSettings(config: MonoAgentConfig): MemoryRecallSettings | undefined {
  const memory = config.memory;
  if (memory === undefined) {
    return undefined;
  }
  if (memory.recallTool?.enabled === false) {
    return undefined;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const sm = memory.supermemory;
    if (sm === undefined) {
      // Defensive: the loader already rejects backend "supermemory" without a block.
      return undefined;
    }
    return {
      supermemory: {
        baseUrl: sm.baseUrl,
        container: resolveSupermemoryContainer(config),
        // The loader already resolved apiKeyEnv → apiKey, so forward the value (see type doc).
        ...(sm.apiKey === undefined ? {} : { apiKey: sm.apiKey }),
        ...(sm.timeoutMs === undefined ? {} : { timeoutMs: sm.timeoutMs }),
      },
    };
  }
  const embeddings = memory.embeddings;
  if (embeddings === undefined) {
    // Default-on recall without embeddings → FTS-only recall (no embedding provider built).
    return { root: memory.path, tier: memory.mode };
  }
  return {
    root: memory.path,
    tier: memory.mode,
    embeddings: {
      provider: embeddings.provider,
      model: embeddings.model,
      ...(embeddings.endpoint === undefined ? {} : { endpoint: embeddings.endpoint }),
      // Prefer forwarding the env-var NAME over the resolved secret value (F13): when apiKeyEnv is
      // present the child re-reads the key from its inherited env, so the raw key never lands in the
      // child's spec env. The literal apiKey is kept only as a fallback for the inline-key case.
      ...(embeddings.apiKeyEnv === undefined ? {} : { apiKeyEnv: embeddings.apiKeyEnv }),
      ...(embeddings.apiKey === undefined ? {} : { apiKey: embeddings.apiKey }),
      ...(embeddings.dim === undefined ? {} : { dim: embeddings.dim }),
      ...(embeddings.timeoutMs === undefined ? {} : { timeoutMs: embeddings.timeoutMs }),
      ...(embeddings.circuitBreaker === undefined ? {} : { circuitBreaker: embeddings.circuitBreaker }),
    },
  };
}

/**
 * Re-read recall settings from the recall server's own environment (the stdio child process).
 *
 * Only `MONO_AGENT_MEMORY_PATH` is required. When the embeddings provider/model are both absent the
 * child runs FTS-only (no embedding provider). When present, the embeddings slice — including the
 * resilience knobs (timeout + circuit breaker) — is rehydrated. When
 * `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV` is set, that named inherited value is authoritative and
 * must resolve; a literal `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY` is accepted only for the inline-key
 * case where no env-var name was declared.
 */
export function memoryRecallSettingsFromEnv(env: Record<string, string | undefined>): MemoryRecallSettings {
  if (optionalString(env.MONO_AGENT_MEMORY_BACKEND) === "supermemory") {
    const baseUrl = optionalString(env.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL);
    if (baseUrl === undefined) {
      throw new Error("memory-recall: missing required environment (MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL).");
    }
    // Container is forwarded by the parent's resolveSupermemoryContainer (always non-empty). A missing
    // value in the child is a wiring bug, not a default — fail loud rather than search a wrong/empty
    // namespace, mirroring the baseUrl check above.
    const container = optionalString(env.MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER);
    if (container === undefined) {
      throw new Error("memory-recall: missing required environment (MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER).");
    }
    const apiKey = optionalString(env.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY);
    const timeoutMs = parsePositiveInt(
      optionalString(env.MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS),
      "MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS",
    );
    return {
      supermemory: {
        baseUrl,
        container,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    };
  }
  const root = optionalString(env.MONO_AGENT_MEMORY_PATH);
  if (root === undefined) {
    throw new Error("memory-recall: missing required environment (MONO_AGENT_MEMORY_PATH).");
  }
  const rawTier = optionalString(env.MONO_AGENT_MEMORY_MODE);
  if (rawTier !== undefined && rawTier !== "lite" && rawTier !== "journal" && rawTier !== "bujo") {
    throw new Error(`memory-recall: unsupported MONO_AGENT_MEMORY_MODE "${rawTier}" (expected lite, journal, or bujo).`);
  }
  const tier = rawTier as BujoTier | undefined;
  const provider = optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER);
  const model = optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL);
  if (provider === undefined && model === undefined) {
    // No embeddings configured → FTS-only recall store.
    return { root, ...(tier === undefined ? {} : { tier }) };
  }
  if (provider === undefined || model === undefined) {
    throw new Error(
      "memory-recall: incomplete embeddings environment (MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER and MONO_AGENT_MEMORY_EMBEDDINGS_MODEL must be set together).",
    );
  }
  if (provider !== "ollama" && provider !== "lmstudio" && provider !== "openai") {
    throw new Error(
      `memory-recall: unsupported MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER "${provider}" ` +
      `(expected "ollama", "lmstudio", or "openai").`,
    );
  }
  const endpoint = optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT);
  const apiKeyEnv = optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV);
  const namedApiKey = apiKeyEnv === undefined ? undefined : optionalString(env[apiKeyEnv]);
  if (apiKeyEnv !== undefined && namedApiKey === undefined) {
    throw new Error(
      `memory-recall: memory.embeddings.apiKeyEnv ${apiKeyEnv} is declared but the inherited environment ` +
      `has no non-empty value; set ${apiKeyEnv} before starting recall.`,
    );
  }
  // A declared name is authoritative: never turn a missing named credential
  // into an accidental keyless request or silently substitute another value.
  const apiKey = apiKeyEnv === undefined
    ? optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY)
    : namedApiKey;
  const dim = parseDim(optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM));
  const timeoutMs = parsePositiveInt(optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS), "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS");
  const failureThreshold = parsePositiveInt(
    optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD),
    "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
  );
  const cooldownMs = parsePositiveInt(
    optionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS),
    "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS",
  );
  const circuitBreaker =
    failureThreshold === undefined && cooldownMs === undefined
      ? undefined
      : {
          ...(failureThreshold === undefined ? {} : { failureThreshold }),
          ...(cooldownMs === undefined ? {} : { cooldownMs }),
        };
  return {
    root,
    ...(tier === undefined ? {} : { tier }),
    embeddings: {
      provider,
      model,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(dim === undefined ? {} : { dim }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(circuitBreaker === undefined ? {} : { circuitBreaker }),
    },
  };
}

/**
 * Env passed to the recall stdio child. Reuses the MONO_AGENT_MEMORY_* names the old memory-mcp used.
 *
 * With no embeddings the child runs FTS-only and only the memory path is emitted. The embeddings
 * resilience knobs (timeout + circuit breaker) are forwarded so the child wraps its provider exactly
 * like the in-app store. SECRET HANDLING (F13): when `apiKeyEnv` is present the env-var NAME is
 * forwarded (NOT the value) and the child re-reads it from its inherited process env; the raw
 * `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY` value is emitted ONLY for the inline-key residual (an inline
 * `apiKey` with no `apiKeyEnv`), where there is no name to forward.
 */
export function memoryRecallMcpEnv(settings: MemoryRecallSettings): Record<string, string> {
  if (isSupermemorySettings(settings)) {
    const sm = settings.supermemory;
    // Forward the RESOLVED key value (not an env-var name): the recall stdio child does not inherit
    // the parent's full env under claude-sdk/codex-app, so a name handoff would fail to authenticate.
    // Same exposure class as the embeddings inline-key residual — the child is our own subprocess.
    return {
      MONO_AGENT_MEMORY_BACKEND: "supermemory",
      MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: sm.baseUrl,
      MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER: sm.container,
      ...(sm.apiKey === undefined ? {} : { MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY: sm.apiKey }),
      ...(sm.timeoutMs === undefined ? {} : { MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS: String(sm.timeoutMs) }),
    };
  }
  const { embeddings } = settings;
  if (embeddings === undefined) {
    return {
      MONO_AGENT_MEMORY_PATH: settings.root,
      ...(settings.tier === undefined ? {} : { MONO_AGENT_MEMORY_MODE: settings.tier }),
    };
  }
  // Forward the secret only as a last resort: prefer the env-var name passthrough.
  const forwardLiteralApiKey = embeddings.apiKeyEnv === undefined && embeddings.apiKey !== undefined;
  return {
    MONO_AGENT_MEMORY_PATH: settings.root,
    ...(settings.tier === undefined ? {} : { MONO_AGENT_MEMORY_MODE: settings.tier }),
    MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: embeddings.provider,
    MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: embeddings.model,
    ...(embeddings.endpoint === undefined ? {} : { MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: embeddings.endpoint }),
    ...(embeddings.apiKeyEnv === undefined ? {} : { MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: embeddings.apiKeyEnv }),
    ...(forwardLiteralApiKey ? { MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: embeddings.apiKey as string } : {}),
    ...(embeddings.dim === undefined ? {} : { MONO_AGENT_MEMORY_EMBEDDINGS_DIM: String(embeddings.dim) }),
    ...(embeddings.timeoutMs === undefined ? {} : { MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS: String(embeddings.timeoutMs) }),
    ...(embeddings.circuitBreaker?.failureThreshold === undefined
      ? {}
      : { MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: String(embeddings.circuitBreaker.failureThreshold) }),
    ...(embeddings.circuitBreaker?.cooldownMs === undefined
      ? {}
      : { MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS: String(embeddings.circuitBreaker.cooldownMs) }),
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
 * stay disabled here). With no embeddings (lite tier / explicit FTS-only opt-in) the store is built
 * without an embedding provider and serves FTS-only recall.
 *
 * The embedding provider is wrapped with the SAME resilience as the in-app store
 * (`createConfiguredMemory`): a bounded per-call timeout (default
 * {@link DEFAULT_RECALL_EMBEDDINGS_TIMEOUT_MS}) keeps a slow backend from stalling recall, and a
 * circuit breaker fast-fails after repeated failures so a sustained outage stops blocking it.
 */
export async function createRecallStore(settings: MemoryRecallSettings): Promise<RecallCapableStore> {
  // The backend packages load lazily so importing this module (the app does, for
  // the runtime extension + settings resolution) never pulls the SQLite/BuJo
  // stack or the Supermemory client into the main process — only the spawned
  // recall child pays for the backend it actually serves.
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
      description: "Read-only hybrid (keyword + semantic) search over durable long-term memory. Use it for prior preferences, facts, decisions, and qualified archived history. Do not use it for unqualified questions about what you or the user just said or sent in the current or last message; use the active conversation history for those questions.",
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

function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`memory-recall: invalid ${name} "${raw}" (expected a positive integer).`);
  }
  return parsed;
}
