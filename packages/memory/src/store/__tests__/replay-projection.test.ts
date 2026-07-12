import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import type { MemoryRecord } from "../types.js";

const OLD_AT = "2026-06-01T00:00:00.000Z";
const REPLACED_AT = "2026-06-02T00:00:00.000Z";
const TERMINAL_AT = "2026-06-03T00:00:00.000Z";

function memory(id: string, status: MemoryRecord["status"], createdAt = OLD_AT): MemoryRecord {
  return {
    id,
    type: "note",
    status,
    text: `memory ${id}`,
    salience: 0.5,
    isInsight: false,
    createdAt,
    accessCount: 0,
    tags: [],
    source: {},
  };
}

describe("MemoryDb replay projection replacement", () => {
  it("replaces only replay-owned lifecycle and edges, preserves graph/telemetry, and is a no-op when exact", () => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("old", "invalidated"));
    db.upsertLexical(memory("new", "open", REPLACED_AT));
    db.upsertLexical(memory("terminal", "dropped"));
    db.addEdge("old", "collection:one", "supports", 1, OLD_AT);
    db.addEdge("old", "entity:one", "about", 0.8, OLD_AT);
    db.recordAccess(["old"], new Date(TERMINAL_AT));

    const projection = {
      terminals: [{ id: "terminal", at: TERMINAL_AT }],
      supersedes: [{ src: "old", dst: "new", at: REPLACED_AT }],
      threads: [{ src: "new", dst: "terminal", weight: 0.75, at: TERMINAL_AT }],
    } as const;
    expect(db.replaceReplayProjection(projection)).toBe(true);
    expect(db.replaceReplayProjection(projection)).toBe(false);

    expect(db.get("old")).toMatchObject({
      status: "invalidated",
      supersededBy: "new",
      supersededAt: REPLACED_AT,
      validTo: REPLACED_AT,
      accessCount: 1,
    });
    expect(db.get("terminal")?.validTo).toBe(TERMINAL_AT);
    expect(db.allEdges()).toEqual(expect.arrayContaining([
      { src: "old", dst: "new", kind: "supersedes", weight: 1, createdAt: REPLACED_AT },
      { src: "new", dst: "terminal", kind: "thread", weight: 0.75, createdAt: TERMINAL_AT },
      { src: "old", dst: "collection:one", kind: "supports", weight: 1, createdAt: OLD_AT },
      { src: "old", dst: "entity:one", kind: "about", weight: 0.8, createdAt: OLD_AT },
    ]));

    expect(db.replaceReplayProjection({ terminals: [], supersedes: [], threads: [] })).toBe(true);
    expect(db.get("old")).toMatchObject({ status: "invalidated", accessCount: 1 });
    expect(db.get("old")?.validTo).toBeUndefined();
    expect(db.get("terminal")?.validTo).toBeUndefined();
    expect(db.allEdges().filter((edge) => edge.kind === "thread" || edge.kind === "supersedes")).toEqual([]);
    expect(db.allEdges().filter((edge) => edge.kind === "supports" || edge.kind === "about")).toHaveLength(2);
    db.close();
  });

  it("allows a supersede destination to be forgotten later", () => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("a", "invalidated"));
    db.upsertLexical(memory("b", "dropped", REPLACED_AT));

    expect(db.replaceReplayProjection({
      terminals: [{ id: "b", at: TERMINAL_AT }],
      supersedes: [{ src: "a", dst: "b", at: REPLACED_AT }],
      threads: [],
    })).toBe(true);
    expect(db.get("a")).toMatchObject({ supersededBy: "b", validTo: REPLACED_AT });
    expect(db.get("b")).toMatchObject({ status: "dropped", validTo: TERMINAL_AT });
    expect(db.replaceReplayProjection({
      terminals: [{ id: "b", at: TERMINAL_AT }],
      supersedes: [{ src: "a", dst: "b", at: REPLACED_AT }],
      threads: [],
    })).toBe(false);
    db.close();
  });

  it("rejects invalid topology before changing the existing projection", () => {
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("a", "invalidated"));
    db.upsertLexical(memory("b", "invalidated", REPLACED_AT));
    db.upsertLexical(memory("c", "open", TERMINAL_AT));
    const valid = {
      terminals: [],
      supersedes: [{ src: "b", dst: "c", at: TERMINAL_AT }],
      threads: [],
    } as const;
    db.replaceReplayProjection(valid);
    const before = db.replayProjectionSnapshot();

    expect(() => db.replaceReplayProjection({
      terminals: [],
      supersedes: [
        { src: "a", dst: "b", at: REPLACED_AT },
        { src: "b", dst: "a", at: TERMINAL_AT },
      ],
      threads: [],
    })).toThrow(/cycle|destination|endpoint/iu);
    expect(db.replayProjectionSnapshot()).toEqual(before);
    db.close();
  });
});
