import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyOriginContextGroupCommit } from "./continuation-origin-store.js";
import { readBoundedOwnerOnlyFile } from "../durable-state/private-files.js";
import { loadLegacyStore, mergeMigrationRecords } from "./continuation-store-records.js";
import {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
} from "./continuation-store.js";
import {
  applyRetention,
  isDurableGeneration,
  isOriginContextGroupCommit,
  isRecord,
  isRecordTransaction,
  isStoreFile,
  normalizeLegacyContinuationRecords,
  requiredDate,
  resolveRetention,
} from "./continuation-store-policy.js";
import {
  MAX_LEGACY_STORE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RECORD_BYTES,
  MAX_TRANSACTION_BYTES,
  type ContinuationRecordTransaction,
  type ContinuationRetentionOptions,
  type DurableContinuationRecord,
} from "./continuation-store-types.js";
import { CONTINUATION_STATES, continuationDigest, type ContinuationState } from "./continuations.js";
import { continuationFsCode, continuationReason, isDoctorObject } from "../diagnostics/inspection-values.js";

const CONTINUATION_V2_ROLLBACK_GUARD = "UPGRADED-TO-RECORDS-V3";
const CONTINUATION_V2_ROLLBACK_GUARD_CONTENT =
  "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n";

export async function inspectContinuationState(
  stateDir: string,
  retention: ContinuationRetentionOptions,
): Promise<{
  readonly status: "ok" | "waiting" | "error";
  readonly details: readonly string[];
}> {
  const details: string[] = [];
  const retentionPolicy = resolveRetention(retention);
  let directory;
  try {
    directory = await lstat(stateDir);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return {
        status: "ok",
        details: ["State has not been initialized; the app will create it with owner-only permissions on first start."],
      };
    }
    return { status: "error", details: [`Continuation state cannot be inspected: ${continuationReason(error)}`] };
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    return { status: "error", details: ["Continuation state path must be a real directory, not a file or symlink."] };
  }
  const directorySecurityError = continuationOwnershipError(directory, "state directory", 0o700);
  if (directorySecurityError !== undefined) {
    return { status: "error", details: [directorySecurityError] };
  }

  const secretError = await inspectContinuationSecret(join(stateDir, "continuation-secret"));
  if (secretError !== undefined) {
    return { status: "error", details: [secretError] };
  }

  const manifestPath = join(stateDir, "continuation-store-v3.json");
  let manifestInfo;
  try {
    manifestInfo = await lstat(manifestPath);
  } catch (error) {
    if (continuationFsCode(error) !== "ENOENT") {
      return { status: "error", details: [`Continuation store manifest cannot be inspected: ${continuationReason(error)}`] };
    }
  }
  if (manifestInfo !== undefined) {
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      return { status: "error", details: ["Continuation store manifest must be a regular file, not a symlink."] };
    }
    const manifestSecurityError = continuationOwnershipError(manifestInfo, "store manifest", 0o600);
    if (manifestSecurityError !== undefined) return { status: "error", details: [manifestSecurityError] };
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readBoundedOwnerOnlyFile(
        manifestPath,
        MAX_MANIFEST_BYTES,
        "Continuation v3 manifest",
      )) as unknown;
    } catch (error) {
      return { status: "error", details: [`Continuation store manifest contains invalid JSON: ${continuationReason(error)}`] };
    }
    if (!isContinuationStoreManifest(
      manifest,
      CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
      "per-record-v3",
    )) {
      return { status: "error", details: ["Continuation store manifest has an unsupported or malformed schema."] };
    }
    const recordsDirectoryPath = join(stateDir, "records-v3");
    const recordsDirectoryError = await inspectContinuationRecordsDirectory(recordsDirectoryPath);
    if (recordsDirectoryError !== undefined) return { status: "error", details: [recordsDirectoryError] };
    let recordsDirectoryHasEntries: boolean;
    try {
      recordsDirectoryHasEntries = (await readdir(recordsDirectoryPath))
        .some((entry) => !(entry.startsWith(".") && entry.endsWith(".tmp")));
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation record directory cannot be inspected: ${continuationReason(error)}`],
      };
    }
    const transaction = await inspectContinuationTransaction(
      join(stateDir, "continuation-transaction-v3.json"),
      CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
    );
    if (!transaction.valid) return { status: "error", details: [transaction.detail] };
    const legacyRecordsDirectoryPath = join(stateDir, "records-v2");
    let legacyRecordsDirectoryExists = false;
    try {
      const legacyRecordsDirectoryInfo = await lstat(legacyRecordsDirectoryPath);
      legacyRecordsDirectoryExists = true;
      if (!legacyRecordsDirectoryInfo.isDirectory() || legacyRecordsDirectoryInfo.isSymbolicLink()) {
        return { status: "error", details: ["Legacy continuation record directory must be a real directory."] };
      }
      const legacyRecordsDirectoryError = await inspectContinuationRecordsDirectory(
        legacyRecordsDirectoryPath,
        { allowV2RollbackGuard: true },
      );
      if (legacyRecordsDirectoryError !== undefined) {
        return { status: "error", details: [legacyRecordsDirectoryError] };
      }
    } catch (error) {
      if (continuationFsCode(error) !== "ENOENT") {
        return {
          status: "error",
          details: [`Legacy continuation record directory cannot be inspected: ${continuationReason(error)}`],
        };
      }
    }
    let legacyStateExists = legacyRecordsDirectoryExists;
    const legacyV1Path = join(stateDir, "continuations-v1.json");
    const legacyV1 = await inspectContinuationEvidenceFile(legacyV1Path, "v1 store");
    if (!legacyV1.valid) return { status: "error", details: [legacyV1.detail] };
    legacyStateExists ||= legacyV1.exists;
    const legacyV2Manifest = await inspectContinuationEvidenceFile(
      join(stateDir, "continuation-store-v2.json"),
      "v2 manifest",
    );
    if (!legacyV2Manifest.valid) return { status: "error", details: [legacyV2Manifest.detail] };
    legacyStateExists ||= legacyV2Manifest.exists;
    const legacyTransaction = await inspectContinuationTransaction(
      join(stateDir, "continuation-transaction-v2.json"),
      2,
    );
    if (!legacyTransaction.valid) return { status: "error", details: [legacyTransaction.detail] };
    legacyStateExists ||= legacyTransaction.pending;
    const manifestRollbackGuardRequired = manifest.rollbackGuardRequired ?? true;
    const legacyMigrationPending = legacyStateExists && !manifestRollbackGuardRequired;
    let recoverableRecords: Map<string, DurableContinuationRecord>;
    try {
      recoverableRecords = await loadContinuationRecordsForRecoveryInspection(recordsDirectoryPath);
      if (transaction.transaction !== undefined) {
        applyContinuationTransactionForInspection(recoverableRecords, transaction.transaction);
      }
      normalizeLegacyContinuationRecords(recoverableRecords);
      if (legacyMigrationPending) {
        const legacy = legacyRecordsDirectoryExists
          ? await loadContinuationRecordsForRecoveryInspection(legacyRecordsDirectoryPath)
          : new Map<string, DurableContinuationRecord>();
        if (legacyTransaction.transaction !== undefined) {
          applyContinuationTransactionForInspection(legacy, legacyTransaction.transaction);
        }
        if (legacyV1.exists) {
          mergeMigrationRecords(legacy, await loadLegacyStore(legacyV1Path), "recoverable v1 and v2");
        }
        mergeMigrationRecords(recoverableRecords, legacy, "recoverable v2 and v3");
      }
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation recoverable records are malformed or conflicting: ${continuationReason(error)}`],
      };
    }
    const originGroups = await inspectContinuationEvidenceDirectory(
      join(stateDir, "origin-context-groups-v1"),
      "origin-context activation directory",
      async () => recoverableRecords,
    );
    if (!originGroups.valid) return { status: "error", details: [originGroups.detail] };
    try {
      applyRetention(recoverableRecords, retentionPolicy, new Date());
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation retention projection cannot be recovered safely: ${continuationReason(error)}`],
      };
    }
    const rollbackGuardRequired = manifestRollbackGuardRequired
      || recordsDirectoryHasEntries
      || transaction.pending
      || originGroups.hasEntries;
    const rollbackGuard = await inspectContinuationRollbackGuard(
      join(legacyRecordsDirectoryPath, CONTINUATION_V2_ROLLBACK_GUARD),
      rollbackGuardRequired,
      legacyMigrationPending
        ? "Legacy continuation state is awaiting v3 migration; the current runtime will fence it before v3 materialization."
        : "The empty v3 store has no v2 rollback guard; the current runtime will install one before its first v3 record becomes durable.",
    );
    if (!rollbackGuard.valid) return { status: "error", details: [rollbackGuard.detail] };
    const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
    if (!owner.valid) return { status: "error", details: [owner.detail] };
    details.push(
      `Store v3: ${String(manifest.stats.records)} retained; ${String(manifest.stats.active)} active; ${String(manifest.stats.unresolvedDelivery)} delivery unknown; ${String(manifest.stats.deadLettered)} dead-lettered; ${String(manifest.stats.historyDegraded)} history-degraded deliveries; ${String(manifest.stats.terminalTombstones)} terminal tombstones; ${String(manifest.stats.compacted)} compacted; ${String(manifest.stats.capturedText)} captured answers.`,
      `Retention: at most ${String(manifest.stats.limits.terminalMaxRecords)} terminal tombstones with a maximum age of ${String(manifest.stats.limits.terminalMaxAgeMs)} ms and ${String(manifest.stats.limits.capturedTextMaxRecords)} captured answers with a maximum age of ${String(manifest.stats.limits.capturedTextMaxAgeMs)} ms.`,
      transaction.detail,
      rollbackGuard.detail,
      originGroups.detail,
      ...(legacyMigrationPending ? ["Legacy continuation state is awaiting idempotent v3 migration."] : []),
      owner.detail,
    );
    return {
      status: transaction.pending
        || originGroups.hasEntries
        || legacyMigrationPending
        || manifest.stats.unresolvedDelivery > 0
        || manifest.stats.deadLettered > 0
        || manifest.stats.historyDegraded > 0
        ? "waiting"
        : "ok",
      details,
    };
  }

  // Without a v3 manifest, derive one complete read-only recovery projection
  // before choosing a status. A crash may leave a WAL, already-applied records
  // after WAL removal, legacy inputs, or an activation marker in any
  // combination; reporting one item as waiting must not mask another item that
  // runtime recovery would reject.
  const unmanifestedV3Transaction = await inspectContinuationTransaction(
    join(stateDir, "continuation-transaction-v3.json"),
    CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  );
  if (!unmanifestedV3Transaction.valid) {
    return { status: "error", details: [unmanifestedV3Transaction.detail] };
  }
  const unmanifestedV2Transaction = await inspectContinuationTransaction(
    join(stateDir, "continuation-transaction-v2.json"),
    2,
  );
  if (!unmanifestedV2Transaction.valid) {
    return { status: "error", details: [unmanifestedV2Transaction.detail] };
  }

  const legacyManifestPath = join(stateDir, "continuation-store-v2.json");
  let legacyManifestInfo;
  try {
    legacyManifestInfo = await lstat(legacyManifestPath);
  } catch (error) {
    if (continuationFsCode(error) !== "ENOENT") {
      return { status: "error", details: [`Legacy continuation store manifest cannot be inspected: ${continuationReason(error)}`] };
    }
  }
  let legacyManifestExists = false;
  let legacyManifestDetails: readonly string[] | undefined;
  if (legacyManifestInfo !== undefined) {
    legacyManifestExists = true;
    if (!legacyManifestInfo.isFile() || legacyManifestInfo.isSymbolicLink()) {
      return { status: "error", details: ["Legacy continuation store manifest must be a regular file, not a symlink."] };
    }
    const manifestSecurityError = continuationOwnershipError(legacyManifestInfo, "legacy store manifest", 0o600);
    if (manifestSecurityError !== undefined) return { status: "error", details: [manifestSecurityError] };
    let legacyManifest: unknown;
    try {
      legacyManifest = JSON.parse(await readBoundedOwnerOnlyFile(
        legacyManifestPath,
        MAX_MANIFEST_BYTES,
        "Continuation v2 manifest",
      )) as unknown;
    } catch (error) {
      return { status: "error", details: [`Legacy continuation store manifest contains invalid JSON: ${continuationReason(error)}`] };
    }
    if (!isContinuationStoreManifest(legacyManifest, 2, "per-record-v2")) {
      return { status: "error", details: ["Legacy continuation store manifest has an unsupported or malformed schema."] };
    }
    legacyManifestDetails = [
      `Legacy store v2 awaiting v3 migration: ${String(legacyManifest.stats.records)} retained; ${String(legacyManifest.stats.active)} active; ${String(legacyManifest.stats.unresolvedDelivery)} delivery unknown; ${String(legacyManifest.stats.deadLettered)} dead-lettered; ${String(legacyManifest.stats.historyDegraded)} history-degraded deliveries; ${String(legacyManifest.stats.terminalTombstones)} terminal tombstones; ${String(legacyManifest.stats.compacted)} compacted; ${String(legacyManifest.stats.capturedText)} captured answers.`,
      `Retention: at most ${String(legacyManifest.stats.limits.terminalMaxRecords)} terminal tombstones with a maximum age of ${String(legacyManifest.stats.limits.terminalMaxAgeMs)} ms and ${String(legacyManifest.stats.limits.capturedTextMaxRecords)} captured answers with a maximum age of ${String(legacyManifest.stats.limits.capturedTextMaxAgeMs)} ms.`,
    ];
  }

  const legacyV1Path = join(stateDir, "continuations-v1.json");
  const legacyV1 = await inspectContinuationEvidenceFile(legacyV1Path, "v1 store");
  if (!legacyV1.valid) return { status: "error", details: [legacyV1.detail] };
  let v3Directory: Awaited<ReturnType<typeof loadOptionalContinuationRecordsForRecoveryInspection>>;
  let v2Directory: Awaited<ReturnType<typeof loadOptionalContinuationRecordsForRecoveryInspection>>;
  let projectedRecords: Map<string, DurableContinuationRecord>;
  let hasCommittedV3Records = false;
  try {
    v3Directory = await loadOptionalContinuationRecordsForRecoveryInspection(join(stateDir, "records-v3"));
    hasCommittedV3Records = v3Directory.records.size > 0;
    v2Directory = await loadOptionalContinuationRecordsForRecoveryInspection(join(stateDir, "records-v2"), {
      allowV2RollbackGuard: true,
    });
    const legacyRecords = v2Directory.records;
    if (unmanifestedV2Transaction.transaction !== undefined) {
      applyContinuationTransactionForInspection(legacyRecords, unmanifestedV2Transaction.transaction);
    }
    if (legacyV1.exists) {
      mergeMigrationRecords(legacyRecords, await loadLegacyStore(legacyV1Path), "recoverable v1 and v2");
    }
    projectedRecords = v3Directory.records;
    if (unmanifestedV3Transaction.transaction !== undefined) {
      applyContinuationTransactionForInspection(projectedRecords, unmanifestedV3Transaction.transaction);
    }
    normalizeLegacyContinuationRecords(projectedRecords);
    mergeMigrationRecords(projectedRecords, legacyRecords, "recoverable v2 and v3");
  } catch (error) {
    return {
      status: "error",
      details: [`Continuation recovery evidence is malformed or conflicting: ${continuationReason(error)}`],
    };
  }
  const originGroups = await inspectContinuationEvidenceDirectory(
    join(stateDir, "origin-context-groups-v1"),
    "origin-context activation directory",
    async () => projectedRecords,
  );
  if (!originGroups.valid) return { status: "error", details: [originGroups.detail] };
  try {
    applyRetention(projectedRecords, retentionPolicy, new Date());
  } catch (error) {
    return {
      status: "error",
      details: [`Continuation retention projection cannot be recovered safely: ${continuationReason(error)}`],
    };
  }
  const rollbackGuard = await inspectContinuationRollbackGuard(
    join(stateDir, "records-v2", CONTINUATION_V2_ROLLBACK_GUARD),
    false,
    "The v2 rollback guard is not installed; the current runtime will install it during v3 migration before publishing v3 state.",
  );
  if (!rollbackGuard.valid) return { status: "error", details: [rollbackGuard.detail] };
  const recoverableEvidenceExists = legacyManifestExists
    || v2Directory.exists
    || hasCommittedV3Records
    || unmanifestedV2Transaction.pending
    || unmanifestedV3Transaction.pending
    || originGroups.hasEntries;
  if (recoverableEvidenceExists) {
    const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
    if (!owner.valid) return { status: "error", details: [owner.detail] };
    details.push(
      ...(legacyManifestDetails ?? ["Continuation records are awaiting completion of the v3 manifest."]),
      ...(unmanifestedV2Transaction.pending ? [unmanifestedV2Transaction.detail] : []),
      ...(unmanifestedV3Transaction.pending ? [unmanifestedV3Transaction.detail] : []),
      rollbackGuard.detail,
      originGroups.detail,
      owner.detail,
    );
    return { status: "waiting", details };
  }

  const storePath = join(stateDir, "continuations-v1.json");
  let storeInfo;
  try {
    storeInfo = await lstat(storePath);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      details.push("No continuation ledger has been written yet.");
      const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
      details.push(owner.detail);
      return { status: owner.valid ? "ok" : "error", details };
    }
    return { status: "error", details: [`Continuation ledger cannot be inspected: ${continuationReason(error)}`] };
  }
  if (!storeInfo.isFile() || storeInfo.isSymbolicLink()) {
    return { status: "error", details: ["Continuation ledger must be a regular file, not a symlink."] };
  }
  const storeSecurityError = continuationOwnershipError(storeInfo, "ledger", 0o600);
  if (storeSecurityError !== undefined) {
    return { status: "error", details: [storeSecurityError] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedOwnerOnlyFile(
      storePath,
      MAX_LEGACY_STORE_BYTES,
      "Continuation legacy store",
    )) as unknown;
  } catch (error) {
    return { status: "error", details: [`Continuation ledger contains invalid JSON: ${continuationReason(error)}`] };
  }
  if (!isContinuationLedger(parsed)) {
    return { status: "error", details: ["Continuation ledger has an unsupported or malformed schema."] };
  }

  const counts = Object.fromEntries(CONTINUATION_STATES.map((state) => [state, 0])) as Record<ContinuationState, number>;
  for (const record of Object.values(parsed.records)) {
    if (!isDoctorObject(record) || typeof record.state !== "string" || !CONTINUATION_STATES.includes(record.state as ContinuationState)) {
      return { status: "error", details: ["Continuation ledger contains a record with an invalid lifecycle state."] };
    }
    counts[record.state as ContinuationState] += 1;
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const pending = counts.claimed + counts.result_received + counts.synthesizing + counts.ready_to_deliver + counts.delivery_retry;
  details.push(
    `Legacy ledger awaiting v3 migration: ${String(total)} total; ${String(pending)} pending; ${String(counts.delivery_unknown)} delivery unknown; ${String(counts.dead_lettered)} dead-lettered.`,
  );
  const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
  details.push(owner.detail);
  return {
    status: !owner.valid
      ? "error"
      : counts.delivery_unknown > 0 || counts.dead_lettered > 0
        ? "waiting"
        : "ok",
    details,
  };
}

async function inspectContinuationSecret(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? undefined
      : `Continuation secret cannot be inspected: ${continuationReason(error)}`;
  }
  if (!info.isFile() || info.isSymbolicLink()) return "Continuation secret must be a regular file, not a symlink.";
  const securityError = continuationOwnershipError(info, "secret", 0o600);
  if (securityError !== undefined) return securityError;
  try {
    const secret = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    if (secret.length !== 32) return "Continuation secret contents are invalid.";
  } catch (error) {
    return `Continuation secret cannot be read: ${continuationReason(error)}`;
  }
  return undefined;
}

async function inspectContinuationOwnerDatabase(path: string): Promise<{
  readonly valid: boolean;
  readonly detail: string;
}> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, detail: "The OS-backed continuation ownership database has not been initialized yet." }
      : { valid: false, detail: `Continuation ownership database cannot be inspected: ${continuationReason(error)}` };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { valid: false, detail: "Continuation ownership database is not a regular file." };
  }
  const securityError = continuationOwnershipError(info, "ownership database", 0o600);
  if (securityError !== undefined) return { valid: false, detail: securityError };
  return { valid: true, detail: "OS-backed exclusive ownership is released automatically on clean stop or process death." };
}

async function inspectContinuationRecordsDirectory(
  path: string,
  options: { readonly allowV2RollbackGuard?: boolean } = {},
): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? "Continuation record directory is missing."
      : `Continuation record directory cannot be inspected: ${continuationReason(error)}`;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return "Continuation record directory must be a real directory, not a file or symlink.";
  }
  const directorySecurityError = continuationOwnershipError(info, "record directory", 0o700);
  if (directorySecurityError !== undefined) return directorySecurityError;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (options.allowV2RollbackGuard && entry.name === CONTINUATION_V2_ROLLBACK_GUARD) continue;
      if (!entry.name.endsWith(".json") && !(entry.name.startsWith(".") && entry.name.endsWith(".tmp"))) {
        return `Continuation record directory contains an unexpected entry: ${entry.name}.`;
      }
      const recordInfo = await lstat(join(path, entry.name));
      if (!recordInfo.isFile() || recordInfo.isSymbolicLink()) {
        return `Continuation record entry is not a regular file: ${entry.name}.`;
      }
      const securityError = continuationOwnershipError(recordInfo, "record", 0o600);
      if (securityError !== undefined) return securityError;
      if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
        try {
          await readBoundedOwnerOnlyFile(
            join(path, entry.name),
            MAX_RECORD_BYTES,
            "Continuation temporary record",
          );
        } catch (error) {
          return `Continuation temporary record is unsafe: ${continuationReason(error)}`;
        }
      }
    }
  } catch (error) {
    return `Continuation record directory cannot be inspected: ${continuationReason(error)}`;
  }
  return undefined;
}

async function inspectContinuationEvidenceDirectory(
  path: string,
  label: string,
  loadRecoverableRecords: () => Promise<Map<string, DurableContinuationRecord>>,
): Promise<{
  readonly valid: boolean;
  readonly hasEntries: boolean;
  readonly hasTemporaryDebris: boolean;
  readonly detail: string;
}> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, hasEntries: false, hasTemporaryDebris: false, detail: `${label} has not been created.` }
      : {
          valid: false,
          hasEntries: false,
          hasTemporaryDebris: false,
          detail: `${label} cannot be inspected: ${continuationReason(error)}`,
        };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { valid: false, hasEntries: false, hasTemporaryDebris: false, detail: `${label} must be a real directory.` };
  }
  const securityError = continuationOwnershipError(info, label, 0o700);
  if (securityError !== undefined) {
    return { valid: false, hasEntries: false, hasTemporaryDebris: false, detail: securityError };
  }
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const temporaryEntries = entries.filter((entry) => entry.name.startsWith(".") && entry.name.endsWith(".tmp"));
    let projectedRecords: Map<string, DurableContinuationRecord> | undefined;
    const recordsForRecovery = async (): Promise<Map<string, DurableContinuationRecord>> => {
      if (projectedRecords !== undefined) return projectedRecords;
      projectedRecords = await loadRecoverableRecords();
      return projectedRecords;
    };
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      const temporary = entry.name.startsWith(".") && entry.name.endsWith(".tmp");
      if (temporary) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          return {
            valid: false,
            hasEntries: true,
            hasTemporaryDebris: true,
            detail: `${label} temporary entry must be a regular file: ${entry.name}.`,
          };
        }
        try {
          await readBoundedOwnerOnlyFile(
            entryPath,
            64 * 1024,
            "Continuation origin-context group temporary",
          );
        } catch (error) {
          return {
            valid: false,
            hasEntries: false,
            hasTemporaryDebris: true,
            detail: `${label} temporary entry is unsafe: ${continuationReason(error)}`,
          };
        }
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} contains an unexpected entry: ${entry.name}.`,
        };
      }
      const entryInfo = await lstat(entryPath);
      if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.nlink !== 1) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker must be a single-link regular file: ${entry.name}.`,
        };
      }
      const entrySecurityError = continuationOwnershipError(entryInfo, `${label} marker`, 0o600);
      if (entrySecurityError !== undefined) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: entrySecurityError,
        };
      }
      if (entryInfo.size > 64 * 1024) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker exceeds its safety limit: ${entry.name}.`,
        };
      }
      let markerBody: string;
      try {
        markerBody = await readBoundedOwnerOnlyFile(
          entryPath,
          64 * 1024,
          "Continuation origin-context group commit",
        );
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker is unsafe to read: ${continuationReason(error)}`,
        };
      }
      let marker: unknown;
      try {
        marker = JSON.parse(markerBody) as unknown;
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker contains invalid JSON: ${continuationReason(error)}`,
        };
      }
      if (!isOriginContextGroupCommit(marker) || `${marker.groupKey}.json` !== entry.name) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker has a malformed schema or filename: ${entry.name}.`,
        };
      }
      try {
        applyOriginContextGroupCommit(await recordsForRecovery(), marker);
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker does not match the recoverable durable records: ${continuationReason(error)}`,
        };
      }
    }
    const markerCount = entries.length - temporaryEntries.length;
    const hasEntries = markerCount > 0;
    const detail = markerCount > 0
      ? `${label} contains ${markerCount === 1 ? "a durable marker" : `${String(markerCount)} durable markers`} awaiting idempotent recovery${temporaryEntries.length > 0 ? ", plus incomplete temporary debris awaiting cleanup" : ""}.`
      : temporaryEntries.length > 0
        ? `${label} contains only incomplete temporary debris awaiting cleanup.`
        : `${label} is owner-only and empty.`;
    return {
      valid: true,
      hasEntries,
      hasTemporaryDebris: temporaryEntries.length > 0,
      detail,
    };
  } catch (error) {
    return {
      valid: false,
      hasEntries: false,
      hasTemporaryDebris: false,
      detail: `${label} cannot be inspected: ${continuationReason(error)}`,
    };
  }
}

