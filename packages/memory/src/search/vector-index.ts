import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MemorySearchError } from "./embeddings.js";
import type { EmbeddingProvider, MemoryChunk, SearchHit, VectorMemoryIndexOptions } from "./types.js";

const DEFAULT_DOCUMENT_PREFIX = "search_document: ";
const DEFAULT_QUERY_PREFIX = "search_query: ";
const DEFAULT_BATCH_SIZE = 32;

interface IndexRecord {
  readonly id: string;
  readonly source: string;
  readonly day?: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly norm: number;
}

/**
 * A dependency-free embedded vector store: embeddings persisted as JSON Lines,
 * searched by brute-force cosine similarity. Fast and simple well under ~50k
 * chunks, which is ample for a single agent's memory; no external vector DB.
 */
export class VectorMemoryIndex {
  private readonly path: string;
  private readonly embeddings: EmbeddingProvider;
  private readonly documentPrefix: string;
  private readonly queryPrefix: string;
  private readonly batchSize: number;
  private records: IndexRecord[] = [];
  private loaded = false;

  constructor(options: VectorMemoryIndexOptions) {
    if (typeof options.path !== "string" || options.path.trim().length === 0) {
      throw new MemorySearchError("invalid_index_options", "Index path must be a non-empty string.");
    }
    this.path = resolve(options.path);
    this.embeddings = options.embeddings;
    this.documentPrefix = options.documentPrefix ?? DEFAULT_DOCUMENT_PREFIX;
    this.queryPrefix = options.queryPrefix ?? DEFAULT_QUERY_PREFIX;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** Replaces the entire index from the supplied chunks (used by consolidation). */
  async rebuild(chunks: readonly MemoryChunk[]): Promise<{ readonly indexed: number }> {
    const deduped = dedupeById(chunks);
    const vectors = await this.embedAll(deduped.map((chunk) => `${this.documentPrefix}${chunk.text}`));
    this.records = deduped.map((chunk, index) => toRecord(chunk, vectors[index] ?? []));
    this.loaded = true;
    await this.persist();
    return { indexed: this.records.length };
  }

  /** Semantic search by cosine similarity. Throws if embeddings are unavailable. */
  async search(query: string, limit = 8, minScore = 0): Promise<readonly SearchHit[]> {
    await this.ensureLoaded();
    if (this.records.length === 0 || query.trim().length === 0) {
      return [];
    }
    const [queryVector] = await this.embeddings.embed([`${this.queryPrefix}${query}`]);
    if (queryVector === undefined) {
      return [];
    }
    const queryNorm = norm(queryVector);
    if (queryNorm === 0) {
      return [];
    }

    const scored = this.records.map((record) => ({
      record,
      score: cosine(queryVector, queryNorm, record.vector, record.norm),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((entry) => entry.score > minScore)
      .slice(0, Math.max(0, limit))
      .map((entry) => toHit(entry.record, entry.score));
  }

  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.records.length;
  }

  private async embedAll(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const vectors = await this.embeddings.embed(batch);
      out.push(...vectors);
    }
    return out;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.loaded = true;
        return;
      }
      throw new MemorySearchError("index_read_failed", "Unable to read vector index.", {
        path: this.path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const records: IndexRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new MemorySearchError("index_read_failed", "Vector index contains malformed JSON.", {
          path: this.path,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      const record = parseRecord(parsed);
      if (record !== undefined) {
        records.push(record);
      }
    }
    this.records = records;
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const body = this.records.length === 0
      ? ""
      : `${this.records.map((record) => JSON.stringify({
          id: record.id,
          source: record.source,
          ...(record.day === undefined ? {} : { day: record.day }),
          text: record.text,
          vector: record.vector,
        })).join("\n")}\n`;
    const tmpPath = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmpPath, body, "utf8");
      await rename(tmpPath, this.path);
    } catch (error) {
      throw new MemorySearchError("index_write_failed", "Unable to write vector index.", {
        path: this.path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createVectorMemoryIndex(options: VectorMemoryIndexOptions): VectorMemoryIndex {
  return new VectorMemoryIndex(options);
}

function dedupeById(chunks: readonly MemoryChunk[]): readonly MemoryChunk[] {
  const byId = new Map<string, MemoryChunk>();
  for (const chunk of chunks) {
    if (chunk.text.trim().length > 0) {
      byId.set(chunk.id, chunk);
    }
  }
  return [...byId.values()];
}

function toRecord(chunk: MemoryChunk, vector: readonly number[]): IndexRecord {
  return {
    id: chunk.id,
    source: chunk.source,
    ...(chunk.day === undefined ? {} : { day: chunk.day }),
    text: chunk.text,
    vector,
    norm: norm(vector),
  };
}

function toHit(record: IndexRecord, score: number): SearchHit {
  return {
    id: record.id,
    source: record.source,
    text: record.text,
    score,
    ...(record.day === undefined ? {} : { day: record.day }),
  };
}

function parseRecord(value: unknown): IndexRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.source !== "string" || typeof record.text !== "string") {
    return undefined;
  }
  if (!Array.isArray(record.vector) || record.vector.some((component) => typeof component !== "number")) {
    return undefined;
  }
  const vector = record.vector as number[];
  return {
    id: record.id,
    source: record.source,
    ...(typeof record.day === "string" ? { day: record.day } : {}),
    text: record.text,
    vector,
    norm: norm(vector),
  };
}

function norm(vector: readonly number[]): number {
  let sum = 0;
  for (const component of vector) {
    sum += component * component;
  }
  return Math.sqrt(sum);
}

function cosine(a: readonly number[], aNorm: number, b: readonly number[], bNorm: number): number {
  if (aNorm === 0 || bNorm === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return dot / (aNorm * bNorm);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
