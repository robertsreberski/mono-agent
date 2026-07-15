import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_BYTES,
  AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGE_BYTES,
  AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES,
  assertAgentContinuationOriginContext,
  type AgentContinuationOriginContext,
} from "@mono-agent/agent-contracts";

import type {
  ContinuationDeliveryReceipt,
  ContinuationMode,
  ContinuationState,
} from "./continuations.js";
import {
  canonicalContinuationJson,
  continuationDigest,
  isContinuationMode,
  isContinuationState,
  TERMINAL_CONTINUATION_STATES,
} from "./continuations.js";

export const CONTINUATION_STORE_SCHEMA_VERSION = 1;
export const CONTINUATION_RECORD_STORE_SCHEMA_VERSION = 3;

const RECORDS_DIRECTORY = "records-v3";
const TRANSACTION_FILE = "continuation-transaction-v3.json";
const MANIFEST_FILE = "continuation-store-v3.json";
const LEGACY_RECORDS_DIRECTORY = "records-v2";
const LEGACY_TRANSACTION_FILE = "continuation-transaction-v2.json";
const V2_ROLLBACK_GUARD = "UPGRADED-TO-RECORDS-V3";
const ORIGIN_CONTEXT_GROUPS_DIRECTORY = "origin-context-groups-v1";
const OWNER_DATABASE_FILE = "continuations-owner.sqlite";
const ORIGIN_CONTEXTS_DIRECTORY = "origin-context-v1";
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_TRANSACTION_BYTES = 16 * 1024 * 1024;
const DEFAULT_TERMINAL_MAX_RECORDS = 50_000;
const DEFAULT_TERMINAL_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_CAPTURED_TEXT_MAX_RECORDS = 1_000;
const DEFAULT_CAPTURED_TEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES = AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_BYTES;
export const MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES = AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES;
export const MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES = AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGE_BYTES;
export const MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES = 256 * 1024 * 1024;

export type ContinuationOriginContextState =
  | "pending"
  | "pinned"
  | "abandoned"
  | "detached_latest"
  | "legacy_missing"
  | "scrubbed";

export interface ContinuationOriginContextReference {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly bytes: number;
  readonly messageCount: number;
}

export interface ContinuationOriginContextPin {
  readonly reference: ContinuationOriginContextReference;
  release(): Promise<void>;
}

export interface ContinuationRetentionOptions {
  /** Metadata/idempotency tombstones retained after terminal compaction. Default 50,000. */
  readonly terminalMaxRecords?: number;
  /** Maximum terminal tombstone age. Default 365 days. */
  readonly terminalMaxAgeMs?: number;
  /** Captured synthesized text retained for operator retrieval. Default 1,000 records. */
  readonly capturedTextMaxRecords?: number;
  /** Captured text retention window. Default 30 days. */
  readonly capturedTextMaxAgeMs?: number;
}

export interface ContinuationStoreStats {
  readonly format: "per-record-v3";
  readonly records: number;
  readonly active: number;
  readonly unresolvedDelivery: number;
  readonly deadLettered: number;
  readonly terminalTombstones: number;
  readonly compacted: number;
  readonly capturedText: number;
  readonly historyDegraded: number;
  readonly limits: {
    readonly terminalMaxRecords: number;
    readonly terminalMaxAgeMs: number;
    readonly capturedTextMaxRecords: number;
    readonly capturedTextMaxAgeMs: number;
  };
}

export interface ContinuationLastError {
  readonly code: string;
  readonly reason: string;
  readonly at: string;
}

export interface DurableContinuationRecord {
  readonly continuationId: string;
  readonly serverName: string;
  readonly originRunId: string;
  readonly originConversationId: string;
  readonly replyToConversationId?: string;
  readonly historyBoundary?: string;
  originContextState: ContinuationOriginContextState;
  originContextRef?: ContinuationOriginContextReference;
  /** Retained after terminal snapshot scrubbing for audit/idempotency. */
  originContextDigest?: string;
  originContextMessageCount?: number;
  /** Domain-separated binding of the v1 claim fingerprint and pinned digest. */
  originContextFingerprint?: string;
  /** Store-only HMAC over the immutable claim, route, task, and snapshot binding. */
  originContextBindingMac?: string;
  completionKind?: "synthesized" | "origin_context_unavailable";
  readonly mode: ContinuationMode;
  readonly routeName?: string;
  readonly taskKey: string;
  readonly taskHash: string;
  readonly claimFingerprint: string;
  readonly resultTokenHash: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly deadline: string;
  state: ContinuationState;
  resultIdempotencyKey?: string;
  resultPayloadHash?: string;
  resultPayload?: unknown;
  synthesisAttempts: number;
  synthesisDeferrals: number;
  synthesisStartedAt?: string;
  synthesizedText?: string;
  actionable?: boolean;
  deliveryAttempts: number;
  deliveryStartedAt?: string;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  lastError?: ContinuationLastError;
  receipt?: ContinuationDeliveryReceipt;
  /** Set once bulky terminal payload/text fields have been removed. */
  compactedAt?: string;
}

interface ContinuationStoreFile {
  readonly schemaVersion: typeof CONTINUATION_STORE_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly records: Record<string, DurableContinuationRecord>;
}

interface ResolvedContinuationRetention {
  readonly terminalMaxRecords: number;
  readonly terminalMaxAgeMs: number;
  readonly capturedTextMaxRecords: number;
  readonly capturedTextMaxAgeMs: number;
}

interface ContinuationRecordTransaction {
  readonly schemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION;
  readonly generation: string;
  readonly createdAt: string;
  readonly writes: readonly DurableContinuationRecord[];
  readonly deletes: readonly string[];
}

