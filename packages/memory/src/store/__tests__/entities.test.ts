import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";

describe("entity repository", () => {
  it("upserts entities idempotently and reads them back", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", summary: "prefers opt-in memory", createdAt: "2026-06-15T09:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z" });
    expect(db.getEntity("person:morgan")).toMatchObject({ name: "Morgan", type: "person", summary: "prefers opt-in memory" });
    expect(db.countEntities()).toBe(1);
    db.close();
  });

  it("preserves optional entity details when an upsert omits them", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({
      id: "person:morgan",
      name: "Morgan",
      type: "person",
      summary: "prefers opt-in memory",
      createdAt: "2026-06-15T09:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
    });
    db.upsertEntity({
      id: "person:morgan",
      name: "Morgan Updated",
      createdAt: "2026-06-17T00:00:00.000Z",
    });

    expect(db.getEntity("person:morgan")).toMatchObject({
      name: "Morgan Updated",
      type: "person",
      summary: "prefers opt-in memory",
      updatedAt: "2026-06-16T00:00:00.000Z",
    });
    db.close();
  });

  it("stores entity relations and lists them by src", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", createdAt: "2026-06-15T09:00:00.000Z" });
    db.addEntityRelation("person:morgan", "project:mono-agent", "maintains");
    expect(db.relationsFor("person:morgan")).toContainEqual(expect.objectContaining({ dst: "project:mono-agent", relation: "maintains" }));
    db.close();
  });

  it("listEntities returns entities ordered by name up to limit", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "concept:bujo", name: "BuJo", type: "concept", createdAt: "2026-06-15T09:00:00.000Z" });

    const all = db.listEntities(50);
    expect(all).toHaveLength(3);
    // Ordered by name (case-sensitive SQLite default: uppercase < lowercase)
    const names = all.map((e) => e.name);
    expect(names).toEqual([...names].sort());

    // Respects limit.
    const one = db.listEntities(1);
    expect(one).toHaveLength(1);

    // Returns empty when no entities.
    const db2 = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    expect(db2.listEntities()).toEqual([]);
    db2.close();

    db.close();
  });
});
