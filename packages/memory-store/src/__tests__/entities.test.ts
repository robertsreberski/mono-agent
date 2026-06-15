import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";

describe("entity repository", () => {
  it("upserts entities idempotently and reads them back", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:robert", name: "Robert", type: "person", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "person:robert", name: "Robert", type: "person", summary: "prefers opt-in memory", createdAt: "2026-06-15T09:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z" });
    expect(db.getEntity("person:robert")).toMatchObject({ name: "Robert", type: "person", summary: "prefers opt-in memory" });
    expect(db.countEntities()).toBe(1);
    db.close();
  });

  it("stores entity relations and lists them by src", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:robert", name: "Robert", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", createdAt: "2026-06-15T09:00:00.000Z" });
    db.addEntityRelation("person:robert", "project:mono-agent", "maintains");
    expect(db.relationsFor("person:robert")).toContainEqual(expect.objectContaining({ dst: "project:mono-agent", relation: "maintains" }));
    db.close();
  });
});
