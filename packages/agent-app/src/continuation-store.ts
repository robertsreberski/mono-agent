import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertAgentContinuationOriginContext,
  type AgentContinuationOriginContext,
} from "@mono-agent/agent-contracts";

import { canonicalContinuationJson } from "./continuations.js";
import {
  OriginContextCorruptionError,
  applyOriginContextGroupCommit,
  applyOriginContextGroupCommits,
  loadOriginContextGroupCommit,
  originContextDigest,
  originContextStoreBytes,
  prepareOriginContextGroupCommit,
  readOriginContextCanonical,
  referencedOriginContextDigests,
  releasePendingOriginPin,
  removeOriginContextGroupCommits,
  sweepOriginContextBlobs,
} from "./continuation-origin-store.js";
import {
  continuationPathExists,
  ensureOwnerOnlyDirectory,
  syncDirectory,
  writeJsonAtomic,
  writeTextAtomic,
} from "./continuation-store-fs.js";
import {
  applyRetention,
  cloneRecord,
  cloneRecords,
  continuationStoreStats,
  isMissing,
  isOriginContextReference,
  normalizeLegacyContinuationRecords,
  replaceRecords,
  requiredDate,
  requiredString,
  resolveRetention,
} from "./continuation-store-policy.js";
import {
  assertV3Manifest,
  loadLegacyStore,
  loadRecordDirectory,
  mergeMigrationRecords,
  persistManifest,
  persistRecordChanges,
  recoverRecordTransaction,
} from "./continuation-store-records.js";
import {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  LEGACY_RECORDS_DIRECTORY,
  LEGACY_TRANSACTION_FILE,
  MANIFEST_FILE,
  MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES,
  ORIGIN_CONTEXT_GROUPS_DIRECTORY,
  ORIGIN_CONTEXTS_DIRECTORY,
  RECORDS_DIRECTORY,
  TRANSACTION_FILE,
  V2_ROLLBACK_GUARD,
  type ContinuationOriginContextGroupCommit,
  type ContinuationRetentionOptions,
  type ContinuationStore,
  type DurableContinuationRecord,
} from "./continuation-store-types.js";

export {
  acquireContinuationStoreLock,
  loadOrCreateContinuationSecret,
} from "./continuation-store-fs.js";
export {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  CONTINUATION_STORE_SCHEMA_VERSION,
  MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES,
} from "./continuation-store-types.js";
export type {
  ContinuationLastError,
  ContinuationOriginContextPin,
  ContinuationOriginContextReference,
  ContinuationOriginContextState,
  ContinuationRetentionOptions,
  ContinuationStore,
  ContinuationStoreLock,
  ContinuationStoreStats,
  DurableContinuationRecord,
} from "./continuation-store-types.js";