interface ContinuationStoreManifest {
  readonly schemaVersion: typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION;
  readonly generation: string;
  readonly updatedAt: string;
  readonly stats: ContinuationStoreStats;
}

interface ContinuationOriginContextGroupCommit {
  readonly schemaVersion: 1;
  readonly groupKey: string;
  readonly originRunId: string;
  readonly originConversationId: string;
  readonly historyBoundary: string;
  readonly snapshotDigest: string;
  readonly memberCount: number;
  readonly memberSetDigest: string;
  readonly activatedAt: string;
}

export interface ContinuationStore {
  readonly path: string;
  get(id: string): Promise<DurableContinuationRecord | undefined>;
  list(): Promise<readonly DurableContinuationRecord[]>;
  findClaim(input: {
    readonly serverName: string;
    readonly originRunId: string;
    readonly taskKey: string;
  }): Promise<DurableContinuationRecord | undefined>;
  stats(): Promise<ContinuationStoreStats>;
  stageOriginContext(snapshot: AgentContinuationOriginContext): Promise<ContinuationOriginContextPin>;
  loadOriginContext(reference: ContinuationOriginContextReference): Promise<AgentContinuationOriginContext | undefined>;
  /**
   * Atomically publishes every prepared context in one immutable origin group.
   * A compact durable group marker is the semantic commit point, so activation
   * remains all-or-nothing even when materializing the individual records takes
   * more than one bounded transaction.
   */
  activateOriginContextGroup(input: {
    readonly claimFingerprint: string;
    readonly activatedAt: string;
  }): Promise<void>;
  mutate<T>(operation: (records: Map<string, DurableContinuationRecord>) => T | Promise<T>): Promise<T>;
}

export interface ContinuationStoreLock {
  release(): Promise<void>;
}

/**
 * Claim exclusive ownership of a continuation state directory for this process.
 * SQLite holds an OS-backed exclusive transaction for the process lifetime.
 * There is no stale-path cleanup race: close or process death releases the OS
 * lock, and SQLite performs any required journal recovery for the next owner.
 */
export async function acquireContinuationStoreLock(stateDir: string): Promise<ContinuationStoreLock> {
  await ensureOwnerOnlyDirectory(stateDir);
  const path = join(stateDir, OWNER_DATABASE_FILE);
  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    if (await continuationPathExists(path)) {
      await assertOwnerOnlyRegularFile(path, "Continuation owner database");
    }
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(path, { timeout: 0 });
    if (process.platform !== "win32") await chmod(path, 0o600);
    await assertOwnerOnlyRegularFile(path, "Continuation owner database");
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS ownership (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO ownership (id, pid, acquired_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at
    `).run(process.pid, new Date().toISOString());
    const journalPath = `${path}-journal`;
    if (process.platform !== "win32" && await continuationPathExists(journalPath)) {
      await chmod(journalPath, 0o600);
    }
  } catch (error) {
    try { database?.close(); } catch { /* best-effort close after failed acquisition */ }
    if (isObject(error) && error.code === "ERR_SQLITE_ERROR" && String(error.message).includes("database is locked")) {
      throw new Error(`Continuation state is already owned by another live process: ${stateDir}`, { cause: error });
    }
    throw error;
  }
  let released = false;
  const owner = database;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        if (owner.isTransaction) owner.exec("ROLLBACK");
      } finally {
        owner.close();
      }
    },
  };
}

/**
 * Open the bounded per-record store. Each continuation has its own atomic 0600
 * file, so a result mutates O(1) durable data instead of rewriting every prior
 * payload. A tiny write-ahead transaction makes multi-record maintenance
 * restart-safe. The legacy v1 monolith is migrated idempotently on first open.
 */
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
  // Finish any v2 transaction before installing the rollback guard. Once the
  // guard exists, v0.10 fails closed while v3 deliberately leaves the v2/v1
  // evidence untouched for audit and manual recovery.
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
    // Install the old-reader poison before the first v3 record becomes active.
    // A crash on either side is restart-safe: v3 repeats a semantic merge, and
    // v0.10 cannot start against a stale v2 snapshot.
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
  // Multiple capabilities from one origin run intentionally stage the same
  // content-addressed snapshot concurrently. Track leases, not just presence:
  // one failed/finalized caller must not sweep the blob while another caller
  // still owns an uncommitted pin for the same digest.
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

  async function locked<T>(operation: (current: Map<string, DurableContinuationRecord>) => T | Promise<T>): Promise<T> {
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
        poisoned = new AggregateError([error, recoveryError], "Continuation durable commit and recovery both failed.");
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
        // The marker is the semantic commit point. It is deliberately compact:
        // the member-set digest makes one fsync atomic for groups whose record
        // materialization spans arbitrarily many bounded transaction batches.
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
        // Publication already committed. Recover the bounded materialization if
        // possible and keep the group marker as the restart-time source of
        // truth. Never report an ambiguous activation failure to a caller that
        // might then abandon an already-published group.
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
      // The fsynced marker means activation is no longer ambiguous. Preserve
      // that success contract and force a restart for any unexpected local
      // maintenance failure after the commit point.
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
        throw new Error(`Continuation origin context exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES)} message limit.`);
      }
      if (snapshot.messages.some((message) =>
        Buffer.byteLength(message.content, "utf8") > MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES)) {
        throw new Error(`Continuation origin context contains a message over its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES)} byte limit.`);
      }
      if (bytes > MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES) {
        throw new Error(`Continuation origin context exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES)} byte limit.`);
      }
      const digest = originContextDigest(canonical);
      const reference = { schemaVersion: 1, digest, bytes, messageCount: snapshot.messages.length } as const;
      pendingOriginPins.set(digest, (pendingOriginPins.get(digest) ?? 0) + 1);
      try {
        await withOriginLock(async () => {
          const path = join(originContextsDir, `${digest}.json`);
          if (await continuationPathExists(path)) {
            const existing = await readOriginContextCanonical(path, reference);
            if (existing !== canonical) throw new Error("Continuation origin context digest collision or content conflict.");
            return;
          }
          const aggregate = await originContextStoreBytes(originContextsDir);
          if (aggregate + bytes > MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES) {
            throw new Error(`Continuation origin context store exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES)} byte quota.`);
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

/** Persistent owner-only key used to derive restart-stable callback capabilities. */
export async function loadOrCreateContinuationSecret(stateDir: string): Promise<Buffer> {
  await ensureOwnerOnlyDirectory(stateDir);
  const path = join(stateDir, "continuation-secret");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Continuation secret is not a regular file: ${path}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`Continuation secret is not owned by the current user: ${path}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`Continuation secret permissions are not owner-only: ${path}`);
    }
    const encoded = (await readFile(path, "utf8")).trim();
    const secret = Buffer.from(encoded, "base64url");
    if (secret.length !== 32) throw new Error(`Continuation secret has invalid contents: ${path}`);
    return secret;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const secret = randomBytes(32);
  try {
    await writeFile(path, `${secret.toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
    return secret;
  } catch (error) {
    if (!isObject(error) || error.code !== "EEXIST") throw error;
    return await loadOrCreateContinuationSecret(stateDir);
  }
}

async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Continuation state path is not a real directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Continuation state directory is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
    const repaired = await lstat(path);
    if ((repaired.mode & 0o077) !== 0) {
      throw new Error(`Continuation state directory permissions are not owner-only: ${path}`);
    }
  }
}

async function loadLegacyStore(path: string): Promise<Map<string, DurableContinuationRecord>> {
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Continuation store is not a regular file: ${path}`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`Continuation store is not owned by the current user: ${path}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`Continuation store permissions are not owner-only: ${path}`);
    }
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return new Map();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation store contains invalid JSON: ${path}`, { cause: error });
  }
  if (!isStoreFile(parsed)) {
    throw new Error(`Continuation store has an unsupported or malformed schema: ${path}`);
  }
  return new Map(Object.entries(parsed.records).map(([id, record]) => [id, record]));
}

