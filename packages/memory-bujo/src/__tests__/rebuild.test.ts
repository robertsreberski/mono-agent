import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "@mono-agent/memory-store";
import { fakeEmbeddings } from "./helpers.js";
import { rebuildFromMarkdown } from "../rebuild.js";

describe("rebuildFromMarkdown", () => {
  it("indexes every bullet across daily files, with no LLM, deterministically", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rebuild-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(join(root, "daily", "2026-06-14.md"),
      '# 2026-06-14\n\n- [ ] Ship substrate.  <!--mem id=01A type=task status=open salience=0.8 isInsight=0 created=2026-06-14T09:00:00.000Z refs=-->\n');
    writeFileSync(join(root, "daily", "2026-06-15.md"),
      '# 2026-06-15\n\n- – Robert prefers opt-in memory.  <!--mem id=01B type=note status=open salience=0.9 isInsight=1 created=2026-06-15T09:00:00.000Z refs=-->\n');

    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    const result = await rebuildFromMarkdown(root, db);
    expect(result.indexed).toBe(2);
    expect(db.count()).toBe(2);
    expect((await db.recall("substrate", { topK: 2 })).map((h) => h.record.id)).toContain("01A");
    db.close();
  });
});
