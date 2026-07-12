import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/index.js";
import { writeCaptureIntent } from "../capture-outbox.js";
import { auditCanonicalGraphParity } from "../graph-parity.js";
import { appendEntity, appendGraphBatch, readGraph } from "../graph.js";

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

    let snapshots = 0;
    const inspected = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "canonicalGraphSnapshot") {
          return () => {
            snapshots += 1;
            return target.canonicalGraphSnapshot();
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(auditCanonicalGraphParity(root, inspected)).toEqual({
      status: "mismatch",
      tier: "bujo",
      matches: false,
      issues: [],
      mutation: {
        capturePending: false,
        migrationPending: false,
        sourceChanged: false,
      },
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
    expect(snapshots).toBe(2);
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
    expect(parity.status).toBe("match");
    expect(parity.entities.matched).toBe(2);
    expect(parity.relations.matched).toBe(1);
    expect(parity.associations.matched).toBe(1);
    db.close();
  });

  it.each([
    ["malformed-json" as const, "{not-json}\n"],
    ["unknown-kind" as const, `${JSON.stringify({ kind: "future-record", id: "x" })}\n`],
  ])("fails closed with %s while compatibility reads remain permissive", (code, graph) => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-invalid-"));
    writeFileSync(join(root, "graph.jsonl"), graph, "utf8");
    const db = openMemoryDb({ path: ":memory:" });

    expect(readGraph(root)).toEqual({ entities: [], relations: [], associations: [] });
    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "invalid",
      matches: false,
      issues: [{ code, line: 1 }],
    });
    db.close();
  });

  it("returns in_progress for an admitted durable capture instead of divergence", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-pending-"));
    writeCaptureIntent(root, [], {}, CANONICAL_AT);
    const db = openMemoryDb({ path: ":memory:" });

    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "in_progress",
      matches: false,
      mutation: {
        capturePending: true,
        migrationPending: false,
        sourceChanged: false,
      },
    });
    db.close();
  });

  it("retries a completed source/index interleaving instead of false-failing", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-race-"));
    const db = openMemoryDb({ path: ":memory:" });
    const entity = { id: "person:morgan", name: "Morgan", createdAt: CANONICAL_AT };
    let inject = true;
    let snapshots = 0;
    const interleaved = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "canonicalGraphSnapshot") {
          return () => {
            snapshots += 1;
            if (inject) {
              inject = false;
              appendEntity(root, entity);
              target.mirrorCanonicalEntity(entity);
            }
            return target.canonicalGraphSnapshot();
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(auditCanonicalGraphParity(root, interleaved)).toMatchObject({
      status: "match",
      matches: true,
      entities: { canonical: 1, active: 1, matched: 1 },
    });
    expect(snapshots).toBe(2);
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
