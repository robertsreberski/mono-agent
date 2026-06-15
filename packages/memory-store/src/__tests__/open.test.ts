import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("creates the db's parent directory if it does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "memstore-"));
    const path = join(root, "nested", "deep", "memory.db");
    const db = openMemoryDb({ path, embeddings: fakeEmbeddings, dim: 8 });
    expect(existsSync(path)).toBe(true);
    db.close();
  });
});
