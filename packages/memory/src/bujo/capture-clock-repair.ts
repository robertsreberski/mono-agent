import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../store/index.js";

import {
  decodeLegacyCaptureClockRepairIntent,
  serializeCaptureIntent,
  type CaptureIntent,
  type CaptureIntentAction,
  type LegacyCaptureClockCorrection,
  type LegacyCaptureClockRepairIntent,
} from "./capture-outbox.js";
import { appendBullet } from "./daily.js";
import {
  MEMORY_CAPTURE_CLOCK_REPAIR_SWAP_OPERATION,
  cleanupSqliteCoordination,
  createDurableRootSwapBackup,
  durableRootSwapTransactionMatches,
  memoryTreeFingerprint,
  readDurableRootSwapBackup,
  readDurableRootSwapTransaction,
  readOwnerJson,
  renameAcrossMaintenanceDirectoriesDurably,
  replaceJsonDurable,
  resolveMemoryRootForMaintenance,
  rootFingerprint,
  unlinkDurable,
  writeJsonExclusiveDurable,
  type DurableRootSwapBackupState,
  type DurableRootSwapTransaction,
} from "./durable-root-swap.js";
import {
  acquireMemoryWriterLeaseForMaintenance,
  resolveActiveMemoryDbPath,
  withManagedRollbackRetirement,
  type MemoryWriterLease,
} from "./generations.js";
import { parseDailyFile, serializeDailyFile } from "./grammar.js";
import {
  assertCanonicalGraphRepairBaseParity,
  assertCanonicalIndexParityUnderMaintenance,
} from "./rebuild.js";
import { acquireMemoryMaintenanceLease, memoryMaintenanceTransactionPath } from "./maintenance.js";
import { recoverDurableMutationState } from "./mutation-lock.js";
import {
  listCanonicalFileNames,
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
  type CanonicalFileIdentity,
} from "./path-safety.js";
import {
  mergeReplayProjectionDelta,
  assertReplayProjectionMatchesDb,
  readBujoCanonicalSourceFingerprint,
  readReplayProjectionStrict,
  serializeReplayProjection,
  type ReplayProjectionDelta,
  type ReplayProjectionV1,
} from "./replay-projection.js";
import type { Bullet } from "./types.js";

const OPERATION = MEMORY_CAPTURE_CLOCK_REPAIR_SWAP_OPERATION;
const INTENT_FILE_RE = /^intent-[a-f0-9-]{36}\.json$/u;
const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_ATTEMPTS = 32;

interface ClockRepairPlan extends LegacyCaptureClockRepairIntent {
  readonly file: string;
  readonly identity: CanonicalFileIdentity;
}

export interface CaptureClockRepairHooks {
  readonly afterBackupDurable?: () => void;
  readonly afterTransactionDurable?: () => void;
  readonly afterCanonicalRepair?: () => void;
  readonly afterReplayAuthorityRepair?: () => void;
  readonly afterDatabaseRepair?: () => void;
  readonly afterIntentRepair?: () => void;
  readonly afterReplay?: () => void;
}

export interface CaptureClockRepairResult {
  readonly repairedIntents: number;
  readonly repairedSupersedes: number;
  readonly backupPath?: string;
}

/**
 * Synchronous, provider-free startup repair for the one invalid retained
 * intent shape emitted before supersession clocks became monotonic.
 */
