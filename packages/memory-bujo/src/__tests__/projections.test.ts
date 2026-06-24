import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDb, type MemoryDb } from "@mono-agent/memory-store";
import { afterEach, describe, expect, it } from "vitest";

import { writeFutureLog, writeIndex } from "../projections.js";
import { fakeEmbeddings } from "./helpers.js";

const DIM = 64;
const FIXED = new Date("2026-06-16T10:00:00.000Z");

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-projections-"));
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
  openDbs.push(db);
  return db;
}

describe("writeFutureLog", () => {
  it("writes future-log.md with scheduled items soonest-first and returns count", async () => {
    const root = newRoot();
    const db = openDb(root);

    // dueAt within horizon (365 days from now)
    const soon = new Date(FIXED.getTime() + 7 * 86_400_000).toISOString();   // 7 days out
    const later = new Date(FIXED.getTime() + 30 * 86_400_000).toISOString(); // 30 days out
    const muchLater = new Date(FIXED.getTime() + 400 * 86_400_000).toISOString(); // beyond 365 day horizon

    await db.upsert({
      id: "SCHED1",
      type: "task",
      status: "scheduled",
      text: "Write quarterly report",
      salience: 0.7,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      dueAt: later,
      source: {},
    });

    await db.upsert({
      id: "SCHED2",
      type: "task",
      status: "open",
      text: "Review team feedback",
      salience: 0.6,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      dueAt: soon,
      source: {},
    });

    await db.upsert({
      id: "SCHED3",
      type: "task",
      status: "scheduled",
      text: "This item is beyond the horizon",
      salience: 0.5,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      dueAt: muchLater,
      source: {},
    });

    // Item with no dueAt should not appear.
    await db.upsert({
      id: "NODUEDATE",
      type: "note",
      status: "open",
      text: "No due date item",
      salience: 0.5,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      source: {},
    });

    const count = writeFutureLog(root, db, FIXED);

    // Only SCHED1 and SCHED2 are within the 365-day horizon.
    expect(count).toBe(2);

    const content = readFileSync(join(root, "future-log.md"), "utf8");
    expect(content).toContain("# Future Log");

    // Both scheduled items must appear.
    expect(content).toContain("SCHED1");
    expect(content).toContain("SCHED2");

    // Item beyond horizon must not appear.
    expect(content).not.toContain("SCHED3");

    // No-due-date item must not appear.
    expect(content).not.toContain("NODUEDATE");

    // Soonest first: SCHED2 (7 days) should appear before SCHED1 (30 days).
    const sched1Pos = content.indexOf("SCHED1");
    const sched2Pos = content.indexOf("SCHED2");
    expect(sched2Pos).toBeLessThan(sched1Pos);

    // Each item uses the BuJo scheduled bullet notation.
    expect(content).toContain("- [<]");

    // Each item includes the ^id anchor.
    expect(content).toContain("^SCHED1");
    expect(content).toContain("^SCHED2");
  });

  it("returns 0 and writes an empty future-log.md when no items are due", async () => {
    const root = newRoot();
    const db = openDb(root);

    const count = writeFutureLog(root, db, FIXED);
    expect(count).toBe(0);

    const content = readFileSync(join(root, "future-log.md"), "utf8");
    expect(content).toContain("# Future Log");
  });

  it("creates the root directory if it does not exist", async () => {
    const base = mkdtempSync(join(tmpdir(), "bujo-projections-mkdir-"));
    const root = join(base, "nested", "subdir");
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });
    openDbs.push(db);

    expect(() => writeFutureLog(root, db, FIXED)).not.toThrow();
  });
});

describe("writeIndex", () => {
  it("writes index.md with counts, top memories, and entities", async () => {
    const root = newRoot();
    const db = openDb(root);

    await db.upsert({
      id: "MEM1",
      type: "note",
      status: "open",
      text: "Morgan works best in the mornings",
      salience: 0.9,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      source: {},
    });

    await db.upsert({
      id: "MEM2",
      type: "note",
      status: "open",
      text: "mono-agent is a personal AI assistant",
      salience: 0.8,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      accessCount: 0,
      tags: [],
      source: {},
    });

    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", createdAt: FIXED.toISOString() });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: FIXED.toISOString() });

    writeIndex(root, db, FIXED);

    const content = readFileSync(join(root, "index.md"), "utf8");

    // Must contain the Overview section with counts.
    expect(content).toContain("## Overview");
    expect(content).toContain("2"); // memory count
    expect(content).toContain("2"); // entity count

    // Must contain Top memories section with at least one memory.
    expect(content).toContain("## Top memories");
    expect(content).toMatch(/Morgan works best|mono-agent is a personal/u);

    // Must contain Entities section with at least one entity.
    expect(content).toContain("## Entities");
    expect(content).toMatch(/Morgan \(person\)|mono-agent \(project\)/u);
  });

  it("creates the root directory if it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "bujo-projections-idx-mkdir-"));
    const root = join(base, "deep", "nested");
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(DIM), dim: DIM });
    openDbs.push(db);

    expect(() => writeIndex(root, db, FIXED)).not.toThrow();

    const content = readFileSync(join(root, "index.md"), "utf8");
    expect(content).toContain("## Overview");
  });
});
