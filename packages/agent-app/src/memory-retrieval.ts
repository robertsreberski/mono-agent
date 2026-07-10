import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { MemoryBlock, MemoryLoadOptions, MemoryStore, MemoryWriteResult } from "@mono-agent/agent-contracts";

import {
  createMemoryRecallServer,
  MEMORY_RECALL_MCP_SERVER_NAME,
  type MemoryRecallRuntimeExtension,
  type RecallCapableStore,
} from "./memory-recall.js";

const AUTO_RECALL_MAX_BYTES = 8_000;
const AUTO_RECALL_MAX_HITS = 5;
const AUTO_RECALL_MIN_SCORE = 0.6;
const MAX_BACKEND_HITS = 50;

export interface SharedRecallStore extends MemoryStore, RecallCapableStore {
  /** Optional local-store telemetry hook; it must not alter relevance. */
  recordAccess?(ids: readonly string[]): void;
}

export interface MemoryRetrievalServiceOptions {
  readonly maxBytes?: number;
  readonly source?: string;
}

interface TurnCache {
  readonly queries: Map<string, Promise<readonly SharedRecallHit[]>>;
  readonly accessedIds: Set<string>;
}

interface SharedRecallHit {
  readonly score: number;
  readonly record: {
    readonly id: string;
    readonly text: string;
  };
}

/**
 * One app-owned read path for automatic context and MemoryRecall.
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

  constructor(
    private readonly store: SharedRecallStore,
    options: MemoryRetrievalServiceOptions = {},
  ) {
    this.maxBytes = Math.min(options.maxBytes ?? AUTO_RECALL_MAX_BYTES, AUTO_RECALL_MAX_BYTES);
    this.source = options.source ?? "memory";
  }

  async load(
    conversationId: string,
    query?: string,
    options: MemoryLoadOptions = {},
  ): Promise<MemoryBlock | undefined> {
    const recallQuery = normalizeQuery(query ?? conversationId);
    if (recallQuery.length === 0) return undefined;
    const ephemeral = options.turnId === undefined;
    const turnId = options.turnId ?? `uncached:${randomUUID()}`;
    try {
      const hits = (await this.recallForTurn(turnId, recallQuery, {
        topK: MAX_BACKEND_HITS,
        trackAccess: false,
      }))
        .filter((hit) => hit.score >= AUTO_RECALL_MIN_SCORE)
        .slice(0, AUTO_RECALL_MAX_HITS);
      if (hits.length === 0) return undefined;
      this.recordServed(turnId, hits);
      return formatRecallBlock(hits, this.source, this.maxBytes);
    } finally {
      if (ephemeral) this.releaseTurn(turnId);
    }
  }

  async recallForTurn(
    turnId: string,
    query: string,
    options: { readonly topK?: number; readonly trackAccess?: boolean } = {},
  ): Promise<readonly SharedRecallHit[]> {
    const normalized = normalizeQuery(query);
    if (normalized.length === 0) return [];
    const turn = this.turnCache(turnId);
    let lookup = turn.queries.get(normalized);
    if (lookup === undefined) {
      lookup = Promise.resolve(
        this.store.recall(normalized, { topK: MAX_BACKEND_HITS, trackAccess: false }),
      ) as Promise<readonly SharedRecallHit[]>;
      turn.queries.set(normalized, lookup);
    }
    const limit = clampLimit(options.topK, 8);
    const hits = (await lookup).slice(0, limit);
    if (options.trackAccess !== false) this.recordServed(turnId, hits);
    return hits;
  }

  releaseTurn(turnId: string): void {
    this.turns.delete(turnId);
  }

  releaseAllTurns(): void {
    this.turns.clear();
  }

  appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
    return this.store.appendHostSummary(conversationId, summary);
  }

  scheduleCapture(conversationId: string, text: string): void {
    this.store.scheduleCapture?.(conversationId, text);
  }

  async flush(): Promise<void> {
    await this.store.flush?.();
  }

  private turnCache(turnId: string): TurnCache {
    let cache = this.turns.get(turnId);
    if (cache !== undefined) return cache;
    cache = { queries: new Map(), accessedIds: new Set() };
    this.turns.set(turnId, cache);
    return cache;
  }

  private recordServed(turnId: string, hits: readonly SharedRecallHit[]): void {
    if (this.store.recordAccess === undefined) return;
    const turn = this.turnCache(turnId);
    const fresh: string[] = [];
    for (const hit of hits) {
      if (!turn.accessedIds.has(hit.record.id)) {
        turn.accessedIds.add(hit.record.id);
        fresh.push(hit.record.id);
      }
    }
    if (fresh.length > 0) this.store.recordAccess(fresh);
  }
}

/** Create a per-turn loopback MCP endpoint over the shared in-process service. */
export function createSharedMemoryRecallRuntimeExtension(
  service: MemoryRetrievalService,
): (input: { readonly runId: string }) => Promise<MemoryRecallRuntimeExtension> {
  return async ({ runId }) => {
    const path = `/mcp/${randomUUID()}`;
    const boundStore: RecallCapableStore = {
      recall: (query, options) => service.recallForTurn(runId, query, options),
      close: async () => {},
    };
    const mcp = createMemoryRecallServer(boundStore);
    let transport: WebStandardStreamableHTTPServerTransport | undefined;
    const http = createServer((request, response) => {
      if (request.url !== path || !isLoopbackHost(request.headers.host)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (transport === undefined) {
        response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        response.end("Memory recall is starting");
        return;
      }
      void (async () => {
        const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
        const webRequest = nodeRequestAsWebRequest(request);
        const webResponse = await transport?.handleRequest(webRequest, { parsedBody });
        if (webResponse === undefined) throw new Error("MemoryRecall MCP transport is unavailable.");
        await writeWebResponse(response, webResponse);
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await listenLoopback(http);
    const address = http.address() as AddressInfo;
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      allowedHosts: [`127.0.0.1:${address.port}`],
      enableDnsRebindingProtection: true,
    });
    try {
      // The SDK's Node transport declaration is not exact-optional compatible
      // with its own base Transport under this repo's compiler settings.
      await mcp.connect(transport as never);
    } catch (error) {
      await closeHttpServer(http);
      throw error;
    }
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
        await mcp.close().catch(() => undefined);
        await closeHttpServer(http);
      },
    };
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
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US").slice(0, 4_000);
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_BACKEND_HITS, Math.max(1, Math.trunc(limit)));
}

function formatRecallBlock(
  hits: readonly SharedRecallHit[],
  source: string,
  maxBytes: number,
): MemoryBlock {
  const full = ["## Memory (recalled)", "", ...hits.map((hit) => `- ${hit.record.text}`)].join("\n");
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return { kind: "markdown", content: full, source, truncated: false };
  }
  const bytes = Buffer.from(full, "utf8").subarray(0, maxBytes);
  const content = new TextDecoder("utf-8").decode(bytes).replace(/�+$/u, "");
  return { kind: "markdown", content, source, truncated: true };
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
