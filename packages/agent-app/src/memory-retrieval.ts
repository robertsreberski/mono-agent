import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  MemoryBlock,
  MemoryCompletedTurn,
  MemoryCompletedTurnResult,
  MemoryLoadOptions,
  MemoryStore,
} from "@mono-agent/agent-contracts";
import {
  AUTO_RECALL_BACKEND_HITS,
  AUTO_RECALL_MAX_BYTES,
  isConversationRelativeQuery,
  MARKER_FOR,
  selectAutomaticRecallHits,
  type JournalBrowseInput,
  type JournalBrowseSnapshot,
} from "@mono-agent/memory/bujo";

import { formatMemoryBackground, type LabelRecallStore } from "./memory-guidance.js";
import {
  createMemoryRecallServer,
  MEMORY_RECALL_MCP_SERVER_NAME,
  type MemoryRecallOutcome,
  type MemoryRecallRuntimeExtension,
  type RecallCapableStore,
} from "./memory-recall.js";

export interface SharedRecallStore extends MemoryStore, RecallCapableStore, LabelRecallStore {
  /** Local-tier chronology. External recall backends intentionally omit it. */
  tier?(): "lite" | "journal" | "bujo";
  browseJournal?(input: JournalBrowseInput): Promise<JournalBrowseSnapshot>;
  /** Affirmative capability signal; a method alone is insufficient. */
  supportsJournalBrowse?(): boolean;
  /** Optional local-store telemetry hook; it must not alter relevance. */
  recordAccess?(ids: readonly string[]): void;
  /**
   * Deterministic durable write for an explicitly remembered fact. Present only
   * on the bujo backend; external backends implement the shared MemoryStore
   * contract without one, so they never advertise the capability below.
   */
  remember?(
    conversationId: string,
    text: string,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<{
    readonly id: string;
    readonly source: string;
    readonly text: string;
    readonly duplicate: boolean;
  }>;
  /** Affirmative capability signal; false on a read-only store. */
  supportsRemember?(): boolean;
}

export interface MemoryRetrievalServiceOptions {
  readonly maxBytes?: number;
  readonly source?: string;
}

export interface SharedMemoryRecallRuntimeExtensionOptions {
  /** Best-effort diagnostic when the loopback tool endpoint cannot start. */
  readonly onUnavailable?: (error: unknown) => void;
  /** Test seam for simulating endpoint startup failures. */
  readonly listen?: (server: Server) => Promise<void>;
}

type OriginalRecallUnavailableReason =
  | "empty"
  | "conversation_relative"
  | "lookup_failed";

type OriginalRecallSelection =
  | {
      readonly available: true;
      readonly query: string;
      readonly outcome: Promise<MemoryRecallOutcome>;
    }
  | {
      readonly available: false;
      readonly reason: OriginalRecallUnavailableReason;
    };

interface TurnCache {
  readonly queries: Map<string, Promise<MemoryRecallOutcome>>;
  readonly expansions: Map<string, Promise<MemoryRecallOutcome>>;
  readonly accessedIds: Set<string>;
  original?: OriginalRecallSelection;
}

interface SharedRecallHit {
  readonly score: number;
  readonly record: {
    readonly id: string;
    readonly text: string;
    readonly type?: "task" | "event" | "note";
    readonly status?: "open" | "done" | "scheduled" | "migrated" | "dropped" | "invalidated";
    readonly isInsight?: boolean;
    readonly createdAt?: string;
    readonly validFrom?: string;
    readonly validTo?: string;
  };
}

/**
 * One configured-harness read path for automatic context and MemoryRecall.
 *
 * Each normalized query in a turn asks the configured backend for a bounded
 * superset once. Automatic recall and the MCP tool then slice that same promise,
 * so an identical query performs at most one embedding/search operation. The
 * cache is explicitly released by the harness after the whole logical turn.
 */
export class MemoryRetrievalService implements MemoryStore {
  private readonly maxBytes: number;
  private readonly source: string;
  private readonly turns = new Map<string, TurnCache>();
  readonly persistCompletedTurn?: (turn: MemoryCompletedTurn) => Promise<MemoryCompletedTurnResult>;

  constructor(
    private readonly store: SharedRecallStore,
    options: MemoryRetrievalServiceOptions = {},
  ) {
    this.maxBytes = Math.max(1, Math.min(options.maxBytes ?? AUTO_RECALL_MAX_BYTES, AUTO_RECALL_MAX_BYTES));
    this.source = options.source ?? "memory";
    const persistCompletedTurn = store.persistCompletedTurn;
    if (persistCompletedTurn !== undefined) {
      // Preserve capability detection: stores without the strong method leave
      // this property absent so the harness takes its legacy fallback.
      this.persistCompletedTurn = (turn) => persistCompletedTurn.call(store, turn);
    }
  }