async function loadRecordDirectory(
  path: string,
  ignoredEntries: ReadonlySet<string> = new Set(),
): Promise<Map<string, DurableContinuationRecord>> {
  const records = new Map<string, DurableContinuationRecord>();
  let removedTemporary = false;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const filePath = join(path, entry.name);
    if (ignoredEntries.has(entry.name)) {
      await assertOwnerOnlyRegularFile(filePath, "Continuation migration guard");
      continue;
    }
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Continuation temporary record is not a regular file: ${filePath}`);
      }
      await rm(filePath, { force: true });
      removedTemporary = true;
      continue;
    }
    if (!entry.name.endsWith(".json")) {
      throw new Error(`Unexpected entry in continuation record directory: ${filePath}`);
    }
    await assertOwnerOnlyRegularFile(filePath, "Continuation record");
    const raw = await readBoundedOwnerOnlyFile(filePath, MAX_RECORD_BYTES, "Continuation record");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Continuation record contains invalid JSON: ${filePath}`, { cause: error });
    }
    if (!isObject(value) || !requiredString(value.continuationId) || !isRecord(value, value.continuationId)) {
      throw new Error(`Continuation record has a malformed schema: ${filePath}`);
    }
    const expectedName = continuationRecordFileName(value.continuationId);
    if (entry.name !== expectedName) {
      throw new Error(`Continuation record filename does not match its id: ${filePath}`);
    }
    if (records.has(value.continuationId)) {
      throw new Error(`Duplicate continuation record: ${value.continuationId}`);
    }
    records.set(value.continuationId, structuredClone(value) as DurableContinuationRecord);
  }
  if (removedTemporary) await syncDirectory(path);
  return records;
}

function mergeMigrationRecords(
  target: Map<string, DurableContinuationRecord>,
  source: Map<string, DurableContinuationRecord>,
  label: string,
): void {
  // Both sides must be normalized before the semantic comparison. Otherwise a
  // crash after persisting defaults (for example synthesisDeferrals=0) makes a
  // restart falsely report a migration conflict against the equivalent v1/v2
  // representation that omitted those fields.
  normalizeLegacyContinuationRecords(target);
  normalizeLegacyContinuationRecords(source);
  for (const [id, record] of source) {
    const current = target.get(id);
    if (current === undefined) {
      target.set(id, structuredClone(record));
    } else if (canonicalContinuationJson(current) !== canonicalContinuationJson(record)) {
      throw new Error(`${label} continuation records conflict for id ${id}; refusing lossy migration.`);
    }
  }
}

