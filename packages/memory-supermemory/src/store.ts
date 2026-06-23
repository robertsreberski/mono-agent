import { createHash } from "node:crypto";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-store";

import type { SupermemoryClient } from "./client.js";
import { formatHitsAsBlock, SUPERMEMORY_SOURCE } from "./format.js";

/** Default per-turn recall budget (bytes) — mirrors the host's DEFAULT_MEMORY_MAX_BYTES. */
const DEFAULT_MAX_BYTES = 64_000;

export interface SupermemoryStoreOptions {
  /** Hard cap on the bytes a single `load` may return. */
  readonly maxBytes?: number;
  /** Max hits to request per recall (passed through to the client). */
  readonly recallLimit?: number;
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
 * Writes are best-effort and NEVER throw — a memory failure must not break a reply. `appendHostSummary`
 * is a bounded await that returns `bytesWritten: 0` on failure; `scheduleCapture` is fire-and-forget,
 * serialized through a single chain (like the bujo store) so captures can't overlap or reject the
 * chain. Supermemory does extraction/consolidation server-side, so capture just posts the raw turn —
 * note that ingestion is async, so a just-captured turn is not immediately searchable.
 *
 * `load` degrades to `undefined` on any client error (mirroring how the harness treats empty recall),
 * so a slow/down backend yields no context rather than a failed turn.
 */
export class SupermemoryMemoryStore implements MemoryStore {
  private captureChain: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly recallLimit: number | undefined;
  private readonly logger: { warn(message: string): void };

  constructor(
    private readonly client: SupermemoryClient,
    options: SupermemoryStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.recallLimit = options.recallLimit;
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
    } catch (error) {
      this.logger.warn(`supermemory recall failed: ${message(error)}`);
      return undefined;
    }
  }

  async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
    const bytes = Buffer.byteLength(summary, "utf8");
    try {
      await this.client.add({
        content: summary,
        // Idempotent: re-emitting the same one-liner upserts instead of duplicating.
        customId: `host-summary:${stableId(`${conversationId}\n${summary}`)}`,
        metadata: { kind: "host-summary", conversationId },
      });
      return { conversationId, source: SUPERMEMORY_SOURCE, bytesWritten: bytes };
    } catch (error) {
      this.logger.warn(`supermemory appendHostSummary failed: ${message(error)}`);
      return { conversationId, source: SUPERMEMORY_SOURCE, bytesWritten: 0 };
    }
  }

  scheduleCapture(conversationId: string, text: string): void {
    this.captureChain = this.captureChain
      .then(async () => {
        try {
          await this.client.add({ content: text, metadata: { kind: "turn-capture", conversationId } });
        } catch (error) {
          this.logger.warn(`supermemory capture failed: ${message(error)}`);
        }
      })
      // Terminal guard: the chain must never settle rejected, or every future capture would be skipped.
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.captureChain;
  }

  /** Drain queued captures (HTTP client owns no handle to close). */
  async close(): Promise<void> {
    await this.flush();
  }

  /**
   * Recall hits shaped for the in-app `memory_recall` MCP tool (Stage 3 reuses the bujo formatter).
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
}

function stableId(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 24);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
