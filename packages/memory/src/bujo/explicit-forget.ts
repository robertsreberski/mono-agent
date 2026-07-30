import { type Stats } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { EmbeddingProvider } from "../search/index.js";
import { openMemoryDb, type MemoryDb } from "../store/index.js";

import {
  assertDurableRootSwapBackupDirectoryInfo,
  assertDurableSwapPrivateArtifactInfo,
  assertHealthyRoot,
  assertSafeRelative,
  assertSameDurableSwapFile,
  assertSameDurableSwapSnapshot,
  cleanupSqliteCoordination,
  createDurableRootSwapBackup,
  durableRootSwapTransactionMatches,
  isSha256,
  MEMORY_FORGET_SWAP_OPERATION,
  memoryTreeFingerprint,
  parseDurableRootSwapBackupManifest,
  readDurableRootSwapBackup,
  readDurableRootSwapTransaction,
  readDurableRootSwapTransactionOptional,
  replaceJsonDurable,
  resolveMemoryRootForMaintenance,
  restoreFromDurableRootSwapTransaction,
  rootFingerprint,
  unlinkDurable,
  writeJsonExclusiveDurable,
  type DurableRootSwapBackupState,
  type DurableRootSwapBackupStatus,
  type DurableRootSwapHooks,
  type DurableRootSwapTransaction,
} from "./durable-root-swap.js";
import {
  acquireMemoryWriterLeaseForMaintenance,
  resolveActiveMemoryDbPath,
  type MemoryWriterLease,
} from "./generations.js";
import { acquireMemoryMaintenanceLease } from "./maintenance.js";
import {
  forgetExplicitMemories,
  previewExplicitForgetMemories,
} from "./migrate.js";
import { recoverDurableMutationState } from "./mutation-lock.js";
import {
  assertCanonicalGraphRepairBaseParity,
  safeRebuildMemoryIndexForMaintenance,
} from "./rebuild.js";
import { readBujoCanonicalSourceFingerprint } from "./replay-projection.js";

const SCHEMA_VERSION = 1;
const MAX_IDS = 32;

/** Explicit forget is one instance of the shared durable root-swap protocol. */
const FORGET_OPERATION = MEMORY_FORGET_SWAP_OPERATION;

export type ExplicitMemoryForgetHooks = DurableRootSwapHooks;

export interface ApplyExplicitMemoryForgetOptions {
  readonly root: string;
  readonly ids: readonly string[];
  readonly expectedRootFingerprint: string;
  readonly expectedSourceFingerprint: string;
  readonly planDigest: string;
  readonly embeddings: EmbeddingProvider;
  readonly dimension: number;
  readonly now?: () => Date;
  readonly hooks?: ExplicitMemoryForgetHooks;
}

export interface RestoreExplicitMemoryForgetOptions {
  readonly root: string;
  readonly backupPath: string;
  readonly expectedRootFingerprint: string;
  readonly hooks?: ExplicitMemoryForgetHooks;
}

export interface ExplicitMemoryForgetApplyResult {
  readonly status: "applied";
  readonly forgotten: number;
  readonly sourceFingerprint: string;
  readonly backupPath: string;
}

export interface ExplicitMemoryForgetRestoreResult {
  readonly status: "restored";
  readonly sourceFingerprint: string;
  readonly backupPath: string;
  readonly planDigest: string;
}

/** Resolve without erasing a configured-root symlink from the safety decision. */
export function resolveExplicitMemoryForgetRoot(root: string): string {
  return resolveMemoryRootForMaintenance(root, FORGET_OPERATION);
}

export type ExplicitMemoryForgetErrorCode =
  | "apply_failed"
  | "apply_failed_recovered"
  | "apply_recovery_failed"
  | "restore_failed";

export class ExplicitMemoryForgetError extends Error {
  constructor(
    readonly code: ExplicitMemoryForgetErrorCode,
    readonly backupPath?: string,
    cause?: unknown,
  ) {
    super(`memory-forget: ${code}`, cause === undefined ? undefined : { cause });
    this.name = "ExplicitMemoryForgetError";
  }
}

export interface ExplicitMemoryForgetBackupManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operation: "memory-forget-backup";
  readonly status: DurableRootSwapBackupStatus;
  readonly rootFingerprint: string;
  readonly sourceFingerprint: string;
  readonly treeFingerprint: string;
  readonly activeDbRelativePath: string;
  readonly dimension: number;
  readonly createdAt: string;
  readonly planDigest: string;
  readonly postTreeFingerprint?: string;
  readonly postActiveDbRelativePath?: string;
}

