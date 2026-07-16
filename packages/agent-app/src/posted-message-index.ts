import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

/**
 * Maps a message the agent POSTED (`channelId` + Slack `ts`) back to the
 * conversation that produced it, so a later in-thread reply can be resolved to
 * that conversation and continue its history/session.
 *
 * Why this exists: a scheduled/proactive post (e.g. a daily digest) runs under a
 * synthetic conversationId (e.g. `scheduled-scan`) and posts via
 * `SlackSendMessage`, which registers no `slack:` conversation. When the user
 * replies, the Slack adapter derives `slack:<channel>:<posted-ts>` — an id with no
 * history. This index closes that gap: the producer records `(channel, ts) →
 * producing conversationId`; the consumer (inbound dispatch) looks it up and
 * aliases the reply onto the producing conversation.
 *
 * Storage is an append-only JSONL file inside the run-artifact dir. Appenders,
 * startup maintenance, and compaction serialize through one owner-only SQLite
 * coordinator. The index, coordinator, and compaction temporary are all opened
 * no-follow and must remain current-owner, regular, single-link files. The
 * `.jsonl` index and its `.lock.sqlite` coordinator are ignored by the
 * `.summary.json` artifact scanners (see `seen-conversations.ts`), so they never
 * collide with run-artifact tooling.
 */

export const POSTED_MESSAGE_INDEX_FILENAME = "posted-message-index.jsonl";

/** Daily-rollover bucket suffix the responder appends (`…#2026-06-22`). */
const ROLLOVER_BUCKET = /#\d{4}-\d{2}-\d{2}$/u;

const DEFAULT_COMPACT_MAX_ENTRIES = 5000;
const COMPACT_HEADROOM_DIVISOR = 10;
const INDEX_LOCK_WAIT_MS = 2000;
const MAX_LOCK_FILE_BYTES = 64 * 1024;
const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;
const inProcessIndexTails = new Map<string, Promise<void>>();
const inProcessIndexStates = new Map<string, LoadedPostedMessageIndexState>();

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface DirectoryIdentity extends FileIdentity {}

interface PostedMessageIndexState {
  readonly count: number;
  readonly size: number;
}

interface LoadedPostedMessageIndexState extends PostedMessageIndexState {
  readonly identity: FileIdentity;
}

interface PostedMessageIndexSnapshot extends LoadedPostedMessageIndexState {
  readonly entries: readonly PostedMessageEntry[];
}

interface PostedMessageIndexLock {
  readonly directoryIdentity: DirectoryIdentity;
  release(): Promise<void>;
}

interface PostedMessageIndexCompactionHooks {
  readonly beforeCreateTemporary?: (path: string) => Promise<void>;
  readonly beforeReplace?: () => Promise<void>;
}

export interface PostedMessageEntry {
  /** Slack channel/DM id the message was posted to. */
  readonly channelId: string;
  /** Slack message timestamp returned by `chat.postMessage`. */
  readonly ts: string;
  /** Producing conversationId, de-bucketed to its base form. */
  readonly conversationId: string;
  /** ISO timestamp of when the entry was written. */
  readonly writtenAt: string;
}

/** The single index-file path both producer and consumer agree on. */
export function resolvePostedMessageIndexPath(artifactDir: string): string {
  return join(artifactDir, POSTED_MESSAGE_INDEX_FILENAME);
}

/** Strip a trailing daily-rollover bucket so the stored id is the base producing id. */
export function basePostedConversationId(conversationId: string): string {
  return conversationId.replace(ROLLOVER_BUCKET, "");
}

/**
 * Record that `conversationId` posted a message at `(channelId, ts)`. Appenders in
 * both the adapter and its stdio child share a filesystem lock with compaction, so
 * a temp-file rename cannot discard a completed concurrent append. Once the cap is
 * reached, compaction drops a batch of oldest entries before appending; this keeps
 * the file at or below the cap without a full rewrite on every later send.
 *
 * Best-effort: a failed index write or lock acquisition must never fail the Slack
 * post, so this function swallows errors. The stored conversationId is de-bucketed
 * so the consumer can let the responder re-bucket to the reply's own day
 * (consistent with daily session rollover).
 */
