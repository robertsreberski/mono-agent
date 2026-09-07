import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import type { MemoryRecord } from "../types.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function record(id: string, createdAt: string, text = id, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.5,
    isInsight: false,
    createdAt,
    lastAccessedAt: "2026-01-01T00:00:00.000Z",
    accessCount: 7,
    tags: [],
    source: { file: "daily/2026-09-01.md", line: 1 },
    ...over,
  };
}

describe("MemoryDb chronological journal browse", () => {
  it("orders parsed instants then ids and applies a half-open range", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    try {
      await db.upsertMany([
        record("lower", "2026-09-01T00:00:00.000Z"),
        record("same-b", "2026-09-01T11:00:00.000+02:00"),
        record("same-a", "2026-09-01T09:00:00.000Z"),
        record("later", "2026-09-01T10:00:00.000Z"),
        record("upper", "2026-09-02T00:00:00.000Z"),
      ]);

      const snapshot = db.browseJournal({
        fromInclusive: "2026-09-01T00:00:00.000Z",
        toExclusive: "2026-09-02T00:00:00.000Z",
        maxEntries: 20,
        maxBytes: 10_000,
      });

      expect(snapshot.records.map(({ id }) => id)).toEqual(["lower", "same-a", "same-b", "later"]);
      expect(snapshot.rangeScanComplete).toBe(true);
      expect(snapshot.truncatedBy).toEqual([]);
      expect(snapshot.lastIncluded).toEqual({ createdAt: "2026-09-01T10:00:00.000Z", id: "later" });
    } finally {
      db.close();
    }
  });

  it("uses one sentinel to report deterministic entry and UTF-8 byte truncation", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    try {
      await db.upsertMany([
        record("a", "2026-09-01T01:00:00.000Z", "one"),
        record("b", "2026-09-01T02:00:00.000Z", "éé"),
        record("c", "2026-09-01T03:00:00.000Z", "three"),
      ]);
      const input = {
        fromInclusive: "2026-09-01T00:00:00.000Z",
        toExclusive: "2026-09-02T00:00:00.000Z",
      };

      expect(db.browseJournal({ ...input, maxEntries: 2, maxBytes: 10_000 })).toMatchObject({
        records: [{ id: "a" }, { id: "b" }],
        rangeScanComplete: false,
        truncatedBy: ["entries"],
        lastIncluded: { createdAt: "2026-09-01T02:00:00.000Z", id: "b" },
      });
      const firstRecordBytes = Buffer.byteLength(JSON.stringify(db.get("a")), "utf8");
      expect(db.browseJournal({ ...input, maxEntries: 10, maxBytes: firstRecordBytes + 3 })).toMatchObject({
        records: [{ id: "a" }],
        rangeScanComplete: false,
        truncatedBy: ["bytes"],
        lastIncluded: { createdAt: "2026-09-01T01:00:00.000Z", id: "a" },
      });
    } finally {
      db.close();
    }
  });

  it("excludes dropped and malformed timestamps without changing access telemetry", async () => {
    const db = openMemoryDb({ path: ":memory:" });
    try {
      await db.upsertMany([
        record("kept", "2026-09-01T01:00:00.000Z"),
        record("forgotten", "2026-09-01T02:00:00.000Z", "must never return", { status: "dropped" }),
        record("malformed", "not-a-date", "must never return"),
      ]);
      const before = db.get("kept");
      const snapshot = db.browseJournal({
        fromInclusive: "2026-09-01T00:00:00.000Z",
        toExclusive: "2026-09-02T00:00:00.000Z",
        maxEntries: 10,
        maxBytes: 10_000,
      });
      expect(snapshot.records.map(({ id }) => id)).toEqual(["kept"]);
      expect(db.get("kept")).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("installs the expression index while an older read-only database remains browseable", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-journal-index-"));
    roots.push(root);
    const path = join(root, "memory.db");
    const writable = openMemoryDb({ path });
    await writable.upsert(record("kept", "2026-09-01T01:00:00.000Z"));
    writable.checkpoint();
    writable.close();

    const raw = new BetterSqlite3(path);
    expect(raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_created_instant_id'",
    ).get()).toMatchObject({ sql: expect.stringContaining("julianday(created_at)") });
    raw.exec("DROP INDEX idx_memories_created_instant_id");
    raw.close();

    const readOnly = openMemoryDb({ path, readOnly: true });
    try {
      expect(readOnly.browseJournal({
        fromInclusive: "2026-09-01T00:00:00.000Z",
        toExclusive: "2026-09-02T00:00:00.000Z",
        maxEntries: 10,
        maxBytes: 10_000,
      }).records.map(({ id }) => id)).toEqual(["kept"]);
    } finally {
      readOnly.close();
    }
  });
});