async function loadContinuationRecordsForRecoveryInspection(
  path: string,
): Promise<Map<string, DurableContinuationRecord>> {
  const records = new Map<string, DurableContinuationRecord>();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (!entry.name.endsWith(".json")) continue;
    const entryPath = join(path, entry.name);
    let value: unknown;
    try {
      value = JSON.parse(await readBoundedOwnerOnlyFile(
        entryPath,
        MAX_RECORD_BYTES,
        "Continuation record",
      )) as unknown;
    } catch (error) {
      throw new Error(`Continuation record cannot be validated for activation recovery: ${entry.name}`, {
        cause: error,
      });
    }
    if (!isDoctorObject(value)
      || typeof value.continuationId !== "string"
      || !isRecord(value, value.continuationId)
      || `${continuationDigest(value.continuationId)}.json` !== entry.name
      || records.has(value.continuationId)) {
      throw new Error(`Continuation record has a malformed schema, duplicate id, or mismatched filename: ${entry.name}`);
    }
    records.set(value.continuationId, structuredClone(value) as DurableContinuationRecord);
  }
  return records;
}

async function loadOptionalContinuationRecordsForRecoveryInspection(
  path: string,
  options: { readonly allowV2RollbackGuard?: boolean } = {},
): Promise<{
  readonly exists: boolean;
  readonly records: Map<string, DurableContinuationRecord>;
}> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Continuation record directory must be a real directory, not a file or symlink.");
    }
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return { exists: false, records: new Map() };
    }
    throw error;
  }
  const inspectionError = await inspectContinuationRecordsDirectory(path, options);
  if (inspectionError !== undefined) throw new Error(inspectionError);
  return {
    exists: true,
    records: await loadContinuationRecordsForRecoveryInspection(path),
  };
}