export async function applyExplicitMemoryForget(
  options: ApplyExplicitMemoryForgetOptions,
): Promise<ExplicitMemoryForgetApplyResult> {
  assertApplyOptions(options);
  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  let db: MemoryDb | undefined;
  let backup: DurableRootSwapBackupState | undefined;
  let transactionDurable = false;
  try {
    const root = resolveExplicitMemoryForgetRoot(options.root);
    const actualRootFingerprint = rootFingerprint(root);
    const existing = readDurableRootSwapTransactionOptional(maintenance.transactionPath, FORGET_OPERATION);
    if (existing !== undefined) {
      if (existing.planDigest !== options.planDigest
        || actualRootFingerprint !== options.expectedRootFingerprint) {
        throw new ExplicitMemoryForgetError("apply_recovery_failed", existing.backupPath);
      }
      backup = readDurableRootSwapBackup(existing.backupPath, FORGET_OPERATION);
      if (!durableRootSwapTransactionMatches(existing, actualRootFingerprint, backup)) {
        throw new ExplicitMemoryForgetError("apply_recovery_failed", backup.path);
      }
      try {
        await restoreFromDurableRootSwapTransaction(
          root,
          maintenance.transactionPath,
          existing,
          backup,
          undefined,
          options.hooks,
          FORGET_OPERATION,
        );
      } catch (recoveryError) {
        throw new ExplicitMemoryForgetError("apply_recovery_failed", backup.path, recoveryError);
      }
      writer = undefined;
      throw new ExplicitMemoryForgetError("apply_failed_recovered", backup.path);
    }

    if (actualRootFingerprint !== options.expectedRootFingerprint) throw new Error("root mismatch");
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    if (rootFingerprint(writer.root) !== actualRootFingerprint) throw new Error("root mismatch");
    const dbPath = resolveActiveMemoryDbPath(root);
    db = openMemoryDb({ path: dbPath, embeddings: options.embeddings, dim: options.dimension });
    recoverDurableMutationState(root, db, "bujo", assertCanonicalGraphRepairBaseParity);
    db.checkpoint();
    if (readBujoCanonicalSourceFingerprint(root) !== options.expectedSourceFingerprint) {
      throw new Error("stale plan");
    }
    previewExplicitForgetMemories(root, db, options.ids);
    db.close();
    db = undefined;
    cleanupSqliteCoordination(dbPath);

    backup = createDurableRootSwapBackup({
      root,
      dbPath,
      operation: FORGET_OPERATION,
      expectedRootFingerprint: options.expectedRootFingerprint,
      expectedSourceFingerprint: options.expectedSourceFingerprint,
      planDigest: options.planDigest,
      dimension: options.dimension,
    });
    await options.hooks?.afterBackupDurable?.();
    const transaction: DurableRootSwapTransaction = {
      schemaVersion: SCHEMA_VERSION,
      operation: FORGET_OPERATION.transactionOperation,
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

    db = openMemoryDb({ path: dbPath, embeddings: options.embeddings, dim: options.dimension });
    const result = await forgetExplicitMemories({
      root,
      db,
      ids: options.ids,
      now: options.now ?? (() => new Date()),
      expectedSourceFingerprint: options.expectedSourceFingerprint,
    });
    db.checkpoint();
    db.close();
    db = undefined;
    cleanupSqliteCoordination(dbPath);
    await options.hooks?.afterMutation?.();
    writer.release();
    writer = undefined;
    const rebuilt = await safeRebuildMemoryIndexForMaintenance({
      root,
      tier: "bujo",
      embeddings: options.embeddings,
      dim: options.dimension,
    });
    assertHealthyRoot(root, rebuilt.active, options.dimension, result.sourceFingerprint);
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
      forgotten: result.forgotten,
      sourceFingerprint: result.sourceFingerprint,
      backupPath: backup.path,
    };
  } catch (error) {
    try { db?.close(); } catch { /* recovery owns the decisive result */ }
    db = undefined;
    if (!transactionDurable || backup === undefined) {
      if (error instanceof ExplicitMemoryForgetError) throw error;
      throw new ExplicitMemoryForgetError("apply_failed", backup?.path, error);
    }
    try {
      const transaction = readDurableRootSwapTransaction(maintenance.transactionPath, FORGET_OPERATION);
      await restoreFromDurableRootSwapTransaction(
        options.root,
        maintenance.transactionPath,
        transaction,
        backup,
        writer,
        options.hooks,
        FORGET_OPERATION,
      );
      writer = undefined;
      throw new ExplicitMemoryForgetError("apply_failed_recovered", backup.path);
    } catch (recoveryError) {
      if (recoveryError instanceof ExplicitMemoryForgetError
        && recoveryError.code === "apply_failed_recovered") throw recoveryError;
      throw new ExplicitMemoryForgetError("apply_recovery_failed", backup.path);
    }
  } finally {
    try { writer?.release(); } finally { maintenance.release(); }
  }
}

