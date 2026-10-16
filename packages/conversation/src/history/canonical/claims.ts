import { OwnedFileDamagedError } from "@mono-agent/turn/engine/owned-fs.js";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { historyProcessIncarnationFromJson, type HistoryProcessIncarnation } from "../../history-process-incarnation.js";
import { currentHistoryProcessIncarnation, historyOwnerIncarnation, historyOwnerLiveness } from "../../history-process-liveness.js";
import { isRecord } from "./codec.js";
import { assertDirectoryIdentity, assertSameIdentity, assertSecureHistoryFile, assertSecureTransientHistoryFile, entryAbsentOrThrowOperational, fsyncDirectory, isErrno, noFollowFlag, type DirectoryIdentity } from "./files.js";
import { historyKey } from "./identity.js";
import { DIRTY_FENCE_PATTERN, DIRTY_FENCE_TEMP_PATTERN } from "./record-contracts.js";

export const LOCKS_DIRECTORY = ".locks";
export const ROOT_LOCK_FILE = "root.sqlite";
export const LOGICAL_SESSION_LOCK_SHARDS = 16;
const MAX_SESSION_CLAIMS_PER_SHARD = 1_024;
export const MAX_SESSION_CLAIM_FILE_BYTES = 1024 * 1024;
const MAX_SESSION_CLAIM_JOURNAL_BYTES = 2 * MAX_SESSION_CLAIM_FILE_BYTES;
const LOGICAL_SESSION_SHARD_LOCK_PATTERN = /^logical-session-shard-([a-f0-9]{2})\.sqlite$/u;
const LOGICAL_SESSION_SHARD_JOURNAL_PATTERN = /^logical-session-shard-([a-f0-9]{2})\.sqlite-journal$/u;
export const ACTIVE_MARKER_PATTERN = /^([a-f0-9]{64})\.([0-9]+)\.([a-f0-9]{32})\.active$/u;
export const MAX_ACTIVE_MARKER_BYTES = 4 * 1024;

// Config reloads can briefly leave old and new harness instances alive in the
// same owner process. Module-level queues serialize both same-conversation
// read/modify/write work and root-wide retention accounting across instances.
const PROCESS_APPEND_QUEUES = new Map<string, Promise<void>>();
const PROCESS_LOGICAL_SESSION_QUEUES = new Map<string, Promise<void>>();
const PROCESS_ROOT_QUEUES = new Map<string, Promise<void>>();

export interface ActiveMarker {
  readonly path: string;
  readonly conversationKey: string;
  readonly pid: number;
  readonly token: string;
  readonly damaged?: true;
  readonly incarnation?: HistoryProcessIncarnation | undefined;
}

export interface HeldConversation {
  readonly logical: HeldLogicalConversation;
  assertOwned(): Promise<void>;
  readonly marker: ActiveMarker;
  readonly rootIdentity: DirectoryIdentity;
  release(): Promise<void>;
}

export interface HeldLogicalConversation {
  assertOwned(): Promise<void>;
  readonly logicalConversationId: string;
  readonly rootIdentity: DirectoryIdentity;
  release(): Promise<void>;
}

export interface HeldExactConversationClaim {
  readonly conversationId: string;
  readonly rootIdentity: DirectoryIdentity;
  release(): Promise<void>;
}

export class HistoryOwnerBusyError extends Error {
  readonly code = "ERR_HARNESS_WRITER_BUSY";
  readonly retryable = true;
}
/** Only emitted after securely reading a marker/fence; never an I/O error. */
export class TornCoordinationFileError extends Error {}

export interface CrossProcessLock {
  release(): Promise<void>;
}

async function acquireQueue(queues: Map<string, Promise<void>>, key: string, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  const prior = (queues.get(key) ?? Promise.resolve()).catch(() => undefined);
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const tail = prior.then(() => gate);
  queues.set(key, tail);
  let released = false, onAbort: (() => void) | undefined;
  const release = (): void => {
    if (released) return;
    released = true; releaseGate();
    // An aborted tail still depends on the live predecessor; successors cannot bypass it.
    void prior.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void prior.then(resolve);
    });
    signal?.throwIfAborted();
    return release;
  } catch (error) { release(); throw error; }
  finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
}

