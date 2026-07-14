import { randomBytes, randomUUID } from "node:crypto";
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
} from "./continuations.js";

export const CONTINUATION_STORE_SCHEMA_VERSION = 1;
export const CONTINUATION_RECORD_STORE_SCHEMA_VERSION = 2;

const RECORDS_DIRECTORY = "records-v2";
const TRANSACTION_FILE = "continuation-transaction-v2.json";
const MANIFEST_FILE = "continuation-store-v2.json";
const OWNER_DATABASE_FILE = "continuations-owner.sqlite";
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_TRANSACTION_BYTES = 16 * 1024 * 1024;
const DEFAULT_TERMINAL_MAX_RECORDS = 50_000;
const DEFAULT_TERMINAL_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_CAPTURED_TEXT_MAX_RECORDS = 1_000;
const DEFAULT_CAPTURED_TEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

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
  readonly format: "per-record-v2";
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
  readonly schemaVersion: typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION;
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
  const transactionPath = join(stateDir, TRANSACTION_FILE);
  const manifestPath = join(stateDir, MANIFEST_FILE);
  const legacyPath = join(stateDir, "continuations-v1.json");
  const policy = resolveRetention(options.retention);
  const now = options.now ?? (() => new Date());

  const recoveredGeneration = await recoverRecordTransaction(recordsDir, transactionPath);
  const records = await loadRecordDirectory(recordsDir);
  const beforeOpen = cloneRecords(records);
  const legacyExists = await continuationPathExists(legacyPath);
  if (legacyExists) {
    const legacy = await loadLegacyStore(legacyPath);
    for (const [id, record] of legacy) {
      const current = records.get(id);
      if (current === undefined) {
        records.set(id, record);
      } else if (canonicalContinuationJson(current) !== canonicalContinuationJson(record)) {
        throw new Error(`Legacy and v2 continuation records conflict for id ${id}; refusing lossy migration.`);
      }
    }
  }
  applyRetention(records, policy, now());
  const migrationGeneration = await persistRecordChanges(recordsDir, transactionPath, beforeOpen, records);
  if (legacyExists) {
    await rm(legacyPath, { force: true });
    await syncDirectory(stateDir);
  }
  let generation = migrationGeneration ?? recoveredGeneration ?? randomUUID();
  await persistManifest(manifestPath, generation, continuationStoreStats(records, policy), now());

  let tail: Promise<void> = Promise.resolve();
  let poisoned: unknown;

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
      return result;
    } catch (error) {
      try {
        const recovered = await recoverRecordTransaction(recordsDir, transactionPath);
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

async function loadRecordDirectory(path: string): Promise<Map<string, DurableContinuationRecord>> {
  const records = new Map<string, DurableContinuationRecord>();
  let removedTemporary = false;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const filePath = join(path, entry.name);
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

async function recoverRecordTransaction(recordsDir: string, transactionPath: string): Promise<string | undefined> {
  if (!await continuationPathExists(transactionPath)) return undefined;
  const raw = await readBoundedOwnerOnlyFile(transactionPath, MAX_TRANSACTION_BYTES, "Continuation transaction");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation transaction contains invalid JSON: ${transactionPath}`, { cause: error });
  }
  if (!isRecordTransaction(value)) {
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
    format: "per-record-v2",
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
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are not owner-only: ${path}`);
  }
}

async function readBoundedOwnerOnlyFile(path: string, maxBytes: number, label: string): Promise<string> {
  await assertOwnerOnlyRegularFile(path, label);
  const info = await lstat(path);
  if (info.size > maxBytes) throw new Error(`${label} exceeds its ${String(maxBytes)} byte safety limit: ${path}`);
  return await readFile(path, "utf8");
}

function isRecordTransaction(value: unknown): value is ContinuationRecordTransaction {
  if (!isObject(value)
    || value.schemaVersion !== CONTINUATION_RECORD_STORE_SCHEMA_VERSION
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

function isRecord(value: unknown, id: string): value is DurableContinuationRecord {
  if (!isObject(value)) return false;
  return value.continuationId === id
    && requiredString(value.serverName)
    && requiredString(value.originRunId)
    && requiredString(value.originConversationId)
    && optionalString(value.replyToConversationId)
    && optionalString(value.historyBoundary)
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