export function repairLegacyCaptureClockDriftAtStartup(options: {
  readonly root: string;
  readonly dimension: number;
  readonly hooks?: CaptureClockRepairHooks;
}): CaptureClockRepairResult {
  const transactionPath = optionalTransactionPath(options.root);
  const recovering = transactionPath !== undefined && isClockRepairTransaction(transactionPath);
  if (!recovering && !existsSync(resolve(options.root))) return emptyResult();

  const initialRoot = recovering
    ? undefined
    : resolveMemoryRootForMaintenance(options.root, OPERATION);
  if (!recovering && discoverPlans(initialRoot!).length === 0) return emptyResult();

  const maintenance = acquireMemoryMaintenanceLease(options.root);
  let writer: MemoryWriterLease | undefined;
  let db: MemoryDb | undefined;
  let backup: DurableRootSwapBackupState | undefined;
  let transactionDurable = false;
  let repairRoot: string | undefined;
  try {
    let root = recovering
      ? resolveMemoryRootForMaintenance(options.root, OPERATION)
      : initialRoot!;
    repairRoot = root;
    const prior = existsSync(maintenance.transactionPath)
      ? readDurableRootSwapTransaction(maintenance.transactionPath, OPERATION)
      : undefined;
    if (prior !== undefined) {
      backup = readDurableRootSwapBackup(prior.backupPath, OPERATION);
      if (!durableRootSwapTransactionMatches(prior, rootFingerprint(root), backup)) {
        throw new Error("memory-capture-clock-repair: recovery transaction does not match its backup.");
      }
      restoreClockRepairRoot(root, maintenance.transactionPath, prior, backup, options.dimension);
      root = resolveMemoryRootForMaintenance(options.root, OPERATION);
      repairRoot = root;
      backup = undefined;
    }

    let plans = discoverPlans(root);
    if (plans.length === 0) return emptyResult();
    const basePlanDigest = aggregatePlanDigest(plans);
    writer = acquireMemoryWriterLeaseForMaintenance(root);
    plans = discoverPlans(root);
    if (aggregatePlanDigest(plans) !== basePlanDigest) {
      throw new Error("memory-capture-clock-repair: retained intent changed before repair.");
    }
    const dbPath = resolveActiveMemoryDbPath(root);
    const expectedRootFingerprint = rootFingerprint(root);
    const expectedSourceFingerprint = readBujoCanonicalSourceFingerprint(root);
    const selectedBackup = selectBackupAttempt({
      root,
      dbPath,
      basePlanDigest,
      expectedRootFingerprint,
      expectedSourceFingerprint,
      dimension: options.dimension,
    });
    const planDigest = selectedBackup.planDigest;
    backup = selectedBackup.backup ?? createDurableRootSwapBackup({
        root,
        dbPath,
        operation: OPERATION,
        expectedRootFingerprint,
        expectedSourceFingerprint,
        planDigest,
        dimension: options.dimension,
      });
    options.hooks?.afterBackupDurable?.();
    const transaction: DurableRootSwapTransaction = {
      schemaVersion: 1,
      operation: OPERATION.transactionOperation,
      phase: "applying",
      rootFingerprint: expectedRootFingerprint,
      backupPath: backup.path,
      planDigest,
      originalTreeFingerprint: backup.manifest.treeFingerprint,
    };
    writeJsonExclusiveDurable(maintenance.transactionPath, transaction);
    transactionDurable = true;
    backup.manifest = { ...backup.manifest, status: "applying" };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    options.hooks?.afterTransactionDurable?.();

    for (const plan of plans) repairCanonicalReplacement(root, plan);
    options.hooks?.afterCanonicalRepair?.();
    for (const plan of plans) repairReplayAuthority(root, plan);
    options.hooks?.afterReplayAuthorityRepair?.();

    db = openMemoryDb({ path: dbPath, dim: options.dimension });
    for (const plan of plans) repairDatabaseClock(db, plan);
    options.hooks?.afterDatabaseRepair?.();
    for (const plan of plans) {
      writeCanonicalFileAtomic(root, plan.file, serializeCaptureIntent(plan.repaired), plan.identity);
    }
    options.hooks?.afterIntentRepair?.();
    recoverDurableMutationState(root, db, "bujo", assertCanonicalGraphRepairBaseParity);
    options.hooks?.afterReplay?.();
    db.checkpoint();
    db.close();
    db = undefined;
    cleanupSqliteCoordination(dbPath);

    const repairedSourceFingerprint = readBujoCanonicalSourceFingerprint(root);
    assertRepairedRoot(root, dbPath, options.dimension, repairedSourceFingerprint);
    backup.manifest = {
      ...backup.manifest,
      status: "applied",
      postTreeFingerprint: memoryTreeFingerprint(root),
      postActiveDbRelativePath: relative(root, dbPath),
    };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    unlinkDurable(maintenance.transactionPath);
    transactionDurable = false;
    writer.release();
    writer = undefined;
    return {
      repairedIntents: plans.length,
      repairedSupersedes: plans.reduce((count, plan) => count + plan.corrections.length, 0),
      backupPath: backup.path,
    };
  } catch (error) {
    try { db?.close(); } catch { /* exact-root recovery decides the outcome */ }
    db = undefined;
    if (transactionDurable && backup !== undefined) {
      try {
        writer?.release();
        writer = undefined;
        const transaction = readDurableRootSwapTransaction(maintenance.transactionPath, OPERATION);
        restoreClockRepairRoot(repairRoot!, maintenance.transactionPath, transaction, backup, options.dimension);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "memory-capture-clock-repair: repair failed and exact-root recovery failed.",
        );
      }
    }
    throw error;
  } finally {
    try { db?.close(); } catch { /* preserve the primary result */ }
    writer?.release();
    maintenance.release();
  }
}