function applyContinuationTransactionForInspection(
  records: Map<string, DurableContinuationRecord>,
  transaction: ContinuationRecordTransaction,
): void {
  for (const record of transaction.writes) {
    records.set(record.continuationId, structuredClone(record));
  }
  for (const id of transaction.deletes) records.delete(id);
}

async function inspectContinuationEvidenceFile(
  path: string,
  label: string,
): Promise<{ readonly valid: boolean; readonly exists: boolean; readonly detail: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, exists: false, detail: `Legacy continuation ${label} is absent.` }
      : {
        valid: false,
        exists: false,
        detail: `Legacy continuation ${label} cannot be inspected: ${continuationReason(error)}`,
      };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return {
      valid: false,
      exists: true,
      detail: `Legacy continuation ${label} must be a single-link regular file.`,
    };
  }
  const securityError = continuationOwnershipError(info, `legacy ${label}`, 0o600);
  return securityError === undefined
    ? { valid: true, exists: true, detail: `Legacy continuation ${label} is owner-only.` }
    : { valid: false, exists: true, detail: securityError };
}

async function inspectContinuationRollbackGuard(
  path: string,
  required: boolean,
  missingDetail = "The v2 rollback guard is not installed; the current runtime will install it during v3 migration.",
): Promise<{ readonly valid: boolean; readonly detail: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return required
        ? { valid: false, detail: "Continuation v2 rollback guard is missing from the v3 store." }
        : { valid: true, detail: missingDetail };
    }
    return { valid: false, detail: `Continuation v2 rollback guard cannot be inspected: ${continuationReason(error)}` };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return { valid: false, detail: "Continuation v2 rollback guard must be a single-link regular file, not a symlink." };
  }
  const securityError = continuationOwnershipError(info, "v2 rollback guard", 0o600);
  if (securityError !== undefined) return { valid: false, detail: securityError };
  if (info.size > 4 * 1024) {
    return { valid: false, detail: "Continuation v2 rollback guard exceeds its safety limit." };
  }
  let contents: string;
  try {
    contents = await readBoundedOwnerOnlyFile(path, 4 * 1024, "Continuation v2 rollback guard");
  } catch (error) {
    return { valid: false, detail: `Continuation v2 rollback guard cannot be read: ${continuationReason(error)}` };
  }
  if (contents !== CONTINUATION_V2_ROLLBACK_GUARD_CONTENT) {
    return { valid: false, detail: "Continuation v2 rollback guard contents are invalid." };
  }
  return {
    valid: true,
    detail: "The owner-only v2 rollback guard prevents older runtimes from opening stale continuation records.",
  };
}

