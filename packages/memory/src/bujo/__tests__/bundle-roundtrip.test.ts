import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/index.js";

import { exportMemoryBundle } from "../bundle-export.js";
import { applyMemoryBundleImport, prepareMemoryBundleImport } from "../bundle-import.js";
import { captureTurnStrict } from "../capture.js";
import { normalizedContentHash } from "../daily.js";
import { applyExplicitMemoryForget } from "../explicit-forget.js";
import { resolveActiveMemoryDbPath } from "../generations.js";
import { parseDailyFile } from "../grammar.js";
import {
  assertCanonicalGraphRepairBaseParity,
  readCanonicalMergeSnapshot,
  safeRebuildMemoryIndex,
} from "../rebuild.js";
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

  it("preserves lifecycle, explicit-memory identity, and graph visibility through import plus rebuild", async () => {
    const originalId = "LIFE-ORIGINAL";
    const replacementId = "LIFE-CURRENT";
    const droppedId = "LIFE-DROPPED";
    const rememberedText = "Compatibility audit explicitly remembers the amber release channel.";
    const rememberedHash = normalizedContentHash(rememberedText);
    const rememberedId = `RM-${rememberedHash}`;
    const replacedAt = new Date("2026-08-02T09:00:00.000Z");
    const droppedAt = new Date("2026-08-03T09:00:00.000Z");
    const source = await createBujoFixture({
      prefix: "roundtrip-lifecycle-source",
      bullets: [
        { id: originalId, text: "Compatibility audit reports Atlas on the blue release channel." },
        { id: droppedId, text: "Compatibility audit temporarily recorded the obsolete pager code." },
      ],
    });

    const sourceStore = createBujoMemoryStore({
      root: source.root,
      tier: "bujo",
      embeddings: source.embeddings,
      dim: source.dim,
      llm: fakeLlm([]),
      clock: () => new Date("2026-08-01T09:00:00.000Z"),
    });
    try {
      expect((await sourceStore.remember("compatibility-audit", rememberedText)).id).toBe(rememberedId);
    } finally {
      await sourceStore.close();
    }

    const sourceDb = openMemoryDb({
      path: resolveActiveMemoryDbPath(source.root),
      embeddings: source.embeddings,
      dim: source.dim,
    });
    try {
      sourceDb.findSimilarMany = async () => [[{
        record: sourceDb.get(originalId)!,
        distance: 0.1,
      }]];
      let modelCall = 0;
      const captured = await captureTurnStrict("Morgan changed the Atlas release channel.", {
        db: sourceDb,
        root: source.root,
        llm: {
          id: "lifecycle-roundtrip-plan",
          complete: async () => {
            modelCall += 1;
            if (modelCall === 1) {
              return JSON.stringify({
                entities: [
                  { id: "person:morgan", name: "Morgan", type: "person" },
                  { id: "project:atlas", name: "Atlas", type: "project" },
                ],
                relations: [{
                  src: "person:morgan",
                  dst: "project:atlas",
                  relation: "maintains",
                }],
                memories: [{
                  type: "note",
                  text: "Compatibility audit now reports Atlas on the green release channel.",
                  salience: 0.8,
                  isInsight: false,
                  entityIds: ["project:atlas"],
                }],
              });
            }
            return JSON.stringify([{
              index: 0,
              action: "supersede",
              targetId: originalId,
              text: "Compatibility audit now reports Atlas on the green release channel.",
            }]);
          },
        },
        nextId: () => replacementId,
        now: () => replacedAt,
        strictModelOutput: true,
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(captured).toMatchObject({
        actions: [{ kind: "supersede", oldId: originalId, newId: replacementId }],
        entities: 2,
        relations: 1,
        associations: 1,
      });
      expect(modelCall).toBe(2);
    } finally {
      sourceDb.close();
    }

    await applyExplicitMemoryForget({
      root: source.root,
      ids: [droppedId],
      expectedRootFingerprint: createHash("sha256").update(realpathSync(source.root)).digest("hex"),
      expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(source.root),
      planDigest: createHash("sha256").update("plan:lifecycle-roundtrip-forget").digest("hex"),
      embeddings: source.embeddings,
      dimension: source.dim,
      now: () => droppedAt,
    });

    const destination = await createBujoFixture({ prefix: "roundtrip-lifecycle-empty", bullets: [] });
    await exportAndImport(source, destination);
    await safeRebuildMemoryIndex({
      root: destination.root,
      tier: "bujo",
      embeddings: destination.embeddings,
      dim: destination.dim,
    });

    const rebuilt = openMemoryDb({
      path: resolveActiveMemoryDbPath(destination.root),
      readOnly: true,
      dim: destination.dim,
    });
    try {
      expect(rebuilt.get(originalId)).toMatchObject({
        status: "invalidated",
        supersededBy: replacementId,
        supersededAt: replacedAt.toISOString(),
        validTo: replacedAt.toISOString(),
      });
      expect(rebuilt.get(replacementId)).toMatchObject({ status: "open" });
      expect(rebuilt.get(droppedId)).toMatchObject({
        status: "dropped",
        validTo: droppedAt.toISOString(),
      });
      expect(rebuilt.get(rememberedId)).toMatchObject({ text: rememberedText, status: "open" });
      expect(rememberedId).toBe(`RM-${normalizedContentHash(rebuilt.get(rememberedId)!.text)}`);
      expect(rebuilt.allEdges()).toContainEqual(expect.objectContaining({
        src: originalId,
        dst: replacementId,
        kind: "supersedes",
        createdAt: replacedAt.toISOString(),
      }));

      const current = await rebuilt.recall("compatibility audit", { topK: 10, trackAccess: false });
      expect(current.map((hit) => hit.record.id).sort()).toEqual([rememberedId, replacementId].sort());
      const explicitHistory = await rebuilt.recall("compatibility audit", {
        topK: 10,
        includeInvalid: true,
        trackAccess: false,
      });
      expect(explicitHistory.map((hit) => hit.record.id).sort())
        .toEqual([droppedId, originalId, rememberedId, replacementId].sort());
      const journal = rebuilt.browseJournal({
        fromInclusive: "2026-07-01T00:00:00.000Z",
        toExclusive: "2026-09-01T00:00:00.000Z",
        maxEntries: 10,
        maxBytes: 16_384,
      });
      expect(journal.records.map(({ id, status }) => ({ id, status })))
        .toEqual(expect.arrayContaining([
          { id: originalId, status: "invalidated" },
          { id: replacementId, status: "open" },
          { id: rememberedId, status: "open" },
        ]));
      expect(journal.records.map(({ id }) => id)).not.toContain(droppedId);
      expect(rebuilt.relationsFor("person:morgan")).toContainEqual({
        src: "person:morgan",
        dst: "project:atlas",
        relation: "maintains",
        createdAt: "2026-08-02T09:00:00.000Z",
      });
      expect(rebuilt.associationsForMemory(replacementId)).toContainEqual({
        memoryId: replacementId,
        entityId: "project:atlas",
        provenance: "capture",
        createdAt: "2026-08-02T09:00:00.000Z",
      });
    } finally {
      rebuilt.close();
    }

    const reopened = createBujoMemoryStore({
      root: destination.root,
      tier: "bujo",
      embeddings: destination.embeddings,
      dim: destination.dim,
      llm: fakeLlm([]),
    });
    try {
      await expect(reopened.remember("compatibility-audit", rememberedText)).resolves.toMatchObject({
        id: rememberedId,
        duplicate: true,
        bytesWritten: 0,
      });
    } finally {
      await reopened.close();
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