function discoverPlans(root: string): ClockRepairPlan[] {
  const names = listCanonicalFileNames(root, ".capture-outbox", {
    allowMissing: true,
    include: (name) => INTENT_FILE_RE.test(name),
  });
  const plans: ClockRepairPlan[] = [];
  for (const name of names) {
    const file = `.capture-outbox/${name}`;
    const snapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_INTENT_BYTES });
    if (snapshot === undefined) throw new Error("memory-capture-clock-repair: retained intent disappeared.");
    const decoded = decodeLegacyCaptureClockRepairIntent(snapshot.content);
    if (decoded !== undefined) plans.push({ file, identity: snapshot.identity, ...decoded });
  }
  return plans;
}

function aggregatePlanDigest(plans: readonly ClockRepairPlan[]): string {
  if (plans.length === 0) throw new Error("memory-capture-clock-repair: repair plan is empty.");
  return createHash("sha256")
    .update("mono-agent-memory-capture-clock-repair-batch-v1\0", "utf8")
    .update(JSON.stringify(plans.map((plan) => ({ file: plan.file, planDigest: plan.planDigest }))), "utf8")
    .digest("hex");
}

function derivedBackupPlanDigest(base: string, attempt: number): string {
  return createHash("sha256")
    .update("mono-agent-memory-capture-clock-repair-attempt-v1\0", "utf8")
    .update(base, "utf8")
    .update("\0", "utf8")
    .update(String(attempt), "utf8")
    .digest("hex");
}

function selectBackupAttempt(options: {
  readonly root: string;
  readonly dbPath: string;
  readonly basePlanDigest: string;
  readonly expectedRootFingerprint: string;
  readonly expectedSourceFingerprint: string;
  readonly dimension: number;
}): { readonly planDigest: string; readonly backup?: DurableRootSwapBackupState } {
  const currentTree = memoryTreeFingerprint(options.root);
  const activeDbRelativePath = relative(options.root, options.dbPath);
  for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt += 1) {
    const planDigest = derivedBackupPlanDigest(options.basePlanDigest, attempt);
    const path = join(
      dirname(options.root),
      `.${basename(options.root)}-${OPERATION.backupInfix}-${planDigest.slice(0, 24)}`,
    );
    if (!existsSync(path)) return { planDigest };
    const backup = readDurableRootSwapBackup(path, OPERATION);
    if (backup.manifest.status === "applied" || backup.manifest.status === "recovered") continue;
    if (backup.manifest.status !== "prepared"
      || backup.manifest.planDigest !== planDigest
      || backup.manifest.rootFingerprint !== options.expectedRootFingerprint
      || backup.manifest.sourceFingerprint !== options.expectedSourceFingerprint
      || backup.manifest.treeFingerprint !== currentTree
      || backup.manifest.activeDbRelativePath !== activeDbRelativePath
      || backup.manifest.dimension !== options.dimension
      || !existsSync(backup.snapshotPath)
      || memoryTreeFingerprint(backup.snapshotPath) !== currentTree
      || aggregatePlanDigest(discoverPlans(backup.snapshotPath)) !== options.basePlanDigest) {
      throw new Error("memory-capture-clock-repair: prepared backup lost compare-and-swap.");
    }
    return { planDigest, backup };
  }
  throw new Error("memory-capture-clock-repair: retained backup namespace is exhausted.");
}

