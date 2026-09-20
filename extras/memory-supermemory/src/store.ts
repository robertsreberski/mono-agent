import { createHash } from "node:crypto";

import type {
  MemoryBlock,
  MemoryCompletedTurn,
  MemoryCompletedTurnResult,
  MemoryStore,
} from "@mono-agent/agent-contracts";

import type { SupermemoryClient } from "./client.js";
import { formatHitsAsBlock, SUPERMEMORY_SOURCE } from "./format.js";

/** Default per-turn recall budget (bytes) — mirrors the host's DEFAULT_MEMORY_MAX_BYTES. */
const DEFAULT_MAX_BYTES = 64_000;
/** Refuse oversized remote writes instead of silently dropping part of a completed turn. */
const MAX_COMPLETED_TURN_BYTES = 1_000_000;
/** Bound same-process completion fingerprints while covering a generous retry working set. */
const DEFAULT_COMPLETED_TURN_CACHE_MAX_ENTRIES = 10_000;
/** Keep even an explicitly enlarged cache within a finite, reviewable memory bound. */
const COMPLETED_TURN_CACHE_MAX_ENTRIES_LIMIT = 1_000_000;
const RECALL_WARNING = "supermemory recall failed; continuing without remote memory.";
const COMPLETED_TURN_WARNING = "supermemory persistCompletedTurn failed; the provider response remains valid.";

export interface SupermemoryStoreOptions {
  /** Hard cap on the bytes a single `load` may return. */
  readonly maxBytes?: number;
  /** Max hits to request per recall (passed through to the client). */
  readonly recallLimit?: number;
  /**
   * Successful completed-turn fingerprints retained for same-process duplicate/conflict checks.
   * Exact duplicates refresh this bounded LRU; older entries fall back to the remote stable-id upsert.
   * This is a direct-constructor tuning seam; the standard factory deliberately uses the default.
   */
  readonly completedTurnCacheMaxEntries?: number;
  readonly logger?: { warn(message: string): void };
}

/** A recall hit shaped like the bujo store's, so the recall MCP server can format it uniformly. */
export interface SupermemoryRecallHit {
  readonly score: number;
  readonly record: { readonly id: string; readonly text: string };
}

const NOOP_LOGGER = { warn: (_message: string): void => {} };

/**
 * MemoryStore backed by an external Supermemory instance (local OSS binary or hosted cloud).
 *
 * The strong `persistCompletedTurn` path awaits one run-keyed remote upsert, coalesces exact
 * same-process retries, rejects payload conflicts retained in a bounded same-process LRU, and
 * propagates failure so the harness can report degradation without changing the provider answer.
 * Supermemory does extraction/consolidation server-side, so
 * ingestion is async and a just-admitted turn may not be immediately searchable.
 *
 * `load` degrades to `undefined` on any client error (mirroring how the harness treats empty recall),
 * so a slow/down backend yields no context rather than a failed turn.
 */
export class SupermemoryMemoryStore implements MemoryStore {
  /** Bounded LRU of successful run/payload digests; never retains raw ids or content. */
  private readonly completedTurns = new Map<string, string>();
  private readonly completedTurnInflight = new Map<string, {
    readonly payloadDigest: string;
    readonly promise: Promise<MemoryCompletedTurnResult>;
  }>();
  private readonly completedTurnCacheMaxEntries: number;
  private readonly maxBytes: number;
  private readonly recallLimit: number | undefined;
  private readonly logger: { warn(message: string): void };

  constructor(
    private readonly client: SupermemoryClient,
    options: SupermemoryStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.recallLimit = options.recallLimit;
    this.completedTurnCacheMaxEntries = normalizeCompletedTurnCacheMaxEntries(
      options.completedTurnCacheMaxEntries,
    );
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async load(conversationId: string, query?: string): Promise<MemoryBlock | undefined> {
    const q = (query ?? "").trim().length > 0 ? (query as string) : conversationId;
    try {
      const hits = await this.search(q);
      if (hits.length === 0) {
        return undefined;
      }
      return formatHitsAsBlock(hits, this.maxBytes);
    } catch {
      safeWarn(this.logger, RECALL_WARNING);
      return undefined;
    }
  }

  /**
   * Strong, awaited completed-turn admission. The remote custom id is derived
   * only from the stable run id, so a cross-process retry upserts the same
   * logical document; digests distinguish exact retry from conflict only while
   * they remain in the bounded local LRU.
   * Any failure is logged and propagated for
   * the harness to surface as memory degradation.
   */
  async persistCompletedTurn(turn: MemoryCompletedTurn): Promise<MemoryCompletedTurnResult> {
    try {
      assertCompletedTurn(turn);
      const content = completedTurnDocument(turn);
      const bytesWritten = Buffer.byteLength(content, "utf8");
      if (bytesWritten > MAX_COMPLETED_TURN_BYTES) {
        throw new Error(`completed turn exceeds the ${MAX_COMPLETED_TURN_BYTES}-byte Supermemory admission limit`);
      }
      const runIdHash = safeHash(turn.runId);
      const customId = `completed-turn-${runIdHash.slice(0, 32)}`;
      const payloadDigest = completedTurnDigest(turn);
      const completed = this.completedTurns.get(runIdHash);
      if (completed !== undefined) {
        assertMatchingCompletedTurn(completed, payloadDigest);
        this.rememberCompletedTurn(runIdHash, completed);
        return completedTurnResult(turn, customId, 0, "duplicate");
      }
      const inflight = this.completedTurnInflight.get(runIdHash);
      if (inflight !== undefined) {
        assertMatchingCompletedTurn(inflight.payloadDigest, payloadDigest);
        await inflight.promise;
        // Another run may have completed and evicted this fingerprint before this waiter resumed.
        this.rememberCompletedTurn(runIdHash, payloadDigest);
        return completedTurnResult(turn, customId, 0, "duplicate");
      }

      const result = completedTurnResult(turn, customId, bytesWritten, "admitted");
      const promise = (async (): Promise<MemoryCompletedTurnResult> => {
        await this.client.add({
          content,
          customId,
          // Keep remote indexing metadata flat and free of raw channel/run ids.
          metadata: {
            kind: "completed-turn",
            schemaVersion: 1,
            hasCapture: turn.captureText !== undefined,
          },
        });
        this.rememberCompletedTurn(runIdHash, payloadDigest);
        return result;
      })();
      this.completedTurnInflight.set(runIdHash, { payloadDigest, promise });
      try {
        return await promise;
      } finally {
        if (this.completedTurnInflight.get(runIdHash)?.promise === promise) {
          this.completedTurnInflight.delete(runIdHash);
        }
      }
    } catch (error) {
      safeWarn(this.logger, COMPLETED_TURN_WARNING);
      throw error;
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.completedTurnInflight.values()].map(({ promise }) => promise));
  }

