import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/index.js";

import { exportMemoryBundle } from "../bundle-export.js";
import { MEMORY_BUNDLE_MANIFEST_FILE, MEMORY_BUNDLE_SOURCE_DIR } from "../bundle-format.js";
import { appendBullet } from "../daily.js";
import {
  applyMemoryBundleImport,
  MemoryBundleImportError,
  prepareMemoryBundleImport,
  restoreMemoryBundleImport,
} from "../bundle-import.js";
import { pruneExplicitMemoryForgetBackups } from "../forget-backup-retention.js";
import { readManagedIndexManifest, resolveActiveMemoryDbPath } from "../generations.js";
import { readBujoCanonicalSourceFingerprint } from "../replay-projection.js";

import {
  bulletOf,
  cleanupBujoFixtures,
  createBujoFixture,
  scratchDirectory,
  type BujoFixture,
} from "./bundle-fixtures.js";
import { fakeEmbeddings } from "./helpers.js";

const SOURCE_FACT = "the source agent knows about the Vinted carrier";

afterEach(() => {
  cleanupBujoFixtures();
});

async function sourceStore(dim = 16): Promise<BujoFixture> {
  return await createBujoFixture({
    prefix: "bundle-import-source",
    dim,
    bullets: [
      { id: "SRC-A", text: SOURCE_FACT },
      { id: "SRC-B", text: "a second source fact", day: "2026-07-31" },
    ],
    entities: [{ id: "person:morgan", name: "Morgan", createdAt: "2026-07-01T00:00:00.000Z" }],
  });
}

async function destinationStore(dim = 16): Promise<BujoFixture> {
  return await createBujoFixture({
    prefix: "bundle-import-dest",
    dim,
    bullets: [{ id: "DST-A", text: "the destination agent's own fact", day: "2026-07-29" }],
  });
}

async function bundleFrom(store: BujoFixture): Promise<string> {
  const bundlePath = join(scratchDirectory("bundle-import-bundle"), "bundle");
  await exportMemoryBundle({ root: store.root, bundlePath });
  return bundlePath;
}

function planDigestFor(label: string): string {
  return createHash("sha256").update(`plan:${label}`).digest("hex");
}

async function applyBundle(
  destination: BujoFixture,
  bundlePath: string,
  overrides: Partial<Parameters<typeof applyMemoryBundleImport>[0]> = {},
) {
  const preview = prepareMemoryBundleImport({ root: destination.root, bundlePath });
  return await applyMemoryBundleImport({
    root: destination.root,
    bundlePath,
    expectedRootFingerprint: preview.rootFingerprint,
    expectedSourceFingerprint: preview.destinationSourceFingerprint,
    expectedBundleDigest: preview.bundleDigest,
    expectedMergeDigest: preview.mergeDigest,
    expectedMergedSourceFingerprint: preview.mergedSourceFingerprint,
    planDigest: planDigestFor("import"),
    embeddings: destination.embeddings,
    dimension: destination.dim,
    ...overrides,
  });
}

