import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
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
