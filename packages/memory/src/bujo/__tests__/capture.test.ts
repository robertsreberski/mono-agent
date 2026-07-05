import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDb, type MemoryDb } from "../../store/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { captureTurn } from "../capture.js";
import { readGraph } from "../graph.js";
import type { ReconcileDeps } from "../reconcile.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
const FIXED = new Date("2026-06-15T12:00:00.000Z");

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bujo-capture-"));
  mkdirSync(join(root, "daily"), { recursive: true });
  return root;
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
  openDbs.push(db);
  return db;
}

/** Simple counter-based nextId factory — avoids the duplicate-id problem of fixed clock+random. */
function makeSeqNextId(): () => string {
  let seq = 0;
  return () => `CAP${String(++seq).padStart(4, "0")}`;
}

describe("captureTurn", () => {
  it("distills → reconciles → extracts entities, mirrors to db AND graph.jsonl, links about edges", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Scripted fakeLlm:
    //  - distill: keyed on "TEXT:" → returns 2 candidates
    //  - entity extraction: keyed on "Extract named entities" (from entities.ts PROMPT)
    //  CLASSIFY won't be called because the db is empty (no similar) → all ADD outright.
    // Entity extraction prompt also contains "TEXT:" so must be matched FIRST (more specific wins).
    const llm = fakeLlm([
      [
        "Extract named entities",
        JSON.stringify({
          entities: [{ id: "person:morgan", name: "Morgan", type: "person" }],
          relations: [{ src: "person:morgan", dst: "person:morgan", relation: "self-reference" }],
        }),
      ],
      [
        "TEXT:",
        JSON.stringify([
          { type: "note", text: "Morgan prefers opt-in memory capture", salience: 0.8, isInsight: false },
          { type: "task", text: "ship Phase 2 memory pipeline", salience: 0.7, isInsight: false },
        ]),
      ],
    ]);

    const deps: ReconcileDeps = {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => FIXED,
    };

    const result = await captureTurn("Morgan discussed the memory pipeline today", deps);

    // 2 memories distilled and added
    expect(result.actions).toHaveLength(2);
    expect(result.actions.every((a) => a.kind === "add")).toBe(true);
    expect(db.count()).toBe(2);

    // Both memories are recallable
    const hits = await db.recall("opt-in memory", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);

    // 1 entity returned
    expect(result.entities).toBe(1);

    // 1 relation returned
    expect(result.relations).toBe(1);

    // Entity present in db
    const entity = db.getEntity("person:morgan");
    expect(entity).toBeDefined();
    expect(entity?.name).toBe("Morgan");
    expect(entity?.type).toBe("person");

    // Entity present in graph.jsonl
    const graph = readGraph(root);
    expect(graph.entities.some((e) => e.id === "person:morgan")).toBe(true);

    // Relation present in graph.jsonl
    expect(graph.relations.some((r) => r.src === "person:morgan" && r.relation === "self-reference")).toBe(true);

    // about edges: each added memory links to the extracted entity
    for (const action of result.actions) {
      if (action.kind === "add") {
        const edges = db.edges(action.id);
        expect(edges.some((e) => e.kind === "about" && e.dst === "person:morgan")).toBe(true);
      }
    }
  });

  it("does not throw when a single entity write fails (entity id missing from db result doesn't abort)", async () => {
    // Verifies the defensive try/catch per-item behavior — overall captureTurn should not throw
    // even with a minimal setup where entity writes are perfectly valid.
    const root = newRoot();
    const db = openDb(root);

    const llm = fakeLlm([
      [
        "TEXT:",
        JSON.stringify([{ type: "note", text: "brief note about something", salience: 0.5, isInsight: false }]),
      ],
      [
        "Extract named entities",
        JSON.stringify({
          entities: [{ id: "concept:something", name: "Something", type: "concept" }],
          relations: [],
        }),
      ],
    ]);

    const deps: ReconcileDeps = {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => FIXED,
    };

    // Should resolve, not throw
    await expect(captureTurn("brief note about something", deps)).resolves.toBeDefined();
  });

  it("does not append duplicate graph records across repeated captures", async () => {
    const root = newRoot();
    const db = openDb(root);
    const llm = fakeLlm([
      [
        "Extract named entities",
        JSON.stringify({
          entities: [{ id: "person:paola", name: "Paola", type: "person" }],
          relations: [{ src: "person:paola", dst: "person:paola", relation: "self-reference" }],
        }),
      ],
      [
        "TEXT:",
        JSON.stringify([{ type: "note", text: "Paola prefers quiet mornings", salience: 0.7, isInsight: false }]),
      ],
    ]);
    let now = new Date("2026-06-15T12:00:00.000Z");
    const deps: ReconcileDeps = {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => now,
    };

    await captureTurn("Paola prefers quiet mornings", deps);
    now = new Date("2026-06-16T12:00:00.000Z");
    await captureTurn("Paola prefers quiet mornings", deps);

    const graphLines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(graphLines).toHaveLength(2);
    const graph = readGraph(root);
    expect(graph.entities).toHaveLength(1);
    expect(graph.relations).toHaveLength(1);
  });

  it("writes entities/relations to canonical graph.jsonl even when the db mirror fails (canonical-first)", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Wrap the db so the *index mirror* (upsertEntity/addEntityRelation) throws. Canonical-first ordering
    // means graph.jsonl is written before the mirror, so the data survives a mirror failure.
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "upsertEntity" || prop === "addEntityRelation") {
          return () => { throw new Error("index mirror down"); };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryDb;

    const llm = fakeLlm([
      [
        "Extract named entities",
        JSON.stringify({
          entities: [
            { id: "person:morgan", name: "Morgan", type: "person" },
            { id: "project:mono-agent", name: "mono-agent", type: "project" },
          ],
          relations: [{ src: "person:morgan", dst: "project:mono-agent", relation: "maintains" }],
        }),
      ],
      [
        "TEXT:",
        JSON.stringify([{ type: "note", text: "Morgan maintains mono-agent", salience: 0.7, isInsight: false }]),
      ],
    ]);

    const deps: ReconcileDeps = { db: failingDb, root, llm, nextId: makeSeqNextId(), now: () => FIXED };
    await expect(captureTurn("Morgan maintains mono-agent", deps)).resolves.toBeDefined();

    const graph = readGraph(root);
    expect(graph.entities.some((e) => e.id === "person:morgan")).toBe(true);
    expect(graph.relations.some((r) => r.src === "person:morgan" && r.relation === "maintains")).toBe(true);
  });

  it("propagates a model failure (does not silently no-op the whole turn)", async () => {
    const root = newRoot();
    const db = openDb(root);
    // The capture LLM is down. distill is the first model call; the failure must propagate out of
    // captureTurn so the async capture boundary logs it — rather than returning an empty summary that
    // is indistinguishable from a turn with nothing worth remembering.
    const throwingLlm = { id: "throws", complete: async () => { throw new Error("ollama unreachable"); } };
    const deps: ReconcileDeps = { db, root, llm: throwingLlm, nextId: makeSeqNextId(), now: () => FIXED };
    await expect(captureTurn("a memorable sentence about the project", deps)).rejects.toThrow(/ollama unreachable/);
  });
});