function sessionClaimKey(kind: "exact" | "logical", conversationId: string): string {
  return createHash("sha256")
    .update("mono-agent-history-session-claim-v1\0")
    .update(kind, "utf8")
    .update("\0")
    .update(conversationId, "utf8")
    .digest("hex");
}

function logicalSessionShardLockName(logicalConversationKey: string): string {
  const shard = Number.parseInt(logicalConversationKey.slice(0, 8), 16) % LOGICAL_SESSION_LOCK_SHARDS;
  return `logical-session-shard-${shard.toString(16).padStart(2, "0")}.sqlite`;
}

export function isLogicalSessionShardLockName(name: string): boolean {
  const match = LOGICAL_SESSION_SHARD_LOCK_PATTERN.exec(name);
  return match !== null && Number.parseInt(match[1] as string, 16) < LOGICAL_SESSION_LOCK_SHARDS;
}

export function isLogicalSessionShardJournalName(name: string): boolean {
  const match = LOGICAL_SESSION_SHARD_JOURNAL_PATTERN.exec(name);
  return match !== null && Number.parseInt(match[1] as string, 16) < LOGICAL_SESSION_LOCK_SHARDS;
}

export async function acquireCrossProcessLock(
  path: string,
  directoryIdentity: DirectoryIdentity,
  tryOnly = false,
  signal?: AbortSignal,
): Promise<CrossProcessLock> {
  signal?.throwIfAborted();
  const directory = dirname(path);
  await ensureOwnerOnlyLockFile(path, directoryIdentity);
  for (;;) {
    signal?.throwIfAborted();
    await assertDirectoryIdentity(directory, directoryIdentity);
    assertSecureHistoryFile(await lstat(path), path);
    let database: DatabaseSync | undefined;
    try {
      signal?.throwIfAborted();
      database = new DatabaseSync(path);
      // MEMORY avoids world-umask-dependent journal sidecars while retaining
      // SQLite's kernel-backed cross-process RESERVED lock semantics.
      database.exec("PRAGMA journal_mode=MEMORY");
      database.exec("BEGIN IMMEDIATE");
      assertSecureHistoryFile(await lstat(path), path);
      signal?.throwIfAborted();
      let released = false;
      return {
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            database?.exec("ROLLBACK");
          } catch {
            // close() is the authoritative kernel-lock release after an
            // unexpected SQLite transaction-state error.
          }
          try {
            database?.close();
          } catch {
            // The connection is no longer reusable; never turn lock cleanup
            // into an ambiguous failure after a semantic history commit.
          }
          database = undefined;
        },
      };
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Closing a failed lock attempt is best-effort.
      }
      if (isRecord(error) && typeof error.errcode === "number" && [11, 26].includes(error.errcode & 0xff)) throw new OwnedFileDamagedError(basename(path), error);
      if (!isSqliteBusy(error)) throw error;
      if (tryOnly) throw new HistoryOwnerBusyError("Legacy history owner is busy.");
      // There is deliberately no age timeout: a live provider turn owns this
      // conversation until it settles. On process death SQLite's OS lock is
      // released automatically, while the durable dirty bit remains.
      await delay(8 + Math.floor(Math.random() * 17), undefined, { signal });
    }
  }
}

