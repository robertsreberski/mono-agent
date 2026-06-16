import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEntity, appendRelation, readGraph } from "../graph.js";
import type { EntityRecord, EntityRelationRecord } from "@mono-agent/memory-store";

function entity(id: string, name: string): EntityRecord {
  return { id, name, type: "person", createdAt: "2026-06-15T09:00:00.000Z" };
}

function relation(src: string, dst: string, rel: string): EntityRelationRecord {
  return { src, dst, relation: rel, createdAt: "2026-06-15T09:00:00.000Z" };
}

describe("readGraph", () => {
  it("returns empty collections when file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    expect(readGraph(root)).toEqual({ entities: [], relations: [] });
  });

  it("round-trips: appended entities and relations are readable", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, entity("person:alice", "Alice"));
    appendRelation(root, relation("person:alice", "project:x", "maintains"));
    const g = readGraph(root);
    expect(g.entities).toHaveLength(1);
    expect(g.entities[0]).toMatchObject({ id: "person:alice", name: "Alice" });
    expect(g.relations).toHaveLength(1);
    expect(g.relations[0]).toMatchObject({ src: "person:alice", dst: "project:x", relation: "maintains" });
  });

  it("dedupes entities by id keeping the LAST occurrence", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, { id: "person:alice", name: "Alice", createdAt: "2026-06-15T09:00:00.000Z" });
    appendEntity(root, {
      id: "person:alice",
      name: "Alice Updated",
      summary: "new summary",
      createdAt: "2026-06-15T09:00:00.000Z",
      updatedAt: "2026-06-15T10:00:00.000Z",
    });
    const g = readGraph(root);
    expect(g.entities).toHaveLength(1);
    expect(g.entities[0]).toMatchObject({ name: "Alice Updated", summary: "new summary" });
  });

  it("dedupes relations by src|dst|relation triple keeping the LAST occurrence", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendRelation(root, { src: "a", dst: "b", relation: "knows", createdAt: "2026-06-15T09:00:00.000Z" });
    appendRelation(root, { src: "a", dst: "b", relation: "knows", createdAt: "2026-06-15T10:00:00.000Z" });
    const g = readGraph(root);
    expect(g.relations).toHaveLength(1);
    expect(g.relations[0]?.createdAt).toBe("2026-06-15T10:00:00.000Z");
  });

  it("skips malformed lines without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, entity("person:bob", "Bob"));
    appendFileSync(join(root, "graph.jsonl"), "NOT_VALID_JSON\n", "utf8");
    appendFileSync(
      join(root, "graph.jsonl"),
      '{"kind":"entity","id":"person:charlie","name":"Charlie","createdAt":"2026-06-15T09:00:00.000Z"}\n',
      "utf8",
    );
    const g = readGraph(root);
    expect(g.entities).toHaveLength(2);
    expect(g.entities.map((e) => e.id)).toContain("person:charlie");
  });
});