  async load(
    conversationId: string,
    query?: string,
    options: MemoryLoadOptions = {},
  ): Promise<MemoryBlock | undefined> {
    const evidenceQuery = normalizeEvidenceQuery(query ?? conversationId);
    const originalQuestion = query === undefined ? "" : normalizeEvidenceQuery(query);
    const ephemeral = options.turnId === undefined;
    const turnId = options.turnId ?? `uncached:${randomUUID()}`;
    if (evidenceQuery.length === 0) {
      if (!ephemeral) this.setOriginalUnavailable(turnId, "empty");
      return undefined;
    }
    // Current/last-message questions belong to the active channel transcript.
    // Clear any earlier selection for a repeated context load and abstain before
    // paying for embeddings/search; durable memory must not displace history.
    if (isConversationRelativeQuery(evidenceQuery)) {
      if (!ephemeral) this.setOriginalUnavailable(turnId, "conversation_relative");
      return undefined;
    }
    try {
      let outcome: MemoryRecallOutcome;
      if (ephemeral || originalQuestion.length === 0) {
        if (!ephemeral) this.setOriginalUnavailable(turnId, "empty");
        outcome = await this.recallOutcomeForTurn(turnId, evidenceQuery, {
          topK: AUTO_RECALL_BACKEND_HITS,
          trackAccess: false,
        });
      } else {
        const turn = this.turnCache(turnId);
        const selection: OriginalRecallSelection = {
          available: true,
          query: originalQuestion,
          outcome: this.recallOutcomeInTurn(turn, evidenceQuery, {
            topK: AUTO_RECALL_BACKEND_HITS,
          }),
        };
        // The latest load owns the selection. Explicit tool calls never replace it.
        turn.original = selection;
        try {
          outcome = await selection.outcome;
        } catch (error) {
          if (this.turns.get(turnId) === turn && turn.original === selection) {
            turn.original = { available: false, reason: "lookup_failed" };
          }
          throw error;
        }
      }
      const hits = selectAutomaticRecallHits(outcome.hits, { query: evidenceQuery });
      const background = formatMemoryBackground(this.store, evidenceQuery, conversationId, options, outcome.hits);
      if (hits.length === 0 && background === undefined) {
        if (outcome.degradation?.code === "embedding_unavailable") {
          throw new Error("Semantic memory retrieval is unavailable; lexical-only recall found no eligible automatic evidence.");
        }
        return undefined;
      }
      const block = hits.length > 0 ? formatRecallBlock(hits, this.source, this.maxBytes, outcome.degradation) : undefined;
      if (hits.length > 0) this.recordServed(turnId, hits);
      return { kind: "markdown", source: this.source,
        content: [block?.content, background].filter((text) => text !== undefined).join("\n\n"),
        truncated: block?.truncated ?? false };
    } finally {
      if (ephemeral) this.releaseTurn(turnId);
    }
  }

  async recallForTurn(
    turnId: string,
    query: string,
    options: { readonly topK?: number; readonly trackAccess?: boolean; readonly expandHops?: 0 | 1 } = {},
  ): Promise<readonly SharedRecallHit[]> {
    const outcome = await this.recallOutcomeForTurn(turnId, query, {
      ...options,
      // The statusless compatibility surface must decide whether it can serve
      // before recording telemetry. Degraded hits are available only through
      // recallOutcomeForTurn(), whose caller can preserve their status.
      trackAccess: false,
    });
    if (outcome.degradation !== undefined) {
      throw new Error("Memory recall is degraded; use status-bearing recall to inspect lexical-only results.");
    }
    if (options.trackAccess !== false) this.recordServed(turnId, outcome.hits);
    return outcome.hits;
  }

  async recallOutcomeForTurn(
    turnId: string,
    query: string,
    options: { readonly topK?: number; readonly trackAccess?: boolean; readonly expandHops?: 0 | 1 } = {},
  ): Promise<MemoryRecallOutcome> {
    const turn = this.turnCache(turnId);
    const outcome = await this.recallOutcomeInTurn(turn, query, options);
    if (options.trackAccess !== false) this.recordServed(turnId, outcome.hits);
    return outcome;
  }

