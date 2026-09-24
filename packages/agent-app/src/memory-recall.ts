import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CircuitBreakerEmbeddingOptions,
  EmbeddingProvider,
  EmbeddingProviderConfig,
} from "@mono-agent/memory/search";
import type { MemoryStatus, MemoryType } from "@mono-agent/memory/store";
import { isConversationRelativeQuery } from "@mono-agent/memory/bujo";
import { normalizeOptionalString } from "@mono-agent/agent-contracts";
import * as z from "zod/v4";
import { readLabelSections, type LabelKind, type LabelSectionRequest, type LabelSections } from "./memory-label-sections.js";
import type { LabelRecallStore } from "./memory-guidance.js";

import type {
  MemoryRecallEmbeddings,
  MemoryRecallSettings,
} from "./memory-recall-settings.js";

export { resolveMemoryRecallSettings } from "./memory-recall-settings.js";
export type {
  MemoryRecallBujoSettings,
  MemoryRecallEmbeddings,
  MemoryRecallEmbeddingsCircuitBreaker,
  MemoryRecallSettings,
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

export interface MemoryRecallHit {
  readonly score: number;
  readonly record: {
    readonly id: string;
    readonly text: string;
    readonly type?: MemoryType;
    readonly status?: MemoryStatus;
    readonly isInsight?: boolean;
    readonly createdAt?: string;
    readonly validFrom?: string;
    readonly validTo?: string;
  };
}

export interface MemoryRecallOutcome {
  readonly hits: readonly MemoryRecallHit[];
  readonly retrievalMode: "hybrid" | "lexical_only";
  readonly degradation?: { readonly code: "embedding_unavailable" };
}

/** Read-only recall surface the MCP server formats. Both backend stores satisfy it structurally. */
export interface RecallCapableStore extends LabelRecallStore {
  labelSections?(request: LabelSectionRequest): LabelSections | undefined;
  recall(
    query: string,
    options?: { readonly topK?: number; readonly trackAccess?: boolean },
  ): Promise<readonly MemoryRecallHit[]>;
  /** Optional local capability. Array-only backends keep their strict behavior. */
  recallWithOutcome?(
    query: string,
    options?: { readonly topK?: number; readonly trackAccess?: boolean },
  ): Promise<MemoryRecallOutcome>;
  /**
   * App-owned per-logical-turn capability. Standalone and capability-free
   * programmatic stores omit it, so they never advertise an original-query mode
   * they cannot fulfill.
   */
  recallOriginalWithOutcome?(options?: { readonly topK?: number }): Promise<
    | { readonly available: true; readonly query: string; readonly outcome: MemoryRecallOutcome }
    | {
        readonly available: false;
        readonly reason: "not_loaded" | "empty" | "conversation_relative" | "lookup_failed" | "replaced";
      }
  >;
  /** Optional deterministic one-hop expansion, used only by the explicit tool. */
  expandGraph?(
    query: string,
    directHits: readonly MemoryRecallHit[],
    options?: { readonly topK?: number },
  ): readonly MemoryRecallHit[] | Promise<readonly MemoryRecallHit[]>;
  /** Explicit capability check for stores whose graph method is tier-dependent. */
  supportsGraphExpansion?(): boolean;
  /** Record only the final hits actually served by the tool. */
  recordAccess?(ids: readonly string[]): void;
  flush?(): Promise<void>;
  close(): Promise<void>;
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
  // Load the native SQLite/BuJo stack only when recall is used.
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

// The denominator is the union of query terms actually present in the candidate
// set, not every English/Italian/Dutch question word. Unicode tokenization keeps
// accented names and multilingual facts from being penalized as ASCII fragments.
const RECALL_FILLER = new Set([
  "a", "an", "and", "are", "at", "de", "del", "der", "die", "do", "een", "en", "e", "het", "hoe", "il", "in", "is", "la", "le", "of", "on", "the", "van", "wat", "was", "what", "when", "waar", "welke", "wie", "zijn",
]);
function explicitTokens(text: string): ReadonlySet<string> {
  return new Set((text.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 && !RECALL_FILLER.has(word)));
}

/** Rerank a served explicit set without changing automatic recall backend scores. */
export function rankExplicitHits(query: string, hits: readonly MemoryRecallHit[]): MemoryRecallHit[] {
  const queryTokens = explicitTokens(query);
  const records = hits.map((hit) => explicitTokens(hit.record.text));
  const covered = [...queryTokens].filter((word) => records.some((words) => words.has(word)));
  if (covered.length === 0) return [...hits];
  const matches = records.map((words) => covered.filter((word) => words.has(word)).length);
  if (matches.every((count) => count === matches[0])) return [...hits];
  return hits.map((hit, index) => ({
    ...hit,
    score: hit.score * 0.8 + 0.2 * ((matches[index] ?? 0) / covered.length),
  })).sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
}

function formatHitDates(hit: MemoryRecallHit): string {
  const parts = [
    hit.record.createdAt === undefined ? undefined : `recorded ${hit.record.createdAt}`,
    hit.record.validFrom === undefined ? undefined : `valid from ${hit.record.validFrom}`,
    hit.record.validTo === undefined ? undefined : `valid to ${hit.record.validTo}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "" : `[${parts.join("; ")}] `;
}

/** Build the configured embedding provider used by recall and safe index maintenance. */
export async function createMemoryEmbeddingProvider(
  embeddings: MemoryRecallEmbeddings,
): Promise<EmbeddingProvider> {
  // Same resolve-at-use contract as managed memory: the loader carries only
  // the credential name, so the value is read here (declared name wins).
  const embeddingsApiKey = embeddings.apiKeyEnv !== undefined
    ? normalizeOptionalString(process.env[embeddings.apiKeyEnv])
    : embeddings.apiKey;
  if (embeddings.apiKeyEnv !== undefined && embeddingsApiKey === undefined) {
    throw new Error(
      `memory.embeddings.apiKeyEnv ${embeddings.apiKeyEnv} is declared but has no resolved value; ` +
      `set ${embeddings.apiKeyEnv} before using semantic memory.`,
    );
  }
  const providerConfig: EmbeddingProviderConfig = {
    provider: embeddings.provider,
    model: embeddings.model,
    ...(embeddings.endpoint === undefined ? {} : { endpoint: embeddings.endpoint }),
    ...(embeddingsApiKey === undefined ? {} : { apiKey: embeddingsApiKey }),
    timeoutMs: embeddings.timeoutMs ?? DEFAULT_RECALL_EMBEDDINGS_TIMEOUT_MS,
    ...(embeddings.instructions === undefined ? {} : { instructions: embeddings.instructions }),
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

/** Register the single read-only `MemoryRecall` tool against a structurally compatible store. */
export function createMemoryRecallServer(store: RecallCapableStore): McpServer {
  const server = new McpServer({ name: "agent-memory", version: "0.3.0" });
  const supportsOriginalQuery = store.recallOriginalWithOutcome !== undefined;
  const baseDescription = "Read-only hybrid (keyword + semantic) targeted search over intentionally captured durable preferences, facts, decisions, and qualified archived history. For a broad retrospective over an explicit period, use MemoryJournal when available; its curated chronology is distinct from targeted search and exact execution evidence. For a request to pick up, continue, or recover interrupted work, do not search MemoryRecall: call RunHistory with {} first when that tool is available, because exact prior-run evidence does not belong to durable memory. Do not use MemoryRecall for unqualified questions about what you or the user just said or sent in the current or last message; use the active conversation history for those questions.";
  const description = supportsOriginalQuery
    ? `${baseDescription} When a rephrased targeted search loses relevant candidates, use original-query mode deliberately to inspect the current logical turn's unchanged automatic lookup question; this does not broaden automatic memory injection.`
    : baseDescription;
  const limitSchema = z.number().int().min(1).max(50).optional().describe("Max results (default 8).");
  const labelArgs = {
    kind: z.enum(["fact", "preference", "lesson"]).optional()
      .describe("Filter labelled fact-sheet/guidance sections only, not ordinary dated hits. Available for local BuJo memory; ignored by remote stores."),
    about: z.string().trim().min(1).max(160).optional()
      .describe("Exact person entity ID or name for the local BuJo fact sheet. Ambiguous names show entity IDs; use an ID to disambiguate. Guidance is empty in about mode. Ordinary hits stay unchanged; remote stores ignore this option."),
  };
  type ToolArgs =
    | { readonly query: string; readonly useOriginalQuery?: false; readonly limit?: number; readonly kind?: LabelKind; readonly about?: string }
    | { readonly useOriginalQuery: true; readonly limit?: number; readonly kind?: LabelKind; readonly about?: string };

  const handleRecall = async (args: ToolArgs) => {
    const originalMode = args.useOriginalQuery === true;
    let effectiveQuery: string;
    let originalOutcome: MemoryRecallOutcome | undefined;
    if (originalMode) {
      let original: Awaited<ReturnType<NonNullable<RecallCapableStore["recallOriginalWithOutcome"]>>> | undefined;
      try {
        original = await store.recallOriginalWithOutcome?.({ topK: clampLimit(args.limit, 8) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Original-query memory recall is temporarily unavailable: ${reason}` }],
          structuredContent: { hits: [], queryMode: "original", degraded: true, reason },
        };
      }
      if (original === undefined || !original.available) {
        const reason = original?.reason ?? "not_loaded";
        const guidance = "The current logical turn has no eligible original automatic-lookup question. Use an explicit durable-memory query or the active conversation history as appropriate.";
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Original-query memory recall is unavailable (${reason}). ${guidance}` }],
          structuredContent: {
            hits: [],
            queryMode: "original",
            originalQueryUnavailable: true,
            reason,
            guidance,
          },
        };
      }
      effectiveQuery = original.query;
      originalOutcome = original.outcome;
    } else {
      effectiveQuery = args.query;
    }
    const originalMetadata = originalMode
      ? { queryMode: "original" as const, effectiveQuery }
      : {};
    const originalPrefix = originalMode
      ? `Memory recall used this logical turn's original query: "${effectiveQuery}".\n`
      : "";
    if (isConversationRelativeQuery(effectiveQuery)) {
      const guidance = "This question refers to the active conversation, not long-term memory. Use the current conversation history to identify the last message.";
      return {
        content: [{ type: "text" as const, text: `${originalPrefix}${guidance}` }],
        structuredContent: { hits: [], conversationRelative: true, guidance, ...originalMetadata },
      };
    }
    const topK = clampLimit(args.limit, 8);
    let hits: readonly MemoryRecallHit[];
    let degradation: MemoryRecallOutcome["degradation"];
    try {
      const graphEnabled = store.expandGraph !== undefined && store.supportsGraphExpansion?.() !== false;
      if (originalOutcome !== undefined) {
        degradation = originalOutcome.degradation;
        // The bound capability already applies the same graph policy while
        // reusing its original direct lookup, so never expand it a second time.
        hits = originalOutcome.hits.slice(0, topK);
      } else {
        const direct = store.recallWithOutcome === undefined
          ? {
              hits: await store.recall(effectiveQuery, {
                topK: graphEnabled ? 50 : topK,
                trackAccess: false,
              }),
              retrievalMode: "hybrid" as const,
            }
          : await store.recallWithOutcome(effectiveQuery, {
              topK: graphEnabled ? 50 : topK,
              // The bundled recall process opens the active generation read-only.
              // Never ask a store to mutate access telemetry on this path.
              trackAccess: false,
            });
        degradation = direct.degradation;
        hits = !graphEnabled || store.expandGraph === undefined
          ? direct.hits.slice(0, topK)
          : await store.expandGraph(effectiveQuery, direct.hits, { topK });
      }
      // Record only the final served set. Read-only BuJo recall stores make
      // this a no-op; shared writable stores deduplicate it for the turn.
      store.recordAccess?.(hits.map((hit) => hit.record.id));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `${originalPrefix}Memory recall is temporarily unavailable: ${reason}` }],
        structuredContent: { hits: [], degraded: true, reason, ...originalMetadata },
      };
    }
    // Explicit tool ranking only. Automatic recall consumes the original backend
    // scores, including its calibrated threshold and lexical-only abstention.
    hits = rankExplicitHits(effectiveQuery, hits);
    let sections: LabelSections | undefined;
    try {
      sections = store.labelSections?.({ query: effectiveQuery,
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.about === undefined ? {} : { about: args.about }) })
        ?? readLabelSections(store, { query: effectiveQuery,
          ...(args.kind === undefined ? {} : { kind: args.kind }),
          ...(args.about === undefined ? {} : { about: args.about }) });
    } catch { /* A bad label cannot discard the normal dated hits. */ }
    const sectionPrefix = sections?.text ? `${sections.text}\n\n` : "";
    const sectionFields = sections === undefined ? {} : {
      ...(sections.factSheet === undefined ? {} : { factSheet: sections.factSheet,
        factSheetTruncated: sections.factSheetTruncated ?? false }),
      ...(sections.preferencesAndLessons === undefined ? {} : { preferencesAndLessons: sections.preferencesAndLessons,
        preferencesAndLessonsTruncated: sections.preferencesAndLessonsTruncated ?? false }),
    };
    const degraded = degradation?.code === "embedding_unavailable";
    if (hits.length === 0) {
      const guidance = "If this request is to pick up, continue, or recover interrupted work and RunHistory is available, call RunHistory with {} first. Do not keep rephrasing MemoryRecall queries for exact prior-run evidence.";
      const text = degraded
        ? `Memory recall is degraded: semantic retrieval is unavailable and lexical-only search returned no matches. ${guidance}`
        : `No memories matched "${effectiveQuery}". ${guidance}`;
      return {
        content: [{ type: "text" as const, text: `${originalPrefix}${sectionPrefix}${text}` }],
        structuredContent: {
          hits: [],
          ...sectionFields,
          ...originalMetadata,
          ...(degraded ? {
            degraded: true,
            retrievalMode: "lexical_only" as const,
            degradation: { code: "embedding_unavailable" as const },
          } : {}),
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
    const hitText = hits
      .map((hit) => `${hit.score.toFixed(3)}  ${formatHitDates(hit)}${lifecyclePrefix(hit)}${hit.record.text}`)
      .join("\n");
    const text = degraded
      ? `Memory recall is degraded: showing lexical-only matches because semantic retrieval is unavailable.\n${hitText}`
      : hitText;
    return {
      content: [{ type: "text" as const, text: `${originalPrefix}${sectionPrefix}${text}` }],
      structuredContent: {
        hits: hits.map((hit) => ({
          id: hit.record.id,
          score: hit.score,
          text: hit.record.text,
          // Optional on the hit contract: a remote backend that supplies
          // neither keeps exactly its previous result shape.
          ...(hit.record.type === undefined ? {} : { type: hit.record.type }),
          ...(hit.record.status === undefined ? {} : { status: hit.record.status }),
          ...(hit.record.createdAt === undefined ? {} : { createdAt: hit.record.createdAt }),
          ...(hit.record.validFrom === undefined ? {} : { validFrom: hit.record.validFrom }),
          ...(hit.record.validTo === undefined ? {} : { validTo: hit.record.validTo }),
        })),
        ...sectionFields,
        ...originalMetadata,
        ...(degraded ? {
          degraded: true,
          retrievalMode: "lexical_only" as const,
          degradation: { code: "embedding_unavailable" as const },
        } : {}),
      },
    };
  };

  if (supportsOriginalQuery) {
    server.registerTool(
      "MemoryRecall",
      {
        title: "Recall from memory",
        description,
        inputSchema: z.object({
          query: z.string().min(1).optional().describe("Natural-language description to recall; required unless useOriginalQuery is true."),
          useOriginalQuery: z.boolean().optional().describe("Use this logical turn's original automatic-lookup question; omit query when true."),
          limit: limitSchema,
          ...labelArgs,
        }).strict().superRefine((value, context) => {
          if (value.useOriginalQuery === true ? value.query !== undefined : value.query === undefined) {
            context.addIssue({
              code: "custom",
              message: "Supply exactly one recall mode: query, or useOriginalQuery: true.",
            });
          }
        }),
      },
      (args) => handleRecall(args as ToolArgs),
    );
  } else {
    server.registerTool(
      "MemoryRecall",
      {
        title: "Recall from memory",
        description,
        inputSchema: {
          query: z.string().min(1).describe("Natural-language description of what to recall."),
          limit: limitSchema,
          ...labelArgs,
        },
      },
      (args) => handleRecall(args as ToolArgs),
    );
  }
  return server;
}

/**
 * Concise lifecycle marker for one rendered hit.
 *
 * Recall surfaces `done`, `scheduled` and `migrated` records alongside open
 * ones, so text alone lets a completed or deferred item read as a current
 * fact — the same misrepresentation the automatic recall block avoids by
 * rendering a status-bearing bullet marker (`memory/src/bujo/recall.ts`).
 *
 * Only a non-open state is labelled. An ordinary open record renders exactly as
 * before, so the common case costs no extra tokens, and a backend that supplies
 * no status keeps its previous output byte-for-byte.
 */
function lifecyclePrefix(hit: MemoryRecallHit): string {
  const status = hit.record.status;
  return status === undefined || status === "open" ? "" : `[${status}] `;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(50, Math.max(1, Math.trunc(limit)));
}
