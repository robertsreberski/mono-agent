import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} };
}

describe("addEdge/expand", () => {
  it("expands one hop along thread/about edges, excluding the seed ids", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    for (const id of ["a", "b", "c", "d"]) await db.upsert(note(id, `memory ${id}`));
    db.addEdge("a", "b", "thread", 0.9);
    db.addEdge("a", "c", "about", 1.0);
    db.addEdge("c", "d", "thread", 0.5); // 2 hops from a — must NOT appear at hops=1

    const expanded = db.expand(["a"], 1).map((r) => r.id).sort();
    expect(expanded).toEqual(["b", "c"]);
    db.close();
  });
});