  async recallOriginalOutcomeForTurn(
    turnId: string,
    options: { readonly topK?: number; readonly expandHops?: 0 | 1 } = {},
  ): Promise<
    | { readonly available: true; readonly query: string; readonly outcome: MemoryRecallOutcome }
    | { readonly available: false; readonly reason: "not_loaded" | OriginalRecallUnavailableReason | "replaced" }
  > {
    const turn = this.turns.get(turnId);
    const selection = turn?.original;
    if (turn === undefined || selection === undefined) {
      return { available: false, reason: "not_loaded" };
    }
    if (!selection.available) return selection;
    try {
      // Re-enter the same turn cache so graph-capable explicit recall can apply
      // its existing one-hop policy without repeating the backend lookup.
      const outcome = await this.recallOutcomeInTurn(turn, selection.query, options);
      if (this.turns.get(turnId) !== turn) {
        return { available: false, reason: "not_loaded" };
      }
      if (turn.original !== selection) {
        return { available: false, reason: "replaced" };
      }
      return { available: true, query: selection.query, outcome };
    } catch (error) {
      if (this.turns.get(turnId) === turn && turn.original === selection) {
        turn.original = { available: false, reason: "lookup_failed" };
      }
      throw error;
    }
  }

  releaseTurn(turnId: string): void {
    this.turns.delete(turnId);
  }

  releaseAllTurns(): void {
    this.turns.clear();
  }

  supportsGraphExpansion(): boolean {
    return this.store.expandGraph !== undefined && this.store.supportsGraphExpansion?.() !== false;
  }

  supportsJournalBrowse(): boolean {
    if (
      typeof this.store.tier !== "function"
      || typeof this.store.browseJournal !== "function"
      || this.store.supportsJournalBrowse?.() !== true
    ) return false;
    const tier = this.store.tier();
    return tier === "lite" || tier === "journal" || tier === "bujo";
  }

  tier(): "lite" | "journal" | "bujo" {
    if (!this.supportsJournalBrowse() || this.store.tier === undefined) {
      throw new Error("memory: the configured store has no chronological journal surface.");
    }
    return this.store.tier();
  }

  async browseJournal(input: JournalBrowseInput): Promise<JournalBrowseSnapshot> {
    if (!this.supportsJournalBrowse() || this.store.browseJournal === undefined) {
      throw new Error("memory: the configured store has no chronological journal surface.");
    }
    return await this.store.browseJournal(input);
  }

  recordAccessIdsForTurn(turnId: string, ids: readonly string[]): void {
    if (this.store.recordAccess === undefined) return;
    // A late tool request must not recreate a cache after endpoint/turn cleanup.
    const turn = this.turns.get(turnId);
    if (turn === undefined) return;
    const fresh = ids.filter((id) => {
      if (turn.accessedIds.has(id)) return false;
      turn.accessedIds.add(id);
      return true;
    });
    if (fresh.length > 0) this.store.recordAccess(fresh);
  }

  supportsRemember(): boolean {
    // Both halves, not just the signal: advertising a write surface whose
    // method is absent would fail every call instead of never appearing.
    return typeof this.store.remember === "function" && this.store.supportsRemember?.() === true;
  }