export async function openContinuationStore(
  stateDir: string,
  options: {
    readonly retention?: ContinuationRetentionOptions;
    readonly now?: () => Date;
  } = {},
): Promise<ContinuationStore> {
  await ensureOwnerOnlyDirectory(stateDir);
  const recordsDir = join(stateDir, RECORDS_DIRECTORY);
  await ensureOwnerOnlyDirectory(recordsDir);
  const legacyRecordsDir = join(stateDir, LEGACY_RECORDS_DIRECTORY);
  await ensureOwnerOnlyDirectory(legacyRecordsDir);
  const originContextsDir = join(stateDir, ORIGIN_CONTEXTS_DIRECTORY);
  await ensureOwnerOnlyDirectory(originContextsDir);
  const originContextGroupsDir = join(stateDir, ORIGIN_CONTEXT_GROUPS_DIRECTORY);
  await ensureOwnerOnlyDirectory(originContextGroupsDir);
  const transactionPath = join(stateDir, TRANSACTION_FILE);
  const manifestPath = join(stateDir, MANIFEST_FILE);
  const legacyPath = join(stateDir, "continuations-v1.json");
  const legacyTransactionPath = join(stateDir, LEGACY_TRANSACTION_FILE);
  const rollbackGuardPath = join(legacyRecordsDir, V2_ROLLBACK_GUARD);
  const policy = resolveRetention(options.retention);
  const now = options.now ?? (() => new Date());

  const manifestExists = await continuationPathExists(manifestPath);
  if (manifestExists) await assertV3Manifest(manifestPath);
  if (!await continuationPathExists(rollbackGuardPath)) {
    await recoverRecordTransaction(legacyRecordsDir, legacyTransactionPath, 2);
  }
  const recoveredGeneration = await recoverRecordTransaction(
    recordsDir,
    transactionPath,
    CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  );
  const records = await loadRecordDirectory(recordsDir);
  const beforeOpen = cloneRecords(records);
  normalizeLegacyContinuationRecords(records);
  if (!manifestExists) {
    const migrationSource = await loadRecordDirectory(legacyRecordsDir, new Set([V2_ROLLBACK_GUARD]));
    normalizeLegacyContinuationRecords(migrationSource);
    if (await continuationPathExists(legacyPath)) {
      const legacy = await loadLegacyStore(legacyPath);
      normalizeLegacyContinuationRecords(legacy);
      mergeMigrationRecords(migrationSource, legacy, "v1 and v2");
    }
    if (!await continuationPathExists(rollbackGuardPath)) {
      await writeTextAtomic(
        rollbackGuardPath,
        "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
        4 * 1024,
      );
    }
    mergeMigrationRecords(records, migrationSource, "v2 and v3");
  }
  const committedOriginGroups = await applyOriginContextGroupCommits(originContextGroupsDir, records);
  applyRetention(records, policy, now());
  const migrationGeneration = await persistRecordChanges(recordsDir, transactionPath, beforeOpen, records);
  let generation = migrationGeneration ?? recoveredGeneration ?? randomUUID();
  await persistManifest(manifestPath, generation, continuationStoreStats(records, policy), now());
  await removeOriginContextGroupCommits(originContextGroupsDir, committedOriginGroups);
  await sweepOriginContextBlobs(originContextsDir, referencedOriginContextDigests(records), new Set());

  let tail: Promise<void> = Promise.resolve();
  let originTail: Promise<void> = Promise.resolve();
  const pendingOriginPins = new Map<string, number>();
  let poisoned: unknown;

  async function withOriginLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = originTail;
    let release!: () => void;
    originTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function locked<T>(
    operation: (current: Map<string, DurableContinuationRecord>) => T | Promise<T>,
  ): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    if (poisoned !== undefined) {
      release();
      throw new Error("Continuation store requires restart after a failed durable transaction.", { cause: poisoned });
    }
    const before = cloneRecords(records);
    const draft = cloneRecords(records);
    let result: T;
    try {
      result = await operation(draft);
    } catch (error) {
      release();
      throw error;
    }
    try {
      applyRetention(draft, policy, now());
      const committedGeneration = await persistRecordChanges(recordsDir, transactionPath, before, draft);
      if (committedGeneration !== undefined) generation = committedGeneration;
      replaceRecords(records, draft);
      await persistManifest(manifestPath, generation, continuationStoreStats(records, policy), now());
      await withOriginLock(async () => {
        await sweepOriginContextBlobs(
          originContextsDir,
          referencedOriginContextDigests(records),
          new Set(pendingOriginPins.keys()),
        );
      });
      return result;
    } catch (error) {
      try {
        const recovered = await recoverRecordTransaction(
          recordsDir,
          transactionPath,
          CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
        );
        if (recovered !== undefined) generation = recovered;
        replaceRecords(records, await loadRecordDirectory(recordsDir));
      } catch (recoveryError) {
        poisoned = new AggregateError(
          [error, recoveryError],
          "Continuation durable commit and recovery both failed.",
        );
        throw poisoned;
      }
      poisoned = error;
      throw error;
    } finally {
      release();
    }
  }

  async function activateOriginContextGroup(input: {
    readonly claimFingerprint: string;
    readonly activatedAt: string;
  }): Promise<void> {
    if (!requiredString(input.claimFingerprint) || !requiredDate(input.activatedAt)) {
      throw new Error("Continuation origin-context activation has an invalid claim or timestamp.");
    }
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    if (poisoned !== undefined) {
      release();
      throw new Error("Continuation store requires restart after a failed durable transaction.", { cause: poisoned });
    }
    const before = cloneRecords(records);
    const draft = cloneRecords(records);
    let commit: ContinuationOriginContextGroupCommit | undefined;
    let markerPath: string | undefined;
    let published = false;
    try {
      commit = prepareOriginContextGroupCommit(draft, input);
      if (commit === undefined) return;
      markerPath = join(originContextGroupsDir, `${commit.groupKey}.json`);
      if (await continuationPathExists(markerPath)) {
        const existing = await loadOriginContextGroupCommit(markerPath);
        if (canonicalContinuationJson(existing) !== canonicalContinuationJson(commit)) {
          throw new Error("Continuation origin-context group activation conflicts with an existing commit marker.");
        }
      } else {
        await writeJsonAtomic(markerPath, commit, true, 64 * 1024);
      }
      published = true;
      applyOriginContextGroupCommit(draft, commit);
      replaceRecords(records, draft);

      try {
        const committedGeneration = await persistRecordChanges(recordsDir, transactionPath, before, draft);
        if (committedGeneration !== undefined) generation = committedGeneration;
        await persistManifest(manifestPath, generation, continuationStoreStats(records, policy), now());
        await rm(markerPath, { force: true });
        await syncDirectory(originContextGroupsDir);
      } catch (materializationError) {
        try {
          const recovered = await recoverRecordTransaction(
            recordsDir,
            transactionPath,
            CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
          );
          if (recovered !== undefined) generation = recovered;
          const recoveredRecords = await loadRecordDirectory(recordsDir);
          normalizeLegacyContinuationRecords(recoveredRecords);
          applyOriginContextGroupCommit(recoveredRecords, commit);
          replaceRecords(records, recoveredRecords);
        } catch (recoveryError) {
          poisoned = new AggregateError(
            [materializationError, recoveryError],
            "Continuation origin-context activation committed but requires restart to recover.",
          );
        }
        poisoned ??= materializationError;
      }
      await withOriginLock(async () => {
        await sweepOriginContextBlobs(
          originContextsDir,
          referencedOriginContextDigests(records),
          new Set(pendingOriginPins.keys()),
        );
      });
    } catch (error) {
      if (!published) throw error;
      poisoned ??= error;
    } finally {
      release();
    }
  }

  return {
    path: manifestPath,
    async get(id) {
      await tail;
      return cloneRecord(records.get(id));
    },
    async list() {
      await tail;
      return [...records.values()].map((record) => cloneRecord(record) as DurableContinuationRecord);
    },
    async findClaim(input) {
      await tail;
      const found = [...records.values()].find((record) =>
        record.serverName === input.serverName
        && record.originRunId === input.originRunId
        && record.taskKey === input.taskKey,
      );
      return cloneRecord(found);
    },
    async stats() {
      await tail;
      return continuationStoreStats(records, policy);
    },
    async stageOriginContext(snapshot) {
      assertAgentContinuationOriginContext(snapshot);
      const canonical = canonicalContinuationJson(snapshot);
      const bytes = Buffer.byteLength(canonical, "utf8");
      if (snapshot.messages.length > MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES) {
        throw new Error(
          `Continuation origin context exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES)} message limit.`,
        );
      }
      if (snapshot.messages.some((message) =>
        Buffer.byteLength(message.content, "utf8") > MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES)) {
        throw new Error(
          `Continuation origin context contains a message over its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES)} byte limit.`,
        );
      }
      if (bytes > MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES) {
        throw new Error(
          `Continuation origin context exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES)} byte limit.`,
        );
      }
      const digest = originContextDigest(canonical);
      const reference = {
        schemaVersion: 1,
        digest,
        bytes,
        messageCount: snapshot.messages.length,
      } as const;
      pendingOriginPins.set(digest, (pendingOriginPins.get(digest) ?? 0) + 1);
      try {
        await withOriginLock(async () => {
          const path = join(originContextsDir, `${digest}.json`);
          if (await continuationPathExists(path)) {
            const existing = await readOriginContextCanonical(path, reference);
            if (existing !== canonical) {
              throw new Error("Continuation origin context digest collision or content conflict.");
            }
            return;
          }
          const aggregate = await originContextStoreBytes(originContextsDir);
          if (aggregate + bytes > MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES) {
            throw new Error(
              `Continuation origin context store exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES)} byte quota.`,
            );
          }
          await writeTextAtomic(path, canonical, MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES);
        });
      } catch (error) {
        releasePendingOriginPin(pendingOriginPins, digest);
        throw error;
      }
      let released = false;
      return {
        reference,
        async release() {
          if (released) return;
          released = true;
          releasePendingOriginPin(pendingOriginPins, digest);
          await withOriginLock(async () => {
            await sweepOriginContextBlobs(
              originContextsDir,
              referencedOriginContextDigests(records),
              new Set(pendingOriginPins.keys()),
            );
          });
        },
      };
    },
    async loadOriginContext(reference) {
      if (!isOriginContextReference(reference)) return undefined;
      return await withOriginLock(async () => {
        const path = join(originContextsDir, `${reference.digest}.json`);
        try {
          const canonical = await readOriginContextCanonical(path, reference);
          return JSON.parse(canonical) as AgentContinuationOriginContext;
        } catch (error) {
          if (isMissing(error) || error instanceof SyntaxError || error instanceof OriginContextCorruptionError) {
            return undefined;
          }
          throw error;
        }
      });
    },
    activateOriginContextGroup,
    mutate: locked,
  };
}
