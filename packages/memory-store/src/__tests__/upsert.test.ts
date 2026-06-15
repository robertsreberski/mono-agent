import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    type: "note",
    status: "open",
    text: "Robert prefers opt-in memory, never silent fallback.",
    salience: 0.8,
    isInsight: true,
    createdAt: "2026-06-15T09:00:00.000Z",
    accessCount: 0,
    tags: ["preference", "memory"],
    source: { session: "s1", file: "daily/2026-06-15.md", line: 4 },
    ...over,
  };
}

describe("upsert/get", () => {
  it("stores and reads back a record with all fields", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    await db.upsert(record());
    const got = db.get("m1");
    expect(got).toMatchObject({
      id: "m1",
      type: "note",
      status: "open",
      text: "Robert prefers opt-in memory, never silent fallback.",
      salience: 0.8,
      isInsight: true,
      createdAt: "2026-06-15T09:00:00.000Z",
      accessCount: 0,
      tags: ["preference", "memory"],
      source: { session: "s1", file: "daily/2026-06-15.md", line: 4 },
    });
    db.close();
  });

  it("upsert is idempotent on id (updates in place, no duplicate rows)", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    await db.upsert(record({ text: "first" }));
    await db.upsert(record({ text: "second", salience: 0.2 }));
    expect(db.get("m1")?.text).toBe("second");
    expect(db.get("m1")?.salience).toBe(0.2);
    expect(db.count()).toBe(1);
    db.close();
  });
});