  async remember(
    conversationId: string,
    text: string,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<{
    readonly id: string;
    readonly source: string;
    readonly text: string;
    readonly duplicate: boolean;
  }> {
    const remember = this.store.remember;
    if (remember === undefined) {
      throw new Error("memory: the configured store has no durable remember surface.");
    }
    const result = await remember.call(this.store, conversationId, text, options);
    // Recall memoizes per turn, so a query answered BEFORE this write would keep
    // returning its stale empty result for the rest of the run — contradicting
    // the immediate-recall guarantee the tool reports. Drop the caches rather
    // than try to predict which queries this fact should now match.
    //
    // An already-stored fact changed nothing durable, so leave the caches
    // alone: clearing them there would make concurrent turns repeat identical
    // backend searches and re-record access telemetry.
    if (!result.duplicate) this.releaseAllTurns();
    return result;
  }

  async flush(): Promise<void> {
    await this.store.flush?.();
  }

  private async recallOutcomeInTurn(
    turn: TurnCache,
    query: string,
    options: { readonly topK?: number; readonly expandHops?: 0 | 1 } = {},
  ): Promise<MemoryRecallOutcome> {
    const evidenceQuery = normalizeEvidenceQuery(query);
    const backendQuery = normalizeQuery(evidenceQuery);
    if (backendQuery.length === 0) return { hits: [], retrievalMode: "lexical_only" };
    // Raw backend lookup remains normalized/shared, while graph expansion has
    // its own evidence-preserving key below. Capitalization is a precision
    // signal for query-local entity references and must reach graph policy.
    let lookup = turn.queries.get(backendQuery);
    if (lookup === undefined) {
      lookup = this.store.recallWithOutcome === undefined
        ? Promise.resolve(
            this.store.recall(backendQuery, { topK: AUTO_RECALL_BACKEND_HITS, trackAccess: false }),
          ).then((hits) => ({ hits, retrievalMode: "hybrid" as const }))
        : Promise.resolve(
            this.store.recallWithOutcome(backendQuery, {
              topK: AUTO_RECALL_BACKEND_HITS,
              trackAccess: false,
            }),
          );
      turn.queries.set(backendQuery, lookup);
    }
    const limit = clampLimit(options.topK, 8);
    const direct = await lookup;
    if (options.expandHops === 1 && this.supportsGraphExpansion() && this.store.expandGraph !== undefined) {
      const expansionKey = `${evidenceQuery}\0${limit}`;
      let expanded = turn.expansions.get(expansionKey);
      if (expanded === undefined) {
        expanded = Promise.resolve(this.store.expandGraph(evidenceQuery, direct.hits, { topK: limit }))
          .then((hits) => ({
            hits,
            retrievalMode: direct.retrievalMode,
            ...(direct.degradation === undefined ? {} : { degradation: direct.degradation }),
          }));
        turn.expansions.set(expansionKey, expanded);
      }
      return await expanded;
    }
    return {
      hits: direct.hits.slice(0, limit),
      retrievalMode: direct.retrievalMode,
      ...(direct.degradation === undefined ? {} : { degradation: direct.degradation }),
    };
  }

  private setOriginalUnavailable(turnId: string, reason: OriginalRecallUnavailableReason): void {
    this.turnCache(turnId).original = { available: false, reason };
  }

  private turnCache(turnId: string): TurnCache {
    let cache = this.turns.get(turnId);
    if (cache !== undefined) return cache;
    cache = { queries: new Map(), expansions: new Map(), accessedIds: new Set() };
    this.turns.set(turnId, cache);
    return cache;
  }

  private recordServed(turnId: string, hits: readonly SharedRecallHit[]): void {
    this.recordAccessIdsForTurn(turnId, hits.map((hit) => hit.record.id));
  }
}

/** Create a per-turn loopback MCP endpoint over the shared in-process service. */
export function createSharedMemoryRecallRuntimeExtension(
  service: MemoryRetrievalService,
  options: SharedMemoryRecallRuntimeExtensionOptions = {},
): (input: { readonly runId: string }) => Promise<MemoryRecallRuntimeExtension> {
  return async ({ runId }) => {
    const path = `/mcp/${randomUUID()}`;
    const graphEnabled = service.supportsGraphExpansion();
    const boundStore: RecallCapableStore = {
      recall: (query, options) => service.recallForTurn(runId, query, options),
      recallWithOutcome: (query, options) => service.recallOutcomeForTurn(runId, query, options),
      recallOriginalWithOutcome: (originalOptions) => service.recallOriginalOutcomeForTurn(runId, {
        ...(originalOptions?.topK === undefined ? {} : { topK: originalOptions.topK }),
        expandHops: graphEnabled ? 1 : 0,
      }),
      ...(graphEnabled ? {
        supportsGraphExpansion: () => true,
        expandGraph: async (query: string, _directHits: readonly SharedRecallHit[], graphOptions?: { readonly topK?: number }) => (
          await service.recallOutcomeForTurn(runId, query, {
            ...(graphOptions?.topK === undefined ? {} : { topK: graphOptions.topK }),
            trackAccess: false,
            expandHops: 1,
          })
        ).hits,
      } : {}),
      // Non-graph stores need the same served-only accounting. The service
      // deduplicates IDs across automatic and deliberate delivery in this turn.
      recordAccess: (ids: readonly string[]) => service.recordAccessIdsForTurn(runId, ids),
      close: async () => {},
    };
    let port: number | undefined;
    const http = createServer((request, response) => {
      if (request.url !== path || !isLoopbackHost(request.headers.host)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (port === undefined) {
        response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        response.end("Memory recall is starting");
        return;
      }
      const boundPort = port;
      void (async () => {
        const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
        const webRequest = nodeRequestAsWebRequest(request);
        // Stateless server+transport minted per request: the runtime opens a
        // fresh MCP client (with a new `initialize`) against this same per-run
        // endpoint on every model-failover attempt, and a long-lived
        // session-stateful transport rejects that second initialize ("Server
        // already initialized"), silently dropping the tool for the answering
        // attempt. The SDK's stateless mode requires a fresh transport per
        // request, so both are per-request; the bound store stays shared.
        const requestMcp = createMemoryRecallServer(boundStore);
        // No sessionIdGenerator: stateless mode (exact-optional forbids an
        // explicit undefined).
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          allowedHosts: [`127.0.0.1:${boundPort}`],
          enableDnsRebindingProtection: true,
        });
        try {
          // The SDK's Node transport declaration is not exact-optional compatible
          // with its own base Transport under this repo's compiler settings.
          await requestMcp.connect(transport as never);
          const webResponse = await transport.handleRequest(webRequest, { parsedBody });
          if (webResponse === undefined) throw new Error("MemoryRecall MCP transport is unavailable.");
          await writeWebResponse(response, webResponse);
        } finally {
          await requestMcp.close().catch(() => undefined);
        }
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    try {
      await (options.listen ?? listenLoopback)(http);
      const address = http.address() as AddressInfo;
      port = address.port;
      let closed = false;
      return {
        runtimeOptions: {
          mcpServers: {
            [MEMORY_RECALL_MCP_SERVER_NAME]: {
              type: "http",
              url: `http://127.0.0.1:${address.port}${path}`,
            },
          },
        },
        cleanup: async () => {
          if (closed) return;
          closed = true;
          try {
            await closeHttpServer(http);
          } finally {
            // An abort-ignoring provider may keep the outer logical turn alive
            // after this endpoint releases its concurrency permit. No tool can
            // use the cache once the endpoint is closed, so release it here as
            // well as in the harness's eventual outer finally.
            service.releaseTurn(runId);
          }
        },
      };
    } catch (error) {
      await closeHttpServer(http);
      service.releaseTurn(runId);
      try {
        options.onUnavailable?.(error);
      } catch {
        // Diagnostics are best-effort; a logger failure cannot fail the turn.
      }
      // Automatic recall already ran through MemoryRetrievalService.load(). A
      // loopback startup failure therefore omits only the explicit tool and
      // must not prevent the provider turn from proceeding.
      return { runtimeOptions: { mcpServers: {} }, cleanup: async () => { service.releaseTurn(runId); } };
    }
  };
}

export function isSharedRecallStore(store: MemoryStore | undefined): store is SharedRecallStore {
  const value = store as Partial<SharedRecallStore> | undefined;
  return value !== undefined && typeof value.recall === "function" && typeof value.close === "function";
}

export function normalizeMemoryRecallQuery(query: string): string {
  return normalizeQuery(query);
}

function normalizeQuery(query: string): string {
  return normalizeEvidenceQuery(query).toLocaleLowerCase("en-US");
}

function normalizeEvidenceQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").slice(0, 4_000);
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(AUTO_RECALL_BACKEND_HITS, Math.max(1, Math.trunc(limit)));
}

function formatRecallBlock(
  hits: readonly SharedRecallHit[],
  source: string,
  maxBytes: number,
  degradation?: MemoryRecallOutcome["degradation"],
): MemoryBlock {
  const degradedHeading = "## Memory (recalled; lexical-only — semantic retrieval unavailable)";
  const compactDegradedHeading = "## Memory degraded: lexical-only";
  let heading = "## Memory (recalled)";
  if (degradation?.code === "embedding_unavailable") {
    const firstEvidence = `- ${formatRecallRecord(hits[0]!.record)}`;
    heading = [degradedHeading, compactDegradedHeading].find((candidate) => (
      Buffer.byteLength(`${candidate}\n\n${firstEvidence}`, "utf8") <= maxBytes
    )) ?? "";
    if (heading.length === 0) {
      throw new Error("Semantic memory retrieval is unavailable; the memory byte budget cannot include lexical-only evidence.");
    }
  }
  const full = [heading, "", ...hits.map((hit) => `- ${formatRecallRecord(hit.record)}`)].join("\n");
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return { kind: "markdown", content: full, source, truncated: false };
  }
  const bytes = Buffer.from(full, "utf8").subarray(0, maxBytes);
  const content = new TextDecoder("utf-8").decode(bytes).replace(/�+$/u, "");
  return { kind: "markdown", content, source, truncated: true };
}

function formatRecallRecord(record: SharedRecallHit["record"]): string {
  if (record.type === undefined || record.status === undefined) return record.text;
  return `${MARKER_FOR(record.type, record.status)} ${record.text}${record.isInsight === true ? " *" : ""}`;
}

function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && /^127\.0\.0\.1:\d+$/u.test(host);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_000_000) throw new Error("MemoryRecall MCP request exceeds 1 MB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function nodeRequestAsWebRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return new Request(`http://${String(request.headers.host)}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers,
  });
}

async function writeWebResponse(response: import("node:http").ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(webResponse.status, headers);
  if (webResponse.body === null) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
