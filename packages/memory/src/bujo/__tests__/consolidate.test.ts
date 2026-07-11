import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import type { EmbeddingProvider } from "../../search/index.js";
import { appendBullet, dailyFilePath } from "../daily.js";
import { writeCaptureIntent, type CaptureIntentHandle } from "../capture-outbox.js";
import { consolidateBujoMemory } from "../consolidate.js";
import { parseDailyFile } from "../grammar.js";
import { migrate } from "../migrate.js";
import { fakeEmbeddings } from "./helpers.js";
import type { Bullet } from "../types.js";

function recordFor(root: string, bullet: Bullet, when: Date): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, when)) },
  };
}

function stageNoopCapture(root: string, bullet: Bullet, when: Date): CaptureIntentHandle {
  return writeCaptureIntent(root, [{
    candidateIndex: 0,
    kind: "noop",
    id: bullet.id,
    expected: { file: relative(root, dailyFilePath(root, when)), bullet },
  }], { entities: [], relations: [], associations: [] }, when.toISOString());
}

describe("consolidateBujoMemory", () => {
  it("decays salience, folds repeated facts by normalized text, and writes deterministic projections", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-consolidate-"));
    const now = new Date("2026-07-06T12:00:00.000Z");
    const olderDate = new Date("2026-06-01T09:00:00.000Z");
    const newerDate = new Date("2026-06-02T09:00:00.000Z");
    const db = openMemoryDb({ path: join(root, "memory.db"), clock: () => now });
    const older: Bullet = {
      id: "OLD",
      type: "note",
      status: "open",
      text: "Morgan prefers opt-in memory.",
      salience: 0.8,
      isInsight: false,
      createdAt: olderDate.toISOString(),
      refs: [],
    };
    const newer: Bullet = {
      id: "NEW",
      type: "note",
      status: "open",
      text: "morgan prefers opt in memory",
      salience: 0.7,
      isInsight: false,
      createdAt: newerDate.toISOString(),
      refs: [],
    };
    const unique: Bullet = {
      id: "UNIQUE",
      type: "note",
      status: "open",
      text: "The launch date is March 3rd.",
      salience: 0.6,
      isInsight: false,
      createdAt: newerDate.toISOString(),
      refs: [],
    };

    appendBullet(root, older, olderDate);
    appendBullet(root, newer, newerDate);
    appendBullet(root, unique, newerDate);
    await db.upsert(recordFor(root, older, olderDate));
    await db.upsert(recordFor(root, newer, newerDate));
    await db.upsert(recordFor(root, unique, newerDate));

    const result = await consolidateBujoMemory({ root, db, now });

    expect(result.decayed).toBeGreaterThan(0);
    expect(result.duplicateGroups).toBe(1);
    expect(result.superseded).toBe(1);
    expect(result.markdownInvalidated).toBe(1);
    expect(db.get("OLD")).toMatchObject({ status: "invalidated", supersededBy: "NEW" });
    expect(db.edges("OLD")).toContainEqual(expect.objectContaining({ src: "OLD", dst: "NEW", kind: "supersedes" }));

    const olderDaily = readFileSync(dailyFilePath(root, olderDate), "utf8");
    expect(olderDaily).toContain("Morgan prefers opt-in memory.");
    expect(parseDailyFile(olderDaily).bullets[0]).toMatchObject({ id: "OLD", status: "invalidated" });

    expect(existsSync(join(root, "index.md"))).toBe(true);
    expect(readFileSync(join(root, "index.md"), "utf8")).toContain("# Index");
    expect(readFileSync(join(root, "future-log.md"), "utf8")).toBe("# Future Log\n");

    db.close();
  });

  it("does not call embeddings when folding duplicates during consolidation", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-consolidate-no-embed-"));
    const now = new Date("2026-07-06T12:00:00.000Z");
    const olderDate = new Date("2026-06-01T09:00:00.000Z");
    const newerDate = new Date("2026-06-02T09:00:00.000Z");
    const base = fakeEmbeddings(64);
    let calls = 0;
    let fail = false;
    const embeddings: EmbeddingProvider = {
      id: "flaky",
      embed: async (texts) => {
        calls += 1;
        if (fail) throw new Error("embedding provider down");
        return base.embed(texts);
      },
    };
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: 64, clock: () => now });
    const older: Bullet = {
      id: "OLD",
      type: "note",
      status: "open",
      text: "Morgan prefers opt-in memory.",
      salience: 0.8,
      isInsight: false,
      createdAt: olderDate.toISOString(),
      refs: [],
    };
    const newer: Bullet = {
      id: "NEW",
      type: "note",
      status: "open",
      text: "morgan prefers opt in memory",
      salience: 0.7,
      isInsight: false,
      createdAt: newerDate.toISOString(),
      refs: [],
    };

    appendBullet(root, older, olderDate);
    appendBullet(root, newer, newerDate);
    await db.upsert(recordFor(root, older, olderDate));
    await db.upsert(recordFor(root, newer, newerDate));
    expect(calls).toBe(2);

    fail = true;
    const result = await consolidateBujoMemory({ root, db, now });

    expect(calls).toBe(2);
    expect(result.superseded).toBe(1);
    expect(db.get("OLD")).toMatchObject({ status: "invalidated", supersededBy: "NEW" });
    expect(db.edges("OLD")).toContainEqual(expect.objectContaining({ src: "OLD", dst: "NEW", kind: "supersedes" }));
    expect(parseDailyFile(readFileSync(dailyFilePath(root, olderDate), "utf8")).bullets[0]).toMatchObject({
      id: "OLD",
      status: "invalidated",
    });
    expect(readFileSync(join(root, "index.md"), "utf8")).toContain("# Index");
    expect(readFileSync(join(root, "future-log.md"), "utf8")).toBe("# Future Log\n");
    db.close();
  });

  it("recovers a pending migration before consolidation changes state", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-consolidate-migration-"));
    const now = new Date("2026-08-20T12:00:00.000Z");
    const created = new Date("2026-06-01T09:00:00.000Z");
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    const bullet: Bullet = {
      id: "CONSOLIDATE-MIGRATION",
      type: "note",
      status: "open",
      text: "consolidation must observe recovered migration",
      salience: 0.2,
      isInsight: false,
      createdAt: created.toISOString(),
      refs: [],
    };
    appendBullet(root, bullet, created);
    await db.upsert(recordFor(root, bullet, created));
    const migrationLlm = vi.fn(async () => JSON.stringify({ action: "promote" }));
    await expect(migrate({
      db,
      root,
      llm: { id: "migration", complete: migrationLlm },
      nextId: () => "unused",
      now: () => now,
      hooks: { afterDecisionDurable: () => { throw new Error("leave-consolidate-migration-pending"); } },
    })).rejects.toThrow("leave-consolidate-migration-pending");
    const monthly = join(root, "monthly", "2026-08.md");
    const originalApplyDecay = db.applyDecay.bind(db);
    const decay = vi.spyOn(db, "applyDecay").mockImplementation((at, options) => {
      expect(readFileSync(monthly, "utf8")).not.toContain("mono-agent-migrate:");
      expect(db.get(bullet.id)?.salience).toBe(0.5);
      return originalApplyDecay(at, options);
    });
    const embeddings = vi.spyOn(db, "prepareUpsertVectors");

    const result = await consolidateBujoMemory({ root, db, now });

    expect(result.duplicateGroups).toBe(0);
    expect(decay).toHaveBeenCalledTimes(1);
    expect(migrationLlm).toHaveBeenCalledTimes(1);
    expect(embeddings).not.toHaveBeenCalled();
    expect(readFileSync(monthly, "utf8")).not.toContain("mono-agent-migrate:");
    db.close();
  });

  it("replays a pending capture before consolidation changes state", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-consolidate-capture-"));
    const now = new Date("2026-07-06T12:00:00.000Z");
    const created = new Date("2026-07-01T09:00:00.000Z");
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    const bullet: Bullet = {
      id: "CONSOLIDATE-CAPTURE",
      type: "note",
      status: "open",
      text: "consolidation must observe replayed capture",
      salience: 0.6,
      isInsight: false,
      createdAt: created.toISOString(),
      refs: [],
    };
    appendBullet(root, bullet, created);
    await db.upsert(recordFor(root, bullet, created));
    const handle = stageNoopCapture(root, bullet, created);
    const originalApplyDecay = db.applyDecay.bind(db);
    const decay = vi.spyOn(db, "applyDecay").mockImplementation((at, options) => {
      expect(existsSync(join(root, handle.file))).toBe(false);
      return originalApplyDecay(at, options);
    });
    const embeddings = vi.spyOn(db, "prepareUpsertVectors");

    const result = await consolidateBujoMemory({ root, db, now });

    expect(result.duplicateGroups).toBe(0);
    expect(decay).toHaveBeenCalledTimes(1);
    expect(embeddings).not.toHaveBeenCalled();
    expect(existsSync(join(root, handle.file))).toBe(false);
    db.close();
  });
});