export async function appendPostedMessage(
  indexPath: string,
  entry: { channelId: string; ts: string; conversationId: string },
  now: () => Date = () => new Date(),
  maxEntries: number = DEFAULT_COMPACT_MAX_ENTRIES,
  compactionHooks: PostedMessageIndexCompactionHooks = {},
): Promise<void> {
  const channelId = entry.channelId.trim();
  const ts = entry.ts.trim();
  const conversationId = basePostedConversationId(entry.conversationId.trim());
  if (channelId.length === 0 || ts.length === 0 || conversationId.length === 0) {
    return;
  }
  const record: PostedMessageEntry = {
    channelId,
    ts,
    conversationId,
    writtenAt: now().toISOString(),
  };
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line);
  const cap = normalizedAppendCap(maxEntries);
  await withPostedMessageIndexLock(indexPath, async (directoryIdentity) => {
    const identity = await ensureOwnerOnlyFile(indexPath, directoryIdentity, true);
    if (identity === undefined) {
      return;
    }
    let state = await loadPostedMessageIndexState(indexPath, directoryIdentity, identity);
    if (state === undefined) {
      return;
    }
    if (state.count >= cap) {
      const compacted = await compactPostedMessageIndexUnlocked(
        indexPath,
        amortizedCompactTarget(cap),
        directoryIdentity,
        compactionHooks,
      );
      if (compacted === undefined) {
        // Preserve the existing bounded file rather than append past the cap when
        // its rewrite cannot be completed safely.
        return;
      }
      state = compacted;
      inProcessIndexStates.set(indexPath, compacted);
    }

    const nextState: PostedMessageIndexState = {
      count: state.count + 1,
      size: state.size + lineBytes,
    };
    try {
      await appendSecureIndexLine(indexPath, line, state, directoryIdentity);
      inProcessIndexStates.set(indexPath, { ...nextState, identity: state.identity });
    } catch {
      // Best-effort. Discard any in-process hint so the next writer reconciles
      // count and size from a securely-opened JSONL snapshot.
      inProcessIndexStates.delete(indexPath);
    }
  });
}

/**
 * Resolve the producing conversationId for a posted message, newest write wins.
 * Returns `undefined` when the file is missing or has no matching entry, so the
 * caller falls back to the default (a fresh `slack:` conversation) — no regression.
 */
export async function lookupProducingConversation(
  indexPath: string,
  channelId: string,
  ts: string,
): Promise<string | undefined> {
  const wantChannel = channelId.trim();
  const wantTs = ts.trim();
  if (wantChannel.length === 0 || wantTs.length === 0) {
    return undefined;
  }
  let match: PostedMessageEntry | undefined;
  for (const entry of await readEntries(indexPath)) {
    if (entry.channelId !== wantChannel || entry.ts !== wantTs) {
      continue;
    }
    if (match === undefined || entry.writtenAt >= match.writtenAt) {
      match = entry;
    }
  }
  return match?.conversationId;
}

/**
 * Bound file growth by rewriting the index with only the newest `maxEntries`
 * (by write time, de-duped to the newest entry per `channel+ts`). Slack-driver
 * startup invokes this exact routine, and every appender also uses the same
 * unlocked implementation after taking this cross-process lock. Best-effort.
 */
export async function compactPostedMessageIndex(
  indexPath: string,
  maxEntries: number = DEFAULT_COMPACT_MAX_ENTRIES,
  hooks: PostedMessageIndexCompactionHooks = {},
): Promise<void> {
  await withPostedMessageIndexLock(indexPath, async (directoryIdentity) => {
    const compacted = await compactPostedMessageIndexUnlocked(
      indexPath,
      normalizedCompactionCap(maxEntries),
      directoryIdentity,
      hooks,
    );
    if (compacted !== undefined) {
      inProcessIndexStates.set(indexPath, compacted);
    }
  });
}

