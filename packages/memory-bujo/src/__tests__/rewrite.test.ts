import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteBullet } from "../daily.js";
import { parseDailyFile } from "../grammar.js";

describe("rewriteBullet", () => {
  it("patches a bullet's status/text in place, preserving other lines", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    const file = "daily/2026-06-15.md";
    writeFileSync(join(root, file), [
      "# 2026-06-15", "",
      "- [ ] task one  <!--mem id=01A type=task status=open salience=0.5 isInsight=0 created=2026-06-15T09:00:00.000Z refs=-->",
      "prose line",
      "- – note two  <!--mem id=01B type=note status=open salience=0.5 isInsight=0 created=2026-06-15T09:00:00.000Z refs=-->",
      "",
    ].join("\n"));
    const ok = rewriteBullet(root, file, "01A", { status: "done", text: "task one (done)" });
    expect(ok).toBe(true);
    const parsed = parseDailyFile(readFileSync(join(root, file), "utf8"));
    const a = parsed.bullets.find((b) => b.id === "01A");
    expect(a).toMatchObject({ status: "done", text: "task one (done)" });
    expect(parsed.bullets.find((b) => b.id === "01B")?.text).toBe("note two"); // untouched
    expect(readFileSync(join(root, file), "utf8")).toContain("prose line"); // prose preserved
  });

  it("returns false when the id is not present", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(join(root, "daily/2026-06-15.md"), "# 2026-06-15\n");
    expect(rewriteBullet(root, "daily/2026-06-15.md", "nope", { status: "done" })).toBe(false);
  });
});
