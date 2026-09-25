import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openMemoryDb, type EntityRecord, type MemoryRecord } from "../../store/index.js";
import { appendGraphBatch, applyCaptureGraphDelta, replaceDbCanonicalGraphProjectionWithParity } from "../graph.js";

const AT = "2026-07-12T08:00:00.000Z";
function memory(id: string, text: string, status: MemoryRecord["status"] = "open"): MemoryRecord {
  return { id, type: "note", status, text, salience: 0.5, isInsight: false,
    createdAt: AT, accessCount: 0, tags: [], source: {} };
}
function entity(id: string, name: string, type = "person"): EntityRecord {
  return { id, name, type, createdAt: AT };
}

describe("capture graph delta", () => {
  it("matches full canonical projection after successive additions, collisions, renames and supports", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-capture-delta-"));
    const delta = openMemoryDb({ path: ":memory:" });
    const full = openMemoryDb({ path: ":memory:" });
    const steps = [
      { memories: [memory("M1", "Morgan and Maple collaborate.")], entities: [] },
      { memories: [], entities: [entity("person:morgan", "Morgan")] },
      { memories: [memory("M2", "Morgan visits Maple.")], entities: [entity("place:maple", "Maple", "place")] },
      { memories: [], entities: [entity("person:morgan-two", "Morgan")] },
      { memories: [], entities: [entity("person:morgan-two", "Quinn")] },
      { memories: [memory("M3", "A migrated note", "migrated")], entities: [entity("collection:notes", "Notes", "collection")],
        associations: [{ memoryId: "M3", entityId: "collection:notes", provenance: "capture" as const, createdAt: AT }] },
      { memories: [memory("M1", "Maple and Quinn collaborate.")], entities: [] },
    ];
    for (const step of steps) {
      for (const record of step.memories) {
        delta.upsertLexical(record);
        full.upsertLexical(record);
      }
      const graph = appendGraphBatch(root, {
        entities: step.entities,
        associations: "associations" in step ? step.associations : [],
      });
      applyCaptureGraphDelta(root, delta, step.memories.map((record) => record.id),
        graph.entities.map((record) => record.id), graph.relations);
      replaceDbCanonicalGraphProjectionWithParity(root, full, () => undefined);
      const projected = delta.canonicalGraphSnapshot();
      const reference = full.canonicalGraphSnapshot();
      expect(projected.memories).toEqual(reference.memories);
      expect(projected.entities).toEqual(reference.entities);
      expect(projected.relations).toEqual(reference.relations);
      expect(projected.associations).toEqual(reference.associations);
      expect(projected.supports).toEqual(reference.supports);
    }
    delta.close();
    full.close();
  });

  it("rejects a crash after the DB delta and converges on receipt replay", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-capture-delta-race-"));
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1", "Morgan is here."));
    const graph = appendGraphBatch(root, { entities: [entity("person:morgan", "Morgan")] });
    const raced = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "applyCanonicalGraphDelta") {
          return (...args: Parameters<typeof db.applyCanonicalGraphDelta>) => {
            target.applyCanonicalGraphDelta(...args);
            appendGraphBatch(root, { entities: [entity("place:maple", "Maple", "place")] });
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => applyCaptureGraphDelta(root, raced, ["M1"], graph.entities.map((record) => record.id), []))
      .toThrow(/source changed/iu);
    expect(() => applyCaptureGraphDelta(root, db, ["M1"], graph.entities.map((record) => record.id), []))
      .not.toThrow();
    expect(db.associationsForMemory("M1")).toEqual([{
      memoryId: "M1", entityId: "person:morgan", provenance: "legacy-name-match", createdAt: AT,
    }]);
    db.close();
  });
});
