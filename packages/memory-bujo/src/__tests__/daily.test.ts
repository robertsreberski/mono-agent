import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendBullet, dailyFilePath } from "../daily.js";
import { parseDailyFile } from "../grammar.js";

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
});
