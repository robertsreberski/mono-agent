import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fakeEmbeddings } from "./helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { dailyFilePath } from "../daily.js";
import { parseDailyFile } from "../grammar.js";

describe("BujoMemoryStore", () => {
  it("appendHostSummary writes a canonical daily bullet and indexes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    const result = await store.appendHostSummary("global", "Robert prefers opt-in memory, never silent fallback.");
    expect(result.bytesWritten).toBeGreaterThan(0);

    const file = readFileSync(dailyFilePath(root, now), "utf8");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets).toHaveLength(1);
    expect(parsed.bullets[0]?.text).toContain("opt-in memory");

    const block = await store.load("global");
    expect(block?.content).toContain("opt-in memory");
    await store.close();
  });

  it("conforms to MemoryStore (load returns undefined-safe markdown block)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    const block = await store.load("global");
    expect(block?.kind).toBe("markdown");
    await store.close();
  });
});
