import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEntityGraphStore } from "../index.js";

const tempDirs: string[] = [];

async function graphPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-graph-test-"));
  tempDirs.push(dir);
  return join(dir, "graph.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("JsonlEntityGraphStore", () => {
  it("upserts entities, merges observations, and dedups", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });

    await store.upsertEntities([{ name: "Example Person", entityType: "person", observations: ["prefers concise answers"] }]);
    const result = await store.upsertEntities([
      { name: "example person", observations: ["prefers concise answers", "contributes to sample-project"] },
    ]);

    expect(result.observationsAdded).toBe(1);
    const entity = await store.getEntity("example person");
    expect(entity?.name).toBe("Example Person"); // first-seen display name preserved
    expect(entity?.entityType).toBe("person");
    expect(entity?.observations).toEqual(["prefers concise answers", "contributes to sample-project"]);
  });

  it("persists to JSONL with the MCP memory-server shape and reloads", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertEntities([{ name: "sample-project", entityType: "project", observations: ["TS monorepo"] }]);
    await store.upsertRelations([{ from: "Example Person", to: "sample-project", relationType: "works on" }]);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"type":"entity"');
    expect(raw).toContain('"type":"relation"');
    expect(raw).toContain('"relationType":"works on"');

    const reloaded = createEntityGraphStore({ path });
    const sub = await reloaded.getSubgraph("Example Person", 1);
    expect(sub.entities.map((e) => e.name).sort()).toEqual(["Example Person", "sample-project"]);
    expect(sub.relations).toEqual([{ from: "Example Person", to: "sample-project", relationType: "works on" }]);
  });

  it("auto-creates stub endpoints for relations and dedups relations", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertRelations([{ from: "Person A", to: "Entity B", relationType: "leads" }]);
    const again = await store.upsertRelations([{ from: "person a", to: "entity b", relationType: "leads" }]);

    expect(again.relationsUpserted).toBe(0);
    expect((await store.getEntity("Person A"))?.entityType).toBe("unknown");
    expect((await store.snapshot()).relations).toHaveLength(1);
  });

  it("traverses a bounded number of hops", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertRelations([
      { from: "A", to: "B", relationType: "knows" },
      { from: "B", to: "C", relationType: "knows" },
    ]);

    const oneHop = await store.getSubgraph("A", 1);
    expect(oneHop.entities.map((e) => e.name).sort()).toEqual(["A", "B"]);

    const twoHop = await store.getSubgraph("A", 2);
    expect(twoHop.entities.map((e) => e.name).sort()).toEqual(["A", "B", "C"]);
  });

  it("keyword-searches across names, types, and observations", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertEntities([
      { name: "Example Person", entityType: "person", observations: ["likes TypeScript"] },
      { name: "sample-project", entityType: "project", observations: ["written in TypeScript"] },
      { name: "Cooking", entityType: "topic", observations: ["pasta"] },
    ]);

    const hits = await store.search("typescript");
    expect(hits.map((e) => e.name).sort()).toEqual(["Example Person", "sample-project"]);
    expect(await store.search("")).toEqual([]);
  });

  it("produces a salience-ranked digest", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertEntities([
      { name: "Example Person", entityType: "person", observations: ["a", "b", "c"] },
      { name: "Side", entityType: "topic", observations: ["x"] },
    ]);

    const digest = await store.digest(10);
    expect(digest.split("\n")[0]).toContain("Example Person (person)");
    expect(digest).toContain("- Side (topic): x");
  });

  it("cascade-deletes entities and their relations", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertRelations([{ from: "A", to: "B", relationType: "knows" }]);

    const removed = await store.deleteEntities(["A"]);
    expect(removed).toBe(1);
    const snapshot = await store.snapshot();
    expect(snapshot.entities.map((e) => e.name)).toEqual(["B"]);
    expect(snapshot.relations).toEqual([]);
  });

  it("throws a clear error on malformed JSONL", async () => {
    const path = await graphPath();
    await writeFile(path, '{"type":"entity","name":"ok","entityType":"x","observations":[]}\nnot json\n', "utf8");
    const store = createEntityGraphStore({ path });

    await expect(store.snapshot()).rejects.toThrow(/Malformed JSON on graph line 2/u);
  });
});