async function assertV3Manifest(path: string): Promise<void> {
  const raw = await readBoundedOwnerOnlyFile(path, 1024 * 1024, "Continuation v3 manifest");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation v3 manifest contains invalid JSON: ${path}`, { cause: error });
  }
  if (!isObject(value)
    || value.schemaVersion !== CONTINUATION_RECORD_STORE_SCHEMA_VERSION
    || !requiredString(value.generation)
    || !requiredDate(value.updatedAt)
    || !isObject(value.stats)) {
    throw new Error(`Continuation v3 manifest has a malformed schema: ${path}`);
  }
}

function prepareOriginContextGroupCommit(
  records: Map<string, DurableContinuationRecord>,
  input: { readonly claimFingerprint: string; readonly activatedAt: string },
): ContinuationOriginContextGroupCommit | undefined {
  const seeds = [...records.values()].filter((record) => record.claimFingerprint === input.claimFingerprint);
  if (seeds.length === 0) return undefined;
  const seed = seeds[0] as DurableContinuationRecord;
  if (seed.originContextState === "detached_latest") return undefined;
  if (seed.historyBoundary === undefined) {
    throw new Error("A pinned continuation origin group must have an immutable history boundary.");
  }
  const candidates = [...records.values()].filter((record) =>
    record.originRunId === seed.originRunId
    && record.originConversationId === seed.originConversationId
    && record.historyBoundary === seed.historyBoundary
    && !TERMINAL_CONTINUATION_STATES.has(record.state));
  if (candidates.length === 0) return undefined;
  const digests = new Set<string>();
  for (const record of candidates) {
    if ((record.originContextState !== "pending" && record.originContextState !== "pinned")
      || record.originContextRef === undefined
      || record.originContextDigest !== record.originContextRef.digest
      || record.originContextBindingMac === undefined) {
      throw new Error("Continuation origin context was not durably prepared for activation.");
    }
    digests.add(record.originContextRef.digest);
  }
  if (digests.size !== 1) {
    throw new Error("Continuation origin claims were prepared with conflicting snapshots.");
  }
  if (candidates.every((record) => record.originContextState === "pinned")) return undefined;
  const snapshotDigest = [...digests][0];
  if (snapshotDigest === undefined) throw new Error("Continuation origin group has no snapshot digest.");
  const memberIds = candidates.map((record) => record.continuationId).sort();
  const groupIdentity = {
    originRunId: seed.originRunId,
    originConversationId: seed.originConversationId,
    historyBoundary: seed.historyBoundary,
  };
  return {
    schemaVersion: 1,
    groupKey: continuationDigest(
      `mono-agent-origin-context-group-v1\0${canonicalContinuationJson(groupIdentity)}`,
    ),
    ...groupIdentity,
    snapshotDigest,
    memberCount: memberIds.length,
    memberSetDigest: continuationDigest(
      `mono-agent-origin-context-members-v1\0${canonicalContinuationJson(memberIds)}`,
    ),
    activatedAt: input.activatedAt,
  };
}

function applyOriginContextGroupCommit(
  records: Map<string, DurableContinuationRecord>,
  commit: ContinuationOriginContextGroupCommit,
): void {
  const candidates = [...records.values()].filter((record) =>
    record.originRunId === commit.originRunId
    && record.originConversationId === commit.originConversationId
    && record.historyBoundary === commit.historyBoundary
    && !TERMINAL_CONTINUATION_STATES.has(record.state));
  const memberIds = candidates.map((record) => record.continuationId).sort();
  const memberSetDigest = continuationDigest(
    `mono-agent-origin-context-members-v1\0${canonicalContinuationJson(memberIds)}`,
  );
  if (candidates.length !== commit.memberCount || memberSetDigest !== commit.memberSetDigest) {
    throw new Error("Continuation origin-context group commit member set does not match durable records.");
  }
  for (const record of candidates) {
    if ((record.originContextState !== "pending" && record.originContextState !== "pinned")
      || record.originContextRef?.digest !== commit.snapshotDigest
      || record.originContextDigest !== commit.snapshotDigest
      || record.originContextBindingMac === undefined) {
      throw new Error("Continuation origin-context group commit does not match its prepared records.");
    }
  }
  for (const record of candidates) {
    if (record.originContextState === "pinned") continue;
    record.originContextState = "pinned";
    record.updatedAt = commit.activatedAt;
    if (record.lastError?.code === "origin_context_pending") delete record.lastError;
    delete record.nextAttemptAt;
  }
}

async function applyOriginContextGroupCommits(
  directory: string,
  records: Map<string, DurableContinuationRecord>,
): Promise<readonly string[]> {
  const applied: string[] = [];
  let removedTemporary = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Continuation origin-context group temporary is not a regular file: ${path}`);
      }
      await rm(path, { force: true });
      removedTemporary = true;
      continue;
    }
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Unexpected entry in continuation origin-context group directory: ${path}`);
    }
    const commit = await loadOriginContextGroupCommit(path);
    if (`${commit.groupKey}.json` !== entry.name) {
      throw new Error(`Continuation origin-context group filename does not match its key: ${path}`);
    }
    applyOriginContextGroupCommit(records, commit);
    applied.push(path);
  }
  if (removedTemporary) await syncDirectory(directory);
  return applied;
}

async function loadOriginContextGroupCommit(path: string): Promise<ContinuationOriginContextGroupCommit> {
  const raw = await readBoundedOwnerOnlyFile(path, 64 * 1024, "Continuation origin-context group commit");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation origin-context group commit contains invalid JSON: ${path}`, { cause: error });
  }
  if (!isOriginContextGroupCommit(value)) {
    throw new Error(`Continuation origin-context group commit has a malformed schema: ${path}`);
  }
  return value;
}

async function removeOriginContextGroupCommits(
  directory: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  for (const path of paths) await rm(path, { force: true });
  await syncDirectory(directory);
}

async function persistRecordChanges(
  recordsDir: string,
  transactionPath: string,
  before: Map<string, DurableContinuationRecord>,
  after: Map<string, DurableContinuationRecord>,
): Promise<string | undefined> {
  const writes = [...after.values()].filter((record) => {
    const prior = before.get(record.continuationId);
    return prior === undefined || JSON.stringify(prior) !== JSON.stringify(record);
  }).map((record) => structuredClone(record));
  const deletes = [...before.keys()].filter((id) => !after.has(id));
  if (writes.length === 0 && deletes.length === 0) return undefined;
  let generation: string | undefined;
  for (const transaction of createTransactionBatches(writes, deletes)) {
    await writeJsonAtomic(transactionPath, transaction, true, MAX_TRANSACTION_BYTES);
    await applyRecordTransaction(recordsDir, transaction);
    await rm(transactionPath, { force: true });
    await syncDirectory(dirname(transactionPath));
    generation = transaction.generation;
  }
  return generation;
}

