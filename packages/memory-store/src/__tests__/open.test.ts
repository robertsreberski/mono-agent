import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";

const fakeEmbeddings = { id: "fake", embed: async () => [] };

describe("openMemoryDb", () => {
  it("opens an in-memory db, loads sqlite-vec, and creates tables", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings, dim: 8 });
    expect(db.vecVersion()).toMatch(/\d+\.\d+/);
    db.close();
  });

  it("rejects a non-positive dimension", () => {
    expect(() => openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings, dim: 0 })).toThrow(/positive integer/);
  });
});