async function inspectContinuationTransaction(
  path: string,
  expectedSchemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
): Promise<{
  readonly valid: boolean;
  readonly pending: boolean;
  readonly transaction?: ContinuationRecordTransaction;
  readonly detail: string;
}> {
  const versionLabel = `v${String(expectedSchemaVersion)}`;
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, pending: false, detail: `No interrupted durable ${versionLabel} transaction is awaiting recovery.` }
      : {
          valid: false,
          pending: false,
          detail: `Continuation ${versionLabel} transaction cannot be inspected: ${continuationReason(error)}`,
        };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction must be a single-link regular file, not a symlink.`,
    };
  }
  const securityError = continuationOwnershipError(info, `${versionLabel} transaction`, 0o600);
  if (securityError !== undefined) return { valid: false, pending: true, detail: securityError };
  let transaction: unknown;
  try {
    transaction = JSON.parse(await readBoundedOwnerOnlyFile(
      path,
      MAX_TRANSACTION_BYTES,
      `Continuation ${versionLabel} transaction`,
    )) as unknown;
  } catch (error) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction cannot be read as bounded JSON: ${continuationReason(error)}`,
    };
  }
  if (!isRecordTransaction(transaction, expectedSchemaVersion)) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction has an unsupported or malformed schema.`,
    };
  }
  const oversizedRecord = transaction.writes.find((record) =>
    Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8") > MAX_RECORD_BYTES);
  if (oversizedRecord !== undefined) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction contains a record over its ${String(MAX_RECORD_BYTES)} byte safety limit: ${oversizedRecord.continuationId}.`,
    };
  }
  return {
    valid: true,
    pending: true,
    transaction,
    detail: `An interrupted durable ${versionLabel} transaction is present and will be completed idempotently by the state owner.`,
  };
}