  /** Await in-flight admissions (HTTP client owns no handle to close). */
  async close(): Promise<void> {
    await this.flush();
  }

  /**
   * Recall hits shaped for the in-app `MemoryRecall` MCP tool (Stage 3 reuses the bujo formatter).
   * Unlike `load`, this propagates client errors so the recall tool can report a search failure.
   */
  async recall(query: string, options?: { readonly topK?: number }): Promise<SupermemoryRecallHit[]> {
    const hits = await this.search(query, options?.topK);
    return hits.map((hit) => ({ score: hit.score, record: { id: hit.id, text: hit.text } }));
  }

  private async search(query: string, topK?: number) {
    const limit = topK ?? this.recallLimit;
    return this.client.search({ query, ...(limit === undefined ? {} : { limit }) });
  }

  private rememberCompletedTurn(runIdHash: string, payloadDigest: string): void {
    // Map iteration is insertion ordered. Reinsert exact retries so the first key is always the LRU.
    this.completedTurns.delete(runIdHash);
    this.completedTurns.set(runIdHash, payloadDigest);
    if (this.completedTurns.size > this.completedTurnCacheMaxEntries) {
      const oldestRunIdHash = this.completedTurns.keys().next().value;
      if (oldestRunIdHash !== undefined) {
        this.completedTurns.delete(oldestRunIdHash);
      }
    }
  }
}

function safeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function completedTurnDigest(turn: MemoryCompletedTurn): string {
  return createHash("sha256").update(JSON.stringify({
    conversationId: turn.conversationId,
    summary: turn.summary,
    ...(turn.captureText === undefined ? {} : { captureText: turn.captureText }),
  })).digest("hex");
}

function assertMatchingCompletedTurn(existing: string, incoming: string): void {
  if (existing !== incoming) {
    throw new Error("supermemory: completed-turn run id conflicts with an already admitted payload");
  }
}

function normalizeCompletedTurnCacheMaxEntries(value: number | undefined): number {
  const maxEntries = value ?? DEFAULT_COMPLETED_TURN_CACHE_MAX_ENTRIES;
  if (
    !Number.isSafeInteger(maxEntries)
    || maxEntries < 1
    || maxEntries > COMPLETED_TURN_CACHE_MAX_ENTRIES_LIMIT
  ) {
    throw new RangeError(
      `completedTurnCacheMaxEntries must be an integer from 1 to ${COMPLETED_TURN_CACHE_MAX_ENTRIES_LIMIT}`,
    );
  }
  return maxEntries;
}

function completedTurnResult(
  turn: MemoryCompletedTurn,
  id: string,
  bytesWritten: number,
  admissionStatus: MemoryCompletedTurnResult["admissionStatus"],
): MemoryCompletedTurnResult {
  return {
    id,
    runId: turn.runId,
    conversationId: turn.conversationId,
    source: SUPERMEMORY_SOURCE,
    bytesWritten,
    // The documents endpoint exposes a successful upsert but cannot identify
    // create versus cross-process retry; local exact retries use "duplicate".
    admissionStatus,
  };
}

function completedTurnDocument(turn: MemoryCompletedTurn): string {
  return [
    "Completed turn summary:",
    turn.summary,
    ...(turn.captureText === undefined
      ? []
      : ["", "Completed turn capture:", turn.captureText]),
  ].join("\n");
}

function assertCompletedTurn(turn: MemoryCompletedTurn): void {
  for (const [field, value] of [
    ["runId", turn.runId],
    ["conversationId", turn.conversationId],
    ["summary", turn.summary],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`completed turn ${field} must be a non-empty string`);
    }
  }
  if (turn.captureText !== undefined && typeof turn.captureText !== "string") {
    throw new TypeError("completed turn captureText must be a string when provided");
  }
}

function safeWarn(logger: { warn(message: string): void }, message: string): void {
  try { logger.warn(message); } catch { /* Diagnostics cannot replace the backend result. */ }
}