function repairCanonicalReplacement(root: string, plan: ClockRepairPlan): void {
  for (const correction of plan.corrections) {
    const legacyAction = supersedeByNewId(plan.legacy, correction.newId);
    const repairedAction = supersedeByNewId(plan.repaired, correction.newId);
    const legacyState = locateBullet(root, correction.oldFile, correction.newId);
    const repairedState = correction.effectiveFile === correction.oldFile
      ? legacyState
      : locateBullet(root, correction.effectiveFile, correction.newId);
    const legacyPresent = legacyState !== undefined && bulletsEqual(legacyState.bullet, legacyAction.afterNew.bullet);
    const repairedPresent = repairedState !== undefined && bulletsEqual(repairedState.bullet, repairedAction.afterNew.bullet);
    if (legacyPresent && repairedPresent && correction.oldFile !== correction.effectiveFile) {
      throw new Error("memory-capture-clock-repair: replacement is duplicated across daily files.");
    }
    if (repairedPresent && !legacyPresent) continue;
    if (legacyState === undefined && repairedState === undefined) continue;
    if (!legacyPresent) throw new Error("memory-capture-clock-repair: canonical replacement lost compare-and-swap.");

    if (correction.oldFile === correction.effectiveFile) {
      const lines = legacyState.snapshot.content;
      const parsed = parseDailyFile(lines);
      const updated = parsed.lines.map((line) => line.bullet?.id === correction.newId
        ? { ...line, bullet: repairedAction.afterNew.bullet }
        : line);
      withManagedRollbackRetirement(root, "daily", () => writeCanonicalFileAtomic(
          root,
          correction.oldFile,
          serializeDailyFile({ lines: updated }),
          legacyState.snapshot.identity,
        ));
      continue;
    }

    withManagedRollbackRetirement(root, "daily", () => {
      appendBullet(root, repairedAction.afterNew.bullet, new Date(correction.effectiveAt));
      const parsed = parseDailyFile(legacyState.snapshot.content);
      const remaining = parsed.lines.filter((line) => line.bullet?.id !== correction.newId);
      writeCanonicalFileAtomic(
        root,
        correction.oldFile,
        serializeDailyFile({ lines: remaining }),
        legacyState.snapshot.identity,
      );
    });
  }
}

function locateBullet(root: string, file: string, id: string): {
  readonly bullet: Bullet;
  readonly snapshot: NonNullable<ReturnType<typeof readCanonicalFileSnapshot>>;
} | undefined {
  const snapshot = readCanonicalFileSnapshot(root, file, { allowMissing: true });
  if (snapshot === undefined) return undefined;
  const matches = parseDailyFile(snapshot.content).bullets.filter((bullet) => bullet.id === id);
  if (matches.length > 1) throw new Error("memory-capture-clock-repair: canonical replacement is duplicated.");
  return matches[0] === undefined ? undefined : { bullet: matches[0], snapshot };
}

function repairReplayAuthority(root: string, plan: ClockRepairPlan): void {
  const current = readReplayProjectionStrict(root);
  if (current.state.kind === "missing") return;
  const legacyDelta = projectionDelta(plan.legacy, plan.legacyAuthorityId);
  const repairedDelta = projectionDelta(plan.repaired, plan.repairedAuthorityId);
  const legacyMatch = authorityDeltaState(current.projection, legacyDelta, plan.legacyAuthorityId);
  const repairedMatch = authorityDeltaState(current.projection, repairedDelta, plan.repairedAuthorityId);
  if (legacyMatch === "absent" && repairedMatch === "absent") return;
  if (legacyMatch === "absent" && repairedMatch === "exact") return;
  if (legacyMatch !== "exact" || repairedMatch !== "absent") {
    throw new Error("memory-capture-clock-repair: replay authority lost compare-and-swap.");
  }
  const withoutLegacy: ReplayProjectionV1 = {
    schemaVersion: 1,
    terminals: current.projection.terminals.filter((entry) => entry.authorityId !== plan.legacyAuthorityId),
    supersedes: current.projection.supersedes.filter((entry) => entry.authorityId !== plan.legacyAuthorityId),
    threads: current.projection.threads.filter((entry) => entry.authorityId !== plan.legacyAuthorityId),
  };
  const repaired = mergeReplayProjectionDelta(withoutLegacy, repairedDelta);
  const replayIdentity = current.state.identity;
  withManagedRollbackRetirement(root, "replay", () => writeCanonicalFileAtomic(
      root,
      ".replay-projection-v1.json",
      serializeReplayProjection(repaired),
      replayIdentity,
    ));
}

function projectionDelta(intent: CaptureIntent, authorityId: string): ReplayProjectionDelta {
  return {
    supersedes: intent.actions.flatMap((action) => action.kind === "supersede" ? [{
      src: action.oldId,
      dst: action.newId,
      at: action.at,
      authorityKind: "capture" as const,
      authorityId,
    }] : []),
    threads: intent.actions.flatMap((action) => action.kind === "add" ? action.threads.map((edge) => ({
      src: edge.src,
      dst: edge.dst,
      weight: edge.weight,
      at: edge.createdAt!,
      authorityKind: "capture" as const,
      authorityId,
    })) : []),
  };
}

