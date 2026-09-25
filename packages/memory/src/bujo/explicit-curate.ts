import { join, relative, resolve } from "node:path";

import type { EmbeddingProvider } from "../search/index.js";
import { openMemoryDb, type MemoryDb } from "../store/index.js";

import {
  assertHealthyRoot,
  assertSafeRelative,
  cleanupSqliteCoordination,
  createDurableRootSwapBackup,
  durableRootSwapTransactionMatches,
  isSha256,
  MEMORY_CURATE_SWAP_OPERATION,
  memoryTreeFingerprint,
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
  applyCurateMutations,
  MAX_CURATE_OPERATOR_MERGES,
  previewCurateMutations,
  type CurateOperatorMerge,
  type CurateProposal,
} from "./curate.js";
import { MAX_CURATE_OWNER_ASSOCIATIONS, type CurateOwnerAssociation } from "./curate-owner.js";
import { recoverDurableMutationState } from "./mutation-lock.js";
import {
  assertCanonicalGraphRepairBaseParity,
  safeRebuildMemoryIndexForMaintenance,
} from "./rebuild.js";
import { readBujoCanonicalSourceFingerprint } from "./replay-projection.js";

const SCHEMA_VERSION = 1;
const MAX_PROPOSALS = 8192;

/** Explicit curate is one instance of the shared durable root-swap protocol. */
const CURATE_OPERATION = MEMORY_CURATE_SWAP_OPERATION;

export type ExplicitMemoryCurateHooks = DurableRootSwapHooks;

export interface ApplyExplicitMemoryCurateOptions {
  readonly root: string;
  readonly proposals: readonly CurateProposal[];
  /** Operator-authoritative entity merges applied in the same transaction. */
  readonly operatorMerges?: readonly CurateOperatorMerge[];
  /** Operator-reviewed `person:owner` association backfill applied in the same transaction. */
  readonly ownerAssociations?: readonly CurateOwnerAssociation[];
  readonly expectedRootFingerprint: string;
  readonly expectedSourceFingerprint: string;
  readonly planDigest: string;
  readonly embeddings: EmbeddingProvider;
  readonly dimension: number;
  readonly now?: () => Date;
  readonly hooks?: ExplicitMemoryCurateHooks;
}

export interface RestoreExplicitMemoryCurateOptions {
  readonly root: string;
  readonly backupPath: string;
  readonly expectedRootFingerprint: string;
  readonly hooks?: ExplicitMemoryCurateHooks;
}

export interface ExplicitMemoryCurateApplyResult {
  readonly status: "applied";
  readonly changed: number;
  readonly sourceFingerprint: string;
  readonly backupPath: string;
}

export interface ExplicitMemoryCurateRestoreResult {
  readonly status: "restored";
  readonly sourceFingerprint: string;
  readonly backupPath: string;
  readonly planDigest: string;
}

/** Resolve without erasing a configured-root symlink from the safety decision. */
export function resolveExplicitMemoryCurateRoot(root: string): string {
  return resolveMemoryRootForMaintenance(root, CURATE_OPERATION);
}

export type ExplicitMemoryCurateErrorCode =
  | "apply_failed"
  | "apply_failed_recovered"
  | "apply_recovery_failed"
  | "restore_failed";

export class ExplicitMemoryCurateError extends Error {
  constructor(
    readonly code: ExplicitMemoryCurateErrorCode,
    readonly backupPath?: string,
    cause?: unknown,
    readonly recoveryError?: unknown,
  ) {
    super(`memory-curate: ${code}`, cause === undefined ? undefined : { cause });
    this.name = "ExplicitMemoryCurateError";
  }
}

