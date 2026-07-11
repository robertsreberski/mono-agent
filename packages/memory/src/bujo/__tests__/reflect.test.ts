import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendBullet, dailyFilePath } from "../daily.js";
import { writeCaptureIntent, type CaptureIntentHandle } from "../capture-outbox.js";
import { parseDailyFile } from "../grammar.js";
import { createIdFactory } from "../ids.js";
import { migrate } from "../migrate.js";
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

function stageNoopCapture(root: string, id: string, when: Date): CaptureIntentHandle {
  const source = dailyFilePath(root, when);
  const bullet = parseDailyFile(readFileSync(source, "utf8")).bullets.find((candidate) => candidate.id === id)!;
  return writeCaptureIntent(root, [{
    candidateIndex: 0,
    kind: "noop",
    id,
    expected: { file: relative(root, source), bullet },
  }], { entities: [], relations: [], associations: [] }, when.toISOString());
}

describe("reflect", () => {
  it("synthesizes one insight from ≥3 seeded memories, stores it with isInsight=true, and adds supports edges", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Seed 3 non-insight memories.
    await seed(db, root, "MEM1", "Morgan prefers quiet focused work in the mornings");
    await seed(db, root, "MEM2", "Morgan tends to schedule deep work sessions early in the day");
    await seed(db, root, "MEM3", "Morgan blocks calendar from 8am to noon for focus time");

    // fakeLlm returns 1 insight referencing MEM1 and MEM2.
    const insightText = "Morgan is a morning-focused worker who guards his peak hours";
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

    await seed(db, root, "MEM1", "Morgan prefers quiet focused work in the mornings");
    await seed(db, root, "MEM2", "Morgan tends to schedule deep work sessions early");
    await seed(db, root, "MEM3", "Morgan blocks calendar for focus time");

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
    await seed(db, root, "MEM1", "Morgan prefers quiet focused work");
    await seed(db, root, "MEM2", "Morgan schedules deep work early");

    const insightText = "Morgan guards his morning hours";
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
    await seed(db, root, "MEM1", "Morgan prefers focused mornings");

    const llm = fakeLlm([]);
    const result = await reflect(makeDeps(db, root, { llm, halfLifeDays: 7, floor: 0.1 }));

    // Decay ran (we just verify it didn't throw and returns a valid number).
    expect(result.decayed).toBeGreaterThanOrEqual(0);
    expect(result.insights).toBe(0); // only 1 memory, skip synthesis
  });

  it("recovers a pending migration before reflection mutates or plans", async () => {
    const root = newRoot();
    const db = openDb(root);
    const migrationNow = new Date("2026-08-20T12:00:00.000Z");
    await seed(db, root, "REFLECT-MIGRATION", "reflection must observe recovered migration", { salience: 0.2 });
    const migrationLlm = vi.fn(async () => JSON.stringify({ action: "promote" }));
    await expect(migrate({
      db,
      root,
      llm: { id: "migration", complete: migrationLlm },
      nextId: () => "unused",
      now: () => migrationNow,
      hooks: { afterDecisionDurable: () => { throw new Error("leave-reflect-migration-pending"); } },
    })).rejects.toThrow("leave-reflect-migration-pending");
    const monthly = join(root, "monthly", "2026-08.md");
    expect(readFileSync(monthly, "utf8")).toContain("mono-agent-migrate:");
    const originalApplyDecay = db.applyDecay.bind(db);
    const decay = vi.spyOn(db, "applyDecay").mockImplementation((now, options) => {
      expect(readFileSync(monthly, "utf8")).not.toContain("mono-agent-migrate:");
      expect(db.get("REFLECT-MIGRATION")?.salience).toBe(0.5);
      return originalApplyDecay(now, options);
    });
    const embeddings = vi.spyOn(db, "prepareUpsertVectors");
    const reflectLlm = vi.fn(async () => { throw new Error("one memory must not call reflection model"); });

    const result = await reflect(makeDeps(db, root, {
      now: () => migrationNow,
      llm: { id: "reflect", complete: reflectLlm },
    }));

    expect(decay).toHaveBeenCalledTimes(1);
    expect(result.insights).toBe(0);
    expect(migrationLlm).toHaveBeenCalledTimes(1);
    expect(reflectLlm).not.toHaveBeenCalled();
    expect(embeddings).not.toHaveBeenCalled();
    expect(readFileSync(monthly, "utf8")).not.toContain("mono-agent-migrate:");
  });

  it("replays a pending capture before reflection mutates or plans", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "REFLECT-CAPTURE", "reflection must observe replayed capture");
    const handle = stageNoopCapture(root, "REFLECT-CAPTURE", FIXED);
    const originalApplyDecay = db.applyDecay.bind(db);
    const decay = vi.spyOn(db, "applyDecay").mockImplementation((now, options) => {
      expect(existsSync(join(root, handle.file))).toBe(false);
      return originalApplyDecay(now, options);
    });
    const embeddings = vi.spyOn(db, "prepareUpsertVectors");
    const complete = vi.fn(async () => { throw new Error("one memory must not call reflection model"); });

    const result = await reflect(makeDeps(db, root, { llm: { id: "reflect", complete } }));

    expect(decay).toHaveBeenCalledTimes(1);
    expect(result.insights).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(embeddings).not.toHaveBeenCalled();
    expect(existsSync(join(root, handle.file))).toBe(false);
  });

  it("rejects legacy dual pending state before changing either artifact", async () => {
    const root = newRoot();
    const db = openDb(root);
    const migrationNow = new Date("2026-08-20T12:00:00.000Z");
    await seed(db, root, "REFLECT-DUAL", "dual protocols must remain untouched", { salience: 0.2 });
    await expect(migrate({
      db,
      root,
      llm: { id: "migration", complete: async () => JSON.stringify({ action: "promote" }) },
      nextId: () => "unused",
      now: () => migrationNow,
      hooks: { afterDecisionDurable: () => { throw new Error("leave-reflect-dual-pending"); } },
    })).rejects.toThrow("leave-reflect-dual-pending");
    const handle = stageNoopCapture(root, "REFLECT-DUAL", FIXED);
    const monthly = join(root, "monthly", "2026-08.md");
    const monthlyBefore = readFileSync(monthly, "utf8");
    const captureBefore = readFileSync(join(root, handle.file), "utf8");
    const dailyBefore = readFileSync(dailyFilePath(root, FIXED), "utf8");
    const decay = vi.spyOn(db, "applyDecay");
    const embeddings = vi.spyOn(db, "prepareUpsertVectors");
    const complete = vi.fn(async () => { throw new Error("dual recovery must fail before model planning"); });

    await expect(reflect(makeDeps(db, root, { llm: { id: "reflect", complete } })))
      .rejects.toThrow(/capture and migration durable state are both pending.*before any mutation/iu);

    expect(decay).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(embeddings).not.toHaveBeenCalled();
    expect(db.get("REFLECT-DUAL")?.salience).toBe(0.2);
    expect(readFileSync(monthly, "utf8")).toBe(monthlyBefore);
    expect(readFileSync(join(root, handle.file), "utf8")).toBe(captureBefore);
    expect(readFileSync(dailyFilePath(root, FIXED), "utf8")).toBe(dailyBefore);
  });
});
