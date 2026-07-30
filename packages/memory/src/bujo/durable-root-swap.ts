import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { openMemoryDb } from "../store/index.js";

import {
  acquireMemoryWriterLeaseForMaintenance,
  type MemoryWriterLease,
} from "./generations.js";
import { fsyncMaintenanceDirectory, memoryMaintenanceTransactionPath } from "./maintenance.js";
import { canonicalMemoryRootPath } from "./path-safety.js";
import { auditCanonicalIndexHealth } from "./rebuild.js";
import { readBujoCanonicalSourceFingerprint } from "./replay-projection.js";

/**
 * Whole-memory-root backup, quarantine, and swap machinery shared by every
 * stopped-store operation that rewrites canonical sources in place.
 *
 * The protocol is a six-phase durable state machine over a sibling backup
 * directory. Each operation supplies its own on-disk `operation` literals and
 * backup directory infix so that artifacts written by one operation can never
 * be consumed by another, while the recovery semantics stay identical.
 *
 * Byte-level primitives keep a neutral `memory-durable-swap:` message prefix.
 * Their suffixes are load-bearing for callers that match on them and must not
 * change.
 */

const SCHEMA_VERSION = 1;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const WRITER_LOCK_RELATIVE_PATH = `.index${sep}writer.lock`;
const LABEL = "memory-durable-swap";

export type DurableRootSwapBackupStatus = "prepared" | "applying" | "applied" | "recovered";

export type DurableRootSwapTransactionPhase =
  | "applying"
  | "restore-prepared"
  | "quarantine-intent"
  | "root-quarantined"
  | "activation-intent"
  | "root-activated";

/** On-disk identity of one stopped-store operation. Artifacts never cross operations. */
export interface DurableRootSwapOperation {
  /** Error-message prefix for operation-level failures, e.g. `"memory-forget"`. */
  readonly label: string;
  /** Literal stored in the backup manifest's `operation` field. */
  readonly backupOperation: string;
  /** Literal stored in the maintenance transaction's `operation` field. */
  readonly transactionOperation: string;
  /** Sibling backup directory infix: `.<root>-<backupInfix>-<planDigest[0:24]>`. */
  readonly backupInfix: string;
}

/**
 * Explicit forget. The literals are frozen: existing
 * `.<root>-forget-backup-<digest>` directories must stay readable.
 */
export const MEMORY_FORGET_SWAP_OPERATION: DurableRootSwapOperation = {
  label: "memory-forget",
  backupOperation: "memory-forget-backup",
  transactionOperation: "memory-forget",
  backupInfix: "forget-backup",
};

/** Bundle import. Distinct literals keep the two operations' artifacts unusable by each other. */
export const MEMORY_IMPORT_SWAP_OPERATION: DurableRootSwapOperation = {
  label: "memory-import",
  backupOperation: "memory-import-backup",
  transactionOperation: "memory-import",
  backupInfix: "import-backup",
};

/** Every operation whose sibling backups share the retention sweep. */
export const MANAGED_SWAP_OPERATIONS: readonly DurableRootSwapOperation[] = [
  MEMORY_FORGET_SWAP_OPERATION,
  MEMORY_IMPORT_SWAP_OPERATION,
];

export interface DurableRootSwapBackupManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operation: string;
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

export interface DurableRootSwapTransaction {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operation: string;
  readonly phase: DurableRootSwapTransactionPhase;
  readonly rootFingerprint: string;
  readonly backupPath: string;
  readonly planDigest: string;
  readonly originalTreeFingerprint: string;
  readonly expectedCurrentTreeFingerprint?: string;
}

export interface DurableRootSwapBackupState {
  readonly path: string;
  readonly snapshotPath: string;
  readonly manifestPath: string;
  readonly postRootPath: string;
  manifest: DurableRootSwapBackupManifest;
}

