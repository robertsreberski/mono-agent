import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendBullet, dailyFilePath } from "../daily.js";
import { writeCaptureIntent } from "../capture-outbox.js";
import { parseDailyFile } from "../grammar.js";
import { migrate } from "../migrate.js";
import { reflect, type ReflectDeps } from "../reflect.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings } from "./helpers.js";

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
  overrides: Partial<MemoryRecord> = {},
): Promise<Bullet> {
  const bullet: Bullet = {
    id,
    type: overrides.type ?? "note",
    status: overrides.status ?? "open",
    text,
    salience: overrides.salience ?? 0.6,
    isInsight: overrides.isInsight ?? false,
    createdAt: overrides.createdAt ?? FIXED.toISOString(),
    ...(overrides.dueAt === undefined ? {} : { dueAt: overrides.dueAt }),
    refs: [],
  };
  appendBullet(root, bullet, FIXED);
  await db.upsert({
    ...bullet,
    accessCount: overrides.accessCount ?? 0,
    tags: overrides.tags ?? [],
    source: { file: relative(root, dailyFilePath(root, FIXED)) },
  });
  return bullet;
}

function makeDeps(db: MemoryDb, root: string, complete = vi.fn(async () => "[]")): ReflectDeps {
  return {
    db,
    root,
    llm: { id: "must-not-run", complete },
    nextId: () => "MUST-NOT-BE-USED",
    now: () => FIXED,
  };
}

describe("reflect compatibility surface", () => {
  it("reports due count without model, canonical, graph, vector, salience, or lifecycle mutation", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "MEM1", "Morning focus", {
      type: "task",
      status: "scheduled",
      dueAt: new Date(FIXED.getTime() - 1_000).toISOString(),
      salience: 0.8,
    });
    await seed(db, root, "MEM2", "Calendar blocks", { salience: 0.7 });
    await seed(db, root, "MEM3", "No meetings before noon", { salience: 0.6 });
    db.addEdge("MEM2", "MEM3", "supports");
    const source = dailyFilePath(root, FIXED);
    const sourceBefore = readFileSync(source, "utf8");
    const recordsBefore = db.topSalient(50);
    const edgesBefore = db.edges("MEM2");
    const snapshotBefore = db.validationSnapshot();
    const complete = vi.fn(async () => { throw new Error("reflection model must not run"); });
    const decay = vi.spyOn(db, "applyDecay");
    const prepare = vi.spyOn(db, "prepareUpsertVectors");

    await expect(reflect(makeDeps(db, root, complete))).resolves.toEqual({ decayed: 0, insights: 0, due: 1 });

    expect(complete).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(db.topSalient(50)).toEqual(recordsBefore);
    expect(db.edges("MEM2")).toEqual(edgesBefore);
    expect(db.validationSnapshot()).toEqual(snapshotBefore);
    expect(readFileSync(source, "utf8")).toBe(sourceBefore);
    expect(existsSync(join(root, "index.md"))).toBe(false);
    expect(existsSync(join(root, "future-log.md"))).toBe(false);
  });

  it("does not replay a pending capture intent", async () => {
    const root = newRoot();
    const db = openDb(root);
    const bullet = await seed(db, root, "PENDING-CAPTURE", "Pending capture remains operator-visible");
    const source = dailyFilePath(root, FIXED);
    const handle = writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "noop",
      id: bullet.id,
      expected: { file: relative(root, source), bullet: parseDailyFile(readFileSync(source, "utf8")).bullets[0]! },
    }], { entities: [], relations: [], associations: [] }, FIXED.toISOString());
    const intentPath = join(root, handle.file);
    const intentBefore = readFileSync(intentPath, "utf8");

    await expect(reflect(makeDeps(db, root))).resolves.toEqual({ decayed: 0, insights: 0, due: 0 });

    expect(readFileSync(intentPath, "utf8")).toBe(intentBefore);
    expect(db.get(bullet.id)?.status).toBe("open");
  });

  it("does not recover an already-paid migration decision", async () => {
    const root = newRoot();
    const db = openDb(root);
    const migrationNow = new Date("2026-08-20T12:00:00.000Z");
    await seed(db, root, "PENDING-MIGRATION", "Paid migration remains pending", {
      createdAt: new Date("2026-04-01T12:00:00.000Z").toISOString(),
      salience: 0.2,
    });
    await expect(migrate({
      db,
      root,
      llm: { id: "migration", complete: async () => JSON.stringify({ action: "promote" }) },
      nextId: () => "unused",
      now: () => migrationNow,
      hooks: { afterDecisionDurable: () => { throw new Error("leave-reflect-migration-pending"); } },
    })).rejects.toThrow("leave-reflect-migration-pending");
    const monthly = join(root, "monthly", "2026-08.md");
    const monthlyBefore = readFileSync(monthly, "utf8");

    await expect(reflect({ ...makeDeps(db, root), now: () => migrationNow })).resolves.toEqual({
      decayed: 0,
      insights: 0,
      due: 0,
    });

    expect(readFileSync(monthly, "utf8")).toBe(monthlyBefore);
    expect(db.get("PENDING-MIGRATION")?.salience).toBe(0.2);
  });

  it("honors an already-aborted caller before reading due state", async () => {
    const root = newRoot();
    const db = openDb(root);
    const due = vi.spyOn(db, "dueItems");
    const controller = new AbortController();
    controller.abort(new Error("stop reflection"));

    await expect(reflect({ ...makeDeps(db, root), abortSignal: controller.signal })).rejects.toThrow("stop reflection");
    expect(due).not.toHaveBeenCalled();
  });
});
