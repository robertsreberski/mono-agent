import { existsSync, lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { EmbeddingProvider } from "../search/index.js";
import { openMemoryDb, type MemoryDb } from "../store/index.js";

import {
  MEMORY_BUNDLE_MANIFEST_FILE,
  MEMORY_BUNDLE_SOURCE_DIR,
  parseMemoryExportBundleManifest,
  type MemoryExportBundleManifest,
} from "./bundle-format.js";
import {
  mergeCanonicalMemoryBundles,
  type MemoryBundleEntityConflictPolicy,
  type MemoryBundleIdConflictPolicy,
  type MemoryBundleMergeCounts,
  type MemoryBundleMergePlan,
  type MemoryBundleEntityDiscard,
} from "./bundle-merge.js";
import { hasPendingCaptureIntent } from "./capture-outbox.js";
import {
  assertDurableRootSwapBackupDirectoryInfo,
  assertHealthyRoot,
  assertSafeRelative,
  cleanupSqliteCoordination,
  createDurableRootSwapBackup,
  durableRootSwapTransactionMatches,
  isSha256,
  MEMORY_IMPORT_SWAP_OPERATION,
  memoryTreeFingerprint,
  readDurableRootSwapBackup,
  readDurableRootSwapTransaction,
  readDurableRootSwapTransactionOptional,
  readOwnerJson,
  replaceJsonDurable,
  resolveMemoryRootForMaintenance,
  restoreFromDurableRootSwapTransaction,
  rootFingerprint,
  unlinkDurable,
  writeJsonExclusiveDurable,
  type DurableRootSwapBackupState,
  type DurableRootSwapHooks,
  type DurableRootSwapTransaction,
} from "./durable-root-swap.js";
import {
  acquireMemoryWriterLeaseForMaintenance,
  resolveActiveMemoryDbPath,
  withManagedRollbackRetirement,
  type MemoryWriterLease,
} from "./generations.js";
import { acquireMemoryMaintenanceLease } from "./maintenance.js";
import { hasPendingMigrateDecision } from "./migrate.js";
import { recoverDurableMutationState } from "./mutation-lock.js";
import { appendCanonicalFile } from "./path-safety.js";
import { writeIndex } from "./projections.js";
import {
  assertCanonicalGraphRepairBaseParity,
  readCanonicalMergeSnapshot,
  safeRebuildMemoryIndexForMaintenance,
} from "./rebuild.js";
import {
  prepareAndPublishReplayProjectionDelta,
  readBujoCanonicalSourceFingerprint,
} from "./replay-projection.js";

/**
 * Import a portable memory bundle into a BuJo memory root, merging it with
 * whatever the destination already holds.
 *
 * Prepare is read-only and can run while the agent is live. Apply requires a
 * stopped store and runs the shared durable root-swap protocol so any failure
 * after the first canonical write rewinds the whole tree.
 *
 * Canonical writes are ordered daily, then graph, then replay. Replay is last
 * because it is the only irreversible one: a published projection cannot be
 * shrunk, and a projection whose endpoints do not resolve makes the corpus
 * permanently unrebuildable.
 */

const SCHEMA_VERSION = 1;
const DAILY_DATE = /^(?:daily\/)?(\d{4}-\d{2}-\d{2})\.md$/u;

const IMPORT_OPERATION = MEMORY_IMPORT_SWAP_OPERATION;

export type MemoryBundleImportHooks = DurableRootSwapHooks;

/** Canonicalize a configured import root while preserving import recovery semantics. */
export function resolveMemoryBundleImportRoot(root: string): string {
  return resolveMemoryRootForMaintenance(root, IMPORT_OPERATION);
}

export interface MemoryBundleImportPolicy {
  readonly onConflict?: MemoryBundleIdConflictPolicy;
  readonly entityConflict?: MemoryBundleEntityConflictPolicy;
  /** Required when the merge would REMOVE derived associations from existing memories. */
  readonly acceptDerivedAssociationDrift?: boolean;
}

export interface PrepareMemoryBundleImportOptions extends MemoryBundleImportPolicy {
  readonly root: string;
  readonly bundlePath: string;
}

export interface MemoryBundleImportPreview {
  readonly rootFingerprint: string;
  readonly destinationSourceFingerprint: string;
  readonly bundlePath: string;
  readonly bundleDigest: string;
  readonly bundleTreeFingerprint: string;
  readonly bundleSourceFingerprint: string;
  readonly mergeDigest: string;
  readonly mergedSourceFingerprint: string;
  readonly onConflict: MemoryBundleIdConflictPolicy;
  readonly entityConflict: MemoryBundleEntityConflictPolicy;
  readonly counts: MemoryBundleMergeCounts;
  readonly entityDiscards: readonly MemoryBundleEntityDiscard[];
  readonly derivedAssociationsAdded: readonly string[];
  readonly derivedAssociationsRemoved: readonly string[];
  /** The bundle was taken over unreplayed durable work in its source store. */
  readonly bundlePendingWork: boolean;
}

export interface ApplyMemoryBundleImportOptions extends MemoryBundleImportPolicy {
  readonly root: string;
  readonly bundlePath: string;
  readonly expectedRootFingerprint: string;
  readonly expectedSourceFingerprint: string;
  readonly expectedBundleDigest: string;
  readonly expectedMergeDigest: string;
  readonly expectedMergedSourceFingerprint: string;
  readonly planDigest: string;
  readonly embeddings: EmbeddingProvider;
  readonly dimension: number;
  readonly now?: () => Date;
  readonly hooks?: MemoryBundleImportHooks;
}

export interface MemoryBundleImportApplyResult {
  readonly status: "applied";
  readonly imported: number;
  readonly skipped: number;
  readonly identical: number;
  readonly sourceFingerprint: string;
  readonly backupPath: string;
}

export interface RestoreMemoryBundleImportOptions {
  readonly root: string;
  readonly backupPath: string;
  readonly expectedRootFingerprint: string;
  readonly hooks?: MemoryBundleImportHooks;
}

export interface MemoryBundleImportRestoreResult {
  readonly status: "restored";
  readonly sourceFingerprint: string;
  readonly backupPath: string;
  readonly planDigest: string;
}

export type MemoryBundleImportErrorCode =
  | "import_bundle_invalid"
  | "import_bundle_incompatible"
  | "import_derived_drift"
  | "import_pending_work"
  | "import_prepare_failed"
  | "import_stale_plan"
  | "import_apply_failed"
  | "import_apply_failed_recovered"
  | "import_apply_recovery_failed"
  | "import_restore_failed";

export class MemoryBundleImportError extends Error {
  constructor(
    readonly code: MemoryBundleImportErrorCode,
    readonly backupPath?: string,
    cause?: unknown,
  ) {
    super(`memory-import: ${code}`, cause === undefined ? undefined : { cause });
    this.name = "MemoryBundleImportError";
  }
}

/** Read-only preview. Safe to run against a live agent. */
export function prepareMemoryBundleImport(
  options: PrepareMemoryBundleImportOptions,
): MemoryBundleImportPreview {
  try {
    const root = resolveMemoryBundleImportRoot(options.root);
    const verified = verifyBundle(options.bundlePath);
    const destination = readCanonicalMergeSnapshot(root);
    const incoming = readCanonicalMergeSnapshot(verified.sourcePath);
    const onConflict = options.onConflict ?? "fail";
    const entityConflict = options.entityConflict ?? "target";
    const merge = mergeCanonicalMemoryBundles(destination, incoming, { onConflict, entityConflict });
    assertDriftAccepted(merge, options.acceptDerivedAssociationDrift === true);
    return {
      rootFingerprint: rootFingerprint(root),
      destinationSourceFingerprint: destination.fingerprint,
      bundlePath: verified.bundlePath,
      bundleDigest: verified.manifest.bundleDigest,
      bundleTreeFingerprint: verified.manifest.treeFingerprint,
      bundleSourceFingerprint: verified.manifest.sourceFingerprint,
      mergeDigest: merge.digest,
      mergedSourceFingerprint: merge.expectedSourceFingerprint,
      onConflict,
      entityConflict,
      counts: merge.counts,
      entityDiscards: merge.entityDiscards,
      derivedAssociationsAdded: merge.derivedAssociationsAdded,
      derivedAssociationsRemoved: merge.derivedAssociationsRemoved,
      bundlePendingWork: verified.manifest.pendingWork === true,
    };
  } catch (error) {
    if (error instanceof MemoryBundleImportError) throw error;
    throw new MemoryBundleImportError("import_prepare_failed", undefined, error);
  }
}

export async function applyMemoryBundleImport(
  options: ApplyMemoryBundleImportOptions,
): Promise<MemoryBundleImportApplyResult> {
  assertApplyOptions(options);
  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  let db: MemoryDb | undefined;
  let backup: DurableRootSwapBackupState | undefined;
  let transactionDurable = false;
  try {
    const root = resolveMemoryBundleImportRoot(options.root);
    const actualRootFingerprint = rootFingerprint(root);
    const existing = readDurableRootSwapTransactionOptional(maintenance.transactionPath, IMPORT_OPERATION);
    if (existing !== undefined) {
      if (existing.planDigest !== options.planDigest
        || actualRootFingerprint !== options.expectedRootFingerprint) {
        throw new MemoryBundleImportError("import_apply_recovery_failed", existing.backupPath);
      }
      backup = readDurableRootSwapBackup(existing.backupPath, IMPORT_OPERATION);
      if (!durableRootSwapTransactionMatches(existing, actualRootFingerprint, backup)) {
        throw new MemoryBundleImportError("import_apply_recovery_failed", backup.path);
      }
      try {
        await restoreFromDurableRootSwapTransaction(
          root, maintenance.transactionPath, existing, backup, undefined, options.hooks, IMPORT_OPERATION,
        );
      } catch (recoveryError) {
        throw new MemoryBundleImportError("import_apply_recovery_failed", backup.path, recoveryError);
      }
      writer = undefined;
      throw new MemoryBundleImportError("import_apply_failed_recovered", backup.path);
    }

    if (actualRootFingerprint !== options.expectedRootFingerprint) {
      throw new MemoryBundleImportError("import_stale_plan");
    }
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    if (rootFingerprint(writer.root) !== actualRootFingerprint) {
      throw new MemoryBundleImportError("import_stale_plan");
    }
    const dbPath = resolveActiveMemoryDbPath(root);
    db = openMemoryDb({ path: dbPath, embeddings: options.embeddings, dim: options.dimension });
    recoverDurableMutationState(root, db, "bujo", assertCanonicalGraphRepairBaseParity);
    db.checkpoint();
    db.close();
    db = undefined;
    cleanupSqliteCoordination(dbPath);

    // Unreplayed durable work would be silently outrun by the rebuild that
    // closes this import, so both stores must be quiet before anything moves.
    if (hasPendingCaptureIntent(root) || hasPendingMigrateDecision(root)) {
      throw new MemoryBundleImportError("import_pending_work");
    }
    if (readBujoCanonicalSourceFingerprint(root) !== options.expectedSourceFingerprint) {
      throw new MemoryBundleImportError("import_stale_plan");
    }

    const verified = verifyBundle(options.bundlePath);
    if (verified.manifest.bundleDigest !== options.expectedBundleDigest) {
      throw new MemoryBundleImportError("import_stale_plan");
    }
    const destination = readCanonicalMergeSnapshot(root);
    const incoming = readCanonicalMergeSnapshot(verified.sourcePath);
    const merge = mergeCanonicalMemoryBundles(destination, incoming, {
      onConflict: options.onConflict ?? "fail",
      entityConflict: options.entityConflict ?? "target",
    });
    assertDriftAccepted(merge, options.acceptDerivedAssociationDrift === true);
    if (merge.digest !== options.expectedMergeDigest
      || merge.expectedSourceFingerprint !== options.expectedMergedSourceFingerprint) {
      throw new MemoryBundleImportError("import_stale_plan");
    }

    backup = createDurableRootSwapBackup({
      root,
      dbPath,
      operation: IMPORT_OPERATION,
      expectedRootFingerprint: options.expectedRootFingerprint,
      expectedSourceFingerprint: options.expectedSourceFingerprint,
      planDigest: options.planDigest,
      dimension: options.dimension,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    await options.hooks?.afterBackupDurable?.();
    const transaction: DurableRootSwapTransaction = {
      schemaVersion: SCHEMA_VERSION,
      operation: IMPORT_OPERATION.transactionOperation,
      phase: "applying",
      rootFingerprint: options.expectedRootFingerprint,
      backupPath: backup.path,
      planDigest: options.planDigest,
      originalTreeFingerprint: backup.manifest.treeFingerprint,
    };
    writeJsonExclusiveDurable(maintenance.transactionPath, transaction);
    transactionDurable = true;
    backup.manifest = { ...backup.manifest, status: "applying" };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    await options.hooks?.afterTransactionDurable?.();

    writeMergedCanonicalSources(root, merge);
    await options.hooks?.afterMutation?.();

    writer.release();
    writer = undefined;
    const rebuilt = await safeRebuildMemoryIndexForMaintenance({
      root,
      tier: "bujo",
      embeddings: options.embeddings,
      dim: options.dimension,
    });
    const sourceFingerprint = readBujoCanonicalSourceFingerprint(root);
    if (sourceFingerprint !== merge.expectedSourceFingerprint) {
      throw new Error("memory-import: canonical source differs from the prepared merge commitment");
    }
    assertHealthyRoot(root, rebuilt.active, options.dimension, merge.expectedSourceFingerprint);
    refreshDerivedProjections(rebuilt.active, root, options.dimension, options.now ?? (() => new Date()));

    const postTreeFingerprint = memoryTreeFingerprint(root);
    const postActiveDbRelativePath = relative(root, rebuilt.active);
    assertSafeRelative(postActiveDbRelativePath);
    backup.manifest = {
      ...backup.manifest,
      status: "applied",
      postTreeFingerprint,
      postActiveDbRelativePath,
    };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    unlinkDurable(maintenance.transactionPath);
    transactionDurable = false;
    return {
      status: "applied",
      imported: merge.importedMemoryIds.length,
      skipped: merge.skippedMemoryIds.length,
      identical: merge.identicalMemoryIds.length,
      sourceFingerprint,
      backupPath: backup.path,
    };
  } catch (error) {
    try { db?.close(); } catch { /* recovery owns the decisive result */ }
    db = undefined;
    if (!transactionDurable || backup === undefined) {
      if (error instanceof MemoryBundleImportError) throw error;
      throw new MemoryBundleImportError("import_apply_failed", backup?.path, error);
    }
    try {
      const transaction = readDurableRootSwapTransaction(maintenance.transactionPath, IMPORT_OPERATION);
      await restoreFromDurableRootSwapTransaction(
        options.root, maintenance.transactionPath, transaction, backup, writer, options.hooks, IMPORT_OPERATION,
      );
      writer = undefined;
      throw new MemoryBundleImportError("import_apply_failed_recovered", backup.path);
    } catch (recoveryError) {
      if (recoveryError instanceof MemoryBundleImportError
        && recoveryError.code === "import_apply_failed_recovered") throw recoveryError;
      throw new MemoryBundleImportError("import_apply_recovery_failed", backup.path);
    }
  } finally {
    try { writer?.release(); } finally { maintenance.release(); }
  }
}

export async function restoreMemoryBundleImport(
  options: RestoreMemoryBundleImportOptions,
): Promise<MemoryBundleImportRestoreResult> {
  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  try {
    const root = resolveMemoryBundleImportRoot(options.root);
    const actualRootFingerprint = rootFingerprint(root);
    // A forget backup and an import backup carry different manifest operation
    // literals, so neither restore path can ever consume the other's artifact.
    const backup = readDurableRootSwapBackup(resolve(options.backupPath), IMPORT_OPERATION);
    if (actualRootFingerprint !== options.expectedRootFingerprint
      || backup.manifest.rootFingerprint !== actualRootFingerprint) {
      throw new MemoryBundleImportError("import_restore_failed");
    }
    const existing = readDurableRootSwapTransactionOptional(maintenance.transactionPath, IMPORT_OPERATION);
    if (existing !== undefined) {
      if (!durableRootSwapTransactionMatches(existing, actualRootFingerprint, backup)) {
        throw new MemoryBundleImportError("import_restore_failed");
      }
      await restoreFromDurableRootSwapTransaction(
        root, maintenance.transactionPath, existing, backup, undefined, options.hooks, IMPORT_OPERATION,
      );
      writer = undefined;
      return restoredResult(backup);
    }
    if (backup.manifest.status !== "applied" || backup.manifest.postTreeFingerprint === undefined
      || backup.manifest.postActiveDbRelativePath === undefined) {
      throw new MemoryBundleImportError("import_restore_failed");
    }
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    if (rootFingerprint(writer.root) !== actualRootFingerprint) {
      throw new MemoryBundleImportError("import_restore_failed");
    }
    cleanupSqliteCoordination(join(
      writer.root,
      ...backup.manifest.postActiveDbRelativePath.split(/[\\/]/u),
    ));
    const currentTreeFingerprint = memoryTreeFingerprint(writer.root);
    if (currentTreeFingerprint !== backup.manifest.postTreeFingerprint) {
      throw new MemoryBundleImportError("import_restore_failed");
    }
    const transaction: DurableRootSwapTransaction = {
      schemaVersion: SCHEMA_VERSION,
      operation: IMPORT_OPERATION.transactionOperation,
      phase: "restore-prepared",
      rootFingerprint: actualRootFingerprint,
      backupPath: backup.path,
      planDigest: backup.manifest.planDigest,
      originalTreeFingerprint: backup.manifest.treeFingerprint,
      expectedCurrentTreeFingerprint: currentTreeFingerprint,
    };
    writeJsonExclusiveDurable(maintenance.transactionPath, transaction);
    await restoreFromDurableRootSwapTransaction(
      root, maintenance.transactionPath, transaction, backup, writer, options.hooks, IMPORT_OPERATION,
    );
    writer = undefined;
    return restoredResult(backup);
  } catch (error) {
    if (error instanceof MemoryBundleImportError) throw error;
    throw new MemoryBundleImportError("import_restore_failed", undefined, error);
  } finally {
    try { writer?.release(); } finally { maintenance.release(); }
  }
}

interface VerifiedBundle {
  readonly bundlePath: string;
  readonly sourcePath: string;
  readonly manifest: MemoryExportBundleManifest;
}

/**
 * The full fail-closed verification ladder. Every step runs before a single
 * destination byte is touched.
 *
 * `embeddingModel` and `dimension` are deliberately NOT gated: the import ends
 * in a full rebuild that re-embeds every record under the importing agent's
 * own provider, so a bundle from a different model or dimension is expected to
 * import cleanly.
 */
function verifyBundle(bundlePath: string): VerifiedBundle {
  const resolved = resolve(bundlePath);
  if (!existsSync(resolved)) throw new MemoryBundleImportError("import_bundle_invalid");
  try {
    assertDurableRootSwapBackupDirectoryInfo(lstatSync(resolved));
  } catch (error) {
    throw new MemoryBundleImportError("import_bundle_invalid", undefined, error);
  }

  const manifestPath = join(resolved, MEMORY_BUNDLE_MANIFEST_FILE);
  let manifest: MemoryExportBundleManifest;
  try {
    manifest = parseMemoryExportBundleManifest(readOwnerJson(manifestPath));
  } catch (error) {
    throw new MemoryBundleImportError("import_bundle_invalid", undefined, error);
  }

  const sourcePath = join(resolved, MEMORY_BUNDLE_SOURCE_DIR);
  if (!existsSync(sourcePath)) throw new MemoryBundleImportError("import_bundle_incompatible");
  try {
    // Byte identity first, then semantic identity. Together they prove the
    // copied tree is exactly what the exporting store committed to.
    if (memoryTreeFingerprint(sourcePath) !== manifest.treeFingerprint
      || readBujoCanonicalSourceFingerprint(sourcePath) !== manifest.sourceFingerprint) {
      throw new Error("bundle source does not match its manifest fingerprints");
    }
    assertNoCarriageReturns(sourcePath);
  } catch (error) {
    throw new MemoryBundleImportError("import_bundle_invalid", undefined, error);
  }
  return { bundlePath: resolved, sourcePath, manifest };
}

/**
 * A CRLF daily file defeats the metadata line's `-->$` anchor, which turns the
 * orphaned comment into a hard rebuild failure. Reject it rather than rewriting
 * bytes the manifest already committed to.
 */
function assertNoCarriageReturns(sourcePath: string): void {
  const snapshot = readCanonicalMergeSnapshot(sourcePath);
  for (const source of snapshot.daily) {
    if (source.bytes.includes(0x0d)) {
      throw new Error(`bundle source ${source.relativePath} contains CRLF line endings`);
    }
  }
}

function assertDriftAccepted(merge: MemoryBundleMergePlan, accepted: boolean): void {
  if (merge.derivedAssociationsRemoved.length === 0 || accepted) return;
  throw new MemoryBundleImportError("import_derived_drift");
}

/**
 * Commit the merge to canonical sources, in the one order that keeps every
 * intermediate state recoverable.
 */
function writeMergedCanonicalSources(root: string, merge: MemoryBundleMergePlan): void {
  for (const append of merge.dailyAppends) {
    const day = DAILY_DATE.exec(append.relativePath)?.[1];
    if (day === undefined) throw new Error(`memory-import: unsupported daily target ${append.relativePath}.`);
    const body = append.blocks.map((block) => `${block}\n`).join("");
    withManagedRollbackRetirement(root, "daily", () => appendCanonicalFile(
      root,
      append.relativePath,
      (existingSize) => `${existingSize === 0 ? `# ${day}\n\n` : ""}${body}`,
    ));
  }
  if (merge.graphLines.length > 0) {
    const body = merge.graphLines.map((line) => `${line}\n`).join("");
    withManagedRollbackRetirement(root, "graph", () => appendCanonicalFile(root, "graph.jsonl", body));
  }
  const replayEntries = (merge.replayDelta.terminals?.length ?? 0)
    + (merge.replayDelta.supersedes?.length ?? 0)
    + (merge.replayDelta.threads?.length ?? 0);
  if (replayEntries > 0) {
    // Last, and irreversible: a published projection has no shrink path.
    withManagedRollbackRetirement(root, "replay", () =>
      prepareAndPublishReplayProjectionDelta(root, merge.replayDelta));
  }
}

/** Refresh the human-readable index so it does not misreport the merged corpus. */
function refreshDerivedProjections(dbPath: string, root: string, dimension: number, now: () => Date): void {
  const db = openMemoryDb({ path: dbPath, readOnly: true, dim: dimension });
  try {
    writeIndex(root, db, now());
  } finally {
    db.close();
  }
  cleanupSqliteCoordination(dbPath);
}

function assertApplyOptions(options: ApplyMemoryBundleImportOptions): void {
  if (!isSha256(options.expectedRootFingerprint) || !isSha256(options.expectedSourceFingerprint)
    || !isSha256(options.expectedBundleDigest) || !isSha256(options.expectedMergeDigest)
    || !isSha256(options.expectedMergedSourceFingerprint)
    || !isSha256(options.planDigest)
    || !Number.isInteger(options.dimension) || options.dimension <= 0) {
    throw new MemoryBundleImportError("import_apply_failed");
  }
}

function restoredResult(backup: DurableRootSwapBackupState): MemoryBundleImportRestoreResult {
  return {
    status: "restored",
    sourceFingerprint: backup.manifest.sourceFingerprint,
    backupPath: backup.path,
    planDigest: backup.manifest.planDigest,
  };
}
