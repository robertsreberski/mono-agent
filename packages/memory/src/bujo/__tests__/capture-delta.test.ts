import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeEmbeddings, projectCapture } from "./helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { assertCanonicalGraphRepairBaseParity } from "../rebuild.js";

import {
  openMemoryDb, type EntityRecord, type EntityRelationRecord,
  type MemoryEntityAssociation, type MemoryRecord,
} from "../../store/index.js";
import {
  appendGraphBatch, applyCaptureGraphDelta, establishCaptureGraphBaseline,
  hasCaptureGraphBaseline, replaceDbCanonicalGraphProjectionWithParity,
} from "../graph.js";

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
    const steps: Array<{
      memories: MemoryRecord[];
      entities: EntityRecord[];
      relations?: EntityRelationRecord[];
      associations?: MemoryEntityAssociation[];
      /** Non-capture memory writes have no graph append, but still need a delta. */
      memoryOnly?: boolean;
      supersede?: readonly [string, string];
      affectedMemoryIds?: string[];
    }> = [
      { memories: [memory("M1", "Morgan and Maple collaborate.")], entities: [] },
      { memories: [], entities: [entity("person:morgan", "Morgan")] },
      { memories: [memory("M2", "Morgan visits Maple.")], entities: [entity("place:maple", "Maple", "place")] },
      { memories: [], entities: [], relations: [{ src: "person:morgan", dst: "place:maple",
        relation: "visits", createdAt: AT }] },
      { memories: [memory("M5", "Morgan keeps a fictional journal.")], entities: [], memoryOnly: true },
      { memories: [], entities: [entity("person:morgan-two", "Morgan")] },
      { memories: [], entities: [entity("person:morgan-two", "Quinn")] },
      { memories: [memory("M3", "A migrated note", "migrated")], entities: [entity("collection:notes", "Notes", "collection")],
        associations: [{ memoryId: "M3", entityId: "collection:notes", provenance: "capture", createdAt: AT }] },
      { memories: [memory("M4", "A replacement note")], entities: [], supersede: ["M3", "M4"],
        affectedMemoryIds: ["M3"] },
      { memories: [], entities: [entity("collection:notes", "Notes", "concept")] },
      { memories: [memory("M1", "Maple and Quinn collaborate.")], entities: [] },
    ];
    for (const step of steps) {
      for (const record of step.memories) {
        delta.upsertLexical(record);
        full.upsertLexical(record);
      }
      if (step.supersede !== undefined) {
        delta.markSuperseded(...step.supersede, AT);
        full.markSuperseded(...step.supersede, AT);
      }
      const graph = step.memoryOnly ? { entities: [], relations: [], associations: [] }
        : appendGraphBatch(root, {
          entities: step.entities,
          relations: step.relations ?? [],
          associations: step.associations ?? [],
        });
      applyCaptureGraphDelta(root, delta,
        [...step.memories.map((record) => record.id), ...(step.affectedMemoryIds ?? [])],
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

  it("keeps a Remember-only memory's legacy association across a later capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-remember-capture-delta-"));
    let count = 0;
    const store = createBujoMemoryStore({ root, tier: "bujo", clock: () => new Date(AT),
      embeddings: fakeEmbeddings(8), dim: 8,
      llm: { id: "fixture", complete: async (_prompt, options) => {
        if (options?.label === "capture:extract") return JSON.stringify({
          memories: [{ type: "note", text: `Fictional orchard update ${++count}.`,
            salience: 0.5, isInsight: false, entityIds: count === 1 ? ["person:morgan"] : [] }],
          entities: count === 1 ? [{ id: "person:morgan", name: "Morgan", type: "person" }] : [],
          relations: [],
        });
        return JSON.stringify([{ index: 0, action: "add" }]);
      } },
    });
    try {
      await projectCapture(store, "fictional-1", "Morgan manages a fictional orchard.");
      const remembered = await store.remember("fictional-2", "Morgan owns a blue bicycle.");
      const db = (store as unknown as { db: ReturnType<typeof openMemoryDb> }).db;
      expect(db.associationsForMemory(remembered.id).map((association) => association.entityId))
        .toEqual(["person:morgan"]);
      await projectCapture(store, "fictional-3", "A distinct fictional notebook update.");
      expect(store.queueSnapshot().intake?.dead).toBe(0);
      const afterCapture = db.canonicalGraphSnapshot();
      replaceDbCanonicalGraphProjectionWithParity(root, db, assertCanonicalGraphRepairBaseParity);
      expect(db.canonicalGraphSnapshot()).toEqual(afterCapture);
      expect(db.associationsForMemory(remembered.id).map((association) => association.entityId))
        .toEqual(["person:morgan"]);
    } finally {
      await store.close();
    }
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
    establishCaptureGraphBaseline(raced);
    expect(() => applyCaptureGraphDelta(root, raced, ["M1"], graph.entities.map((record) => record.id), []))
      .toThrow(/source changed/iu);
    expect(hasCaptureGraphBaseline(raced)).toBe(false);
    replaceDbCanonicalGraphProjectionWithParity(root, db, () => undefined);
    const afterRepair = db.canonicalGraphSnapshot();
    replaceDbCanonicalGraphProjectionWithParity(root, db, () => undefined);
    expect(db.canonicalGraphSnapshot()).toEqual(afterRepair);
    expect(afterRepair.entities.map((record) => record.id)).toEqual(["person:morgan", "place:maple"]);
    expect(db.associationsForMemory("M1")).toEqual([{
      memoryId: "M1", entityId: "person:morgan", provenance: "legacy-name-match", createdAt: AT,
    }]);
    db.close();
  });
});