function continuationOwnershipError(
  info: Awaited<ReturnType<typeof lstat>>,
  label: string,
  expectedMode: number,
): string | undefined {
  if (typeof process.getuid === "function" && Number(info.uid) !== process.getuid()) {
    return `Continuation ${label} is not owned by the current user.`;
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== expectedMode) {
    return `Continuation ${label} permissions must be ${expectedMode.toString(8)}.`;
  }
  return undefined;
}

function isContinuationLedger(value: unknown): value is {
  readonly schemaVersion: number;
  readonly records: Record<string, unknown>;
} {
  return isStoreFile(value);
}

function isContinuationStoreManifest(
  value: unknown,
  schemaVersion: number,
  format: "per-record-v2" | "per-record-v3",
): value is {
  readonly schemaVersion: number;
  readonly generation: string;
  readonly updatedAt: string;
  readonly rollbackGuardRequired?: boolean;
  readonly stats: {
    readonly records: number;
    readonly active: number;
    readonly unresolvedDelivery: number;
    readonly deadLettered: number;
    readonly historyDegraded: number;
    readonly terminalTombstones: number;
    readonly compacted: number;
    readonly capturedText: number;
    readonly limits: {
      readonly terminalMaxRecords: number;
      readonly terminalMaxAgeMs: number;
      readonly capturedTextMaxRecords: number;
      readonly capturedTextMaxAgeMs: number;
    };
  };
} {
  if (!isDoctorObject(value)
    || value.schemaVersion !== schemaVersion
    || !isDurableGeneration(value.generation)
    || !requiredDate(value.updatedAt)
    || (value.rollbackGuardRequired !== undefined && typeof value.rollbackGuardRequired !== "boolean")
    || !isDoctorObject(value.stats)
    || value.stats.format !== format
    || !isDoctorObject(value.stats.limits)) return false;
  return [
    value.stats.records,
    value.stats.active,
    value.stats.unresolvedDelivery,
    value.stats.deadLettered,
    value.stats.historyDegraded,
    value.stats.terminalTombstones,
    value.stats.compacted,
    value.stats.capturedText,
    value.stats.limits.terminalMaxRecords,
    value.stats.limits.terminalMaxAgeMs,
    value.stats.limits.capturedTextMaxRecords,
    value.stats.limits.capturedTextMaxAgeMs,
  ].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0);
}