async function acquireSessionClaim(
  path: string,
  directoryIdentity: DirectoryIdentity,
  claimKey: string,
  tryOnly = false,
  signal?: AbortSignal,
): Promise<CrossProcessLock> {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/u.test(claimKey)) {
    throw new Error("History session claim key must be an opaque SHA-256 digest.");
  }
  const directory = dirname(path);
  const token = randomBytes(16).toString("hex");
  await ensureOwnerOnlyLockFile(
    path,
    directoryIdentity,
    true,
    MAX_SESSION_CLAIM_FILE_BYTES,
  );
  const incarnation = await currentHistoryProcessIncarnation(), ownerLive = historyOwnerLiveness();
  for (;;) {
    signal?.throwIfAborted();
    await assertDirectoryIdentity(directory, directoryIdentity);
    assertSecureHistoryFile(await lstat(path), path);
    await assertSessionClaimJournalIfPresent(`${path}-journal`);
    let database: DatabaseSync | undefined;
    let transactionOpen = false;
    try {
      signal?.throwIfAborted();
      database = new DatabaseSync(path);
      database.exec("PRAGMA journal_mode=DELETE");
      database.exec("PRAGMA synchronous=FULL");
      database.exec("PRAGMA busy_timeout=0");
      database.exec(`
        CREATE TABLE IF NOT EXISTS session_claims (
          claim_key TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          token TEXT NOT NULL,
          acquired_at_ms INTEGER NOT NULL,
          incarnation TEXT
        ) WITHOUT ROWID
      `);
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      if (!database.prepare("PRAGMA table_info(session_claims)").all().some((column) => column.name === "incarnation")) {
        database.exec("ALTER TABLE session_claims ADD COLUMN incarnation TEXT");
        // Publish the additive schema even when a legacy owner is still live.
        database.exec("COMMIT"); transactionOpen = false;
        signal?.throwIfAborted();
        database.exec("BEGIN IMMEDIATE"); transactionOpen = true;
      }
      const prior = database.prepare(`
        SELECT claim_key,pid,token,acquired_at_ms,incarnation FROM session_claims WHERE claim_key=?
      `).get(claimKey) as Record<string, unknown> | undefined;
      if (prior !== undefined) {
        const owner = parseSessionClaimOwner(prior, path);
        if (owner.claimKey !== claimKey) {
          throw new Error(`History session claim ${path} changed during acquisition.`);
        }
        const priorPid = owner.pid;
        const priorToken = owner.token;
        if (await ownerLive(priorPid, owner.incarnation)) {
          database.exec("ROLLBACK");
          transactionOpen = false;
          database.close();
          database = undefined;
          if (tryOnly) throw new HistoryOwnerBusyError("Exact history claim is busy.");
          // Ownership is explicit and exact-keyed. Polling only observes that
          // live owner; unrelated keys can claim the same database meanwhile.
          await delay(8 + Math.floor(Math.random() * 17), undefined, { signal });
          continue;
        }
        const removed = database.prepare(`
          DELETE FROM session_claims WHERE claim_key=? AND pid=? AND token=?
        `).run(claimKey, priorPid, priorToken);
        if (Number(removed.changes) !== 1) {
          throw new Error("History session claim changed during dead-owner recovery.");
        }
      } else {
        const count = sessionClaimCount(database, path);
        if (count > MAX_SESSION_CLAIMS_PER_SHARD) {
          throw new Error(
            `History session claims exceed the ${MAX_SESSION_CLAIMS_PER_SHARD}-claim shard limit.`,
          );
        }
        if (count === MAX_SESSION_CLAIMS_PER_SHARD) {
          const owners = database.prepare(`
            SELECT claim_key,pid,token,acquired_at_ms,incarnation FROM session_claims ORDER BY claim_key
          `).all() as Record<string, unknown>[];
          if (owners.length !== count) {
            throw new Error(`History session claim registry ${path} changed during capacity recovery.`);
          }
          const removeDead = database.prepare(`
            DELETE FROM session_claims WHERE claim_key=? AND pid=? AND token=?
          `);
          for (const row of owners) {
            const owner = parseSessionClaimOwner(row, path);
            if (await ownerLive(owner.pid, owner.incarnation)) continue;
            const removed = removeDead.run(owner.claimKey, owner.pid, owner.token);
            if (Number(removed.changes) !== 1) {
              throw new Error("History session claim changed during capacity recovery.");
            }
          }
          if (sessionClaimCount(database, path) >= MAX_SESSION_CLAIMS_PER_SHARD) {
            throw new Error(
              `History session claims exceed the ${MAX_SESSION_CLAIMS_PER_SHARD}-claim shard limit.`,
            );
          }
        }
      }
      database.prepare(`
        INSERT INTO session_claims (claim_key,pid,token,acquired_at_ms,incarnation)
        VALUES (?,?,?,?,?)
      `).run(claimKey, process.pid, token, Date.now(), JSON.stringify(incarnation) ?? null);
      database.exec("COMMIT");
      transactionOpen = false;
      database.close();
      database = undefined;
      let released = false;
      const lock = {
        release: async (): Promise<void> => {
          if (released) return;
          await releaseSessionClaim(
            path,
            directoryIdentity,
            claimKey,
            token,
          );
          released = true;
        },
      };
      if (signal?.aborted) { await lock.release(); signal.throwIfAborted(); }
      return lock;
    } catch (error) {
      if (transactionOpen) {
        try { database?.exec("ROLLBACK"); } catch { /* close releases the short transaction */ }
      }
      try { database?.close(); } catch { /* no reuse after a failed claim attempt */ }
      if (isRecord(error) && typeof error.errcode === "number" && [11, 26].includes(error.errcode & 0xff)) throw new OwnedFileDamagedError(basename(path), error);
      if (!isSqliteBusy(error)) throw error;
      if (tryOnly) throw new HistoryOwnerBusyError("History claim shard is busy.");
      await delay(8 + Math.floor(Math.random() * 17), undefined, { signal });
    }
  }
}

