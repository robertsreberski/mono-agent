import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { DEFAULT_EMBEDDING_BATCH_SIZE } from "../db-core.js";
import { fakeEmbeddings } from "./helpers.js";
import type { EmbeddingProvider } from "../../search/index.js";
import type { MemoryRecord } from "../types.js";

const DIM = 8;

function record(id: string): MemoryRecord {
  return {
    id, type: "note", status: "open", text: `Zorbel note ${id}`, salience: 0.5, isInsight: false,
    createdAt: "2026-05-15T12:00:00.000Z", accessCount: 0, tags: [], source: {},
  };
}

describe("prepareUpsertVectors", () => {
  it("embeds a large explicit plan in bounded provider requests, preserving order", async () => {
    const base = fakeEmbeddings(DIM);
    const sizes: number[] = [];
    const embeddings: EmbeddingProvider = {
      id: base.id,
      embed: async (texts) => { sizes.push(texts.length); return await base.embed(texts); },
    };
    const db = openMemoryDb({ path: ":memory:", embeddings, dim: DIM });
    const records = Array.from({ length: DEFAULT_EMBEDDING_BATCH_SIZE * 3 + 5 }, (_, index) => record(`m${index}`));
    const vectors = await db.prepareUpsertVectors(records);
    expect(sizes.every((size) => size <= DEFAULT_EMBEDDING_BATCH_SIZE)).toBe(true);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(records.length);
    expect(vectors).toHaveLength(records.length);
    for (const index of [0, DEFAULT_EMBEDDING_BATCH_SIZE, records.length - 1]) {
      expect(vectors[index]).toEqual((await db.prepareUpsertVectors([records[index]!]))[0]);
    }
    db.close();
  });
});