export interface DurableRootSwapHooks {
  readonly afterBackupDurable?: () => void | Promise<void>;
  readonly afterTransactionDurable?: () => void | Promise<void>;
  readonly afterMutation?: () => void | Promise<void>;
  readonly afterQuarantineIntentDurable?: () => void | Promise<void>;
  readonly afterRootRenameDurable?: () => void | Promise<void>;
  readonly afterRootQuarantined?: () => void | Promise<void>;
  readonly afterActivationIntentDurable?: () => void | Promise<void>;
  readonly afterSnapshotRenameDurable?: () => void | Promise<void>;
  readonly afterRootActivated?: () => void | Promise<void>;
}

export interface CreateDurableRootSwapBackupOptions {
  readonly root: string;
  readonly dbPath: string;
  readonly operation: DurableRootSwapOperation;
  readonly expectedRootFingerprint: string;
  readonly expectedSourceFingerprint: string;
  readonly planDigest: string;
  readonly dimension: number;
  readonly now?: () => Date;
}

/** Resolve without erasing a configured-root symlink from the safety decision. */
export function resolveMemoryRootForMaintenance(
  root: string,
  operation: DurableRootSwapOperation,
): string {
  try {
    return canonicalMemoryRootPath(root, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const absolute = resolve(root);
    const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
    // A missing configured root is valid only during the two durable swap
    // intents. The complete sibling marker authenticates the expected path;
    // malformed or absent state remains fail-closed.
    const transaction = readDurableRootSwapTransaction(
      memoryMaintenanceTransactionPath(canonical),
      operation,
    );
    if (transaction.rootFingerprint !== rootFingerprint(canonical)) throw error;
    return canonical;
  }
}

export function createDurableRootSwapBackup(
  options: CreateDurableRootSwapBackupOptions,
): DurableRootSwapBackupState {
  const { root, dbPath, operation } = options;
  const backupPath = join(
    dirname(root),
    `.${basename(root)}-${operation.backupInfix}-${options.planDigest.slice(0, 24)}`,
  );
  if (existsSync(backupPath)) {
    const existing = readDurableRootSwapBackup(backupPath, operation);
    if (existing.manifest.status !== "prepared"
      || existing.manifest.planDigest !== options.planDigest
      || existing.manifest.rootFingerprint !== options.expectedRootFingerprint
      || existing.manifest.sourceFingerprint !== options.expectedSourceFingerprint
      || memoryTreeFingerprint(root) !== existing.manifest.treeFingerprint) {
      throw new Error("backup already exists in a non-resumable state");
    }
    assertDurableRootSwapBackupSnapshot(existing);
    return existing;
  }
  const stagingPath = `${backupPath}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(stagingPath, { mode: 0o700 });
  chmodSync(stagingPath, 0o700);
  fsyncMaintenanceDirectory(dirname(stagingPath));
  const snapshotPath = join(stagingPath, "snapshot");
  try {
    copyTreeDurably(root, snapshotPath, root);
    const treeFingerprint = memoryTreeFingerprint(root);
    if (memoryTreeFingerprint(snapshotPath) !== treeFingerprint) throw new Error("backup mismatch");
    const activeDbRelativePath = relative(root, dbPath);
    assertSafeRelative(activeDbRelativePath);
    const manifest: DurableRootSwapBackupManifest = {
      schemaVersion: SCHEMA_VERSION,
      operation: operation.backupOperation,
      status: "prepared",
      rootFingerprint: options.expectedRootFingerprint,
      sourceFingerprint: options.expectedSourceFingerprint,
      treeFingerprint,
      activeDbRelativePath,
      dimension: options.dimension,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      planDigest: options.planDigest,
    };
    const manifestPath = join(stagingPath, "manifest.json");
    writeJsonExclusiveDurable(manifestPath, manifest);
    fsyncMaintenanceDirectory(stagingPath);
    if (existsSync(backupPath)) throw new Error("backup was published concurrently");
    renameSync(stagingPath, backupPath);
    fsyncMaintenanceDirectory(dirname(backupPath));
    return readDurableRootSwapBackup(backupPath, operation);
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    fsyncMaintenanceDirectory(dirname(stagingPath));
    throw error;
  }
}

export function durableRootSwapTransactionMatches(
  transaction: DurableRootSwapTransaction,
  actualRootFingerprint: string,
  backup: DurableRootSwapBackupState,
): boolean {
  return transaction.rootFingerprint === actualRootFingerprint
    && transaction.rootFingerprint === backup.manifest.rootFingerprint
    && resolve(transaction.backupPath) === backup.path
    && transaction.planDigest === backup.manifest.planDigest
    && transaction.originalTreeFingerprint === backup.manifest.treeFingerprint;
}

export async function restoreFromDurableRootSwapTransaction(
  rawRoot: string,
  transactionPath: string,
  initialTransaction: DurableRootSwapTransaction,
  backup: DurableRootSwapBackupState,
  initialWriter: MemoryWriterLease | undefined,
  hooks: DurableRootSwapHooks | undefined,
  operation: DurableRootSwapOperation,
): Promise<void> {
  let writer = initialWriter;
  let transaction = reconcileRestoreTransaction(
    transactionPath,
    initialTransaction,
    resolve(rawRoot),
    backup,
  );
  const root = resolve(rawRoot);
  try {
    const activatedOnDisk = transaction.phase === "root-activated"
      && existsSync(root) && existsSync(backup.postRootPath) && !existsSync(backup.snapshotPath);
    if (transaction.phase === "root-activated" && !activatedOnDisk) {
      // A prior in-process rollback restored the pre-restore layout while a
      // crash prevented the phase record from being rewound. Re-pin the root
      // and restart the swap instead of stranding an impossible phase.
      if (!existsSync(root) || !existsSync(backup.snapshotPath) || existsSync(backup.postRootPath)) {
        throw new Error("restore activation recovery state is invalid");
      }
      transaction = {
        ...transaction,
        phase: transaction.expectedCurrentTreeFingerprint === undefined ? "applying" : "restore-prepared",
      };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (!activatedOnDisk && existsSync(backup.snapshotPath)) assertDurableRootSwapBackupSnapshot(backup);
    if (transaction.phase === "applying") {
      writer ??= acquireMemoryWriterLeaseForMaintenance(root);
      transaction = { ...transaction, phase: "restore-prepared" };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (transaction.phase === "restore-prepared") {
      writer ??= acquireMemoryWriterLeaseForMaintenance(root);
      if (transaction.expectedCurrentTreeFingerprint !== undefined
        && memoryTreeFingerprint(root) !== transaction.expectedCurrentTreeFingerprint) {
        throw new Error("current memory changed before restore");
      }
      writer?.release();
      writer = undefined;
      if (existsSync(backup.postRootPath)) throw new Error("restore quarantine already exists");
      if (transaction.expectedCurrentTreeFingerprint !== undefined
        && memoryTreeFingerprint(root) !== transaction.expectedCurrentTreeFingerprint) {
        throw new Error("current memory changed at restore commit");
      }
      transaction = { ...transaction, phase: "quarantine-intent" };
      replaceJsonDurable(transactionPath, transaction);
      await hooks?.afterQuarantineIntentDurable?.();
    }
    if (transaction.phase === "quarantine-intent") {
      const rootExists = existsSync(root);
      const snapshotExists = existsSync(backup.snapshotPath);
      const postRootExists = existsSync(backup.postRootPath);
      if (rootExists && snapshotExists && !postRootExists) {
        if (transaction.expectedCurrentTreeFingerprint !== undefined
          && memoryTreeFingerprint(root) !== transaction.expectedCurrentTreeFingerprint) {
          throw new Error("current memory changed at restore rename");
        }
        renameAcrossMaintenanceDirectoriesDurably(root, backup.postRootPath);
        await hooks?.afterRootRenameDurable?.();
      } else if (rootExists || !snapshotExists || !postRootExists) {
        throw new Error("restore quarantine intent state is invalid");
      }
      transaction = { ...transaction, phase: "root-quarantined" };
      replaceJsonDurable(transactionPath, transaction);
      await hooks?.afterRootQuarantined?.();
    }
    if (transaction.phase === "root-quarantined") {
      if (existsSync(root) || !existsSync(backup.snapshotPath) || !existsSync(backup.postRootPath)) {
        throw new Error("restore quarantine state is invalid");
      }
      transaction = { ...transaction, phase: "activation-intent" };
      replaceJsonDurable(transactionPath, transaction);
      await hooks?.afterActivationIntentDurable?.();
    }
    if (transaction.phase === "activation-intent") {
      const rootExists = existsSync(root);
      const snapshotExists = existsSync(backup.snapshotPath);
      const postRootExists = existsSync(backup.postRootPath);
      if (!rootExists && snapshotExists && postRootExists) {
        renameAcrossMaintenanceDirectoriesDurably(backup.snapshotPath, root);
        await hooks?.afterSnapshotRenameDurable?.();
      } else if (!rootExists || snapshotExists || !postRootExists) {
        throw new Error("restore activation intent state is invalid");
      }
      transaction = { ...transaction, phase: "root-activated" };
      replaceJsonDurable(transactionPath, transaction);
      await hooks?.afterRootActivated?.();
    }
    if (transaction.phase !== "root-activated" || !existsSync(root) || !existsSync(backup.postRootPath)) {
      throw new Error("restore activation state is invalid");
    }
    assertHealthyRoot(
      root,
      join(root, ...backup.manifest.activeDbRelativePath.split(/[\\/]/u)),
      backup.manifest.dimension,
      backup.manifest.sourceFingerprint,
    );
    if (memoryTreeFingerprint(root) !== backup.manifest.treeFingerprint) {
      throw new Error("restored tree fingerprint mismatch");
    }
    backup.manifest = { ...backup.manifest, status: "recovered" };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    unlinkDurable(transactionPath);
    try {
      rmSync(backup.postRootPath, { recursive: true, force: false });
      fsyncMaintenanceDirectory(backup.path);
    } catch {
      // Restore is already validated and durably committed. Retain harmless
      // quarantine rather than misreporting the committed root as a failure.
    }
  } catch (error) {
    writer?.release();
    try {
      if (existsSync(backup.postRootPath)) {
        if (existsSync(root)) {
          if (existsSync(backup.snapshotPath)) throw new Error("snapshot destination occupied");
          renameAcrossMaintenanceDirectoriesDurably(root, backup.snapshotPath);
        }
        renameAcrossMaintenanceDirectoriesDurably(backup.postRootPath, root);
        const restoredCurrent = memoryTreeFingerprint(root);
        if (transaction.expectedCurrentTreeFingerprint !== undefined
          && restoredCurrent !== transaction.expectedCurrentTreeFingerprint) {
          throw new Error("rollback fingerprint mismatch");
        }
      } else if (!existsSync(root) || !existsSync(backup.snapshotPath)) {
        throw new Error("restore rollback state is invalid");
      } else if (transaction.expectedCurrentTreeFingerprint !== undefined
        && memoryTreeFingerprint(root) !== transaction.expectedCurrentTreeFingerprint) {
        throw new Error("rollback fingerprint mismatch");
      }

      if (transaction.expectedCurrentTreeFingerprint !== undefined) {
        if (backup.manifest.status === "recovered") {
          backup.manifest = { ...backup.manifest, status: "applied" };
          replaceJsonDurable(backup.manifestPath, backup.manifest);
        }
        if (existsSync(transactionPath)) unlinkDurable(transactionPath);
      } else {
        transaction = { ...transaction, phase: "applying" };
        replaceJsonDurable(transactionPath, transaction);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `${operation.label}: restore rollback failed; quarantine retained.`,
      );
    }
    throw error;
  }
}

function reconcileRestoreTransaction(
  transactionPath: string,
  initial: DurableRootSwapTransaction,
  root: string,
  backup: DurableRootSwapBackupState,
): DurableRootSwapTransaction {
  const rootExists = existsSync(root);
  const snapshotExists = existsSync(backup.snapshotPath);
  const postRootExists = existsSync(backup.postRootPath);
  let phase = initial.phase;

  // Accept the two legacy predecessor-phase crash layouts as well as the new
  // intent-first layouts. Reconciliation occurs before any writer acquisition,
  // so a missing root can never be accidentally recreated.
  if (phase === "restore-prepared" && !rootExists && snapshotExists && postRootExists) {
    phase = "root-quarantined";
  } else if (phase === "root-quarantined" && rootExists && !snapshotExists && postRootExists) {
    phase = "root-activated";
  } else if (phase === "root-activated" && rootExists && snapshotExists && !postRootExists) {
    phase = initial.expectedCurrentTreeFingerprint === undefined ? "applying" : "restore-prepared";
  }
  if (phase === initial.phase) return initial;
  const reconciled = { ...initial, phase };
  replaceJsonDurable(transactionPath, reconciled);
  return reconciled;
}

export function assertDurableRootSwapBackupSnapshot(backup: DurableRootSwapBackupState): void {
  if (!existsSync(backup.snapshotPath)) throw new Error("backup snapshot is unavailable");
  if (memoryTreeFingerprint(backup.snapshotPath) !== backup.manifest.treeFingerprint) {
    throw new Error("backup snapshot changed");
  }
  assertHealthyRoot(
    backup.snapshotPath,
    join(backup.snapshotPath, ...backup.manifest.activeDbRelativePath.split(/[\\/]/u)),
    backup.manifest.dimension,
    backup.manifest.sourceFingerprint,
  );
  if (memoryTreeFingerprint(backup.snapshotPath) !== backup.manifest.treeFingerprint) {
    throw new Error("backup snapshot changed during validation");
  }
}

export function assertHealthyRoot(
  root: string,
  dbPath: string,
  dimension: number,
  sourceFingerprint: string,
): void {
  if (readBujoCanonicalSourceFingerprint(root) !== sourceFingerprint) {
    throw new Error("canonical source fingerprint mismatch");
  }
  const db = openMemoryDb({ path: dbPath, readOnly: true, dim: dimension });
  try {
    if (db.integrityCheck().toLowerCase() !== "ok") throw new Error("SQLite integrity check failed");
    if (auditCanonicalIndexHealth(root, "bujo", db).status !== "match") {
      throw new Error("canonical and index state do not match");
    }
  } finally {
    db.close();
  }
  cleanupSqliteCoordination(dbPath);
}

export function readDurableRootSwapBackup(
  path: string,
  operation: DurableRootSwapOperation,
): DurableRootSwapBackupState {
  const info = lstatSync(path);
  assertDurableRootSwapBackupDirectoryInfo(info);
  const manifestPath = join(path, "manifest.json");
  const manifest = parseDurableRootSwapBackupManifest(readOwnerJson(manifestPath), operation);
  return {
    path,
    snapshotPath: join(path, "snapshot"),
    manifestPath,
    postRootPath: join(path, "post-root"),
    manifest,
  };
}

export function assertDurableRootSwapBackupDirectoryInfo(info: Stats): void {
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("backup directory is unsafe");
  }
}

export function parseDurableRootSwapBackupManifest(
  value: unknown,
  operation: DurableRootSwapOperation,
): DurableRootSwapBackupManifest {
  const manifest = value !== null && typeof value === "object"
    ? value as Partial<DurableRootSwapBackupManifest>
    : {};
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.operation !== operation.backupOperation
    || !["prepared", "applying", "applied", "recovered"].includes(String(manifest.status))
    || !isSha256(manifest.rootFingerprint) || !isSha256(manifest.sourceFingerprint)
    || !isSha256(manifest.treeFingerprint) || !isSha256(manifest.planDigest)
    || typeof manifest.activeDbRelativePath !== "string"
    || !Number.isInteger(manifest.dimension) || Number(manifest.dimension) <= 0
    || typeof manifest.createdAt !== "string"
    || (manifest.postTreeFingerprint !== undefined && !isSha256(manifest.postTreeFingerprint))
    || (manifest.postActiveDbRelativePath !== undefined && typeof manifest.postActiveDbRelativePath !== "string")) {
    throw new Error("backup manifest is invalid");
  }
  assertSafeRelative(manifest.activeDbRelativePath);
  if (manifest.postActiveDbRelativePath !== undefined) assertSafeRelative(manifest.postActiveDbRelativePath);
  return manifest as DurableRootSwapBackupManifest;
}

export function readDurableRootSwapTransactionOptional(
  path: string,
  operation: DurableRootSwapOperation,
): DurableRootSwapTransaction | undefined {
  return existsSync(path) ? readDurableRootSwapTransaction(path, operation) : undefined;
}

export function readDurableRootSwapTransaction(
  path: string,
  operation: DurableRootSwapOperation,
): DurableRootSwapTransaction {
  const value = readOwnerJson(path) as Partial<DurableRootSwapTransaction>;
  if (value.schemaVersion !== SCHEMA_VERSION || value.operation !== operation.transactionOperation
    || ![
      "applying",
      "restore-prepared",
      "quarantine-intent",
      "root-quarantined",
      "activation-intent",
      "root-activated",
    ].includes(String(value.phase))
    || !isSha256(value.rootFingerprint) || !isSha256(value.planDigest)
    || !isSha256(value.originalTreeFingerprint) || typeof value.backupPath !== "string"
    || (value.expectedCurrentTreeFingerprint !== undefined && !isSha256(value.expectedCurrentTreeFingerprint))) {
    throw new Error("maintenance transaction is invalid");
  }
  return value as DurableRootSwapTransaction;
}

export function memoryTreeFingerprint(root: string): string {
  const hash = createHash("sha256");
  hashTreeEntry(root, ".", hash);
  return hash.digest("hex");
}

function hashTreeEntry(root: string, relativePath: string, hash: ReturnType<typeof createHash>): void {
  const absolute = relativePath === "." ? root : join(root, relativePath);
  const info = lstatSync(absolute);
  const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
  if (info.isDirectory() && !info.isSymbolicLink()) {
    hash.update(`directory\0${relativePath}\0${mode}\0`);
    for (const name of readdirSync(absolute).sort()) {
      const child = relativePath === "." ? name : join(relativePath, name);
      if (child === WRITER_LOCK_RELATIVE_PATH) continue;
      hashTreeEntry(root, child, hash);
    }
    return;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${LABEL}: backup tree contains an unsafe entry`);
  }
  // File mtimes are part of the legacy capture-outbox freshness contract.
  // Directory mtimes are intentionally excluded because writer-lock churn
  // changes .index without changing committed memory content.
  // Node's Date-based futimes API preserves millisecond precision, which is
  // also the precision consumed by the legacy timestamp derivation.
  hash.update(`file\0${relativePath}\0${mode}\0${info.size}\0${info.mtime.valueOf()}\0`);
  hashFilePinned(absolute, info, hash);
  hash.update("\0");
}