function authorityDeltaState(
  projection: ReplayProjectionV1,
  delta: ReplayProjectionDelta,
  authorityId: string,
): "absent" | "exact" | "different" {
  const actual = [
    ...projection.terminals.filter((entry) => entry.authorityId === authorityId),
    ...projection.supersedes.filter((entry) => entry.authorityId === authorityId),
    ...projection.threads.filter((entry) => entry.authorityId === authorityId),
  ].map(canonicalJson).sort();
  if (actual.length === 0) return "absent";
  const expected = [
    ...(delta.terminals ?? []),
    ...(delta.supersedes ?? []),
    ...(delta.threads ?? []),
  ].map(canonicalJson).sort();
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
    ? "exact"
    : "different";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function repairDatabaseClock(db: MemoryDb, plan: ClockRepairPlan): void {
  for (const correction of plan.corrections) {
    const legacy = supersedeByNewId(plan.legacy, correction.newId);
    const repaired = supersedeByNewId(plan.repaired, correction.newId);
    const old = db.get(correction.oldId);
    if (old === undefined
      || (!recordMatchesBullet(old, legacy.beforeOld) && !recordMatchesBullet(old, legacy.afterOld))) {
      throw new Error("memory-capture-clock-repair: active-index target lost compare-and-swap.");
    }
    const replacement = db.get(correction.newId);
    if (replacement !== undefined
      && !recordMatchesBullet(replacement, legacy.afterNew)
      && !recordMatchesBullet(replacement, repaired.afterNew)) {
      throw new Error("memory-capture-clock-repair: active-index replacement lost compare-and-swap.");
    }
    db.repairLegacySupersedeClock({
      oldId: correction.oldId,
      newId: correction.newId,
      expectedOldStatus: correction.expectedOldStatus,
      legacyAt: correction.admittedAt,
      effectiveAt: correction.effectiveAt,
      legacySourceFile: correction.oldFile,
      effectiveSourceFile: correction.effectiveFile,
    });
  }
}

function recordMatchesBullet(record: MemoryRecord, state: { readonly file: string; readonly bullet: Bullet }): boolean {
  return record.id === state.bullet.id
    && record.type === state.bullet.type
    && record.status === state.bullet.status
    && record.text === state.bullet.text
    && record.salience === state.bullet.salience
    && record.isInsight === state.bullet.isInsight
    && record.createdAt === state.bullet.createdAt
    && record.dueAt === state.bullet.dueAt
    && record.source.file === state.file;
}

function supersedeByNewId(
  intent: CaptureIntent,
  newId: string,
): Extract<CaptureIntentAction, { readonly kind: "supersede" }> {
  const action = intent.actions.find((candidate): candidate is Extract<CaptureIntentAction, { readonly kind: "supersede" }> => (
    candidate.kind === "supersede" && candidate.newId === newId
  ));
  if (action === undefined) throw new Error("memory-capture-clock-repair: supersede action disappeared.");
  return action;
}

function bulletsEqual(left: Bullet, right: Bullet): boolean {
  return left.id === right.id && left.type === right.type && left.status === right.status
    && left.text === right.text && left.salience === right.salience
    && left.isInsight === right.isInsight && left.createdAt === right.createdAt
    && left.dueAt === right.dueAt && left.refs.length === right.refs.length
    && left.refs.every((ref, index) => ref === right.refs[index]);
}

function assertRepairedRoot(root: string, dbPath: string, dimension: number, sourceFingerprint: string): void {
  if (readBujoCanonicalSourceFingerprint(root) !== sourceFingerprint) {
    throw new Error("memory-capture-clock-repair: canonical source changed during repair.");
  }
  const db = openMemoryDb({ path: dbPath, readOnly: true, dim: dimension });
  try {
    if (db.integrityCheck().toLowerCase() !== "ok") {
      throw new Error("memory-capture-clock-repair: SQLite integrity check failed.");
    }
    const replay = readReplayProjectionStrict(root);
    if (replay.state.kind !== "present") {
      throw new Error("memory-capture-clock-repair: replay authority is missing after repair.");
    }
    assertReplayProjectionMatchesDb(db, replay.projection);
    assertCanonicalIndexParityUnderMaintenance(root, db);
  } finally {
    db.close();
  }
  cleanupSqliteCoordination(dbPath);
}

function restoreClockRepairRoot(
  rawRoot: string,
  transactionPath: string,
  initial: DurableRootSwapTransaction,
  backup: DurableRootSwapBackupState,
  dimension: number,
): void {
  const root = resolve(rawRoot);
  let transaction = reconcileRestorePhase(transactionPath, initial, root, backup);
  assertOriginalBackup(backup, transaction, dimension);
  let writer: MemoryWriterLease | undefined;
  try {
    if ((transaction.phase === "applying" || transaction.phase === "restore-prepared"
      || transaction.phase === "quarantine-intent") && existsSync(root)) {
      writer = acquireMemoryWriterLeaseForMaintenance(root);
    }
    if (transaction.phase === "applying") {
      transaction = { ...transaction, phase: "restore-prepared" };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (transaction.phase === "restore-prepared") {
      transaction = { ...transaction, phase: "quarantine-intent" };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (transaction.phase === "quarantine-intent") {
      if (existsSync(root) && existsSync(backup.snapshotPath) && !existsSync(backup.postRootPath)) {
        writer?.release();
        writer = undefined;
        renameAcrossMaintenanceDirectoriesDurably(root, backup.postRootPath);
      } else if (existsSync(root) || !existsSync(backup.snapshotPath) || !existsSync(backup.postRootPath)) {
        throw new Error("memory-capture-clock-repair: quarantine state is invalid.");
      }
      transaction = { ...transaction, phase: "root-quarantined" };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (transaction.phase === "root-quarantined") {
      transaction = { ...transaction, phase: "activation-intent" };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (transaction.phase === "activation-intent") {
      if (!existsSync(root) && existsSync(backup.snapshotPath) && existsSync(backup.postRootPath)) {
        renameAcrossMaintenanceDirectoriesDurably(backup.snapshotPath, root);
      } else if (!existsSync(root) || existsSync(backup.snapshotPath) || !existsSync(backup.postRootPath)) {
        throw new Error("memory-capture-clock-repair: activation state is invalid.");
      }
      transaction = { ...transaction, phase: "root-activated" };
      replaceJsonDurable(transactionPath, transaction);
    }
    if (transaction.phase !== "root-activated" || memoryTreeFingerprint(root) !== backup.manifest.treeFingerprint) {
      throw new Error("memory-capture-clock-repair: restored root fingerprint mismatch.");
    }
    backup.manifest = { ...backup.manifest, status: "recovered" };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    unlinkDurable(transactionPath);
    try { rmSync(backup.postRootPath, { recursive: true, force: false }); } catch { /* harmless retained quarantine */ }
  } finally {
    writer?.release();
  }
}

function reconcileRestorePhase(
  path: string,
  transaction: DurableRootSwapTransaction,
  root: string,
  backup: DurableRootSwapBackupState,
): DurableRootSwapTransaction {
  const rootExists = existsSync(root);
  const snapshotExists = existsSync(backup.snapshotPath);
  const postExists = existsSync(backup.postRootPath);
  let phase = transaction.phase;
  if ((phase === "restore-prepared" || phase === "quarantine-intent")
    && !rootExists && snapshotExists && postExists) phase = "root-quarantined";
  if ((phase === "root-quarantined" || phase === "activation-intent")
    && rootExists && !snapshotExists && postExists) phase = "root-activated";
  if (phase === transaction.phase) return transaction;
  const repaired = { ...transaction, phase };
  replaceJsonDurable(path, repaired);
  return repaired;
}

function assertOriginalBackup(
  backup: DurableRootSwapBackupState,
  transaction: DurableRootSwapTransaction,
  _dimension: number,
): void {
  if (!existsSync(backup.snapshotPath)
    || memoryTreeFingerprint(backup.snapshotPath) !== backup.manifest.treeFingerprint) {
    throw new Error("memory-capture-clock-repair: original backup changed.");
  }
  const plans = discoverPlans(backup.snapshotPath);
  const base = aggregatePlanDigest(plans);
  const recognized = Array.from({ length: MAX_BACKUP_ATTEMPTS }, (_, attempt) => (
    derivedBackupPlanDigest(base, attempt)
  )).includes(transaction.planDigest);
  if (!recognized) throw new Error("memory-capture-clock-repair: original backup plan changed.");
  if (memoryTreeFingerprint(backup.snapshotPath) !== backup.manifest.treeFingerprint) {
    throw new Error("memory-capture-clock-repair: original backup changed during validation.");
  }
}

function optionalTransactionPath(root: string): string | undefined {
  try { return memoryMaintenanceTransactionPath(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isClockRepairTransaction(path: string): boolean {
  if (!existsSync(path)) return false;
  const value = readOwnerJson(path);
  return typeof value === "object" && value !== null
    && (value as { operation?: unknown }).operation === OPERATION.transactionOperation;
}

function emptyResult(): CaptureClockRepairResult {
  return { repairedIntents: 0, repairedSupersedes: 0 };
}
