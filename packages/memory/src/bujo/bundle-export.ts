import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  renameSync,
  rmSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { hasPendingCaptureIntent } from "./capture-outbox.js";
import {
  completeMemoryBundleManifest,
  MEMORY_BUNDLE_EXTRAS_DIR,
  MEMORY_BUNDLE_MANIFEST_FILE,
  MEMORY_BUNDLE_SCHEMA_VERSION,
  MEMORY_BUNDLE_SOURCE_DIR,
  type MemoryBundleCounts,
  type MemoryBundleScope,
  type MemoryExportBundleManifest,
} from "./bundle-format.js";
import {
  assertDurableRootSwapBackupDirectoryInfo,
  copyTreeDurably,
  memoryTreeFingerprint,
  writeJsonExclusiveDurable,
} from "./durable-root-swap.js";
import { fsyncMaintenanceDirectory } from "./maintenance.js";
import { hasPendingMigrateDecision } from "./migrate.js";
import { assertCanonicalDailySourcePath, canonicalMemoryRootPath } from "./path-safety.js";
import { readCanonicalMergeSnapshot, validateCanonicalCorpus } from "./rebuild.js";
import { readBujoCanonicalSourceFingerprint, REPLAY_PROJECTION_FILE } from "./replay-projection.js";

/**
 * Export a portable, verifiable copy of a BuJo memory root's canonical corpus.
 *
 * Export is strictly read-only: it never opens SQLite, never takes the writer
 * or maintenance lease, and never touches `.index/`. A running agent therefore
 * does not need to be stopped to be backed up. Consistency comes from a
 * fingerprint sandwich around the copy rather than from a lock.
 */

const GRAPH_FILE = "graph.jsonl";
const EXTRA_DIRECTORIES = ["audit", "monthly", "legacy"] as const;
const MAX_ATTEMPTS = 3;
const MAX_STALE_STAGING_CANDIDATES = 32;
const MAX_STALE_STAGING_ENTRIES = 10_000;
const MAX_STALE_STAGING_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_STALE_STAGING_DEPTH = 32;
const MAX_PID = 0x7fff_ffff;
const UUID_V4 = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";

export interface MemoryBundleExportHooks {
  /** Race seam: fires after the canonical set is copied, before the closing fingerprint. */
  readonly afterSourceCopied?: () => void | Promise<void>;
}

export interface ExportMemoryBundleOptions {
  readonly root: string;
  readonly bundlePath: string;
  readonly scope?: MemoryBundleScope;
  /** Export over unreplayed durable work. Stamps `pendingWork` into the manifest. */
  readonly allowPending?: boolean;
  readonly agentSourceId?: string;
  /** Advisory provenance only; import re-embeds and must never gate on these. */
  readonly embeddingModel?: string;
  readonly dimension?: number;
  readonly now?: () => Date;
  readonly hooks?: MemoryBundleExportHooks;
}

export interface MemoryBundleExportResult {
  readonly status: "exported";
  readonly bundlePath: string;
  readonly scope: MemoryBundleScope;
  readonly sourceFingerprint: string;
  readonly treeFingerprint: string;
  readonly counts: MemoryBundleCounts;
  readonly pendingWork: boolean;
}

export type MemoryBundleExportErrorCode =
  | "export_destination_invalid"
  | "export_pending_work"
  | "export_source_changed"
  | "export_source_invalid"
  | "export_failed";

