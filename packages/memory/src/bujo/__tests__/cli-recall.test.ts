import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/index.js";
import { safeRebuildMemoryIndex, serializeBullet } from "../index.js";

const CLI = fileURLToPath(new URL("../../../dist/bujo/cli.js", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("memory-bujo read-only recall", () => {
  it.each(["legacy", "managed"] as const)("returns a hit from a %s index without access writes", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), `memory-bujo-cli-${kind}-`));
    roots.push(root);
    if (kind === "legacy") {
      const db = openMemoryDb({ path: join(root, "memory.db") });
      await db.upsert({
        id: "legacy-hit",
        type: "note",
        status: "open",
        text: "Legacy recall needle is preserved.",
        salience: 0.7,
        isInsight: false,
        createdAt: "2026-07-11T09:00:00.000Z",
        accessCount: 0,
        tags: [],
        source: {},
      });
      db.close();
    } else {
      const daily = join(root, "daily");
      mkdirSync(daily, { recursive: true });
      writeFileSync(join(daily, "2026-07-11.md"), `${serializeBullet({
        id: "managed-hit",
        type: "note",
        status: "open",
        text: "Managed recall needle is preserved.",
        salience: 0.7,
        isInsight: false,
        createdAt: "2026-07-11T09:00:00.000Z",
        refs: [],
      })}\n`);
      await safeRebuildMemoryIndex({ root, tier: "lite" });
    }

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("MONO_AGENT_MEMORY_EMBEDDINGS_")) delete env[key];
    }
    const result = spawnSync(process.execPath, [CLI, "recall", root, "recall needle"], {
      encoding: "utf8",
      env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${kind === "legacy" ? "Legacy" : "Managed"} recall needle is preserved.`);
  });
});