async function compactPostedMessageIndexUnlocked(
  indexPath: string,
  maxEntries: number,
  directoryIdentity: DirectoryIdentity,
  hooks: PostedMessageIndexCompactionHooks = {},
): Promise<LoadedPostedMessageIndexState | undefined> {
  const snapshot = await tryReadIndexSnapshot(indexPath, directoryIdentity);
  if (snapshot === undefined) {
    return undefined;
  }
  if (snapshot.entries.length <= maxEntries) {
    return snapshot;
  }
  // Newest entry per (channel, ts), then newest-first, then cap.
  const latest = new Map<string, PostedMessageEntry>();
  for (const entry of snapshot.entries) {
    const key = `${entry.channelId} ${entry.ts}`;
    const prior = latest.get(key);
    if (prior === undefined || entry.writtenAt >= prior.writtenAt) {
      latest.set(key, entry);
    }
  }
  const kept = [...latest.values()]
    .sort((a, b) => (a.writtenAt < b.writtenAt ? 1 : a.writtenAt > b.writtenAt ? -1 : 0))
    .slice(0, maxEntries);
  const body = kept.map((entry) => JSON.stringify(entry)).join("\n");
  const nextBody = kept.length === 0 ? "" : `${body}\n`;
  const nextSize = Buffer.byteLength(nextBody);
  // A random name prevents a crashed compactor's secure stale temp from
  // permanently blocking future maintenance. Exclusive creation below remains
  // the authoritative defense if a candidate is planted after its name exists.
  const tmpPath = `${indexPath}.tmp-${String(process.pid)}-${randomBytes(16).toString("hex")}`;
  let temporary: FileHandle | undefined;
  let temporaryIdentity: FileIdentity | undefined;

  try {
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    await hooks.beforeCreateTemporary?.(tmpPath);
    // O_EXCL makes a pre-planted symlink, hard link, file, or directory a
    // fail-closed EEXIST. O_NOFOLLOW covers platforms where an implementation
    // does not give O_EXCL the documented final-component symlink protection.
    temporary = await open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag() | nonBlockFlag(),
      0o600,
    );
    await temporary.writeFile(nextBody, "utf8");
    await temporary.chmod(0o600);
    await temporary.sync();
    const written = await temporary.stat();
    assertSecureFile(written, tmpPath);
    if (written.size !== nextSize) {
      throw new Error(`Posted-message index temporary ${tmpPath} was not written completely.`);
    }
    temporaryIdentity = identityOf(written);

    await hooks.beforeReplace?.();
    await assertFileIdentity(indexPath, snapshot.identity);
    await assertFileIdentity(tmpPath, temporaryIdentity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    await temporary.close();
    temporary = undefined;
    await rename(tmpPath, indexPath);
    await fsyncDirectory(dirname(indexPath), directoryIdentity);
    const replaced = await lstat(indexPath);
    assertSecureFile(replaced, indexPath);
    assertSameIdentity(temporaryIdentity, replaced, indexPath);
    return { count: kept.length, size: nextSize, identity: temporaryIdentity };
  } catch {
    // Never unlink a path after a failed identity check: without unlinkat(2), a
    // same-user swap between check and unlink could delete an unrelated victim.
    // A securely-created stale temp has a one-use random name and is inert to
    // future attempts; a pre-planted path is never opened, chmodded, written,
    // renamed, or removed.
    return undefined;
  } finally {
    await temporary?.close().catch(() => undefined);
  }
}

function normalizedAppendCap(maxEntries: number): number {
  return Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : DEFAULT_COMPACT_MAX_ENTRIES;
}