async function releaseSessionClaim(
  path: string,
  directoryIdentity: DirectoryIdentity,
  claimKey: string,
  token: string,
): Promise<void> {
  const directory = dirname(path);
  for (;;) {
    await assertDirectoryIdentity(directory, directoryIdentity);
    assertSecureHistoryFile(await lstat(path), path);
    await assertSessionClaimJournalIfPresent(`${path}-journal`);
    let database: DatabaseSync | undefined;
    let transactionOpen = false;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA journal_mode=DELETE");
      database.exec("PRAGMA synchronous=FULL");
      database.exec("PRAGMA busy_timeout=0");
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const owner = database.prepare(`
        SELECT claim_key,pid,token,acquired_at_ms FROM session_claims WHERE claim_key=?
      `).get(claimKey) as Record<string, unknown> | undefined;
      const parsedOwner = owner === undefined ? undefined : parseSessionClaimOwner(owner, path);
      if (
        parsedOwner?.claimKey !== claimKey
        || parsedOwner.pid !== process.pid
        || parsedOwner.token !== token
      ) {
        throw new Error("History session claim ownership changed before release.");
      }
      const removed = database.prepare(`
        DELETE FROM session_claims WHERE claim_key=? AND pid=? AND token=?
      `).run(claimKey, process.pid, token);
      if (Number(removed.changes) !== 1) {
        throw new Error("History session claim was not released exactly once.");
      }
      database.exec("COMMIT");
      transactionOpen = false;
      database.close();
      return;
    } catch (error) {
      if (transactionOpen) {
        try { database?.exec("ROLLBACK"); } catch { /* close releases the short transaction */ }
      }
      try { database?.close(); } catch { /* no reuse after a failed release attempt */ }
      if (!isSqliteBusy(error)) throw error;
      await delay(8 + Math.floor(Math.random() * 17));
    }
  }
}

function parseSessionClaimOwner(
  row: Record<string, unknown>,
  path: string,
): { readonly claimKey: string; readonly pid: number; readonly token: string; readonly incarnation?: HistoryProcessIncarnation | undefined } {
  const claimKey = row.claim_key;
  const pid = Number(row.pid);
  const token = row.token;
  const acquiredAtMs = Number(row.acquired_at_ms);
  if (
    typeof claimKey !== "string"
    || !/^[a-f0-9]{64}$/u.test(claimKey)
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || typeof token !== "string"
    || !/^[a-f0-9]{32}$/u.test(token)
    || !Number.isSafeInteger(acquiredAtMs)
    || acquiredAtMs < 0
  ) {
    throw new Error(`History session claim ${path} has an invalid owner.`);
  }
  return { claimKey, pid, token, incarnation: historyOwnerIncarnation(row.incarnation) };
}

