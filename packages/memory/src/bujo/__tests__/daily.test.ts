import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendBullet, dailyFilePath, normalizedContentHash, withJournalWriteLock } from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import { createIdFactory } from "../ids.js";
import type { Bullet } from "../types.js";

describe("daily file", () => {
  it("computes the daily path from a date", () => {
    expect(dailyFilePath("/root", new Date("2026-06-15T23:00:00.000Z"))).toBe("/root/daily/2026-06-15.md");
  });

  it("appends a bullet and is re-parseable", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const bullet = appendBullet(root, {
      id: "01TESTID", type: "note", status: "open", text: "A captured fact.", salience: 0.6, isInsight: false, createdAt: now.toISOString(), refs: [],
    }, now);
    const file = readFileSync(dailyFilePath(root, now), "utf8");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets.map((b) => b.id)).toContain("01TESTID");
    expect(bullet.id).toBe("01TESTID");
  });

  it("does not duplicate the daily header on a second append", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const note = (id: string): Bullet => ({
      id, type: "note", status: "open", text: `fact ${id}`, salience: 0.5, isInsight: false, createdAt: now.toISOString(), refs: [],
    });
    appendBullet(root, note("01A"), now);
    appendBullet(root, note("01B"), now);
    const file = readFileSync(dailyFilePath(root, now), "utf8");
    expect((file.match(/^# 2026-06-15$/gmu) ?? []).length).toBe(1);
    expect(parseDailyFile(file).bullets.map((b) => b.id)).toEqual(["01A", "01B"]);
  });

  it("normalizes Unicode/whitespace for hashes without folding case-sensitive facts", () => {
    expect(normalizedContentHash("Token  ABC\nactive")).toBe(normalizedContentHash("Token ABC active"));
    expect(normalizedContentHash("Token ABC active")).not.toBe(normalizedContentHash("Token abc active"));
  });

  it("never steals a live lock or unlinks an identity-replaced lock", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-lock-"));
    expect(() => withJournalWriteLock(root, () => withJournalWriteLock(root, () => undefined))).toThrow(/held/i);

    const lockPath = join(root, ".journal-write.lock");
    withJournalWriteLock(root, () => {
      unlinkSync(lockPath);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, replacement: true }), "utf8");
    });
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("createIdFactory", () => {
  it("is deterministic with injected clock+random and time-sortable", () => {
    const earlier = createIdFactory({ clock: () => new Date("2026-06-15T09:00:00.000Z"), random: () => 0 });
    const later = createIdFactory({ clock: () => new Date("2026-06-15T10:00:00.000Z"), random: () => 0 });
    const a = earlier();
    expect(earlier()).toBe(a); // same clock + random → identical id
    expect(a).toHaveLength(26); // 10 time chars + 16 random chars
    expect(later() > a).toBe(true); // later timestamp → lexicographically larger
  });
});