async function recoverRecordTransaction(
  recordsDir: string,
  transactionPath: string,
  expectedSchemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
): Promise<string | undefined> {
  if (!await continuationPathExists(transactionPath)) return undefined;
  const raw = await readBoundedOwnerOnlyFile(transactionPath, MAX_TRANSACTION_BYTES, "Continuation transaction");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation transaction contains invalid JSON: ${transactionPath}`, { cause: error });
  }
  if (!isRecordTransaction(value, expectedSchemaVersion)) {
    throw new Error(`Continuation transaction has a malformed schema: ${transactionPath}`);
  }
  await applyRecordTransaction(recordsDir, value);
  await rm(transactionPath, { force: true });
  await syncDirectory(dirname(transactionPath));
  return value.generation;
}

async function applyRecordTransaction(
  recordsDir: string,
  transaction: ContinuationRecordTransaction,
): Promise<void> {
  for (const record of transaction.writes) {
    await writeJsonAtomic(
      join(recordsDir, continuationRecordFileName(record.continuationId)),
      record,
      false,
      MAX_RECORD_BYTES,
    );
  }
  for (const id of transaction.deletes) {
    await rm(join(recordsDir, continuationRecordFileName(id)), { force: true });
  }
  await syncDirectory(recordsDir);
}

async function persistManifest(
  path: string,
  generation: string,
  stats: ContinuationStoreStats,
  now: Date,
): Promise<void> {
  await writeJsonAtomic(path, {
    schemaVersion: CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
    generation,
    updatedAt: now.toISOString(),
    stats,
  } satisfies ContinuationStoreManifest);
}

async function writeJsonAtomic(
  path: string,
  value: unknown,
  syncParent = true,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new Error(`Durable continuation file exceeds its ${String(maxBytes)} byte safety limit: ${path}`);
  }
  const temporary = join(dirname(path), `.${continuationDigest(path).slice(0, 12)}-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    if (syncParent) await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeTextAtomic(path: string, body: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new Error(`Durable continuation file exceeds its ${String(maxBytes)} byte safety limit: ${path}`);
  }
  const temporary = join(dirname(path), `.${continuationDigest(path).slice(0, 12)}-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

class OriginContextCorruptionError extends Error {}

function originContextDigest(canonical: string): string {
  return continuationDigest(`mono-agent-origin-context-v1\0${canonical}`);
}

async function readOriginContextCanonical(
  path: string,
  reference: ContinuationOriginContextReference,
): Promise<string> {
  let canonical: string;
  try {
    const loaded = await readBoundedOwnerOnlyFileWithStats(
      path,
      MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES,
      "Continuation origin context",
    );
    if (loaded.bytes !== reference.bytes) {
      throw new OriginContextCorruptionError("Continuation origin context size does not match its reference.");
    }
    canonical = loaded.text;
  } catch (error) {
    if (error instanceof OriginContextCorruptionError || isMissing(error)) throw error;
    throw new OriginContextCorruptionError("Continuation origin context is not a safe owner-only file.", { cause: error });
  }
  if (Buffer.byteLength(canonical, "utf8") !== reference.bytes
    || originContextDigest(canonical) !== reference.digest) {
    throw new OriginContextCorruptionError("Continuation origin context digest does not match its reference.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical) as unknown;
  } catch (error) {
    throw new OriginContextCorruptionError("Continuation origin context is not valid JSON.", { cause: error });
  }
  if (canonicalContinuationJson(parsed) !== canonical) {
    throw new OriginContextCorruptionError("Continuation origin context is not canonically encoded.");
  }
  try {
    assertAgentContinuationOriginContext(parsed);
  } catch (error) {
    throw new OriginContextCorruptionError("Continuation origin context has an invalid schema.", { cause: error });
  }
  if (parsed.messages.length !== reference.messageCount) {
    throw new OriginContextCorruptionError("Continuation origin context message count does not match its reference.");
  }
  return canonical;
}

function referencedOriginContextDigests(
  records: Map<string, DurableContinuationRecord>,
): ReadonlySet<string> {
  return new Set([...records.values()].flatMap((record) =>
    record.originContextRef === undefined ? [] : [record.originContextRef.digest]));
}

function releasePendingOriginPin(pins: Map<string, number>, digest: string): void {
  const count = pins.get(digest);
  if (count === undefined) return;
  if (count <= 1) pins.delete(digest);
  else pins.set(digest, count - 1);
}

async function sweepOriginContextBlobs(
  directory: string,
  referenced: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): Promise<void> {
  let changed = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error(`Continuation origin-context temporary is not a regular file: ${path}`);
      }
      await rm(path, { force: true });
      changed = true;
      continue;
    }
    const match = /^([a-f0-9]{64})\.json$/u.exec(entry.name);
    if (match?.[1] !== undefined && !referenced.has(match[1]) && !pending.has(match[1])) {
      // Once no durable record references a blob, unlink it without opening or
      // following it. This also lets the safe-fallback path clean up a blob
      // whose mode/identity was corrupted instead of poisoning record storage.
      await rm(path, { force: true, recursive: true });
      changed = true;
      continue;
    }
    if (match?.[1] === undefined) {
      throw new Error(`Unexpected entry in continuation origin-context directory: ${path}`);
    }
    // A referenced blob is untrusted payload, not store metadata. Do not let a
    // corrupt mode, hard link, symlink, or non-file poison startup; the
    // descriptor-stable load path will classify it as unavailable and the
    // service can emit its deterministic zero-model fallback.
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    try {
      await assertOwnerOnlyRegularFile(path, "Continuation origin context");
    } catch {
      continue;
    }
  }
  if (changed) await syncDirectory(directory);
}

async function originContextStoreBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      throw new Error(`Unexpected entry in continuation origin-context directory: ${join(directory, entry.name)}`);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const info = await lstat(join(directory, entry.name));
    total += info.size;
    if (total > MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES) {
      throw new Error("Continuation origin context store exceeds its aggregate byte quota.");
    }
  }
  return total;
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (process.platform === "win32"
      && isObject(error)
      && (error.code === "EISDIR"
        || error.code === "EPERM"
        || error.code === "EACCES"
        || error.code === "EINVAL"
        || error.code === "EBADF")) {
      return;
    }
    throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function createTransactionBatches(
  writes: readonly DurableContinuationRecord[],
  deletes: readonly string[],
): readonly ContinuationRecordTransaction[] {
  type Change =
    | { readonly kind: "write"; readonly record: DurableContinuationRecord }
    | { readonly kind: "delete"; readonly id: string };
  const batches: ContinuationRecordTransaction[] = [];
  const createdAt = new Date().toISOString();
  for (const record of writes) {
    const bytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (bytes > MAX_RECORD_BYTES) {
      throw new Error(`Continuation record exceeds its ${String(MAX_RECORD_BYTES)} byte safety limit: ${record.continuationId}`);
    }
  }
  const changes: Change[] = [
    ...writes.map((record): Change => ({ kind: "write", record: structuredClone(record) })),
    ...deletes.map((id): Change => ({ kind: "delete", id })),
  ];
  const makeTransaction = (entries: readonly Change[]): ContinuationRecordTransaction => ({
    schemaVersion: CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
    generation: randomUUID(),
    createdAt,
    writes: entries.flatMap((entry) => entry.kind === "write" ? [entry.record] : []),
    deletes: entries.flatMap((entry) => entry.kind === "delete" ? [entry.id] : []),
  });
  const appendBounded = (entries: readonly Change[]): void => {
    if (entries.length === 0) return;
    const candidate = makeTransaction(entries);
    const bytes = Buffer.byteLength(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    if (bytes <= MAX_TRANSACTION_BYTES) {
      batches.push(candidate);
      return;
    }
    if (entries.length === 1) {
      const only = entries[0];
      throw new Error(only?.kind === "write"
        ? `Continuation record is too large for a bounded durable transaction: ${only.record.continuationId}`
        : `Continuation id is too large for a bounded durable transaction: ${only?.id ?? "unknown"}`);
    }
    const middle = Math.floor(entries.length / 2);
    appendBounded(entries.slice(0, middle));
    appendBounded(entries.slice(middle));
  };

  // Coarse compact-JSON estimates avoid repeatedly serializing an ever-growing
  // migration batch. Exact pretty-JSON size is checked at flush and recursively
  // split, so every persisted transaction remains within the hard bound.
  const targetBytes = Math.floor(MAX_TRANSACTION_BYTES / 2);
  let batch: Change[] = [];
  let estimatedBytes = 512;
  for (const change of changes) {
    const value = change.kind === "write" ? change.record : change.id;
    const estimate = Buffer.byteLength(JSON.stringify(value), "utf8") + 64;
    if (batch.length > 0 && estimatedBytes + estimate > targetBytes) {
      appendBounded(batch);
      batch = [];
      estimatedBytes = 512;
    }
    batch.push(change);
    estimatedBytes += estimate;
  }
  appendBounded(batch);
  return batches;
}

function resolveRetention(options: ContinuationRetentionOptions | undefined): ResolvedContinuationRetention {
  const policy: ResolvedContinuationRetention = {
    terminalMaxRecords: options?.terminalMaxRecords ?? DEFAULT_TERMINAL_MAX_RECORDS,
    terminalMaxAgeMs: options?.terminalMaxAgeMs ?? DEFAULT_TERMINAL_MAX_AGE_MS,
    capturedTextMaxRecords: options?.capturedTextMaxRecords ?? DEFAULT_CAPTURED_TEXT_MAX_RECORDS,
    capturedTextMaxAgeMs: options?.capturedTextMaxAgeMs ?? DEFAULT_CAPTURED_TEXT_MAX_AGE_MS,
  };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Continuation retention ${name} must be a non-negative safe integer.`);
    }
  }
  return policy;
}