export class MemoryBundleExportError extends Error {
  constructor(readonly code: MemoryBundleExportErrorCode, message: string, cause?: unknown) {
    super(`memory-bundle-export: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "MemoryBundleExportError";
  }
}

export async function exportMemoryBundle(
  options: ExportMemoryBundleOptions,
): Promise<MemoryBundleExportResult> {
  const root = canonicalMemoryRootPath(options.root, false);
  const bundlePath = resolveBundleDestination(root, options.bundlePath);
  const scope = options.scope ?? "canonical";
  const now = options.now ?? (() => new Date());

  // A SIGKILL cannot run the local finally block. Reclaim only exact reserved
  // siblings from dead PIDs, and only after a bounded owner-controlled tree and
  // inode-stable rename claim prove that the path is ours to remove.
  reclaimStaleExportStaging(bundlePath);

  const pendingWork = hasPendingCaptureIntent(root) || hasPendingMigrateDecision(root);
  if (pendingWork && options.allowPending !== true) {
    throw new MemoryBundleExportError(
      "export_pending_work",
      "the store has unreplayed durable work; let the agent drain or pass --allow-pending.",
    );
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const stagingPath = `${bundlePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const before = readBujoCanonicalSourceFingerprint(root);
      const sourcePath = join(stagingPath, MEMORY_BUNDLE_SOURCE_DIR);
      mkdirSync(stagingPath, { mode: 0o700, recursive: false });
      fsyncMaintenanceDirectory(dirname(stagingPath));
      mkdirSync(sourcePath, { mode: 0o700 });

      const canonicalPaths = copyCanonicalSources(root, sourcePath);
      if (scope === "canonical+extras") copyExtras(root, join(stagingPath, MEMORY_BUNDLE_EXTRAS_DIR));
      await options.hooks?.afterSourceCopied?.();

      // Fingerprint sandwich: the store must be unchanged across the copy, and
      // the copied bytes must independently hash to the same canonical value.
      // The second check is the decisive one — it proves what we wrote, not
      // merely that the source held still.
      if (readBujoCanonicalSourceFingerprint(root) !== before
        || readBujoCanonicalSourceFingerprint(sourcePath) !== before) {
        discardStaging(stagingPath);
        if (attempt === MAX_ATTEMPTS) {
          throw new MemoryBundleExportError(
            "export_source_changed",
            "the memory store kept changing during export; retry with the agent idle.",
          );
        }
        continue;
      }

      const validation = validateCanonicalCorpus(sourcePath, "bujo");
      const counts: MemoryBundleCounts = {
        dailyFiles: canonicalPaths.length,
        memories: validation.memories,
        graphEntities: validation.entities,
        graphRelations: validation.relations,
        graphAssociations: validation.associations,
        replayTerminals: validation.replayTerminals,
        replaySupersedes: validation.replaySupersedes,
        replayThreads: validation.replayThreads,
      };
      const treeFingerprint = memoryTreeFingerprint(sourcePath);
      const manifest: MemoryExportBundleManifest = completeMemoryBundleManifest({
        schemaVersion: MEMORY_BUNDLE_SCHEMA_VERSION,
        operation: "memory-export-bundle",
        status: "complete",
        tier: "bujo",
        scope,
        sourceRootFingerprint: createHash("sha256").update(root).digest("hex"),
        sourceFingerprint: before,
        treeFingerprint,
        ...(scope === "canonical+extras" && existsSync(join(stagingPath, MEMORY_BUNDLE_EXTRAS_DIR))
          ? { extrasTreeFingerprint: memoryTreeFingerprint(join(stagingPath, MEMORY_BUNDLE_EXTRAS_DIR)) }
          : {}),
        ...(options.embeddingModel === undefined ? {} : { embeddingModel: options.embeddingModel }),
        ...(options.dimension === undefined ? {} : { dimension: options.dimension }),
        ...(options.agentSourceId === undefined ? {} : { agentSourceId: options.agentSourceId }),
        ...(pendingWork ? { pendingWork: true } : {}),
        createdAt: now().toISOString(),
        counts,
      });
      writeJsonExclusiveDurable(join(stagingPath, MEMORY_BUNDLE_MANIFEST_FILE), manifest);
      fsyncMaintenanceDirectory(stagingPath);

      if (existsSync(bundlePath)) {
        throw new MemoryBundleExportError("export_destination_invalid", "the bundle path already exists.");
      }
      renameSync(stagingPath, bundlePath);
      fsyncMaintenanceDirectory(dirname(bundlePath));
      return {
        status: "exported",
        bundlePath,
        scope,
        sourceFingerprint: before,
        treeFingerprint,
        counts,
        pendingWork,
      };
    } catch (error) {
      discardStaging(stagingPath);
      if (error instanceof MemoryBundleExportError) throw error;
      throw new MemoryBundleExportError("export_failed", "the export could not be completed.", error);
    }
  }
  throw new MemoryBundleExportError("export_source_changed", "the export exhausted its retry budget.");
}

/**
 * Copy exactly the canonical source set — the same files the rebuild planner
 * reads — preserving each file's relative layout, mode, and mtime.
 */
function copyCanonicalSources(root: string, sourcePath: string): string[] {
  const snapshot = readCanonicalMergeSnapshot(root);
  const dailyPaths: string[] = [];
  let madeDailyDirectory = false;
  for (const source of snapshot.daily) {
    try {
      assertCanonicalDailySourcePath(source.relativePath);
    } catch (error) {
      // A non-dated name under daily/ can never be rewritten by migrate or
      // forget, so a bundle must not be able to carry one into another store.
      throw new MemoryBundleExportError(
        "export_source_invalid",
        `canonical source "${source.relativePath}" is not a dated daily file; `
        + "repair the store before exporting.",
        error,
      );
    }
    if (source.relativePath.includes("/") && !madeDailyDirectory) {
      mkdirSync(join(sourcePath, "daily"), { mode: 0o700 });
      madeDailyDirectory = true;
    }
    copyCanonicalFile(root, sourcePath, source.relativePath);
    dailyPaths.push(source.relativePath);
  }
  if (existsSync(join(root, GRAPH_FILE))) copyCanonicalFile(root, sourcePath, GRAPH_FILE);
  // A bujo corpus is unimportable without its replay authority; the planner
  // hard-refuses to infer lifecycle from SQLite, so this is never optional.
  if (!existsSync(join(root, REPLAY_PROJECTION_FILE))) {
    throw new MemoryBundleExportError(
      "export_source_invalid",
      `${REPLAY_PROJECTION_FILE} is missing; run stopped-store replay adoption before exporting.`,
    );
  }
  copyCanonicalFile(root, sourcePath, REPLAY_PROJECTION_FILE);
  fsyncMaintenanceDirectory(sourcePath);
  return dailyPaths;
}

function copyCanonicalFile(root: string, sourcePath: string, relativePath: string): void {
  copyTreeDurably(join(root, ...relativePath.split("/")), join(sourcePath, ...relativePath.split("/")), root);
}

/**
 * Copy the non-canonical companions. These are for the operator only — import
 * never reads them. `monthly/` in particular carries pending migrate decisions
 * that would wedge another store's migration protocol if replayed into it.
 */
function copyExtras(root: string, extrasPath: string): void {
  let created = false;
  for (const name of EXTRA_DIRECTORIES) {
    const source = join(root, name);
    if (!existsSync(source)) continue;
    const info = lstatSync(source);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    if (readdirSync(source).length === 0) continue;
    if (!created) {
      mkdirSync(extrasPath, { mode: 0o700 });
      created = true;
    }
    copyTreeDurably(source, join(extrasPath, name), root);
  }
  if (created) fsyncMaintenanceDirectory(extrasPath);
}

/** Refuse a destination inside the memory root, or one that already exists. */
function resolveBundleDestination(root: string, bundlePath: string): string {
  const absolute = resolve(bundlePath);
  const parent = dirname(absolute);
  if (!existsSync(parent)) {
    throw new MemoryBundleExportError("export_destination_invalid", "the bundle parent directory does not exist.");
  }
  const canonicalParent = canonicalMemoryRootPath(parent, false);
  const resolved = join(canonicalParent, basename(absolute));
  if (resolved === root || isSameOrUnder(resolved, root)) {
    throw new MemoryBundleExportError(
      "export_destination_invalid",
      "the bundle must be written outside the memory root.",
    );
  }
  if (existsSync(resolved)) {
    throw new MemoryBundleExportError("export_destination_invalid", "the bundle path already exists.");
  }
  return resolved;
}

function isSameOrUnder(candidate: string, directory: string): boolean {
  const rel = relative(directory, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function discardStaging(stagingPath: string): void {
  try {
    rmSync(stagingPath, { recursive: true, force: true });
    fsyncMaintenanceDirectory(dirname(stagingPath));
  } catch {
    // Staging is unpublished by construction; a failed cleanup must not mask
    // the decisive export result.
  }
}

function reclaimStaleExportStaging(bundlePath: string): void {
  if (typeof process.getuid !== "function") return;
  const parent = dirname(bundlePath);
  let parentInfo: Stats;
  let names: string[];
  try {
    parentInfo = lstatSync(parent);
    if (!safeStagingParent(parentInfo)) return;
    const pattern = new RegExp(
      `^${escapeRegExp(basename(bundlePath))}\\.tmp-([1-9][0-9]*)-${UUID_V4}$`,
      "u",
    );
    names = readdirSync(parent)
      .filter((name) => pattern.test(name))
      .sort();
    if (names.length > MAX_STALE_STAGING_CANDIDATES) return;

    for (const name of names) {
      const match = pattern.exec(name);
      const pid = Number(match?.[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID || processMayBeAlive(pid)) continue;
      const candidatePath = join(parent, name);
      const candidate = safeStagingTree(candidatePath);
      if (candidate === undefined || !sameDirectoryIdentity(parent, parentInfo)) continue;

      const claimedPath = `${bundlePath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        if (existsSync(claimedPath)) continue;
        renameSync(candidatePath, claimedPath);
      } catch {
        continue;
      }

      const claimed = safeStagingTree(claimedPath, candidate);
      if (claimed === undefined || !sameDirectoryIdentity(parent, parentInfo)) {
        // The claimed name is reserved and will be reconsidered only after this
        // process exits. Never delete a path whose identity or tree became
        // ambiguous across the claim.
        continue;
      }
      try {
        rmSync(claimedPath, { recursive: true, force: false });
        fsyncMaintenanceDirectory(parent);
      } catch {
        // Cleanup is best effort. A later export can safely reconsider the
        // still-reserved owner-controlled claim after this PID exits.
      }
    }
  } catch {
    // Ambiguous parents, inventories, or entries are preserved. Export itself
    // remains governed by the normal exclusive staging/publish path.
  }
}

function safeStagingTree(
  root: string,
  expected?: { readonly dev: number; readonly ino: number },
): { readonly dev: number; readonly ino: number } | undefined {
  try {
    const rootInfo = lstatSync(root);
    assertDurableRootSwapBackupDirectoryInfo(rootInfo);
    if (expected !== undefined && (rootInfo.dev !== expected.dev || rootInfo.ino !== expected.ino)) return undefined;
    const uid = process.getuid!();
    const device = rootInfo.dev;
    const stack = [{ path: root, depth: 0 }];
    let entries = 1;
    let bytes = 0;
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.depth > MAX_STALE_STAGING_DEPTH) return undefined;
      const before = lstatSync(current.path);
      if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid
        || before.dev !== device || (before.mode & 0o022) !== 0) return undefined;
      const directory = opendirSync(current.path);
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          entries += 1;
          if (entries > MAX_STALE_STAGING_ENTRIES) return undefined;
          const childPath = join(current.path, entry.name);
          const info = lstatSync(childPath);
          if (info.isSymbolicLink() || info.uid !== uid || info.dev !== device || (info.mode & 0o022) !== 0) {
            return undefined;
          }
          if (info.isDirectory()) {
            stack.push({ path: childPath, depth: current.depth + 1 });
            continue;
          }
          if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 0) {
            return undefined;
          }
          bytes += info.size;
          if (!Number.isSafeInteger(bytes) || bytes > MAX_STALE_STAGING_BYTES) return undefined;
        }
      } finally {
        directory.closeSync();
      }
      const after = lstatSync(current.path);
      if (after.dev !== before.dev || after.ino !== before.ino) return undefined;
    }
    const after = lstatSync(root);
    return after.dev === rootInfo.dev && after.ino === rootInfo.ino
      ? { dev: rootInfo.dev, ino: rootInfo.ino }
      : undefined;
  } catch {
    return undefined;
  }
}

function safeStagingParent(info: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink()
    && ((info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0);
}

function sameDirectoryIdentity(path: string, expected: Stats): boolean {
  try {
    const current = lstatSync(path);
    return safeStagingParent(current) && current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
