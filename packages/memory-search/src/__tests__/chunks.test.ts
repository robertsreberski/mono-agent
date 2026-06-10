import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { gatherMemoryChunks } from "../index.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-chunks-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("gatherMemoryChunks", () => {
  it("splits journal files into sections and summarizes entities", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "daily"), { recursive: true });
    await mkdir(join(root, "monthly"), { recursive: true });
    await writeFile(
      join(root, "daily", "2026-06-09.md"),
      "## Turn — 1\n\nDiscussed pricing.\n\n## Note — 2\n\nExample Person prefers concision.",
      "utf8",
    );
    await writeFile(join(root, "monthly", "2026-06.md"), "## Summary\n\nShipped the adapter.", "utf8");

    const chunks = await gatherMemoryChunks(root, [
      { name: "Example Person", entityType: "person", observations: ["prefers concision", "contributes to sample-project"] },
      { name: "Empty", entityType: "topic", observations: [] },
    ]);

    const dailyChunks = chunks.filter((chunk) => chunk.source === "daily/2026-06-09.md");
    expect(dailyChunks).toHaveLength(2);
    expect(dailyChunks[0]?.id).toBe("daily/2026-06-09.md#0");
    expect(dailyChunks[0]?.day).toBe("2026-06-09");
    expect(dailyChunks[0]?.text).toContain("Discussed pricing.");

    const monthly = chunks.find((chunk) => chunk.source === "monthly/2026-06.md");
    expect(monthly?.text).toContain("Shipped the adapter.");
    expect(monthly?.day).toBeUndefined();

    const examplePerson = chunks.find((chunk) => chunk.id === "entity:example person");
    expect(examplePerson?.text).toBe("Example Person (person): prefers concision; contributes to sample-project");
    expect(chunks.find((chunk) => chunk.id === "entity:empty")?.text).toBe("Empty (topic)");
  });

  it("returns an empty list for a missing root", async () => {
    const root = await tempRoot();
    expect(await gatherMemoryChunks(join(root, "nope"), [])).toEqual([]);
  });
});