const SETTLED_TERMINAL_STATES = new Set<ContinuationState>([
  "delivered",
  "expired",
  "cancelled",
  "dead_lettered",
]);

const ORIGIN_CONTEXT_SCRUB_STATES = new Set<ContinuationState>([
  "delivery_unknown",
  "delivered",
  "expired",
  "cancelled",
  "dead_lettered",
]);

function applyRetention(
  records: Map<string, DurableContinuationRecord>,
  policy: ResolvedContinuationRetention,
  now: Date,
): void {
  const nowMs = now.getTime();
  const captures = [...records.values()]
    .filter((record) => SETTLED_TERMINAL_STATES.has(record.state)
      && record.mode === "capture"
      && record.synthesizedText !== undefined
      && nowMs - Date.parse(record.updatedAt) <= policy.capturedTextMaxAgeMs)
    .sort(newestFirst)
    .slice(0, policy.capturedTextMaxRecords);
  const retainedCaptureText = new Set(captures.map((record) => record.continuationId));

  for (const record of records.values()) {
    if (ORIGIN_CONTEXT_SCRUB_STATES.has(record.state) && record.originContextRef !== undefined) {
      record.originContextDigest ??= record.originContextRef.digest;
      record.originContextMessageCount ??= record.originContextRef.messageCount;
      delete record.originContextRef;
      record.originContextState = "scrubbed";
    }
    if (!SETTLED_TERMINAL_STATES.has(record.state)) continue;
    if (record.resultPayload !== undefined) {
      delete record.resultPayload;
    }
    if (record.synthesizedText !== undefined && !retainedCaptureText.has(record.continuationId)) {
      delete record.synthesizedText;
    }
    if (record.compactedAt === undefined) {
      record.compactedAt = now.toISOString();
    }
  }

  const retainedTerminalIds = new Set([...records.values()]
    .filter((record) => SETTLED_TERMINAL_STATES.has(record.state)
      && nowMs - Date.parse(record.updatedAt) <= policy.terminalMaxAgeMs)
    .sort(newestFirst)
    .slice(0, policy.terminalMaxRecords)
    .map((record) => record.continuationId));
  for (const [id, record] of records) {
    if (SETTLED_TERMINAL_STATES.has(record.state) && !retainedTerminalIds.has(id)) records.delete(id);
  }
}