function sessionClaimCount(database: DatabaseSync, path: string): number {
  const row = database.prepare("SELECT count(*) AS count FROM session_claims")
    .get() as Record<string, unknown>;
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`History session claim registry ${path} has an invalid row count.`);
  }
  return count;
}

export async function assertSessionClaimJournalIfPresent(path: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  assertSecureTransientHistoryFile(info, path);
  if (info.size > MAX_SESSION_CLAIM_JOURNAL_BYTES) {
    throw new Error(`History session claim journal ${path} is unexpectedly large.`);
  }
}

export async function acquireExistingCrossProcessLock(
  path: string,
  directoryIdentity: DirectoryIdentity,
  tryOnly = false,
  signal?: AbortSignal,
): Promise<CrossProcessLock | undefined> {
  signal?.throwIfAborted();
  try {
    const info = await lstat(path);
    assertSecureHistoryFile(info, path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  return await acquireCrossProcessLock(path, directoryIdentity, tryOnly, signal);
}

export async function ensureOwnerOnlyLockFile(
  path: string,
  directoryIdentity: DirectoryIdentity,
  syncCreatedDirectory = true,
  maxBytes = 64 * 1024,
): Promise<boolean> {
  const directory = dirname(path);
  await assertDirectoryIdentity(directory, directoryIdentity);
  let handle;
  let created = false;
  try {
    try {
      handle = await open(
        path,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
        0o600,
      );
      created = true;
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const info = await lstat(path);
  assertSecureHistoryFile(info, path);
  if (info.size > maxBytes) throw new Error(`History lock file ${path} is unexpectedly large.`);
  if (created && syncCreatedDirectory) await fsyncDirectory(directory, directoryIdentity);
  return created;
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy/iu.test(error.message);
}

export async function readActiveMarker(path: string): Promise<ActiveMarker> {
  const before = await lstat(path);
  assertSecureHistoryFile(before, path);
  if (before.size > MAX_ACTIVE_MARKER_BYTES) throw new Error(`History active marker ${path} is too large.`);
  let handle, contentsRead = false;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    assertSecureHistoryFile(opened, path);
    assertSameIdentity(before, opened, path);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_ACTIVE_MARKER_BYTES) throw new Error(`History active marker ${path} is too large.`);
    const after = await handle.stat();
    assertSecureHistoryFile(after, path); assertSameIdentity(opened, after, path);
    contentsRead = true;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`History active marker ${path} is not valid JSON.`);
    }
    if (
      !isRecord(value)
      || !["conversationKey,pid,token,version", "conversationKey,incarnation,pid,token,version"].includes(Object.keys(value).sort().join(","))
      || value.version !== 1
      || typeof value.conversationKey !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.conversationKey)
      || !Number.isSafeInteger(value.pid)
      || (value.pid as number) <= 0
      || typeof value.token !== "string"
      || !/^[a-f0-9]{32}$/u.test(value.token)
    ) {
      throw new Error(`History active marker ${path} has an unsupported schema.`);
    }
    if (basename(path) !== `${value.conversationKey}.${value.pid}.${value.token}.active`) throw new Error(`History active marker ${path} does not match its filename.`);
    return {
      path,
      conversationKey: value.conversationKey,
      pid: value.pid as number,
      token: value.token, incarnation: historyProcessIncarnationFromJson(value.incarnation),
    };
  } catch (error) {
    if (contentsRead) throw new TornCoordinationFileError(error instanceof Error ? error.message : "Invalid coordination contents", { cause: error });
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface HistoryClaimPorts {
  readonly root: string;
  ensureRoot(): Promise<DirectoryIdentity>;
  ensureLocksRoot(): Promise<DirectoryIdentity>;
  noteDamagedEntry(name: string): void;
}

export class HistoryClaims {
  constructor(private readonly ports: HistoryClaimPorts) {}
  private get root(): string { return this.ports.root; }


  async acquireLogicalConversation(
    logicalConversationId: string,
    tryOnly = false,
    signal?: AbortSignal,
  ): Promise<HeldLogicalConversation> {
    signal?.throwIfAborted();
    if (tryOnly && PROCESS_LOGICAL_SESSION_QUEUES.has(`${this.root}\0${historyKey(logicalConversationId)}`)) throw new HistoryOwnerBusyError("Logical history owner is busy.");
    const releaseProcess = await acquireQueue(
      PROCESS_LOGICAL_SESSION_QUEUES,
      `${this.root}\0${historyKey(logicalConversationId)}`,
      signal,
    );
    try {
      const rootIdentity = await this.ports.ensureRoot();
      const locksIdentity = await this.ports.ensureLocksRoot();
      const lock = await acquireSessionClaim(
        join(this.root, LOCKS_DIRECTORY, logicalSessionShardLockName(historyKey(logicalConversationId))),
        locksIdentity,
        sessionClaimKey("logical", logicalConversationId),
        tryOnly,
        signal,
      );
      let released = false;
      return {
        logicalConversationId,
        rootIdentity,
        assertOwned: async (): Promise<void> => {
          if (released) throw new Error("History logical ownership has been released.");
          await assertDirectoryIdentity(this.root, rootIdentity);
          await assertDirectoryIdentity(join(this.root, LOCKS_DIRECTORY), locksIdentity);
        },
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            await lock.release();
          } finally {
            releaseProcess();
          }
        },
      };
    } catch (error) {
      releaseProcess();
      throw error;
    }
  }

  async acquireExactConversationClaim(
    conversationId: string,
    tryOnly = false,
    signal?: AbortSignal,
  ): Promise<HeldExactConversationClaim> {
    signal?.throwIfAborted();
    const rootIdentity = await this.ports.ensureRoot();
    const locksIdentity = await this.ports.ensureLocksRoot();
    const lock = await acquireSessionClaim(
      join(this.root, LOCKS_DIRECTORY, logicalSessionShardLockName(historyKey(conversationId))),
      locksIdentity,
      sessionClaimKey("exact", conversationId),
      tryOnly,
      signal,
    );
    let released = false;
    return {
      conversationId,
      rootIdentity,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await lock.release();
      },
    };
  }

  async createActiveMarker(
    conversationKey: string,
    locksIdentity: DirectoryIdentity,
  ): Promise<ActiveMarker> {
    const token = randomBytes(16).toString("hex"), incarnation = await currentHistoryProcessIncarnation();
    const marker: ActiveMarker = {
      path: join(this.root, LOCKS_DIRECTORY, `${conversationKey}.${process.pid}.${token}.active`),
      conversationKey,
      pid: process.pid,
      token, incarnation,
    };
    const body = Buffer.from(`${JSON.stringify({
      version: 1,
      conversationKey,
      pid: process.pid,
      token, incarnation,
    })}\n`, "utf8");
    let handle;
    let complete = false;
    try {
      handle = await open(
        marker.path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
        0o600,
      );
      await handle.writeFile(body);
      await handle.chmod(0o600);
      await handle.sync();
      const info = await handle.stat();
      assertSecureHistoryFile(info, marker.path);
      if (info.size !== body.byteLength) throw new Error(`History active marker ${marker.path} was not written completely.`);
      complete = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!complete) await rm(marker.path, { force: true }).catch(() => undefined);
    }
    try {
      await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
      return marker;
    } catch (error) {
      await rm(marker.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async removeActiveMarker(marker: ActiveMarker): Promise<void> {
    const locksIdentity = await this.ports.ensureLocksRoot();
    await rm(marker.path, { force: true });
    await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
  }

  async scanActiveMarkers(cleanDead: boolean): Promise<readonly ActiveMarker[]> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    const locksIdentity = await this.ports.ensureLocksRoot();
    await assertDirectoryIdentity(locksRoot, locksIdentity);
    const markers: ActiveMarker[] = [], ownerLive = historyOwnerLiveness();
    let removed = false;
    for (const name of (await readdir(locksRoot)).sort()) {
      if (
        name === ROOT_LOCK_FILE
        || isLogicalSessionShardLockName(name)
      ) {
        const path = join(locksRoot, name);
        assertSecureHistoryFile(await lstat(path), path);
        continue;
      }
      if (isLogicalSessionShardJournalName(name)) {
        await assertSessionClaimJournalIfPresent(join(locksRoot, name));
        continue;
      }
      // Fences are owner-scoped and classified by scanDirtyFences.
      if (DIRTY_FENCE_PATTERN.test(name) || DIRTY_FENCE_TEMP_PATTERN.test(name)) continue;
      const match = ACTIVE_MARKER_PATTERN.exec(name);
      if (match === null) continue; // unrelated names are never read or deleted
      const path = join(locksRoot, name);
      let marker: ActiveMarker = { path, conversationKey: match[1]!, pid: Number.parseInt(match[2]!, 10), token: match[3]! };
      try {
        marker = await readActiveMarker(path);
      } catch (error) {
        await this.assertLocksIdentity(locksIdentity);
        if (entryAbsentOrThrowOperational(error)) continue;
        // Only a successful owned-file read may prove a torn liveness marker.
        // A dead writer cannot finish it; there is no recoverable payload here.
        if (error instanceof TornCoordinationFileError && cleanDead && !await ownerLive(marker.pid)) {
          await rm(path); removed = true; continue;
        }
        if (error instanceof TornCoordinationFileError) { markers.push(marker); continue; }
        this.ports.noteDamagedEntry(name); markers.push({ ...marker, damaged: true }); continue;
      }
      // Valid markers and owned torn markers are both reclaimable after owner death.
      if (cleanDead && !await ownerLive(marker.pid, marker.incarnation)) { await rm(path); removed = true; }
      else markers.push(marker);
    }
    if (removed) await fsyncDirectory(locksRoot, locksIdentity);
    return markers;
  }

  /** Probe only a needed recovery/retention owner through SQLite, never raw
   * open/close: closing a raw fd can release this process's fcntl locks. */
  async legacyLockAvailable(key: string): Promise<boolean> {
    const identity = await this.ports.ensureLocksRoot(); let lock: CrossProcessLock | undefined;
    try { lock = await acquireExistingCrossProcessLock(join(this.root, LOCKS_DIRECTORY, `${key}.sqlite`), identity, true); return true; }
    catch (error) {
      await this.assertLocksIdentity(identity);
      if (entryAbsentOrThrowOperational(error)) return true;
      if (!(error instanceof HistoryOwnerBusyError)) this.ports.noteDamagedEntry(`${key}.sqlite`);
      return false;
    }
    finally { await lock?.release(); }
  }

  async assertLocksIdentity(identity: DirectoryIdentity): Promise<void> {
    await assertDirectoryIdentity(this.root, await this.ports.ensureRoot());
    await assertDirectoryIdentity(join(this.root, LOCKS_DIRECTORY), identity);
  }
}

export function acquireHistoryRootQueue(root: string, signal?: AbortSignal): Promise<() => void> {
  return acquireQueue(PROCESS_ROOT_QUEUES, root, signal);
}
export function acquireHistoryConversationQueue(key: string, signal?: AbortSignal): Promise<() => void> {
  return acquireQueue(PROCESS_APPEND_QUEUES, key, signal);
}
export function isHistoryConversationQueued(key: string): boolean {
  return PROCESS_APPEND_QUEUES.has(key);
}