describe("memory bundle import", { timeout: 60_000 }, () => {
  it("merges a bundle into a populated destination and rebuilds a healthy index", async () => {
    const source = await sourceStore();
    const destination = await destinationStore();
    const bundlePath = await bundleFrom(source);

    const preview = prepareMemoryBundleImport({ root: destination.root, bundlePath });
    expect(preview.counts.newMemories).toBe(2);
    expect(preview.counts.newEntities).toBe(1);

    const result = await applyBundle(destination, bundlePath);

    expect(result.status).toBe("applied");
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.sourceFingerprint).toBe(preview.mergedSourceFingerprint);
    expect(readBujoCanonicalSourceFingerprint(destination.root)).toBe(preview.mergedSourceFingerprint);

    const db = openMemoryDb({
      path: resolveActiveMemoryDbPath(destination.root),
      readOnly: true,
      dim: destination.dim,
    });
    try {
      const snapshot = db.validationSnapshot();
      expect(snapshot.memories).toBe(3);
      expect(snapshot.vectors).toBe(snapshot.memories);
      expect(snapshot.contentHashes).toBe(0);
      expect(db.allMemories().map((record) => record.id).sort()).toEqual(["DST-A", "SRC-A", "SRC-B"]);
    } finally {
      db.close();
    }
  });

  it("imports across a different embedding model and dimension", async () => {
    const source = await sourceStore(16);
    const destination = await destinationStore(24);
    const bundlePath = await bundleFrom(source);

    const result = await applyBundle(destination, bundlePath);

    expect(result.status).toBe("applied");
    const db = openMemoryDb({
      path: resolveActiveMemoryDbPath(destination.root),
      readOnly: true,
      dim: destination.dim,
    });
    try {
      const metadata = db.indexMetadata();
      // The importing agent's identity wins; the bundle's is advisory only.
      expect(metadata?.dimension).toBe(24);
      expect(metadata?.embeddingModel).toBe(fakeEmbeddings(24).id);
      const snapshot = db.validationSnapshot();
      expect(snapshot.vectors).toBe(snapshot.memories);
      expect(snapshot.memories).toBe(3);
    } finally {
      db.close();
    }
  });

  it("restores an empty destination to exactly the source corpus", async () => {
    const source = await sourceStore();
    const destination = await createBujoFixture({ prefix: "bundle-import-empty", bullets: [] });
    const bundlePath = await bundleFrom(source);

    await applyBundle(destination, bundlePath);

    // Import-into-empty is the degenerate merge case, so the canonical
    // fingerprints must agree exactly.
    expect(readBujoCanonicalSourceFingerprint(destination.root))
      .toBe(readBujoCanonicalSourceFingerprint(source.root));
  });

  it("is idempotent: re-importing the same bundle changes nothing", async () => {
    const source = await sourceStore();
    const destination = await destinationStore();
    const bundlePath = await bundleFrom(source);
    await applyBundle(destination, bundlePath);
    const afterFirst = readBujoCanonicalSourceFingerprint(destination.root);

    const second = await applyBundle(destination, bundlePath, { planDigest: planDigestFor("second") });

    expect(second.imported).toBe(0);
    expect(second.identical).toBe(2);
    expect(readBujoCanonicalSourceFingerprint(destination.root)).toBe(afterFirst);
  });

  it("leaves imported bullets in a dated daily file so they stay forgettable", async () => {
    const source = await sourceStore();
    const destination = await destinationStore();
    const bundlePath = await bundleFrom(source);

    await applyBundle(destination, bundlePath);

    // A non-dated target would index fine but could never be rewritten by
    // migrate or forget, which is silent and permanent.
    const daily = readFileSync(join(destination.root, "daily", "2026-07-30.md"), "utf8");
    expect(daily).toContain(SOURCE_FACT);
    expect(existsSync(join(destination.root, "daily", "2026-07-31.md"))).toBe(true);
  });

  it("does not advertise a rollback generation after import", async () => {
    const source = await sourceStore();
    const destination = await destinationStore();
    const bundlePath = await bundleFrom(source);

    await applyBundle(destination, bundlePath);

    // The canonical source changed, so the prior generation can no longer be a
    // source-parity-verified rollback target. `import restore` is the undo.
    expect(readManagedIndexManifest(destination.root)?.rollback).toBeUndefined();
  });

  it("refreshes index.md so it does not misreport the merged corpus", async () => {
    const source = await sourceStore();
    const destination = await destinationStore();
    const bundlePath = await bundleFrom(source);

    await applyBundle(destination, bundlePath);

    expect(readFileSync(join(destination.root, "index.md"), "utf8")).toContain("- Memories: 3");
  });

  describe("fail-closed verification", () => {
    it("refuses a bundle whose source bytes were tampered with", async () => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);
      const before = readBujoCanonicalSourceFingerprint(destination.root);

      const daily = join(bundlePath, MEMORY_BUNDLE_SOURCE_DIR, "daily", "2026-07-30.md");
      chmodSync(daily, 0o600);
      writeFileSync(daily, `${readFileSync(daily, "utf8")}\n- – smuggled\n`, { mode: 0o600 });

      expect(() => prepareMemoryBundleImport({ root: destination.root, bundlePath }))
        .toThrow(MemoryBundleImportError);
      expect(readBujoCanonicalSourceFingerprint(destination.root)).toBe(before);
    });

    it("refuses a world-readable bundle directory", async () => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);
      chmodSync(bundlePath, 0o755);

      expect(() => prepareMemoryBundleImport({ root: destination.root, bundlePath }))
        .toThrow(MemoryBundleImportError);
    });

    it("refuses a symlinked manifest without reading its target or changing the destination", async () => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);
      const before = readBujoCanonicalSourceFingerprint(destination.root);
      const manifestPath = join(bundlePath, MEMORY_BUNDLE_MANIFEST_FILE);
      const outsideManifest = join(scratchDirectory("bundle-import-outside-manifest"), "owner.json");
      writeFileSync(outsideManifest, readFileSync(manifestPath), { mode: 0o600 });
      unlinkSync(manifestPath);
      symlinkSync(outsideManifest, manifestPath);

      expect(() => prepareMemoryBundleImport({ root: destination.root, bundlePath }))
        .toThrow(MemoryBundleImportError);
      expect(readBujoCanonicalSourceFingerprint(destination.root)).toBe(before);
    });

    it("refuses a bundle whose manifest counts were edited", async () => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);

      const manifestPath = join(bundlePath, MEMORY_BUNDLE_MANIFEST_FILE);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      (manifest.counts as Record<string, unknown>).memories = 99;
      chmodSync(manifestPath, 0o600);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

      expect(() => prepareMemoryBundleImport({ root: destination.root, bundlePath }))
        .toThrow(MemoryBundleImportError);
    });

    it("refuses to apply a plan whose destination moved after prepare", async () => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);
      const preview = prepareMemoryBundleImport({ root: destination.root, bundlePath });

      const other = await createBujoFixture({
        prefix: "bundle-import-drift",
        bullets: [{ id: "DRIFT", text: "written after prepare" }],
      });

      await expect(applyMemoryBundleImport({
        root: destination.root,
        bundlePath,
        expectedRootFingerprint: preview.rootFingerprint,
        // A fingerprint from a different corpus stands in for post-prepare drift.
        expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(other.root),
        expectedBundleDigest: preview.bundleDigest,
        expectedMergeDigest: preview.mergeDigest,
        expectedMergedSourceFingerprint: preview.mergedSourceFingerprint,
        planDigest: planDigestFor("stale"),
        embeddings: destination.embeddings,
        dimension: destination.dim,
      })).rejects.toMatchObject({ code: "import_stale_plan" });
    });

    it("refuses an id conflict by default and skips it on request", async () => {
      const source = await createBujoFixture({
        prefix: "bundle-import-conflict-source",
        bullets: [{ id: "SHARED", text: "the source version" }],
      });
      const destination = await createBujoFixture({
        prefix: "bundle-import-conflict-dest",
        bullets: [{ id: "SHARED", text: "the destination version" }],
      });
      const bundlePath = await bundleFrom(source);

      expect(() => prepareMemoryBundleImport({ root: destination.root, bundlePath }))
        .toThrow(MemoryBundleImportError);

      const preview = prepareMemoryBundleImport({
        root: destination.root,
        bundlePath,
        onConflict: "skip",
      });
      expect(preview.counts.conflictingMemories).toBe(1);
      expect(preview.counts.newMemories).toBe(0);
    });

    it("gates a merge that would remove derived associations from existing memories", async () => {
      const source = await createBujoFixture({
        prefix: "bundle-import-drift-source",
        bullets: [{ id: "SRC-A", text: "unrelated source fact" }],
        entities: [{ id: "contact:morgan", name: "Morgan", createdAt: "2026-07-01T00:00:00.000Z" }],
      });
      const destination = await createBujoFixture({
        prefix: "bundle-import-drift-dest",
        bullets: [{ id: "DST-A", text: "Morgan shipped the release", day: "2026-07-29" }],
        entities: [{ id: "person:morgan", name: "Morgan", createdAt: "2026-07-01T00:00:00.000Z" }],
      });
      const bundlePath = await bundleFrom(source);

      // Two ids normalizing to one name disable the whole name group, deleting
      // an association the destination previously derived for its own memory.
      expect(() => prepareMemoryBundleImport({ root: destination.root, bundlePath }))
        .toThrow(MemoryBundleImportError);

      const accepted = prepareMemoryBundleImport({
        root: destination.root,
        bundlePath,
        acceptDerivedAssociationDrift: true,
      });
      expect(accepted.derivedAssociationsRemoved).toEqual(["DST-A -> person:morgan"]);
    });
  });

  describe("restore", () => {
    it("returns the destination to its exact pre-import tree", async () => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);
      const before = readBujoCanonicalSourceFingerprint(destination.root);

      const applied = await applyBundle(destination, bundlePath);
      expect(readBujoCanonicalSourceFingerprint(destination.root)).not.toBe(before);

      // Restore binds to the actual root; an unrelated fingerprint is refused.
      await expect(restoreMemoryBundleImport({
        root: destination.root,
        backupPath: applied.backupPath,
        expectedRootFingerprint: createHash("sha256").update("not-this-root").digest("hex"),
      })).rejects.toMatchObject({ code: "import_restore_failed" });

      const preview = prepareMemoryBundleImport({ root: destination.root, bundlePath, onConflict: "skip" });
      const ok = await restoreMemoryBundleImport({
        root: destination.root,
        backupPath: applied.backupPath,
        expectedRootFingerprint: preview.rootFingerprint,
      });
      expect(ok.status).toBe("restored");
      expect(readBujoCanonicalSourceFingerprint(destination.root)).toBe(before);
    });

    it("refuses a forget backup rather than consuming another operation's artifact", async () => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);
      const applied = await applyBundle(destination, bundlePath);

      const manifestPath = join(applied.backupPath, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.operation = "memory-forget-backup";
      chmodSync(manifestPath, 0o600);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

      const preview = prepareMemoryBundleImport({ root: destination.root, bundlePath, onConflict: "skip" });
      await expect(restoreMemoryBundleImport({
        root: destination.root,
        backupPath: applied.backupPath,
        expectedRootFingerprint: preview.rootFingerprint,
      })).rejects.toMatchObject({ code: "import_restore_failed" });
    });
  });

  it("enrolls its backup in the shared retention sweep", async () => {
    const source = await sourceStore();
    const destination = await destinationStore();
    const bundlePath = await bundleFrom(source);
    const applied = await applyBundle(destination, bundlePath);

    const sweep = await pruneExplicitMemoryForgetBackups({ root: destination.root, dryRun: true });

    // Without this the import backups would accumulate forever, unlike the
    // forget backups they sit beside.
    expect(sweep.candidateCount).toBe(1);
    expect(applied.backupPath).toContain("-import-backup-");
  });

  describe("crash recovery", () => {
    it("recovers when a valid but unplanned canonical write appears after the committed merge", async () => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);
      const before = readBujoCanonicalSourceFingerprint(destination.root);

      await expect(applyBundle(destination, bundlePath, {
        hooks: {
          afterMutation: () => {
            appendBullet(
              destination.root,
              bulletOf({ id: "UNPLANNED", text: "valid but uncommitted post-merge write", day: "2026-08-01" }),
              new Date("2026-08-01T05:00:00.000Z"),
            );
          },
        },
      })).rejects.toMatchObject({ code: "import_apply_failed_recovered" });

      // The injected bullet is structurally rebuildable, so only the
      // independently prepared post-merge fingerprint can reject it.
      expect(readBujoCanonicalSourceFingerprint(destination.root)).toBe(before);
    });

    it.each([
      ["afterTransactionDurable"],
      ["afterMutation"],
    ] as const)("rewinds the destination when the apply fails at %s", async (hook) => {
      const source = await sourceStore();
      const destination = await destinationStore();
      const bundlePath = await bundleFrom(source);
      const before = readBujoCanonicalSourceFingerprint(destination.root);

      await expect(applyBundle(destination, bundlePath, {
        hooks: { [hook]: () => { throw new Error("injected crash"); } },
      })).rejects.toMatchObject({ code: "import_apply_failed_recovered" });

      expect(readBujoCanonicalSourceFingerprint(destination.root)).toBe(before);
    });
  });
});