function normalizedCompactionCap(maxEntries: number): number {
  return Number.isSafeInteger(maxEntries) && maxEntries >= 0
    ? maxEntries
    : DEFAULT_COMPACT_MAX_ENTRIES;
}

function amortizedCompactTarget(maxEntries: number): number {
  const headroom = Math.max(1, Math.ceil(maxEntries / COMPACT_HEADROOM_DIVISOR));
  return Math.max(0, maxEntries - headroom);
}

async function loadPostedMessageIndexState(
  indexPath: string,
  directoryIdentity: DirectoryIdentity,
  expectedIdentity: FileIdentity,
): Promise<LoadedPostedMessageIndexState | undefined> {
  const size = await secureFileSize(indexPath, expectedIdentity, directoryIdentity);
  const cached = inProcessIndexStates.get(indexPath);
  if (
    cached !== undefined
    && cached.size === size
    && sameIdentity(cached.identity, expectedIdentity)
  ) {
    return cached;
  }
  const snapshot = await tryReadIndexSnapshot(indexPath, directoryIdentity);
  if (snapshot === undefined) {
    return undefined;
  }
  assertSameIdentity(expectedIdentity, snapshot.identity, indexPath);
  inProcessIndexStates.set(indexPath, snapshot);
  return snapshot;
}

async function withPostedMessageIndexLock(
  indexPath: string,
  action: (directoryIdentity: DirectoryIdentity) => Promise<void>,
): Promise<void> {
  // Avoid blocking this process's event loop on its own synchronous SQLite lock;
  // the OS-backed lock below then serializes the adapter against stdio children.
  const prior = inProcessIndexTails.get(indexPath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queueSlot = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = prior.then(() => queueSlot);
  inProcessIndexTails.set(indexPath, tail);
  await prior;
  try {
    const lock = await acquirePostedMessageIndexLock(indexPath);
    if (lock === undefined) {
      return;
    }
    try {
      await action(lock.directoryIdentity);
    } finally {
      await lock.release();
    }
  } catch {
    // Best-effort; a posted-message index failure never fails the Slack post.
  } finally {
    releaseQueue();
    if (inProcessIndexTails.get(indexPath) === tail) {
      inProcessIndexTails.delete(indexPath);
    }
  }
}

async function acquirePostedMessageIndexLock(
  indexPath: string,
): Promise<PostedMessageIndexLock | undefined> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  let directoryIdentity: DirectoryIdentity;
  try {
    directoryIdentity = await ensureIndexDirectory(indexPath);
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return undefined;
  }
  const lockPath = `${indexPath}.lock.sqlite`;
  let lockIdentity: FileIdentity;
  try {
    const ensured = await ensureOwnerOnlyFile(lockPath, directoryIdentity, true);
    if (ensured === undefined) {
      return undefined;
    }
    lockIdentity = ensured;
    await assertLockFileIdentity(lockPath, lockIdentity);
    await assertNoSqliteSidecars(lockPath, directoryIdentity);
  } catch {
    return undefined;
  }

  const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
  while (true) {
    let database: import("node:sqlite").DatabaseSync | undefined;
    try {
      await assertLockFileIdentity(lockPath, lockIdentity);
      await assertNoSqliteSidecars(lockPath, directoryIdentity);
      database = new DatabaseSync(lockPath, { timeout: 0 });
      // MEMORY preserves SQLite's kernel-backed cross-process lock while avoiding
      // attacker-preparable, umask-dependent -journal/-wal/-shm filesystem paths.
      // This database is lock-only: no schema or count state is ever mutated, so
      // process death never relies on a MEMORY journal for data recovery.
      database.exec("PRAGMA journal_mode=MEMORY");
      await assertLockFileIdentity(lockPath, lockIdentity);
      await assertNoSqliteSidecars(lockPath, directoryIdentity);
      // The kernel releases this transaction lock automatically on close or
      // process death; there is no stale-path cleanup race.
      database.exec("BEGIN IMMEDIATE");
      await assertLockFileIdentity(lockPath, lockIdentity);
      await assertNoSqliteSidecars(lockPath, directoryIdentity);
      return postedMessageIndexLock(
        database,
        lockPath,
        lockIdentity,
        directoryIdentity,
      );
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Best-effort cleanup after a failed acquisition.
      }
      if (!isSqliteBusy(error) || Date.now() >= deadline) {
        return undefined;
      }
      await delay(8 + Math.floor(Math.random() * 8));
    }
  }
}

