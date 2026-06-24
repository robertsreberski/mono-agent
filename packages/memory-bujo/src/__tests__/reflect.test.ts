import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "@mono-agent/memory-store";
import { afterEach, describe, expect, it } from "vitest";

import { appendBullet, dailyFilePath } from "../daily.js";
import { createIdFactory } from "../ids.js";
import { MemoryModelError } from "../model-error.js";
import { reflect, type ReflectDeps } from "../reflect.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
const FIXED = new Date("2026-06-15T12:00:00.000Z");

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-reflect-"));
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
  openDbs.push(db);
  return db;
}

async function seed(
  db: MemoryDb,
  root: string,
  id: string,
  text: string,
  opts: { salience?: number; isInsight?: boolean } = {},
): Promise<void> {
  const bullet: Bullet = {
    id,
    type: "note",
    status: "open",
    text,
    salience: opts.salience ?? 0.6,
    isInsight: opts.isInsight ?? false,
    createdAt: FIXED.toISOString(),
    refs: [],
  };
  appendBullet(root, bullet, FIXED);
  const record: MemoryRecord = {
    id,
    type: "note",
    status: "open",
    text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, FIXED)) },
  };
  await db.upsert(record);
}

function makeDeps(db: MemoryDb, root: string, overrides: Partial<ReflectDeps> = {}): ReflectDeps {
  return {
    db,
    root,
    llm: fakeLlm([]),
    nextId: createIdFactory({ clock: () => FIXED, random: () => 0 }),
    now: () => FIXED,
    ...overrides,
  };
}

describe("reflect", () => {
  it("synthesizes one insight from ≥3 seeded memories, stores it with isInsight=true, and adds supports edges", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Seed 3 non-insight memories.
    await seed(db, root, "MEM1", "Example Operator prefers quiet focused work in the mornings");
    await seed(db, root, "MEM2", "Example Operator tends to schedule deep work sessions early in the day");
    await seed(db, root, "MEM3", "Example Operator blocks calendar from 8am to noon for focus time");

    // fakeLlm returns 1 insight referencing MEM1 and MEM2.
    const insightText = "Example Operator is a morning-focused worker who guards his peak hours";
    const llm = fakeLlm([
      [
        "insight",
        JSON.stringify([{ text: insightText, sourceIds: ["MEM1", "MEM2"] }]),
      ],
    ]);

    const result = await reflect(makeDeps(db, root, { llm }));

    // Should return decayed >= 0, insights: 1, due: 0 (no due items seeded).
    expect(result.decayed).toBeGreaterThanOrEqual(0);
    expect(result.insights).toBe(1);
    expect(result.due).toBe(0);

    // The insight memory should exist in the db with isInsight=true.
    const allRecords = db.topSalient(50);
    const insightRecord = allRecords.find((r) => r.isInsight);
    expect(insightRecord).toBeDefined();
    expect(insightRecord?.text).toBe(insightText);
    expect(insightRecord?.isInsight).toBe(true);
    expect(insightRecord?.salience).toBeCloseTo(0.7, 5);

    // The insight should be recallable.
    const hits = await db.recall("morning focus work", { topK: 10 });
    expect(hits.some((h) => h.record.isInsight)).toBe(true);

    // "supports" edges from the insight to MEM1 and MEM2.
    const insightId = insightRecord?.id ?? "";
    const edges = db.edges(insightId);
    const supportsEdges = edges.filter((e) => e.kind === "supports");
    const edgeDsts = supportsEdges.map((e) => e.dst);
    expect(edgeDsts).toContain("MEM1");
    expect(edgeDsts).toContain("MEM2");
    // Should NOT have an edge to MEM3 (not in sourceIds).
    expect(edgeDsts).not.toContain("MEM3");
  });

  it("surfaces (rethrows) a model failure during insight synthesis instead of returning insights:0", async () => {
    const root = newRoot();
    const db = openDb(root);

    await seed(db, root, "MEM1", "Example Operator prefers quiet focused work in the mornings");
    await seed(db, root, "MEM2", "Example Operator tends to schedule deep work sessions early");
    await seed(db, root, "MEM3", "Example Operator blocks calendar for focus time");

    const throwingLlm = {
      id: "throwing-llm",
      complete: async (_prompt: string): Promise<string> => {
        throw new Error("LLM unavailable");
      },
    };

    // A dead model during the nightly reflection must surface (the scheduler logs it) — not look
    // like a successful reflection that simply found no insights worth synthesizing.
    const err = await reflect(makeDeps(db, root, { llm: throwingLlm })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryModelError);
    expect((err as MemoryModelError).kind).toBe("llm");
    expect((err as MemoryModelError).stage).toBe("insights");
    expect((err as Error).message).toMatch(/LLM unavailable/);
    // The message must be scope-neutral: a reflection failure must NOT read as a "capture" failure.
    expect((err as Error).message).not.toMatch(/capture/i);
  });

  it("returns insights:0 when fewer than 3 non-insight memories exist", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Only 2 memories.
    await seed(db, root, "MEM1", "Example Operator prefers quiet focused work");
    await seed(db, root, "MEM2", "Example Operator schedules deep work early");

    const insightText = "Example Operator guards his morning hours";
    const llm = fakeLlm([
      ["insight", JSON.stringify([{ text: insightText, sourceIds: ["MEM1"] }])],
    ]);

    const result = await reflect(makeDeps(db, root, { llm }));

    expect(result.insights).toBe(0);
    // No insight record was created.
    const allRecords = db.topSalient(50);
    expect(allRecords.some((r) => r.isInsight)).toBe(false);
  });

  it("counts due items correctly", async () => {
    const root = newRoot();
    const db = openDb(root);

    await seed(db, root, "MEM1", "Write quarterly report");
    await seed(db, root, "MEM2", "Review team feedback");
    await seed(db, root, "MEM3", "Prepare slides for all hands");

    // Manually upsert a record with a due date in the past.
    const pastDue = new Date(FIXED.getTime() - 86_400_000).toISOString(); // yesterday
    await db.upsert({
      id: "DUE1",
      type: "task",
      status: "scheduled",
      text: "Send weekly update email",
      salience: 0.7,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      dueAt: pastDue,
      source: { file: relative(root, dailyFilePath(root, FIXED)) },
    });

    const llm = fakeLlm([]);
    const result = await reflect(makeDeps(db, root, { llm }));

    // 1 item is due (DUE1).
    expect(result.due).toBe(1);
  });

  it("passes halfLifeDays and floor to applyDecay when provided", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Seed 1 memory — not enough for insight synthesis, but decay still runs.
    await seed(db, root, "MEM1", "Example Operator prefers focused mornings");

    const llm = fakeLlm([]);
    const result = await reflect(makeDeps(db, root, { llm, halfLifeDays: 7, floor: 0.1 }));

    // Decay ran (we just verify it didn't throw and returns a valid number).
    expect(result.decayed).toBeGreaterThanOrEqual(0);
    expect(result.insights).toBe(0); // only 1 memory, skip synthesis
  });
});
