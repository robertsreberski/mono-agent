import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendBullet, dailyFilePath, rewriteBullet } from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import { readGraph } from "../graph.js";
import { createIdFactory } from "../ids.js";
import { assertNoPendingMigrateDecision, migrate, type MigrateDeps } from "../migrate.js";
import { MemoryModelError } from "../model-error.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
// "now" — 60-day-old memories are aging candidates (createdAt = now - 60d)
const NOW = new Date("2026-06-15T12:00:00.000Z");
const SIXTY_DAYS_AGO = new Date(NOW.getTime() - 60 * 86_400_000);

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-migrate-"));
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({
    path: join(root, "memory.db"),
    embeddings: fakeEmbeddings(DIM),
    dim: DIM,
  });
  openDbs.push(db);
  return db;
}

function closeDb(db: MemoryDb): void {
  const index = openDbs.indexOf(db);
  if (index >= 0) openDbs.splice(index, 1);
  db.close();
}

/** Seed an aging memory: append a bullet to the daily file and upsert with old createdAt + low salience. */
async function seedAging(
  db: MemoryDb,
  root: string,
  id: string,
  text: string,
  opts: { salience?: number } = {},
): Promise<void> {
  const bullet: Bullet = {
    id,
    type: "note",
    status: "open",
    text,
    salience: opts.salience ?? 0.2,
    isInsight: false,
    createdAt: SIXTY_DAYS_AGO.toISOString(),
    refs: [],
  };
  // Write to daily file dated at SIXTY_DAYS_AGO so we can locate it via source.file
  appendBullet(root, bullet, SIXTY_DAYS_AGO);
  const record: MemoryRecord = {
    id,
    type: "note",
    status: "open",
    text,
    salience: bullet.salience,
    isInsight: false,
    createdAt: SIXTY_DAYS_AGO.toISOString(),
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, SIXTY_DAYS_AGO)) },
  };
  await db.upsert(record);
}

function makeDeps(
  db: MemoryDb,
  root: string,
  overrides: Partial<MigrateDeps> = {},
): MigrateDeps {
  return {
    db,
    root,
    llm: fakeLlm([]),
    nextId: createIdFactory({ clock: () => NOW, random: () => 0 }),
    now: () => NOW,
    ...overrides,
  };
}

function dailyContent(root: string, when: Date): string {
  return readFileSync(dailyFilePath(root, when), "utf8");
}