export async function restoreExplicitMemoryForget(
  options: RestoreExplicitMemoryForgetOptions,
): Promise<ExplicitMemoryForgetRestoreResult> {
  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  try {
    const root = resolveExplicitMemoryForgetRoot(options.root);
    const actualRootFingerprint = rootFingerprint(root);
    const backup = readDurableRootSwapBackup(resolve(options.backupPath), FORGET_OPERATION);
    if (actualRootFingerprint !== options.expectedRootFingerprint
      || backup.manifest.rootFingerprint !== actualRootFingerprint) {
      throw new ExplicitMemoryForgetError("restore_failed");
    }
    const existing = readDurableRootSwapTransactionOptional(maintenance.transactionPath, FORGET_OPERATION);
    if (existing !== undefined) {
      if (!durableRootSwapTransactionMatches(existing, actualRootFingerprint, backup)) {
        throw new ExplicitMemoryForgetError("restore_failed");
      }
      await restoreFromDurableRootSwapTransaction(
        root,
        maintenance.transactionPath,
        existing,
        backup,
        undefined,
        options.hooks,
        FORGET_OPERATION,
      );
      writer = undefined;
      return restoredResult(backup);
    }
    if (backup.manifest.status !== "applied" || backup.manifest.postTreeFingerprint === undefined
      || backup.manifest.postActiveDbRelativePath === undefined) {
      throw new ExplicitMemoryForgetError("restore_failed");
    }
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    if (rootFingerprint(writer.root) !== actualRootFingerprint) {
      throw new ExplicitMemoryForgetError("restore_failed");
    }
    cleanupSqliteCoordination(join(
      writer.root,
      ...backup.manifest.postActiveDbRelativePath.split(/[\\/]/u),
    ));
    const currentTreeFingerprint = memoryTreeFingerprint(writer.root);
    if (currentTreeFingerprint !== backup.manifest.postTreeFingerprint) {
      throw new ExplicitMemoryForgetError("restore_failed");
    }
    const transaction: DurableRootSwapTransaction = {
      schemaVersion: SCHEMA_VERSION,
      operation: FORGET_OPERATION.transactionOperation,
      phase: "restore-prepared",
      rootFingerprint: actualRootFingerprint,
      backupPath: backup.path,
      planDigest: backup.manifest.planDigest,
      originalTreeFingerprint: backup.manifest.treeFingerprint,
      expectedCurrentTreeFingerprint: currentTreeFingerprint,
    };
    writeJsonExclusiveDurable(maintenance.transactionPath, transaction);
    await restoreFromDurableRootSwapTransaction(
      root,
      maintenance.transactionPath,
      transaction,
      backup,
      writer,
      options.hooks,
      FORGET_OPERATION,
    );
    writer = undefined;
    return restoredResult(backup);
  } catch (error) {
    if (error instanceof ExplicitMemoryForgetError) throw error;
    throw new ExplicitMemoryForgetError("restore_failed", undefined, error);
  } finally {
    try { writer?.release(); } finally { maintenance.release(); }
  }
}

/** @internal Shared with the asynchronous retention reader. */
export function assertExplicitMemoryForgetBackupDirectoryInfo(info: Stats): void {
  assertDurableRootSwapBackupDirectoryInfo(info);
}

/** @internal Shared with the asynchronous retention reader. */
export function parseExplicitMemoryForgetBackupManifest(value: unknown): ExplicitMemoryForgetBackupManifest {
  return parseDurableRootSwapBackupManifest(value, FORGET_OPERATION) as ExplicitMemoryForgetBackupManifest;
}

/** @internal Shared with the asynchronous retention reader. */
export function assertExplicitMemoryForgetPrivateArtifactInfo(info: Stats): void {
  assertDurableSwapPrivateArtifactInfo(info);
}

export function assertSameExplicitMemoryForgetFile(
  expected: Pick<Stats, "dev" | "ino" | "isFile" | "isSymbolicLink" | "nlink">,
  actual: Stats,
  label: string,
): void {
  assertSameDurableSwapFile(expected, actual, label);
}

export function assertSameExplicitMemoryForgetSnapshot(
  expected: Stats,
  actual: Stats,
  label: string,
): void {
  assertSameDurableSwapSnapshot(expected, actual, label);
}

function assertApplyOptions(options: ApplyExplicitMemoryForgetOptions): void {
  resolveExplicitMemoryForgetRoot(options.root);
  if (options.ids.length === 0 || options.ids.length > MAX_IDS || new Set(options.ids).size !== options.ids.length
    || !isSha256(options.expectedRootFingerprint) || !isSha256(options.expectedSourceFingerprint)
    || !isSha256(options.planDigest) || !Number.isInteger(options.dimension) || options.dimension <= 0) {
    throw new ExplicitMemoryForgetError("apply_failed");
  }
}

function restoredResult(backup: DurableRootSwapBackupState): ExplicitMemoryForgetRestoreResult {
  return {
    status: "restored",
    sourceFingerprint: backup.manifest.sourceFingerprint,
    backupPath: backup.path,
    planDigest: backup.manifest.planDigest,
  };
}
