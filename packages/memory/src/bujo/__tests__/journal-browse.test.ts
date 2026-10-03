import { projectSummary } from "./helpers.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { appendAuditBullet } from "../daily.js";
import { createBujoMemoryStore } from "../store.js";
import { cleanupBujoFixtures, createBujoFixture } from "./bundle-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  cleanupBujoFixtures();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function record(
  id: string,
  source: MemoryRecord["source"],
  over: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    type: "note",
    status: "open",
    text: `journal ${id}`,
    salience: 0.5,
    isInsight: false,
    createdAt: "2026-09-01T10:00:00.000Z",
    accessCount: 0,
    tags: [],
    source,
    ...over,
  };
}

const RANGE = {
  fromInclusive: "2026-09-01T00:00:00.000Z",
  toExclusive: "2026-09-02T00:00:00.000Z",
  maxEntries: 100,
  maxBytes: 10_000,
} as const;

describe("BujoMemoryStore journal browse capability", () => {
  it("is affirmative in writable and read-only Lite stores with the same snapshot", async () => {
    const parent = mkdtempSync(join(tmpdir(), "memory-journal-lite-"));
    roots.push(parent);
    const configuredRoot = join(parent, "memory");
    mkdirSync(configuredRoot, { mode: 0o700 });
    const root = realpathSync(configuredRoot);
    const writable = createBujoMemoryStore({
      root,
      tier: "lite",
      clock: () => new Date("2026-09-01T10:00:00.000Z"),
    });
    expect(writable.supportsJournalBrowse()).toBe(true);
    await projectSummary(writable, "conversation-private", "Synthetic Lite journal entry.");
    const writableSnapshot = await writable.browseJournal(RANGE);
    await writable.close();

    const readOnly = createBujoMemoryStore({ root, tier: "lite", readOnly: true });
    try {
      expect(readOnly.supportsJournalBrowse()).toBe(true);
      expect(await readOnly.browseJournal(RANGE)).toEqual(writableSnapshot);
    } finally {
      await readOnly.close();
    }
  });

  it("affirms Journal and BuJo without invoking embedding or LLM providers", async () => {
    const fixture = await createBujoFixture({
      prefix: "memory-journal-bujo-tier",
      bullets: [{ id: "curated", text: "Curated BuJo summary.", day: "2026-09-01" }],
    });
    let providerCalls = 0;
    const throwingEmbeddings = {
      id: fixture.embeddings.id,
      async embed(): Promise<number[][]> {
        providerCalls += 1;
        throw new Error("journal browse must not embed");
      },
    };
    const bujo = createBujoMemoryStore({
      root: fixture.root,
      tier: "bujo",
      readOnly: true,
      embeddings: throwingEmbeddings,
      dim: fixture.dim,
    });
    try {
      expect(bujo.supportsJournalBrowse()).toBe(true);
      expect((await bujo.browseJournal(RANGE)).records.map(({ id }) => id)).toEqual(["curated"]);
      expect(providerCalls).toBe(0);
    } finally {
      await bujo.close();
    }

    const parent = mkdtempSync(join(tmpdir(), "memory-journal-journal-tier-"));
    roots.push(parent);
    const configuredRoot = join(parent, "memory");
    mkdirSync(configuredRoot, { mode: 0o700 });
    const root = realpathSync(configuredRoot);
    const dbPath = join(root, "memory.db");
    const seed = openMemoryDb({ path: dbPath, embeddings: fixture.embeddings, dim: fixture.dim });
    await seed.upsert(record("journal-tier", { file: "daily/2026-09-01.md" }));
    seed.checkpoint();
    seed.close();
    const journal = createBujoMemoryStore({
      root,
      dbPath,
      tier: "journal",
      readOnly: true,
      embeddings: throwingEmbeddings,
      dim: fixture.dim,
    });
    try {
      expect(journal.supportsJournalBrowse()).toBe(true);
      expect((await journal.browseJournal(RANGE)).records.map(({ id }) => id)).toEqual(["journal-tier"]);
      expect(providerCalls).toBe(0);
    } finally {
      await journal.close();
    }
  });

  it("returns only canonical daily provenance and reports excluded index rows", async () => {
    const parent = mkdtempSync(join(tmpdir(), "memory-journal-provenance-"));
    roots.push(parent);
    const configuredRoot = join(parent, "memory");
    mkdirSync(configuredRoot, { mode: 0o700 });
    const root = realpathSync(configuredRoot);
    const dbPath = join(root, "memory.db");
    const db = openMemoryDb({ path: dbPath });
    await db.upsertMany([
      record("modern", { file: "daily/2026-09-01.md", line: 2 }),
      record("legacy", { file: "2026-09-01.md", line: 3 }),
      record("missing", {}),
      record("unsafe", { file: "../private.md" }),
      record("audit-shaped", { file: "audit/2026-09-01.md" }),
      record("dropped", { file: "daily/2026-09-01.md" }, { status: "dropped", text: "forgotten secret" }),
    ]);
    db.checkpoint();
    db.close();
    appendAuditBullet(root, {
      id: "raw-audit-only",
      type: "note",
      status: "open",
      text: "Raw audit observation must stay absent.",
      salience: 0.5,
      isInsight: false,
      createdAt: "2026-09-01T11:00:00.000Z",
      refs: [],
    }, new Date("2026-09-01T11:00:00.000Z"));

    const store = createBujoMemoryStore({ root, dbPath, tier: "lite", readOnly: true });
    try {
      const snapshot = await store.browseJournal(RANGE);
      expect(snapshot.records.map(({ id }) => id)).toEqual(["legacy", "modern"]);
      expect(snapshot.nonJournalProvenanceExcluded).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("forgotten secret");
      expect(JSON.stringify(snapshot)).not.toContain("Raw audit observation");
      expect(JSON.stringify(snapshot)).not.toContain("../private.md");
    } finally {
      await store.close();
    }
  });

  it("applies the entry budget only after excluding a saturated unsafe provenance prefix", async () => {
    const parent = mkdtempSync(join(tmpdir(), "memory-journal-entry-eligibility-"));
    roots.push(parent);
    const configuredRoot = join(parent, "memory");
    mkdirSync(configuredRoot, { mode: 0o700 });
    const root = realpathSync(configuredRoot);
    const dbPath = join(root, "memory.db");
    const db = openMemoryDb({ path: dbPath });
    await db.upsertMany([
      ...Array.from({ length: 1_000 }, (_, index) => record(
        `unsafe-${String(index).padStart(4, "0")}`,
        { file: "audit/2026-09-01.md" },
        { createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, 0, index)).toISOString() },
      )),
      record("eligible", { file: "daily/2026-09-01.md" }, { createdAt: "2026-09-01T01:00:00.000Z" }),
    ]);
    db.checkpoint();
    db.close();

    const store = createBujoMemoryStore({ root, dbPath, tier: "lite", readOnly: true });
    try {
      const snapshot = await store.browseJournal({
        ...RANGE,
        maxEntries: 1_000,
        maxBytes: 2 * 1024 * 1024,
      });
      expect(snapshot.records.map(({ id }) => id)).toEqual(["eligible"]);
      expect(snapshot).toMatchObject({
        rangeScanComplete: true,
        truncatedBy: [],
        nonJournalProvenanceExcluded: true,
        lastIncluded: { id: "eligible" },
      });
    } finally {
      await store.close();
    }
  });

  it("does not charge an oversized unsafe row against the eligible byte budget", async () => {
    const parent = mkdtempSync(join(tmpdir(), "memory-journal-byte-eligibility-"));
    roots.push(parent);
    const configuredRoot = join(parent, "memory");
    mkdirSync(configuredRoot, { mode: 0o700 });
    const root = realpathSync(configuredRoot);
    const dbPath = join(root, "memory.db");
    const db = openMemoryDb({ path: dbPath });
    await db.upsertMany([
      record("unsafe-oversized", { file: "../private.md" }, {
        createdAt: "2026-09-01T00:30:00.000Z",
        text: "x".repeat(20_000),
      }),
      record("eligible-after-oversized", { file: "daily/2026-09-01.md" }, {
        createdAt: "2026-09-01T01:00:00.000Z",
      }),
    ]);
    db.checkpoint();
    db.close();

    const store = createBujoMemoryStore({ root, dbPath, tier: "lite", readOnly: true });
    try {
      const snapshot = await store.browseJournal({ ...RANGE, maxBytes: 1_000 });
      expect(snapshot.records.map(({ id }) => id)).toEqual(["eligible-after-oversized"]);
      expect(snapshot).toMatchObject({
        rangeScanComplete: true,
        truncatedBy: [],
        nonJournalProvenanceExcluded: true,
        lastIncluded: { id: "eligible-after-oversized" },
      });
      expect(JSON.stringify(snapshot)).not.toContain("x".repeat(1_000));
    } finally {
      await store.close();
    }
  });
});