function newestFirst(left: DurableContinuationRecord, right: DurableContinuationRecord): number {
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  return byUpdatedAt === 0 ? right.continuationId.localeCompare(left.continuationId) : byUpdatedAt;
}

function continuationStoreStats(
  records: Map<string, DurableContinuationRecord>,
  policy: ResolvedContinuationRetention,
): ContinuationStoreStats {
  const values = [...records.values()];
  return {
    format: "per-record-v3",
    records: values.length,
    active: values.filter((record) => !SETTLED_TERMINAL_STATES.has(record.state) && record.state !== "delivery_unknown").length,
    unresolvedDelivery: values.filter((record) => record.state === "delivery_unknown").length,
    deadLettered: values.filter((record) => record.state === "dead_lettered").length,
    terminalTombstones: values.filter((record) => SETTLED_TERMINAL_STATES.has(record.state)).length,
    compacted: values.filter((record) => record.compactedAt !== undefined).length,
    capturedText: values.filter((record) => record.mode === "capture" && record.synthesizedText !== undefined).length,
    historyDegraded: values.filter((record) => record.receipt?.historyRecorded === false).length,
    limits: { ...policy },
  };
}

function cloneRecords(records: Map<string, DurableContinuationRecord>): Map<string, DurableContinuationRecord> {
  return new Map([...records].map(([id, record]) => [id, structuredClone(record)]));
}

function replaceRecords(
  target: Map<string, DurableContinuationRecord>,
  source: Map<string, DurableContinuationRecord>,
): void {
  target.clear();
  for (const [id, record] of source) target.set(id, structuredClone(record));
}

function continuationRecordFileName(id: string): string {
  return `${continuationDigest(id)}.json`;
}

async function continuationPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function assertOwnerOnlyRegularFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  assertOwnerOnlySingleLinkStats(info, path, label);
}

function assertOwnerOnlySingleLinkStats(
  info: Stats,
  path: string,
  label: string,
): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
  if (info.nlink !== 1) throw new Error(`${label} must have exactly one filesystem link: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are not owner-only: ${path}`);
  }
}

async function readBoundedOwnerOnlyFile(path: string, maxBytes: number, label: string): Promise<string> {
  return (await readBoundedOwnerOnlyFileWithStats(path, maxBytes, label)).text;
}

async function readBoundedOwnerOnlyFileWithStats(
  path: string,
  maxBytes: number,
  label: string,
): Promise<{ readonly text: string; readonly bytes: number }> {
  const pathInfo = await lstat(path);
  assertOwnerOnlySingleLinkStats(pathInfo, path, label);
  const flags = fsConstants.O_RDONLY
    | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, flags);
    const before = await handle.stat();
    assertOwnerOnlySingleLinkStats(before, path, label);
    if (before.dev !== pathInfo.dev || before.ino !== pathInfo.ino) {
      throw new Error(`${label} changed identity while it was opened: ${path}`);
    }
    if (before.size > maxBytes) {
      throw new Error(`${label} exceeds its ${String(maxBytes)} byte safety limit: ${path}`);
    }
    const body = await handle.readFile();
    const after = await handle.stat();
    assertOwnerOnlySingleLinkStats(after, path, label);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || body.byteLength !== before.size) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    return { text: body.toString("utf8"), bytes: body.byteLength };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isRecordTransaction(
  value: unknown,
  expectedSchemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
): value is ContinuationRecordTransaction {
  if (!isObject(value)
    || value.schemaVersion !== expectedSchemaVersion
    || !requiredString(value.generation)
    || !requiredDate(value.createdAt)
    || !Array.isArray(value.writes)
    || !Array.isArray(value.deletes)) return false;
  const writesValid = value.writes.every((record) => isObject(record)
      && requiredString(record.continuationId)
      && isRecord(record, record.continuationId));
  if (!writesValid || !value.deletes.every(requiredString)) return false;
  const writeIds = value.writes.map((record) => (record as DurableContinuationRecord).continuationId);
  const deleteIds = value.deletes as string[];
  return new Set(writeIds).size === writeIds.length
    && new Set(deleteIds).size === deleteIds.length
    && !deleteIds.some((id) => writeIds.includes(id));
}

function isStoreFile(value: unknown): value is ContinuationStoreFile {
  if (!isObject(value) || value.schemaVersion !== CONTINUATION_STORE_SCHEMA_VERSION || !isObject(value.records)) {
    return false;
  }
  return Object.entries(value.records).every(([id, record]) => id.length > 0 && isRecord(record, id));
}

