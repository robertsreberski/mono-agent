import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEntity, appendRelation, readGraph } from "../graph.js";
import type { EntityRecord, EntityRelationRecord } from "../../store/index.js";

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

  it("does not append a duplicate entity record", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    const alice = entity("person:alice", "Alice");
    appendEntity(root, alice);
    appendEntity(root, { ...alice, createdAt: "2026-06-15T10:00:00.000Z" });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(readGraph(root).entities).toHaveLength(1);
  });

  it("does not append a partial duplicate that omits existing optional entity details", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, {
      id: "person:alice",
      name: "Alice",
      type: "person",
      summary: "prefers quiet mornings",
      createdAt: "2026-06-15T09:00:00.000Z",
    });
    appendEntity(root, {
      id: "person:alice",
      name: "Alice",
      createdAt: "2026-06-15T10:00:00.000Z",
    });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(readGraph(root).entities[0]).toMatchObject({
      type: "person",
      summary: "prefers quiet mornings",
    });
  });

  it("preserves existing optional entity details when appending a partial update", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, {
      id: "person:alice",
      name: "Alice",
      type: "person",
      summary: "prefers quiet mornings",
      createdAt: "2026-06-15T09:00:00.000Z",
    });
    appendEntity(root, {
      id: "person:alice",
      name: "Alice Updated",
      createdAt: "2026-06-15T10:00:00.000Z",
    });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(readGraph(root).entities[0]).toMatchObject({
      name: "Alice Updated",
      type: "person",
      summary: "prefers quiet mornings",
    });
  });

  it("still appends entity updates so the last occurrence wins", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendEntity(root, entity("person:alice", "Alice"));
    appendEntity(root, {
      id: "person:alice",
      name: "Alice Updated",
      summary: "new summary",
      createdAt: "2026-06-15T09:00:00.000Z",
      updatedAt: "2026-06-15T10:00:00.000Z",
    });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(readGraph(root).entities[0]).toMatchObject({ name: "Alice Updated", summary: "new summary" });
  });

  it("dedupes relations by src|dst|relation triple keeping the LAST occurrence", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    appendRelation(root, { src: "a", dst: "b", relation: "knows", createdAt: "2026-06-15T09:00:00.000Z" });
    appendFileSync(
      join(root, "graph.jsonl"),
      '{"kind":"relation","src":"a","dst":"b","relation":"knows","createdAt":"2026-06-15T10:00:00.000Z"}\n',
      "utf8",
    );
    const g = readGraph(root);
    expect(g.relations).toHaveLength(1);
    expect(g.relations[0]?.createdAt).toBe("2026-06-15T10:00:00.000Z");
  });

  it("does not append duplicate relation triples", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-"));
    const rel = relation("person:alice", "project:x", "maintains");
    appendRelation(root, rel);
    appendRelation(root, { ...rel, createdAt: "2026-06-15T10:00:00.000Z" });

    const lines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(readGraph(root).relations).toHaveLength(1);
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
