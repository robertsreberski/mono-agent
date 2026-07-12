import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/index.js";
import { auditCanonicalGraphParity } from "../graph-parity.js";
import { appendGraphBatch } from "../graph.js";

const CANONICAL_AT = "2026-01-01T00:00:00.000Z";
const DRIFTED_AT = "2026-06-01T00:00:00.000Z";

describe("canonical graph parity", () => {
  it("reports aggregate payload, timestamp, provenance, missing, and extra drift without providers", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-"));
    appendGraphBatch(root, {
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: CANONICAL_AT },
        { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: CANONICAL_AT },
        { id: "concept:memory", name: "Memory", type: "concept", createdAt: CANONICAL_AT },
      ],
      relations: [{
        src: "person:morgan",
        dst: "project:mono-agent",
        relation: "maintains",
        createdAt: CANONICAL_AT,
      }],
      associations: [{
        memoryId: "M1",
        entityId: "person:morgan",
        provenance: "legacy-name-match",
        createdAt: CANONICAL_AT,
      }],
    });

    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1"));
    db.upsertEntity({ id: "person:morgan", name: "Morgan drifted", type: "person", createdAt: DRIFTED_AT });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: CANONICAL_AT });
    db.upsertEntity({ id: "org:extra", name: "Extra", type: "org", createdAt: CANONICAL_AT });
    db.addEntityRelation("person:morgan", "project:mono-agent", "maintains", DRIFTED_AT);
    db.associateMemory({
      memoryId: "M1",
      entityId: "person:morgan",
      provenance: "capture",
      createdAt: DRIFTED_AT,
    });

    expect(auditCanonicalGraphParity(root, db)).toEqual({
      matches: false,
      entities: {
        canonical: 3,
        active: 3,
        matched: 1,
        missing: 1,
        extra: 1,
        mismatched: 1,
        payloadMismatches: 1,
        timestampMismatches: 1,
        provenanceMismatches: 0,
      },
      relations: {
        canonical: 1,
        active: 1,
        matched: 0,
        missing: 0,
        extra: 0,
        mismatched: 1,
        payloadMismatches: 0,
        timestampMismatches: 1,
        provenanceMismatches: 0,
      },
      associations: {
        canonical: 1,
        active: 1,
        matched: 0,
        missing: 0,
        extra: 0,
        mismatched: 1,
        payloadMismatches: 0,
        timestampMismatches: 1,
        provenanceMismatches: 1,
      },
    });
    db.close();
  });

  it("reports exact parity after canonical projection mirroring", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-exact-"));
    const graph = appendGraphBatch(root, {
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: CANONICAL_AT },
        { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: CANONICAL_AT },
      ],
      relations: [{
        src: "person:morgan",
        dst: "project:mono-agent",
        relation: "maintains",
        createdAt: CANONICAL_AT,
      }],
      associations: [{
        memoryId: "M1",
        entityId: "person:morgan",
        provenance: "capture",
        createdAt: CANONICAL_AT,
      }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1"));
    for (const entity of graph.entities) db.mirrorCanonicalEntity(entity);
    for (const relation of graph.relations) db.mirrorCanonicalRelation(relation);
    for (const association of graph.associations) db.mirrorCanonicalAssociation(association);

    const parity = auditCanonicalGraphParity(root, db);
    expect(parity.matches).toBe(true);
    expect(parity.entities.matched).toBe(2);
    expect(parity.relations.matched).toBe(1);
    expect(parity.associations.matched).toBe(1);
    db.close();
  });
});

function memory(id: string) {
  return {
    id,
    type: "note" as const,
    status: "open" as const,
    text: "Morgan maintains mono-agent.",
    salience: 0.7,
    isInsight: false,
    createdAt: CANONICAL_AT,
    accessCount: 0,
    tags: [],
    source: { file: "daily/2026-01-01.md", line: 3 },
  };
}