export async function applyExplicitMemoryCurate(
  options: ApplyExplicitMemoryCurateOptions,
): Promise<ExplicitMemoryCurateApplyResult> {
  assertApplyOptions(options);
  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  let db: MemoryDb | undefined;
  let backup: DurableRootSwapBackupState | undefined;
  let transactionDurable = false;
  try {
    const root = resolveExplicitMemoryCurateRoot(options.root);
    const actualRootFingerprint = rootFingerprint(root);
    const existing = readDurableRootSwapTransactionOptional(maintenance.transactionPath, CURATE_OPERATION);
    if (existing !== undefined) {
      if (existing.planDigest !== options.planDigest
        || actualRootFingerprint !== options.expectedRootFingerprint) {
        throw new ExplicitMemoryCurateError("apply_recovery_failed", existing.backupPath);
      }
      backup = readDurableRootSwapBackup(existing.backupPath, CURATE_OPERATION);
      if (!durableRootSwapTransactionMatches(existing, actualRootFingerprint, backup)) {
        throw new ExplicitMemoryCurateError("apply_recovery_failed", backup.path);
      }
      try {
        await restoreFromDurableRootSwapTransaction(
          root,
          maintenance.transactionPath,
          existing,
          backup,
          undefined,
          options.hooks,
          CURATE_OPERATION,
        );
      } catch (recoveryError) {
        throw new ExplicitMemoryCurateError("apply_recovery_failed", backup.path, recoveryError);
      }
      writer = undefined;
      throw new ExplicitMemoryCurateError("apply_failed_recovered", backup.path);
    }

    if (actualRootFingerprint !== options.expectedRootFingerprint) throw new Error("root mismatch");
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    if (rootFingerprint(writer.root) !== actualRootFingerprint) throw new Error("root mismatch");
    const dbPath = resolveActiveMemoryDbPath(root);
    db = openMemoryDb({ path: dbPath, embeddings: options.embeddings, dim: options.dimension });
    recoverDurableMutationState(root, db, "bujo", assertCanonicalGraphRepairBaseParity);
    db.checkpoint();
    // The plan fingerprint identifies its preparation snapshot, not the live store.
    // Only selected source lines must still match; merge constraints are checked on the current graph.
    previewCurateMutations(root, options.proposals, db, options.operatorMerges, options.ownerAssociations);
    const currentSourceFingerprint = readBujoCanonicalSourceFingerprint(root);
    db.close();
    db = undefined;
    cleanupSqliteCoordination(dbPath);

    backup = createDurableRootSwapBackup({
      root,
      dbPath,
      operation: CURATE_OPERATION,
      expectedRootFingerprint: options.expectedRootFingerprint,
      expectedSourceFingerprint: currentSourceFingerprint,
      planDigest: options.planDigest,
      dimension: options.dimension,
    });
    await options.hooks?.afterBackupDurable?.();
    const transaction: DurableRootSwapTransaction = {
      schemaVersion: SCHEMA_VERSION,
      operation: CURATE_OPERATION.transactionOperation,
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
    const result = await applyCurateMutations(root, db, options.proposals, currentSourceFingerprint, options.now ?? (() => new Date()),
      options.operatorMerges, options.ownerAssociations);
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
      changed: result.changed,
      sourceFingerprint: result.sourceFingerprint,
      backupPath: backup.path,
    };
  } catch (error) {
    try { db?.close(); } catch { /* recovery owns the decisive result */ }
    db = undefined;
    if (!transactionDurable || backup === undefined) {
      if (error instanceof ExplicitMemoryCurateError) throw error;
      throw new ExplicitMemoryCurateError("apply_failed", backup?.path, error);
    }
    try {
      const transaction = readDurableRootSwapTransaction(maintenance.transactionPath, CURATE_OPERATION);
      await restoreFromDurableRootSwapTransaction(
        options.root,
        maintenance.transactionPath,
        transaction,
        backup,
        writer,
        options.hooks,
        CURATE_OPERATION,
      );
      writer = undefined;
      throw new ExplicitMemoryCurateError("apply_failed_recovered", backup.path, error);
    } catch (recoveryError) {
      if (recoveryError instanceof ExplicitMemoryCurateError
        && recoveryError.code === "apply_failed_recovered") throw recoveryError;
      throw new ExplicitMemoryCurateError("apply_recovery_failed", backup.path, error, recoveryError);
    }
  } finally {
    try { writer?.release(); } finally { maintenance.release(); }
  }
}

