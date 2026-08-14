import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exportMemoryBundle } from "../bundle-export.js";
import { applyMemoryBundleImport, prepareMemoryBundleImport } from "../bundle-import.js";
import { parseDailyFile } from "../grammar.js";
import { readCanonicalMergeSnapshot } from "../rebuild.js";
import { readBujoCanonicalSourceFingerprint } from "../replay-projection.js";
import { createBujoMemoryStore } from "../store.js";

import {
  cleanupBujoFixtures,
  createBujoFixture,
  scratchDirectory,
  type BujoFixture,
} from "./bundle-fixtures.js";
import { fakeLlm } from "./helpers.js";

/**
 * End-to-end properties of a full export -> import cycle, over a corpus rich
 * enough to exercise refs, due dates, lifecycle status, and the entity graph.
 */

afterEach(() => {
  cleanupBujoFixtures();
});

async function richStore(prefix: string, dim = 16): Promise<BujoFixture> {
  return await createBujoFixture({
    prefix,
    dim,
    bullets: [
      { id: "RT-NOTE", text: "a plain note", refs: ["alpha", "beta"] },
      { id: "RT-TASK", text: "an open task", type: "task", status: "open", salience: 0.9 },
      { id: "RT-EVENT", text: "an event happened", type: "event", day: "2026-07-31" },
    ],
    entities: [
      { id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-07-01T00:00:00.000Z" },
      { id: "project:atlas", name: "Atlas", type: "project", createdAt: "2026-07-02T00:00:00.000Z" },
    ],
    associations: [
      {
        memoryId: "RT-TASK",
        entityId: "project:atlas",
        provenance: "capture",
        createdAt: "2026-07-30T05:00:00.000Z",
      },
    ],
  });
}

async function exportAndImport(source: BujoFixture, destination: BujoFixture): Promise<void> {
  const bundlePath = join(scratchDirectory("roundtrip-bundle"), "bundle");
  await exportMemoryBundle({ root: source.root, bundlePath });
  const preview = prepareMemoryBundleImport({ root: destination.root, bundlePath });
  await applyMemoryBundleImport({
    root: destination.root,
    bundlePath,
    expectedRootFingerprint: preview.rootFingerprint,
    expectedSourceFingerprint: preview.destinationSourceFingerprint,
    expectedBundleDigest: preview.bundleDigest,
    expectedMergeDigest: preview.mergeDigest,
    expectedMergedSourceFingerprint: preview.mergedSourceFingerprint,
    planDigest: createHash("sha256").update(`plan:${destination.root}`).digest("hex"),
    embeddings: destination.embeddings,
    dimension: destination.dim,
  });
}

describe("memory bundle round trip", { timeout: 60_000 }, () => {
  it("reproduces every bullet field, refs included, in the destination markdown", async () => {
    const source = await richStore("roundtrip-source");
    const destination = await createBujoFixture({ prefix: "roundtrip-empty", bullets: [] });

    await exportAndImport(source, destination);

    const before = new Map(
      readCanonicalMergeSnapshot(source.root).daily
        .flatMap((file) => parseDailyFile(file.bytes.toString("utf8")).bullets)
        .map((bullet) => [bullet.id, bullet]),
    );
    const after = new Map(
      readCanonicalMergeSnapshot(destination.root).daily
        .flatMap((file) => parseDailyFile(file.bytes.toString("utf8")).bullets)
        .map((bullet) => [bullet.id, bullet]),
    );

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, bullet] of before) {
      // refs live only in markdown — MemoryRecord drops them — so a
      // record-based re-serialization would silently lose this.
      expect(after.get(id)).toEqual(bullet);
    }
    expect(after.get("RT-NOTE")?.refs).toEqual(["alpha", "beta"]);
  });

  it("preserves the entity graph including provenance and entity types", async () => {
    const source = await richStore("roundtrip-graph-source");
    const destination = await createBujoFixture({ prefix: "roundtrip-graph-empty", bullets: [] });

    await exportAndImport(source, destination);

    const before = readCanonicalMergeSnapshot(source.root).graph;
    const after = readCanonicalMergeSnapshot(destination.root).graph;
    expect(after.entities).toEqual(before.entities);
    expect(after.associations).toEqual(before.associations);
    expect(after.associations[0]?.provenance).toBe("capture");
  });

  it("is a no-op when a store imports its own bundle", async () => {
    const store = await richStore("roundtrip-self");
    const before = readBujoCanonicalSourceFingerprint(store.root);
    const bundlePath = join(scratchDirectory("roundtrip-self-bundle"), "bundle");
    await exportMemoryBundle({ root: store.root, bundlePath });

    const preview = prepareMemoryBundleImport({ root: store.root, bundlePath });
    expect(preview.counts.newMemories).toBe(0);
    expect(preview.counts.identicalMemories).toBe(3);

    const result = await applyMemoryBundleImport({
      root: store.root,
      bundlePath,
      expectedRootFingerprint: preview.rootFingerprint,
      expectedSourceFingerprint: preview.destinationSourceFingerprint,
      expectedBundleDigest: preview.bundleDigest,
      expectedMergeDigest: preview.mergeDigest,
      expectedMergedSourceFingerprint: preview.mergedSourceFingerprint,
      planDigest: createHash("sha256").update("plan:self").digest("hex"),
      embeddings: store.embeddings,
      dimension: store.dim,
    });

    expect(result.imported).toBe(0);
    expect(readBujoCanonicalSourceFingerprint(store.root)).toBe(before);
  });

  it("leaves the destination openable as a writable BuJo store", async () => {
    const source = await richStore("roundtrip-writable-source");
    const destination = await createBujoFixture({
      prefix: "roundtrip-writable-dest",
      bullets: [{ id: "DEST-A", text: "the destination's own fact", day: "2026-07-29" }],
    });

    await exportAndImport(source, destination);

    // Opening writable is the assertion: it enforces 100% vector coverage and
    // replay/DB agreement, the two invariants a partially rebuilt index would
    // violate. Recall ranking is a separate concern and is not asserted here.
    const store = createBujoMemoryStore({
      root: destination.root,
      embeddings: destination.embeddings,
      dim: destination.dim,
      llm: fakeLlm([]),
    });
    try {
      await expect(store.load("conversation", "plain note")).resolves.not.toThrow();
    } finally {
      await store.close?.();
    }
  });

  it("keeps index.md consistent with the merged corpus", async () => {
    const source = await richStore("roundtrip-index-source");
    const destination = await createBujoFixture({
      prefix: "roundtrip-index-dest",
      bullets: [{ id: "DEST-A", text: "destination fact", day: "2026-07-29" }],
    });

    await exportAndImport(source, destination);

    expect(readFileSync(join(destination.root, "index.md"), "utf8")).toContain("- Memories: 4");
  });
});
