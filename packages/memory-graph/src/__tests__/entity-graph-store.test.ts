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

    await store.upsertEntities([{ name: "Robert", entityType: "person", observations: ["prefers concise answers"] }]);
    const result = await store.upsertEntities([
      { name: "robert", observations: ["prefers concise answers", "works on mono-agent"] },
    ]);

    expect(result.observationsAdded).toBe(1);
    const entity = await store.getEntity("ROBERT");
    expect(entity?.name).toBe("Robert"); // first-seen display name preserved
    expect(entity?.entityType).toBe("person");
    expect(entity?.observations).toEqual(["prefers concise answers", "works on mono-agent"]);
  });

  it("persists to JSONL with the MCP memory-server shape and reloads", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertEntities([{ name: "mono-agent", entityType: "project", observations: ["TS monorepo"] }]);
    await store.upsertRelations([{ from: "Robert", to: "mono-agent", relationType: "works on" }]);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"type":"entity"');
    expect(raw).toContain('"type":"relation"');
    expect(raw).toContain('"relationType":"works on"');

    const reloaded = createEntityGraphStore({ path });
    const sub = await reloaded.getSubgraph("Robert", 1);
    expect(sub.entities.map((e) => e.name).sort()).toEqual(["Robert", "mono-agent"]);
    expect(sub.relations).toEqual([{ from: "Robert", to: "mono-agent", relationType: "works on" }]);
  });

  it("auto-creates stub endpoints for relations and dedups relations", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertRelations([{ from: "Alice", to: "Bravo", relationType: "leads" }]);
    const again = await store.upsertRelations([{ from: "alice", to: "bravo", relationType: "leads" }]);

    expect(again.relationsUpserted).toBe(0);
    expect((await store.getEntity("Alice"))?.entityType).toBe("unknown");
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
      { name: "Robert", entityType: "person", observations: ["likes TypeScript"] },
      { name: "mono-agent", entityType: "project", observations: ["written in TypeScript"] },
      { name: "Cooking", entityType: "topic", observations: ["pasta"] },
    ]);

    const hits = await store.search("typescript");
    expect(hits.map((e) => e.name).sort()).toEqual(["Robert", "mono-agent"]);
    expect(await store.search("")).toEqual([]);
  });

  it("produces a salience-ranked digest", async () => {
    const path = await graphPath();
    const store = createEntityGraphStore({ path });
    await store.upsertEntities([
      { name: "Robert", entityType: "person", observations: ["a", "b", "c"] },
      { name: "Side", entityType: "topic", observations: ["x"] },
    ]);

    const digest = await store.digest(10);
    expect(digest.split("\n")[0]).toContain("Robert (person)");
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
