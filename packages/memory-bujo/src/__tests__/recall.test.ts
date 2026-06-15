import { describe, expect, it } from "vitest";

import { openMemoryDb } from "@mono-agent/memory-store";
import { fakeEmbeddings } from "./helpers.js";
import { composeRecallBlock } from "../recall.js";

describe("composeRecallBlock", () => {
  it("renders a markdown block with the most relevant memories and a source label", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert({ id: "a", type: "note", status: "open", text: "Robert prefers opt-in memory.", salience: 0.9, isInsight: true, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    await db.upsert({ id: "b", type: "task", status: "open", text: "Ship the substrate.", salience: 0.6, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    const block = await composeRecallBlock(db, "memory preferences", { topK: 5 });
    expect(block.kind).toBe("markdown");
    expect(block.source).toBe("memory-bujo");
    expect(block.content).toContain("Robert prefers opt-in memory.");
    expect(block.truncated).toBe(false);
    db.close();
  });

  it("truncates to the byte budget and flags it", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    for (let i = 0; i < 20; i += 1) {
      await db.upsert({ id: `m${i}`, type: "note", status: "open", text: `memory fact number ${i} about cats`, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    }
    const block = await composeRecallBlock(db, "cats", { topK: 20, maxBytes: 120 });
    expect(Buffer.byteLength(block.content, "utf8")).toBeLessThanOrEqual(120);
    expect(block.truncated).toBe(true);
    db.close();
  });
});
