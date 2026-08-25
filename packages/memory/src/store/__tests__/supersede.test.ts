import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { EmbeddingProvider } from "../../search/index.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} };
}

describe("supersede", () => {
  it("invalidates the old record (keeps the row) and links the new one", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("old", "Morgan lives in Berlin"));
    await db.supersede("old", note("new", "Morgan lives in Lisbon"));

    const old = db.get("old");
    expect(old).toBeDefined();                       // not deleted
    expect(old?.status).toBe("invalidated");
    expect(old?.supersededBy).toBe("new");
    expect(old?.supersededAt).toBe("2026-06-16T00:00:00.000Z");
    expect(old?.validTo).toBe("2026-06-16T00:00:00.000Z");
    expect(db.get("new")?.status).toBe("open");
    expect(db.edges("old")).toContainEqual(expect.objectContaining({ src: "old", dst: "new", kind: "supersedes" }));
    db.close();
  });

  it("excludes the superseded record from default recall but keeps it for includeInvalid", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("old", "Berlin city note"));
    await db.supersede("old", note("new", "Lisbon city note"));
    const live = await db.recall("city", { topK: 5 });
    expect(live.map((h) => h.record.id)).not.toContain("old");
    const all = await db.recall("city", { topK: 5, includeInvalid: true });
    expect(all.map((h) => h.record.id)).toContain("old");
    db.close();
  });

  it("rejects an unknown oldId or a self-supersede", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("old", "Berlin"));
    await expect(db.supersede("missing", note("new", "Lisbon"))).rejects.toThrow(/unknown memory/);
    await expect(db.supersede("old", note("old", "self"))).rejects.toThrow(/distinct id/);
    db.close();
  });

  it("markSuperseded links two existing records without embedding either record", async () => {
    const base = fakeEmbeddings(64);
    let calls = 0;
    let fail = false;
    const embeddings: EmbeddingProvider = {
      id: "flaky",
      embed: async (texts) => {
        calls += 1;
        if (fail) throw new Error("embedding provider down");
        return base.embed(texts);
      },
    };
    const db = openMemoryDb({ path: ":memory:", embeddings, dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("old", "Berlin city note"));
    await db.upsert(note("new", "Lisbon city note"));
    expect(calls).toBe(2);

    fail = true;
    db.markSuperseded("old", "new");

    expect(calls).toBe(2);
    expect(db.get("old")).toMatchObject({
      status: "invalidated",
      supersededBy: "new",
      supersededAt: "2026-06-16T00:00:00.000Z",
      validTo: "2026-06-16T00:00:00.000Z",
    });
    expect(db.edges("old")).toContainEqual(expect.objectContaining({ src: "old", dst: "new", kind: "supersedes" }));
    db.close();
  });

  it("repairs only the fenced legacy supersede clock and preserves its vector", () => {
    const legacyAt = "2026-06-15T23:59:00.000Z";
    const effectiveAt = "2026-06-16T00:01:00.000Z";
    const vector = Array.from({ length: 64 }, (_, index) => index === 0 ? 1 : 0);
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    db.commitPreparedUpserts([{
      ...note("clock-old", "The original memory"),
      createdAt: effectiveAt,
      source: { file: "daily/2026-06-16.md" },
    }, {
      ...note("clock-new", "The correction"),
      createdAt: legacyAt,
      source: { file: "daily/2026-06-15.md" },
    }], [vector, vector]);
    db.markSuperseded("clock-old", "clock-new", legacyAt);

    expect(db.repairLegacySupersedeClock({
      oldId: "clock-old",
      newId: "clock-new",
      expectedOldStatus: "open",
      legacyAt,
      effectiveAt,
      legacySourceFile: "daily/2026-06-15.md",
      effectiveSourceFile: "daily/2026-06-16.md",
    })).toBe("repaired");
    expect(db.get("clock-new")).toMatchObject({
      createdAt: effectiveAt,
      source: { file: "daily/2026-06-16.md" },
    });
    expect(db.get("clock-old")).toMatchObject({
      supersededBy: "clock-new",
      supersededAt: effectiveAt,
      validTo: effectiveAt,
    });
    expect(db.allEdges()).toContainEqual(expect.objectContaining({
      src: "clock-old",
      dst: "clock-new",
      kind: "supersedes",
      createdAt: effectiveAt,
    }));
    expect(db.hasVector("clock-new")).toBe(true);
    expect(db.repairLegacySupersedeClock({
      oldId: "clock-old",
      newId: "clock-new",
      expectedOldStatus: "open",
      legacyAt,
      effectiveAt,
      legacySourceFile: "daily/2026-06-15.md",
      effectiveSourceFile: "daily/2026-06-16.md",
    })).toBe("repaired");
    db.close();
  });

  it("leaves an unapplied legacy supersede for ordinary replay and rejects unrelated replacement state", () => {
    const legacyAt = "2026-06-15T23:59:00.000Z";
    const effectiveAt = "2026-06-16T00:01:00.000Z";
    const vector = Array.from({ length: 64 }, (_, index) => index === 0 ? 1 : 0);
    const input = {
      oldId: "clock-old",
      newId: "clock-new",
      expectedOldStatus: "open",
      legacyAt,
      effectiveAt,
      legacySourceFile: "daily/2026-06-15.md",
      effectiveSourceFile: "daily/2026-06-16.md",
    } as const;
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    db.commitPreparedUpserts([{
      ...note("clock-old", "The original memory"),
      createdAt: effectiveAt,
      source: { file: "daily/2026-06-16.md" },
    }], [vector]);
    expect(db.repairLegacySupersedeClock(input)).toBe("not-applied");
    expect(db.get("clock-old")?.status).toBe("open");

    db.commitPreparedUpserts([{
      ...note("clock-new", "Unrelated replacement state"),
      createdAt: "2026-06-15T23:58:00.000Z",
      source: { file: "daily/2026-06-14.md" },
    }], [vector]);
    expect(() => db.repairLegacySupersedeClock(input)).toThrow(/replacement lost compare-and-swap/iu);
    db.close();
  });
});