export function renameAcrossMaintenanceDirectoriesDurably(source: string, destination: string): void {
  renameSync(source, destination);
  const sourceParent = dirname(source);
  const destinationParent = dirname(destination);
  fsyncMaintenanceDirectory(sourceParent);
  if (destinationParent !== sourceParent) fsyncMaintenanceDirectory(destinationParent);
}

function hashFilePinned(path: string, before: Stats, hash: ReturnType<typeof createHash>): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertSameDurableSwapFile(before, opened, path);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (count <= 0) throw new Error(`${LABEL}: short fingerprint read`);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    assertSameDurableSwapSnapshot(opened, fstatSync(fd), path);
    assertSameDurableSwapFile(opened, lstatSync(path), path);
  } finally {
    closeSync(fd);
  }
}

export function copyTreeDurably(source: string, destination: string, sourceRoot: string): void {
  const relativePath = relative(sourceRoot, source) || ".";
  const info = lstatSync(source);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    mkdirSync(destination, { mode: info.mode & 0o777 });
    chmodSync(destination, info.mode & 0o777);
    fsyncMaintenanceDirectory(dirname(destination));
    for (const name of readdirSync(source).sort()) {
      const childRelative = relativePath === "." ? name : join(relativePath, name);
      if (childRelative === WRITER_LOCK_RELATIVE_PATH) continue;
      copyTreeDurably(join(source, name), join(destination, name), sourceRoot);
    }
    utimesSync(destination, info.atime, info.mtime);
    fsyncMaintenanceDirectory(destination);
    return;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${LABEL}: memory tree contains an unsafe entry`);
  }
  const input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: number | undefined;
  try {
    const opened = fstatSync(input);
    assertSameDurableSwapFile(info, opened, source);
    output = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      info.mode & 0o777,
    );
    fchmodSync(output, opened.mode & 0o777);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (count <= 0) throw new Error(`${LABEL}: short backup read`);
      let written = 0;
      while (written < count) written += writeSync(output, buffer, written, count - written);
      offset += count;
    }
    futimesSync(output, opened.atime, opened.mtime);
    fsyncSync(output);
    assertSameDurableSwapSnapshot(opened, fstatSync(input), source);
    assertSameDurableSwapFile(opened, lstatSync(source), source);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

export function cleanupSqliteCoordination(dbPath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const path = `${dbPath}${suffix}`;
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`${LABEL}: unsafe SQLite coordination file`);
    }
    if (suffix !== "-shm" && info.size !== 0) {
      throw new Error(`${LABEL}: SQLite coordination file is not checkpointed`);
    }
    unlinkSync(path);
    fsyncMaintenanceDirectory(dirname(path));
  }
}

export function writeJsonExclusiveDurable(path: string, value: unknown): void {
  const temp = `${path}.publish-${process.pid}-${randomUUID()}`;
  try {
    writeJsonFileDurable(temp, value);
    if (existsSync(path)) throw new Error(`${LABEL}: durable artifact already exists`);
    renameSync(temp, path);
    fsyncMaintenanceDirectory(dirname(path));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function writeJsonFileDurable(path: string, value: unknown): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function replaceJsonDurable(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeJsonFileDurable(temp, value);
    renameSync(temp, path);
    fsyncMaintenanceDirectory(dirname(path));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function readOwnerJson(path: string): unknown {
  const before = lstatSync(path);
  assertDurableSwapPrivateArtifactInfo(before);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertSameDurableSwapFile(before, opened, path);
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count <= 0) throw new Error(`${LABEL}: short artifact read`);
      offset += count;
    }
    assertSameDurableSwapSnapshot(opened, fstatSync(fd), path);
    assertSameDurableSwapFile(opened, lstatSync(path), path);
    return JSON.parse(data.toString("utf8")) as unknown;
  } finally {
    closeSync(fd);
  }
}

export function assertDurableSwapPrivateArtifactInfo(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size > MAX_ARTIFACT_BYTES || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error(`${LABEL}: private artifact is unsafe`);
  }
}

export function unlinkDurable(path: string): void {
  unlinkSync(path);
  fsyncMaintenanceDirectory(dirname(path));
}

export function assertSafeRelative(path: string): void {
  const parts = path.split(/[\\/]/u);
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")
    || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`${LABEL}: unsafe relative path`);
  }
}

export function assertSameDurableSwapFile(
  expected: Pick<Stats, "dev" | "ino" | "isFile" | "isSymbolicLink" | "nlink">,
  actual: Stats,
  label: string,
): void {
  if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1
    || expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`${LABEL}: ${label} changed identity`);
  }
}

export function assertSameDurableSwapSnapshot(
  expected: Stats,
  actual: Stats,
  label: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.size !== actual.size
    || expected.mtimeMs !== actual.mtimeMs || expected.ctimeMs !== actual.ctimeMs) {
    throw new Error(`${LABEL}: ${label} changed while accessed`);
  }
}

export function rootFingerprint(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