export async function restoreExplicitMemoryCurate(
  options: RestoreExplicitMemoryCurateOptions,
): Promise<ExplicitMemoryCurateRestoreResult> {
  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  try {
    const root = resolveExplicitMemoryCurateRoot(options.root);
    const actualRootFingerprint = rootFingerprint(root);
    const backup = readDurableRootSwapBackup(resolve(options.backupPath), CURATE_OPERATION);
    if (actualRootFingerprint !== options.expectedRootFingerprint
      || backup.manifest.rootFingerprint !== actualRootFingerprint) {
      throw new ExplicitMemoryCurateError("restore_failed");
    }
    const existing = readDurableRootSwapTransactionOptional(maintenance.transactionPath, CURATE_OPERATION);
    if (existing !== undefined) {
      if (!durableRootSwapTransactionMatches(existing, actualRootFingerprint, backup)) {
        throw new ExplicitMemoryCurateError("restore_failed");
      }
      await restoreFromDurableRootSwapTransaction(
        root,
        maintenance.transactionPath,
        existing,
        backup,
        undefined,
        options.hooks,
        CURATE_OPERATION,
      );
      writer = undefined;
      return restoredResult(backup);
    }
    if (backup.manifest.status !== "applied" || backup.manifest.postTreeFingerprint === undefined
      || backup.manifest.postActiveDbRelativePath === undefined) {
      throw new ExplicitMemoryCurateError("restore_failed");
    }
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    if (rootFingerprint(writer.root) !== actualRootFingerprint) {
      throw new ExplicitMemoryCurateError("restore_failed");
    }
    cleanupSqliteCoordination(join(
      writer.root,
      ...backup.manifest.postActiveDbRelativePath.split(/[\\/]/u),
    ));
    const currentTreeFingerprint = memoryTreeFingerprint(writer.root);
    if (currentTreeFingerprint !== backup.manifest.postTreeFingerprint) {
      throw new ExplicitMemoryCurateError("restore_failed");
    }
    const transaction: DurableRootSwapTransaction = {
      schemaVersion: SCHEMA_VERSION,
      operation: CURATE_OPERATION.transactionOperation,
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
      CURATE_OPERATION,
    );
    writer = undefined;
    return restoredResult(backup);
  } catch (error) {
    if (error instanceof ExplicitMemoryCurateError) throw error;
    throw new ExplicitMemoryCurateError("restore_failed", undefined, error);
  } finally {
    try { writer?.release(); } finally { maintenance.release(); }
  }
}

function assertApplyOptions(options: ApplyExplicitMemoryCurateOptions): void {
  resolveExplicitMemoryCurateRoot(options.root);
  const merges = options.operatorMerges ?? [];
  const owners = options.ownerAssociations ?? [];
  if (options.proposals.length + merges.filter(({ accepted }) => accepted).length + owners.filter(({ accepted }) => accepted).length === 0
    || options.proposals.length > MAX_PROPOSALS || merges.length > MAX_CURATE_OPERATOR_MERGES
    || owners.length > MAX_CURATE_OWNER_ASSOCIATIONS
    || !isSha256(options.expectedRootFingerprint) || !isSha256(options.expectedSourceFingerprint)
    || !isSha256(options.planDigest) || !Number.isInteger(options.dimension) || options.dimension <= 0) {
    throw new ExplicitMemoryCurateError("apply_failed");
  }
}

function restoredResult(backup: DurableRootSwapBackupState): ExplicitMemoryCurateRestoreResult {
  return {
    status: "restored",
    sourceFingerprint: backup.manifest.sourceFingerprint,
    backupPath: backup.path,
    planDigest: backup.manifest.planDigest,
  };
}
