import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createVectorMemoryIndex } from "../index.js";
import type { EmbeddingProvider } from "../index.js";

const VOCAB = ["pricing", "migration", "typescript", "cooking", "pasta", "robert"];

// Deterministic bag-of-words embedder so cosine ranking is predictable offline.
const stubEmbeddings: EmbeddingProvider = {
  id: "stub",
  async embed(texts) {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
    });
  },
};

const tempDirs: string[] = [];

async function indexPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-search-test-"));
  tempDirs.push(dir);
  return join(dir, "index", "embeddings.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("VectorMemoryIndex", () => {
  it("ranks by cosine similarity and filters non-matches", async () => {
    const index = createVectorMemoryIndex({ path: await indexPath(), embeddings: stubEmbeddings });
    await index.rebuild([
      { id: "a", source: "daily/x.md", text: "Discussed the pricing migration timeline." },
      { id: "b", source: "graph", text: "Robert likes TypeScript." },
      { id: "c", source: "daily/y.md", text: "Cooking pasta tonight." },
    ]);

    const hits = await index.search("pricing migration", 5);
    expect(hits[0]?.id).toBe("a");
    expect(hits.map((hit) => hit.id)).not.toContain("c");
    expect(hits[0]?.score).toBeGreaterThan(0.9);
  });

  it("persists to JSONL and reloads in a fresh instance", async () => {
    const path = await indexPath();
    const writer = createVectorMemoryIndex({ path, embeddings: stubEmbeddings });
    await writer.rebuild([{ id: "a", source: "graph", text: "Robert and TypeScript", day: "2026-06-09" }]);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"vector"');
    expect(raw).toContain('"day":"2026-06-09"');

    const reader = createVectorMemoryIndex({ path, embeddings: stubEmbeddings });
    expect(await reader.size()).toBe(1);
    const hits = await reader.search("robert", 3);
    expect(hits[0]?.id).toBe("a");
    expect(hits[0]?.day).toBe("2026-06-09");
  });

  it("returns nothing for an empty index or empty query", async () => {
    const index = createVectorMemoryIndex({ path: await indexPath(), embeddings: stubEmbeddings });
    expect(await index.search("anything")).toEqual([]);
    await index.rebuild([{ id: "a", source: "graph", text: "Robert" }]);
    expect(await index.search("   ")).toEqual([]);
  });

  it("dedupes chunks by id and skips blank text", async () => {
    const index = createVectorMemoryIndex({ path: await indexPath(), embeddings: stubEmbeddings });
    const result = await index.rebuild([
      { id: "a", source: "graph", text: "Robert" },
      { id: "a", source: "graph", text: "Robert updated" },
      { id: "b", source: "graph", text: "   " },
    ]);
    expect(result.indexed).toBe(1);
  });
});