function normalizeLegacyContinuationRecords(records: Map<string, DurableContinuationRecord>): void {
  for (const record of records.values()) {
    if (record.originContextState === undefined) {
      record.originContextState = record.historyBoundary === undefined
        ? "detached_latest"
        : "legacy_missing";
    }
    if (record.synthesisDeferrals === undefined) record.synthesisDeferrals = 0;
  }
}

function isRecord(value: unknown, id: string): value is DurableContinuationRecord {
  if (!isObject(value)) return false;
  return value.continuationId === id
    && requiredString(value.serverName)
    && requiredString(value.originRunId)
    && requiredString(value.originConversationId)
    && optionalString(value.replyToConversationId)
    && optionalString(value.historyBoundary)
    && (value.originContextState === undefined || isOriginContextState(value.originContextState))
    && (value.originContextRef === undefined || isOriginContextReference(value.originContextRef))
    && (value.originContextDigest === undefined || isSha256(value.originContextDigest))
    && (value.originContextMessageCount === undefined
      || (Number.isSafeInteger(value.originContextMessageCount)
        && Number(value.originContextMessageCount) >= 0
        && Number(value.originContextMessageCount) <= MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES))
    && (value.originContextFingerprint === undefined || isSha256(value.originContextFingerprint))
    && (value.originContextBindingMac === undefined || isSha256(value.originContextBindingMac))
    && (value.completionKind === undefined
      || value.completionKind === "synthesized"
      || value.completionKind === "origin_context_unavailable")
    && isContinuationMode(value.mode)
    && optionalString(value.routeName)
    && requiredString(value.taskKey)
    && requiredString(value.taskHash)
    && requiredString(value.claimFingerprint)
    && /^[a-f0-9]{64}$/u.test(String(value.resultTokenHash))
    && requiredDate(value.createdAt)
    && requiredDate(value.updatedAt)
    && requiredDate(value.deadline)
    && isContinuationState(value.state)
    && Number.isInteger(value.synthesisAttempts)
    && Number(value.synthesisAttempts) >= 0
    && (value.synthesisDeferrals === undefined
      || (Number.isSafeInteger(value.synthesisDeferrals) && Number(value.synthesisDeferrals) >= 0))
    && Number.isInteger(value.deliveryAttempts)
    && Number(value.deliveryAttempts) >= 0
    && optionalString(value.resultIdempotencyKey)
    && optionalString(value.resultPayloadHash)
    && optionalDate(value.synthesisStartedAt)
    && optionalString(value.synthesizedText)
    && (value.actionable === undefined || typeof value.actionable === "boolean")
    && optionalDate(value.deliveryStartedAt)
    && optionalDate(value.nextAttemptAt)
    && optionalString(value.leaseOwner)
    && optionalDate(value.leaseUntil)
    && optionalDate(value.compactedAt)
    && (value.lastError === undefined || isLastError(value.lastError))
    && (value.receipt === undefined || isReceipt(value.receipt));
}

function isOriginContextState(value: unknown): value is ContinuationOriginContextState {
  return value === "pending"
    || value === "pinned"
    || value === "abandoned"
    || value === "detached_latest"
    || value === "legacy_missing"
    || value === "scrubbed";
}

function isOriginContextReference(value: unknown): value is ContinuationOriginContextReference {
  return isObject(value)
    && value.schemaVersion === 1
    && isSha256(value.digest)
    && Number.isSafeInteger(value.bytes)
    && Number(value.bytes) > 0
    && Number(value.bytes) <= MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES
    && Number.isSafeInteger(value.messageCount)
    && Number(value.messageCount) >= 2
    && Number(value.messageCount) <= MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES;
}

function isOriginContextGroupCommit(value: unknown): value is ContinuationOriginContextGroupCommit {
  if (!isObject(value)
    || value.schemaVersion !== 1
    || !isSha256(value.groupKey)
    || !requiredString(value.originRunId)
    || !requiredString(value.originConversationId)
    || !requiredString(value.historyBoundary)
    || !isSha256(value.snapshotDigest)
    || !Number.isSafeInteger(value.memberCount)
    || Number(value.memberCount) < 1
    || !isSha256(value.memberSetDigest)
    || !requiredDate(value.activatedAt)) return false;
  const expectedKey = continuationDigest(
    `mono-agent-origin-context-group-v1\0${canonicalContinuationJson({
      originRunId: value.originRunId,
      originConversationId: value.originConversationId,
      historyBoundary: value.historyBoundary,
    })}`,
  );
  return value.groupKey === expectedKey;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isLastError(value: unknown): boolean {
  return isObject(value) && requiredString(value.code) && requiredString(value.reason) && requiredDate(value.at);
}

function isReceipt(value: unknown): boolean {
  if (!isObject(value)
    || (value.kind !== "delivered" && value.kind !== "suppressed" && value.kind !== "captured" && value.kind !== "silent")) {
    return false;
  }
  return requiredDate(value.deliveredAt)
    && optionalString(value.deliveryId)
    && optionalString(value.channelId)
    && (value.historyRecorded === undefined || typeof value.historyRecorded === "boolean")
    && (value.historyErrorCode === undefined
      || (typeof value.historyErrorCode === "string" && value.historyErrorCode.length > 0 && value.historyErrorCode.length <= 128))
    && (value.historyErrorCode === undefined || value.historyRecorded === false)
    && (value.kind === "delivered" || (value.historyRecorded === undefined && value.historyErrorCode === undefined));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function requiredDate(value: unknown): value is string {
  return requiredString(value) && Number.isFinite(Date.parse(value));
}

function optionalDate(value: unknown): boolean {
  return value === undefined || requiredDate(value);
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function cloneRecord(record: DurableContinuationRecord | undefined): DurableContinuationRecord | undefined {
  return record === undefined ? undefined : structuredClone(record);
}
