import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, type: "note", status: "open", text, salience: 0.5, isInsight: false,
    createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {}, ...over,
  };
}

describe("recall", () => {
  it("ranks the topically-matching memory first via hybrid search", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "the cat sat on the mat"));
    await db.upsert(note("b", "stock market crash wiped out savings"));
    await db.upsert(note("c", "a cat themed cafe downtown"));
    const hits = await db.recall("cat mat", { topK: 3 });
    expect(hits[0]?.record.id).toBe("a"); // shares both query tokens (cat, mat)
    expect(hits.map((h) => h.record.id)).toContain("c"); // shares one (cat); b shares none
    db.close();
  });

  it("excludes invalidated/dropped memories by default", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "cat one", { status: "invalidated" }));
    await db.upsert(note("b", "cat two", { status: "dropped" }));
    await db.upsert(note("c", "cat three"));
    const hits = await db.recall("cat", { topK: 5 });
    expect(hits.map((h) => h.record.id)).toEqual(["c"]);
    db.close();
  });

  it("bumps access_count and last_accessed_at on returned memories", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("a", "cat"));
    await db.recall("cat", { topK: 1 });
    const got = db.get("a");
    expect(got?.accessCount).toBe(1);
    expect(got?.lastAccessedAt).toBe("2026-06-16T00:00:00.000Z");
    db.close();
  });
});