function postedMessageIndexLock(
  database: import("node:sqlite").DatabaseSync,
  lockPath: string,
  lockIdentity: FileIdentity,
  directoryIdentity: DirectoryIdentity,
): PostedMessageIndexLock {
  let released = false;
  return {
    directoryIdentity,
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        if (database.isTransaction) {
          database.exec("ROLLBACK");
        }
      } catch {
        // close() is the authoritative kernel-lock release. SQLite is deliberately
        // lock-only, so there is no mutable coordinator state to recover.
      }
      try {
        database.close();
      } catch {
        // The connection is no longer reusable.
      }
      await assertLockFileIdentity(lockPath, lockIdentity);
      await assertNoSqliteSidecars(lockPath, directoryIdentity);
    },
  };
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy/iu.test(error.message);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function readEntries(indexPath: string): Promise<readonly PostedMessageEntry[]> {
  let directoryIdentity: DirectoryIdentity | undefined;
  try {
    directoryIdentity = await existingIndexDirectoryIdentity(indexPath);
  } catch {
    return [];
  }
  if (directoryIdentity === undefined) {
    return [];
  }
  return (await tryReadIndexSnapshot(indexPath, directoryIdentity))?.entries ?? [];
}

async function tryReadIndexSnapshot(
  indexPath: string,
  directoryIdentity: DirectoryIdentity,
): Promise<PostedMessageIndexSnapshot | undefined> {
  let handle: FileHandle | undefined;
  try {
    const identity = await ensureOwnerOnlyFile(indexPath, directoryIdentity, false);
    if (identity === undefined) {
      return undefined;
    }
    const before = await lstat(indexPath);
    assertSecureFile(before, indexPath);
    assertSameIdentity(identity, before, indexPath);
    handle = await open(indexPath, fsConstants.O_RDONLY | noFollowFlag() | nonBlockFlag());
    const opened = await handle.stat();
    assertSecureFile(opened, indexPath);
    assertSameIdentity(identity, opened, indexPath);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertSecureFile(after, indexPath);
    assertSameIdentity(opened, after, indexPath);
    await assertFileIdentity(indexPath, identity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    const entries = parseEntries(bytes.toString("utf8"));
    return {
      entries,
      count: entries.length,
      size: bytes.byteLength,
      identity,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseEntries(raw: string): readonly PostedMessageEntry[] {
  const out: PostedMessageEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = parseEntry(trimmed);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  }
  return out;
}

async function appendSecureIndexLine(
  indexPath: string,
  line: string,
  expected: LoadedPostedMessageIndexState,
  directoryIdentity: DirectoryIdentity,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    await assertFileIdentity(indexPath, expected.identity);
    handle = await open(
      indexPath,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollowFlag() | nonBlockFlag(),
    );
    const opened = await handle.stat();
    assertSecureFile(opened, indexPath);
    assertSameIdentity(expected.identity, opened, indexPath);
    if (opened.size !== expected.size) {
      throw new Error(`Posted-message index ${indexPath} changed before append.`);
    }
    const result = await handle.write(line);
    const lineBytes = Buffer.byteLength(line);
    if (result.bytesWritten !== lineBytes) {
      throw new Error(`Posted-message index ${indexPath} append was incomplete.`);
    }
    const after = await handle.stat();
    assertSecureFile(after, indexPath);
    assertSameIdentity(opened, after, indexPath);
    if (after.size !== expected.size + lineBytes) {
      throw new Error(`Posted-message index ${indexPath} changed during append.`);
    }
    await assertFileIdentity(indexPath, expected.identity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function secureFileSize(
  path: string,
  expectedIdentity: FileIdentity,
  directoryIdentity: DirectoryIdentity,
): Promise<number> {
  let handle: FileHandle | undefined;
  try {
    await assertFileIdentity(path, expectedIdentity);
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | nonBlockFlag());
    const info = await handle.stat();
    assertSecureFile(info, path);
    assertSameIdentity(expectedIdentity, info, path);
    await assertFileIdentity(path, expectedIdentity);
    await assertDirectoryIdentity(dirname(path), directoryIdentity);
    return info.size;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureOwnerOnlyFile(
  path: string,
  directoryIdentity: DirectoryIdentity,
  createIfMissing: boolean,
): Promise<FileIdentity | undefined> {
  const directory = dirname(path);
  await assertDirectoryIdentity(directory, directoryIdentity);
  let created = false;
  let createHandle: FileHandle | undefined;
  if (createIfMissing) {
    try {
      try {
        createHandle = await open(
          path,
          fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag() | nonBlockFlag(),
          0o600,
        );
        created = true;
        await createHandle.chmod(0o600);
        await createHandle.sync();
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          throw error;
        }
      }
    } finally {
      await createHandle?.close().catch(() => undefined);
    }
  }
  if (!created && !createIfMissing) {
    try {
      await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  }

  const before = await lstat(path);
  assertSecureFileShape(before, path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDWR | noFollowFlag() | nonBlockFlag());
    const opened = await handle.stat();
    assertSecureFileShape(opened, path);
    assertSameIdentity(before, opened, path);
    if (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600);
      await handle.sync();
    }
    const secured = await handle.stat();
    assertSecureFile(secured, path);
    assertSameIdentity(opened, secured, path);
    const after = await lstat(path);
    assertSecureFile(after, path);
    assertSameIdentity(secured, after, path);
    await assertDirectoryIdentity(directory, directoryIdentity);
    if (created) {
      await fsyncDirectory(directory, directoryIdentity);
    }
    return identityOf(secured);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureIndexDirectory(indexPath: string): Promise<DirectoryIdentity> {
  const directory = dirname(indexPath);
  await createDirectoryPathWithoutSymlinks(directory);
  const identity = await existingIndexDirectoryIdentityRequired(indexPath);
  return await secureOwnerOnlyDirectory(directory, identity);
}

async function existingIndexDirectoryIdentity(
  indexPath: string,
): Promise<DirectoryIdentity | undefined> {
  try {
    return await existingIndexDirectoryIdentityRequired(indexPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function existingIndexDirectoryIdentityRequired(
  indexPath: string,
): Promise<DirectoryIdentity> {
  const directory = dirname(indexPath);
  const info = await lstat(directory);
  assertSecureDirectory(info, directory);
  return identityOf(info);
}

async function createDirectoryPathWithoutSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) {
          throw mkdirError;
        }
      }
      info = await lstat(current);
    }
    // macOS exposes root-owned compatibility links such as /var -> /private/var.
    // User-controlled links anywhere in the configured path remain fail-closed.
    if (info.isSymbolicLink()) {
      const uid = process.getuid?.();
      if (uid === undefined || info.uid !== 0 || uid === 0) {
        throw new Error(`Posted-message index path component ${current} must not be a user-controlled symbolic link.`);
      }
      continue;
    }
    if (!info.isDirectory()) {
      throw new Error(`Posted-message index path component ${current} must be a directory.`);
    }
    assertSafeDirectoryComponent(info, current);
  }
}

async function secureOwnerOnlyDirectory(
  path: string,
  expected: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  if (process.platform === "win32") {
    await assertDirectoryIdentity(path, expected);
    return expected;
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag(),
    );
    const opened = await handle.stat();
    assertSecureDirectory(opened, path);
    assertSameIdentity(expected, opened, path);
    if ((opened.mode & 0o777) !== 0o700) {
      await handle.chmod(0o700);
      await handle.sync();
    }
    const secured = await handle.stat();
    assertSecureDirectory(secured, path);
    if ((secured.mode & 0o777) !== 0o700) {
      throw new Error(`Posted-message index directory ${path} must have owner-only mode 0700.`);
    }
    assertSameIdentity(opened, secured, path);
    const after = await lstat(path);
    assertSecureDirectory(after, path);
    assertSameIdentity(secured, after, path);
    return identityOf(secured);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertNoSqliteSidecars(
  lockPath: string,
  directoryIdentity: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(dirname(lockPath), directoryIdentity);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const path = `${lockPath}${suffix}`;
    try {
      await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    throw new Error(`Posted-message index SQLite sidecar path ${path} must not exist.`);
  }
}

function assertSecureDirectory(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Posted-message index directory ${path} must be a non-symlink directory.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (process.platform !== "win32" && (info.mode & 0o022) !== 0) {
    throw new Error(`Posted-message index directory ${path} must not be group/world writable.`);
  }
}

function assertSafeDirectoryComponent(info: Stats, path: string): void {
  if (process.platform === "win32" || (info.mode & 0o022) === 0) {
    return;
  }
  const uid = process.getuid?.();
  const rootOwnedSticky = uid !== undefined && info.uid === 0 && (info.mode & 0o1000) !== 0;
  if (!rootOwnedSticky) {
    throw new Error(`Posted-message index path component ${path} must not be group/world writable.`);
  }
}

function assertSecureFileShape(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Posted-message index path ${path} must be a non-symlink regular file.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (info.nlink !== 1) {
    throw new Error(`Posted-message index file ${path} must have exactly one hard link.`);
  }
}

function assertSecureFile(info: Stats, path: string): void {
  assertSecureFileShape(info, path);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`Posted-message index file ${path} must have owner-only mode 0600.`);
  }
}

function assertOwnedByCurrentUser(info: Stats, path: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`Posted-message index path ${path} must be owned by the current user.`);
  }
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const info = await lstat(path);
  assertSecureDirectory(info, path);
  assertSameIdentity(expected, info, path);
}

async function assertFileIdentity(path: string, expected: FileIdentity): Promise<void> {
  const info = await lstat(path);
  assertSecureFile(info, path);
  assertSameIdentity(expected, info, path);
}

async function assertLockFileIdentity(path: string, expected: FileIdentity): Promise<void> {
  const info = await lstat(path);
  assertSecureFile(info, path);
  assertSameIdentity(expected, info, path);
  if (info.size > MAX_LOCK_FILE_BYTES) {
    throw new Error(`Posted-message index lock ${path} is unexpectedly large.`);
  }
}

function assertSameIdentity(before: FileIdentity, after: FileIdentity, path: string): void {
  if (!sameIdentity(before, after)) {
    throw new Error(`Posted-message index path ${path} changed while it was in use.`);
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityOf(info: FileIdentity): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

async function fsyncDirectory(path: string, expected: DirectoryIdentity): Promise<void> {
  if (process.platform === "win32") {
    await assertDirectoryIdentity(path, expected);
    return;
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag(),
    );
    const info = await handle.stat();
    assertSecureDirectory(info, path);
    assertSameIdentity(expected, info, path);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function nonBlockFlag(): number {
  return fsConstants.O_NONBLOCK ?? 0;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function parseEntry(line: string): PostedMessageEntry | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined; // tolerate a torn/partial line
  }
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  const channelId = stringField(record.channelId);
  const ts = stringField(record.ts);
  const conversationId = stringField(record.conversationId);
  if (channelId === undefined || ts === undefined || conversationId === undefined) {
    return undefined;
  }
  return {
    channelId,
    ts,
    conversationId,
    writtenAt: stringField(record.writtenAt) ?? "",
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