describe("migrate", () => {
  it("applies all four actions (promote / reschedule / cluster / forget) and writes monthly record", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Seed 4 aging low-salience memories
    await seedAging(db, root, "MIG-PROMOTE", "learn more about type theory fundamentals");
    await seedAging(db, root, "MIG-RESCHEDULE", "review quarterly goals and OKRs");
    await seedAging(db, root, "MIG-CLUSTER", "read book on stoicism and resilience");
    await seedAging(db, root, "MIG-FORGET", "buy milk from the corner store");

    // Script the fake LLM: key on each item's unique text fragment
    const dueAt = "2026-07-01T00:00:00.000Z";
    const llm = fakeLlm([
      ["type theory", JSON.stringify({ action: "promote" })],
      ["quarterly goals", JSON.stringify({ action: "reschedule", dueAt })],
      ["stoicism", JSON.stringify({ action: "cluster", collection: "books" })],
      ["buy milk", JSON.stringify({ action: "forget" })],
    ]);

    const result = await migrate(makeDeps(db, root, { llm }));

    // Counts
    expect(result.promoted).toBe(1);
    expect(result.rescheduled).toBe(1);
    expect(result.clustered).toBe(1);
    expect(result.forgotten).toBe(1);
    expect(result.reviewed).toBe(4);

    // --- promote: salience raised in db + in the daily file ---
    const promoted = db.get("MIG-PROMOTE");
    expect(promoted).toBeDefined();
    expect(promoted!.salience).toBeCloseTo(0.2 + 0.3, 5);

    const promotedFile = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO));
    const promotedBullet = promotedFile.bullets.find((b) => b.id === "MIG-PROMOTE");
    expect(promotedBullet).toBeDefined();
    expect(promotedBullet!.salience).toBeCloseTo(0.2 + 0.3, 5);

    // --- reschedule: status scheduled + dueAt in db + in the daily file ---
    const rescheduled = db.get("MIG-RESCHEDULE");
    expect(rescheduled).toBeDefined();
    expect(rescheduled!.status).toBe("scheduled");
    expect(rescheduled!.dueAt).toBe(dueAt);

    const rescheduledBullet = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (b) => b.id === "MIG-RESCHEDULE",
    );
    expect(rescheduledBullet).toBeDefined();
    expect(rescheduledBullet!.status).toBe("scheduled");
    expect(rescheduledBullet!.dueAt).toBe(dueAt);

    // --- cluster: collection set in db + collection entity + supports edge ---
    const clustered = db.get("MIG-CLUSTER");
    expect(clustered).toBeDefined();
    expect(clustered!.status).toBe("migrated");
    expect(clustered!.collection).toBe("books");
    expect(parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (b) => b.id === "MIG-CLUSTER",
    )?.status).toBe("migrated");

    const collectionEntity = db.getEntity("collection:books");
    expect(collectionEntity).toBeDefined();
    expect(collectionEntity!.id).toBe("collection:books");
    expect(collectionEntity!.type).toBe("collection");

    const clusterEdges = db.edges("MIG-CLUSTER");
    expect(clusterEdges.some((e) => e.kind === "supports" && e.dst === "collection:books")).toBe(true);
    expect(readGraph(root)).toMatchObject({
      entities: [expect.objectContaining({ id: "collection:books", name: "books", type: "collection" })],
      associations: [expect.objectContaining({
        memoryId: "MIG-CLUSTER",
        entityId: "collection:books",
        provenance: "capture",
      })],
    });

    // --- forget: status dropped + validTo in db + daily line struck ---
    const forgotten = db.get("MIG-FORGET");
    expect(forgotten).toBeDefined();
    expect(forgotten!.status).toBe("dropped");
    expect(forgotten!.validTo).toBe(NOW.toISOString());

    const forgottenBullet = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (b) => b.id === "MIG-FORGET",
    );
    expect(forgottenBullet).toBeDefined();
    expect(forgottenBullet!.status).toBe("dropped");

    // --- monthly/<YYYY-MM>.md exists and lists the actions ---
    const monthlyPath = join(root, "monthly", "2026-06.md");
    expect(existsSync(monthlyPath)).toBe(true);
    const monthlyContent = readFileSync(monthlyPath, "utf8");
    expect(monthlyContent).toContain("promote");
    expect(monthlyContent).toContain("MIG-PROMOTE");
    expect(monthlyContent).toContain("reschedule");
    expect(monthlyContent).toContain("MIG-RESCHEDULE");
    expect(monthlyContent).toContain("cluster");
    expect(monthlyContent).toContain("MIG-CLUSTER");
    expect(monthlyContent).toContain("forget");
    expect(monthlyContent).toContain("MIG-FORGET");
    expect(monthlyContent).not.toContain("mono-agent-migrate:");
  });

  it("refuses a symlinked monthly directory without writing outside the memory root", async () => {
    const root = newRoot();
    const outside = mkdtempSync(join(tmpdir(), "bujo-migrate-outside-"));
    const db = openDb(root);
    await seedAging(db, root, "MIG-LINK", "monthly path confinement sentinel");
    symlinkSync(outside, join(root, "monthly"), "dir");
    const llm = fakeLlm([["path confinement", JSON.stringify({ action: "promote" })]]);

    await expect(migrate(makeDeps(db, root, { llm }))).rejects.toThrow(/directory.*symlink/iu);
    expect(existsSync(join(outside, "2026-06.md"))).toBe(false);
    expect(db.get("MIG-LINK")?.salience).toBe(0.2);
  });

  it.each(["after-decision", "after-action"] as const)(
    "replays a durable pending decision after restart without another model call (%s)",
    async (fault) => {
      const root = newRoot();
      let db = openDb(root);
      await seedAging(db, root, "MIG-RETRY", "retry-safe monthly migration sentinel");
      const firstLlm = vi.fn(async () => JSON.stringify({ action: "promote" }));

      await expect(migrate(makeDeps(db, root, {
        llm: { id: "first", complete: firstLlm },
        hooks: fault === "after-decision"
          ? { afterDecisionDurable: () => { throw new Error("fault-after-decision"); } }
          : { afterActionCommitted: () => { throw new Error("fault-after-action"); } },
      }))).rejects.toThrow(`fault-${fault}`);

      expect(firstLlm).toHaveBeenCalledTimes(1);
      expect(db.get("MIG-RETRY")?.salience).toBe(fault === "after-decision" ? 0.2 : 0.5);
      const monthly = readFileSync(join(root, "monthly", "2026-06.md"), "utf8");
      expect(monthly).toContain("mono-agent-migrate:");
      expect(monthly).not.toContain("mono-agent-migrate:complete:");
      expect(() => assertNoPendingMigrateDecision(root)).toThrow(/durable decision.*pending/iu);

      closeDb(db);
      db = openDb(root);
      const retryLlm = vi.fn(async () => { throw new Error("retry must not call the LLM"); });
      const retried = await migrate(makeDeps(db, root, { llm: { id: "retry", complete: retryLlm } }));

      expect(retryLlm).not.toHaveBeenCalled();
      expect(retried).toMatchObject({ promoted: 1, reviewed: 1 });
      expect(db.get("MIG-RETRY")?.salience).toBe(0.5);
      expect(parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets[0]?.salience).toBe(0.5);
      const recoveredMonthly = readFileSync(join(root, "monthly", "2026-06.md"), "utf8");
      expect(recoveredMonthly).toContain("- promote MIG-RETRY");
      expect(recoveredMonthly).not.toContain("mono-agent-migrate:");
      expect(() => assertNoPendingMigrateDecision(root)).not.toThrow();
    },
  );

  it("promotes very-low-salience memories out of the aging pool", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-LOW", "very low salience promotion sentinel", { salience: 0 });
    const firstLlm = vi.fn(async () => JSON.stringify({ action: "promote" }));

    const first = await migrate(makeDeps(db, root, { llm: { id: "first", complete: firstLlm } }));
    expect(first.promoted).toBe(1);
    expect(db.get("MIG-LOW")?.salience).toBe(0.5);

    const retryLlm = vi.fn(async () => { throw new Error("promoted item must leave aging pool"); });
    const retry = await migrate(makeDeps(db, root, { llm: { id: "retry", complete: retryLlm } }));
    expect(retry.reviewed).toBe(0);
    expect(retryLlm).not.toHaveBeenCalled();
  });

  it("recovers a clustered decision into a terminal state without a second LLM call", async () => {
    const root = newRoot();
    let db = openDb(root);
    await seedAging(db, root, "MIG-CLUSTER-RETRY", "cluster retry migration sentinel");
    await expect(migrate(makeDeps(db, root, {
      llm: fakeLlm([["cluster retry", JSON.stringify({ action: "cluster", collection: "retries" })]]),
      hooks: { afterDecisionDurable: () => { throw new Error("crash-after-cluster-decision"); } },
    }))).rejects.toThrow("crash-after-cluster-decision");
    closeDb(db);
    db = openDb(root);
    const retryLlm = vi.fn(async () => { throw new Error("cluster recovery must not call LLM"); });

    const recovered = await migrate(makeDeps(db, root, { llm: { id: "retry", complete: retryLlm } }));

    expect(retryLlm).not.toHaveBeenCalled();
    expect(recovered).toMatchObject({ clustered: 1, reviewed: 1 });
    expect(db.get("MIG-CLUSTER-RETRY")).toMatchObject({ status: "migrated", collection: "retries" });
    expect(parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (b) => b.id === "MIG-CLUSTER-RETRY",
    )?.status).toBe("migrated");
    expect(readGraph(root).associations).toEqual([
      expect.objectContaining({
        memoryId: "MIG-CLUSTER-RETRY",
        entityId: "collection:retries",
        provenance: "capture",
      }),
    ]);
  });

  it("fails closed when canonical source changes after a pending decision is durable", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-CONFLICT", "canonical conflict migration sentinel");
    await expect(migrate(makeDeps(db, root, {
      llm: fakeLlm([["canonical conflict", JSON.stringify({ action: "promote" })]]),
      hooks: { afterDecisionDurable: () => { throw new Error("crash-after-decision"); } },
    }))).rejects.toThrow("crash-after-decision");
    const source = relative(root, dailyFilePath(root, SIXTY_DAYS_AGO));
    expect(rewriteBullet(root, source, "MIG-CONFLICT", { text: "An intervening canonical edit." })).toBe(true);
    const retryLlm = vi.fn(async () => { throw new Error("must not call model on conflict"); });

    await expect(migrate(makeDeps(db, root, {
      llm: { id: "retry", complete: retryLlm },
    }))).rejects.toThrow(/no longer matches|canonical/iu);

    expect(retryLlm).not.toHaveBeenCalled();
    expect(db.get("MIG-CONFLICT")?.salience).toBe(0.2);
    expect(readFileSync(join(root, "monthly", "2026-06.md"), "utf8")).toContain("mono-agent-migrate:");
  });

  it("fails closed on a corrupted pending marker instead of silently paying for another decision", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-CORRUPT", "corrupted marker migration sentinel");
    await expect(migrate(makeDeps(db, root, {
      llm: fakeLlm([["corrupted marker", JSON.stringify({ action: "promote" })]]),
      hooks: { afterDecisionDurable: () => { throw new Error("crash-after-decision"); } },
    }))).rejects.toThrow("crash-after-decision");
    const monthlyPath = join(root, "monthly", "2026-06.md");
    const corrupted = readFileSync(monthlyPath, "utf8").replace(
      /<!-- mono-agent-migrate:[^\n]+ -->/u,
      "<!-- mono-agent-migrate:not-valid-base64 -->",
    );
    writeFileSync(monthlyPath, corrupted, "utf8");
    const retryLlm = vi.fn(async () => { throw new Error("must not call model on corrupt marker"); });

    await expect(migrate(makeDeps(db, root, {
      llm: { id: "retry", complete: retryLlm },
    }))).rejects.toThrow(/malformed durable pending decision/iu);

    expect(retryLlm).not.toHaveBeenCalled();
    expect(db.get("MIG-CORRUPT")?.salience).toBe(0.2);
  });

  it("surfaces (rethrows) a model failure during migration instead of swallowing it per-item", async () => {
    const root = newRoot();
    const db = openDb(root);

    await seedAging(db, root, "MIG-A", "this item will be reviewed by the migrator");
    await seedAging(db, root, "MIG-B", "stoic philosophy reading list for the weekend");

    // A real model outage fails every call (not per-content). It must surface so the ritual
    // scheduler logs it — not look like a migration that found nothing to do.
    const throwingLlm = {
      id: "throwing-llm",
      complete: async (): Promise<string> => { throw new Error("ollama unavailable"); },
    };

    const err = await migrate(makeDeps(db, root, { llm: throwingLlm })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryModelError);
    expect((err as MemoryModelError).kind).toBe("llm");
    expect((err as MemoryModelError).stage).toBe("migrate");
    expect((err as Error).message).toMatch(/ollama unavailable/);
    // A migration failure must NOT read as a "capture" failure.
    expect((err as Error).message).not.toMatch(/capture/i);
  });

  it("surfaces an embedding outage after one paid decision instead of repeating the LLM across the batch", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-EMBED-A", "first embedding outage sentinel");
    await seedAging(db, root, "MIG-EMBED-B", "second embedding outage sentinel");
    vi.spyOn(db, "prepareUpsertVectors").mockRejectedValue(new Error("embedding provider unavailable"));
    const complete = vi.fn(async () => JSON.stringify({ action: "promote" }));

    const err = await migrate(makeDeps(db, root, {
      llm: { id: "paid-decision", complete },
    })).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(MemoryModelError);
    expect((err as MemoryModelError).kind).toBe("embedding");
    expect((err as MemoryModelError).stage).toBe("migrate");
    expect((err as Error).message).toMatch(/embedding provider unavailable/iu);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(db.get("MIG-EMBED-A")?.salience).toBe(0.2);
    expect(db.get("MIG-EMBED-B")?.salience).toBe(0.2);
    expect(existsSync(join(root, "monthly", "2026-06.md"))).toBe(false);
  });

  it("isolates a genuine per-item data error (missing daily file) without aborting the batch", async () => {
    const root = newRoot();
    const db = openDb(root);

    // A good aging item with a real daily file...
    await seedAging(db, root, "MIG-GOOD", "good item that the migrator forgets");
    // ...and an aging index record whose canonical daily file is MISSING (index/markdown divergence).
    // A "promote" decision will try to rewrite the missing file → a DATA error, isolated per-item.
    await db.upsert({
      id: "MIG-GHOST", type: "note", status: "open", text: "ghost item that the migrator promotes",
      salience: 0.2, isInsight: false, createdAt: SIXTY_DAYS_AGO.toISOString(), accessCount: 0, tags: [],
      source: { file: "daily/2099-01-01.md" },
    });

    const llm = fakeLlm([
      ["ghost item that the migrator promotes", JSON.stringify({ action: "promote" })],
      ["good item that the migrator forgets", JSON.stringify({ action: "forget" })],
    ]);

    // The data error on MIG-GHOST is isolated; the batch is not aborted and does not reject.
    const result = await migrate(makeDeps(db, root, { llm }));

    expect(result.forgotten).toBe(1);
    expect(db.get("MIG-GHOST")!.status).toBe("open"); // unchanged — its write failed and was skipped
    expect(db.get("MIG-GOOD")!.status).toBe("dropped");
  });

  it("skips rewriteBullet when source.file is undefined, still mirrors index", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Upsert a record directly without a source.file (no corresponding disk bullet)
    await db.upsert({
      id: "MIG-NOFILE",
      type: "note",
      status: "open",
      text: "orphaned index record with no file",
      salience: 0.2,
      isInsight: false,
      createdAt: SIXTY_DAYS_AGO.toISOString(),
      accessCount: 0,
      tags: [],
      source: {}, // no file
    });

    const llm = fakeLlm([["orphaned", JSON.stringify({ action: "promote" })]]);

    // Should not throw even though there's no file to rewrite
    const result = await migrate(makeDeps(db, root, { llm }));

    expect(result.promoted).toBe(1);

    const record = db.get("MIG-NOFILE");
    expect(record!.salience).toBeCloseTo(0.2 + 0.3, 5);
  });

  it("skips items with invalid/unrecognized action from LLM", async () => {
    const root = newRoot();
    const db = openDb(root);

    await seedAging(db, root, "MIG-INVALID", "item that gets invalid action from llm");

    const llm = fakeLlm([["invalid action", JSON.stringify({ action: "teleport" })]]);

    const result = await migrate(makeDeps(db, root, { llm }));

    // Reviewed but no action taken
    expect(result.reviewed).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.rescheduled).toBe(0);
    expect(result.clustered).toBe(0);
    expect(result.forgotten).toBe(0);

    // Record unchanged
    expect(db.get("MIG-INVALID")!.status).toBe("open");
  });

  it("returns all-zero counts when no aging items exist", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Seed a fresh high-salience memory (not an aging candidate)
    await db.upsert({
      id: "FRESH",
      type: "note",
      status: "open",
      text: "just captured this moment",
      salience: 0.8,
      isInsight: false,
      createdAt: NOW.toISOString(),
      accessCount: 0,
      tags: [],
      source: {},
    });

    const llm = fakeLlm([["just captured", JSON.stringify({ action: "forget" })]]);

    const result = await migrate(makeDeps(db, root, { llm }));

    expect(result.reviewed).toBe(0);
    expect(result.promoted).toBe(0);
    expect(result.forgotten).toBe(0);
  });
});
