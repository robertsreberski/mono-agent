import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MEMORY_BUNDLE_MANIFEST_FILE,
  MEMORY_BUNDLE_SOURCE_DIR,
  parseMemoryExportBundleManifest,
} from "../bundle-format.js";
import { exportMemoryBundle, MemoryBundleExportError } from "../bundle-export.js";
import { appendBullet } from "../daily.js";
import { readBujoCanonicalSourceFingerprint, REPLAY_PROJECTION_FILE } from "../replay-projection.js";

import {
  bulletOf,
  cleanupBujoFixtures,
  createBujoFixture,
  scratchDirectory,
} from "./bundle-fixtures.js";

const SENTINEL = "private export sentinel about Morgan";

afterEach(() => {
  cleanupBujoFixtures();
});

async function fixture() {
  return await createBujoFixture({
    prefix: "bundle-export",
    bullets: [
      { id: "EXPORT-A", text: SENTINEL },
      { id: "EXPORT-B", text: "second exported fact", day: "2026-07-31" },
    ],
    entities: [{ id: "person:morgan", name: "Morgan", createdAt: "2026-07-01T00:00:00.000Z" }],
  });
}

describe("memory bundle export", { timeout: 60_000 }, () => {
  it("writes an owner-private bundle whose source hashes to the live canonical fingerprint", async () => {
    const store = await fixture();
    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");

    const result = await exportMemoryBundle({ root: store.root, bundlePath });

    expect(result.status).toBe("exported");
    expect(result.counts.memories).toBe(2);
    expect(result.counts.dailyFiles).toBe(2);
    expect(result.counts.graphEntities).toBe(1);
    expect(result.sourceFingerprint).toBe(readBujoCanonicalSourceFingerprint(store.root));

    const sourcePath = join(bundlePath, MEMORY_BUNDLE_SOURCE_DIR);
    // The bundle's source/ is shaped exactly like a memory root, so the
    // production fingerprint runs against it verbatim.
    expect(readBujoCanonicalSourceFingerprint(sourcePath)).toBe(result.sourceFingerprint);
    expect((lstatSync(bundlePath).mode & 0o777).toString(8)).toBe("700");
    expect((lstatSync(join(bundlePath, MEMORY_BUNDLE_MANIFEST_FILE)).mode & 0o777).toString(8)).toBe("600");
    expect(existsSync(join(sourcePath, "daily", "2026-07-30.md"))).toBe(true);
    expect(existsSync(join(sourcePath, REPLAY_PROJECTION_FILE))).toBe(true);
    expect(existsSync(join(sourcePath, "graph.jsonl"))).toBe(true);
  });

  it("excludes derived projections and every managed runtime directory", async () => {
    const store = await fixture();
    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");

    await exportMemoryBundle({ root: store.root, bundlePath });

    const sourcePath = join(bundlePath, MEMORY_BUNDLE_SOURCE_DIR);
    for (const excluded of [".index", ".capture-intake", ".capture-outbox", "index.md", "future-log.md", "memory.db"]) {
      expect(existsSync(join(sourcePath, excluded))).toBe(false);
    }
  });

  it("keeps memory text out of the manifest", async () => {
    const store = await fixture();
    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");

    await exportMemoryBundle({ root: store.root, bundlePath });

    const manifest = readFileSync(join(bundlePath, MEMORY_BUNDLE_MANIFEST_FILE), "utf8");
    expect(manifest).not.toContain(SENTINEL);
    expect(manifest).not.toContain("EXPORT-A");
    expect(manifest).not.toContain("Morgan");
  });

  it("records the embedding identity as advisory provenance only", async () => {
    const store = await fixture();
    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");

    await exportMemoryBundle({
      root: store.root,
      bundlePath,
      embeddingModel: "ollama:nomic-embed-text:v1.5",
      dimension: 768,
      agentSourceId: "personal-agent",
    });

    const manifest = parseMemoryExportBundleManifest(
      JSON.parse(readFileSync(join(bundlePath, MEMORY_BUNDLE_MANIFEST_FILE), "utf8")),
    );
    expect(manifest.embeddingModel).toBe("ollama:nomic-embed-text:v1.5");
    expect(manifest.dimension).toBe(768);
    expect(manifest.agentSourceId).toBe("personal-agent");
  });

  it("rejects a manifest whose counts were edited after the fact", async () => {
    const store = await fixture();
    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");
    await exportMemoryBundle({ root: store.root, bundlePath });

    const manifestPath = join(bundlePath, MEMORY_BUNDLE_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    (manifest.counts as Record<string, unknown>).memories = 99;

    expect(() => parseMemoryExportBundleManifest(manifest)).toThrow(/digest does not match/iu);
  });

  it("rejects an unknown manifest field rather than ignoring it", async () => {
    const store = await fixture();
    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");
    await exportMemoryBundle({ root: store.root, bundlePath });

    const manifest = JSON.parse(
      readFileSync(join(bundlePath, MEMORY_BUNDLE_MANIFEST_FILE), "utf8"),
    ) as Record<string, unknown>;
    manifest.smuggled = "../../etc";

    expect(() => parseMemoryExportBundleManifest(manifest)).toThrow(/manifest is invalid/iu);
  });

  it("refuses a destination inside the memory root or one that already exists", async () => {
    const store = await fixture();

    await expect(exportMemoryBundle({ root: store.root, bundlePath: join(store.root, "bundle") }))
      .rejects.toMatchObject({ code: "export_destination_invalid" });

    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");
    await exportMemoryBundle({ root: store.root, bundlePath });
    await expect(exportMemoryBundle({ root: store.root, bundlePath }))
      .rejects.toMatchObject({ code: "export_destination_invalid" });
  });

  it("refuses a corpus whose replay authority is missing", async () => {
    const store = await createBujoFixture({
      prefix: "bundle-export-noreplay",
      bullets: [{ id: "EXPORT-A", text: "a" }],
    });
    chmodSync(join(store.root, REPLAY_PROJECTION_FILE), 0o600);
    writeFileSync(join(store.root, REPLAY_PROJECTION_FILE), "", { mode: 0o600 });

    await expect(exportMemoryBundle({
      root: store.root,
      bundlePath: join(scratchDirectory("bundle-dest"), "bundle"),
    })).rejects.toBeInstanceOf(MemoryBundleExportError);
  });

  it("retries when the store changes mid-copy and fails closed once the budget is spent", async () => {
    const store = await fixture();
    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");
    let day = 1;

    await expect(exportMemoryBundle({
      root: store.root,
      bundlePath,
      hooks: {
        afterSourceCopied: () => {
          // A live agent appending a new bullet in the middle of every copy.
          const created = new Date(`2026-08-0${day}T05:00:00.000Z`);
          day += 1;
          appendBullet(store.root, bulletOf({ id: `RACE-${day}`, text: `raced ${day}` }), created);
        },
      },
    })).rejects.toMatchObject({ code: "export_source_changed" });

    // Nothing was published; a torn bundle never appears at the target path.
    expect(existsSync(bundlePath)).toBe(false);
  });

  it("succeeds when a mid-copy write happens only once", async () => {
    const store = await fixture();
    const bundlePath = join(scratchDirectory("bundle-dest"), "bundle");
    let raced = false;

    const result = await exportMemoryBundle({
      root: store.root,
      bundlePath,
      hooks: {
        afterSourceCopied: () => {
          if (raced) return;
          raced = true;
          appendBullet(
            store.root,
            bulletOf({ id: "RACE-ONCE", text: "raced once" }),
            new Date("2026-08-01T05:00:00.000Z"),
          );
        },
      },
    });

    expect(result.status).toBe("exported");
    expect(result.sourceFingerprint).toBe(readBujoCanonicalSourceFingerprint(store.root));
    expect(result.counts.memories).toBe(3);
  });

  it("reclaims only bounded owner-controlled staging siblings left by dead exporters", async () => {
    if (typeof process.getuid !== "function") return;
    const store = await fixture();
    const parent = scratchDirectory("bundle-staging-reclaim");
    const bundlePath = join(parent, "bundle");
    const pid = absentPid();
    const stale = `${bundlePath}.tmp-${pid}-${randomUUID()}`;
    mkdirSync(stale, { mode: 0o700 });
    writeFileSync(join(stale, "partial"), "stale\n", { mode: 0o600 });

    const ambiguous = `${bundlePath}.tmp-${pid}-${randomUUID()}`;
    const outside = scratchDirectory("bundle-staging-ambiguous");
    symlinkSync(outside, ambiguous);

    await exportMemoryBundle({ root: store.root, bundlePath });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(ambiguous)).toBe(true);
    expect(existsSync(bundlePath)).toBe(true);
  });
});

function absentPid(): number {
  for (const candidate of [0x7fff_ffff, 1_000_000_000, process.pid + 1_000_000]) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("test could not identify an absent PID");
}
