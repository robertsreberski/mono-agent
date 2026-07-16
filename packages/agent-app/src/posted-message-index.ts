import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
 * Storage is an append-only JSONL file inside the run-artifact dir. Append-only
 * keeps cross-process writes safe: the `SlackSendMessage` child process and the
 * adapter serialize appends and compaction through the same filesystem lock.
 * Small `O_APPEND` writes remain atomic, while batched compaction creates enough
 * headroom to avoid rewriting on every send once the cap is reached. The `.jsonl`
 * index and its `.lock.sqlite` coordinator are ignored by the `.summary.json`
 * artifact scanners (see `seen-conversations.ts`), so they never collide with
 * run-artifact tooling.
 */

export const POSTED_MESSAGE_INDEX_FILENAME = "posted-message-index.jsonl";

/** Daily-rollover bucket suffix the responder appends (`…#2026-06-22`). */
const ROLLOVER_BUCKET = /#\d{4}-\d{2}-\d{2}$/u;

const DEFAULT_COMPACT_MAX_ENTRIES = 5000;
const COMPACT_HEADROOM_DIVISOR = 10;
const INDEX_LOCK_WAIT_MS = 2000;
const inProcessIndexTails = new Map<string, Promise<void>>();

interface PostedMessageIndexState {
  readonly count: number;
  readonly size: number;
}

type PostedMessageIndexDatabase = import("node:sqlite").DatabaseSync;

interface PostedMessageIndexLock {
  readonly database: PostedMessageIndexDatabase;
  release(commit: boolean): Promise<void>;
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
  const cap = normalizedAppendCap(maxEntries);
  await withPostedMessageIndexLock(indexPath, async (database) => {
    let state = await loadPostedMessageIndexState(database, indexPath);
    if (state === undefined) {
      return;
    }
    if (state.count >= cap) {
      const compacted = await compactPostedMessageIndexUnlocked(
        indexPath,
        amortizedCompactTarget(cap),
      );
      if (compacted === undefined) {
        // Preserve the existing bounded file rather than append past the cap when
        // its rewrite cannot be completed safely.
        return;
      }
      state = compacted;
    }

    const nextState: PostedMessageIndexState = {
      count: state.count + 1,
      size: state.size + Buffer.byteLength(line),
    };
    // Stage the expected post-append state in the lock transaction first. A crash
    // rolls it back; a failed append commits a size mismatch, so either way the
    // next writer recounts instead of under-counting.
    writePostedMessageIndexState(database, nextState);
    try {
      await appendFile(indexPath, line, "utf8");
    } catch {
      // Best-effort. The future-size state intentionally no longer matches, which
      // forces the next writer to recover from the index itself.
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
 * (by write time, de-duped to the newest entry per `channel+ts`). Compaction and
 * every appender share one cross-process lock; temp-file + rename keeps the visible
 * index atomic without racing away a completed append. Best-effort.
 */
export async function compactPostedMessageIndex(
  indexPath: string,
  maxEntries: number = DEFAULT_COMPACT_MAX_ENTRIES,
  hooks: { readonly beforeReplace?: () => Promise<void> } = {},
): Promise<void> {
  await withPostedMessageIndexLock(indexPath, async (database) => {
    const compacted = await compactPostedMessageIndexUnlocked(indexPath, maxEntries, hooks);
    if (compacted !== undefined) {
      writePostedMessageIndexState(database, compacted);
    }
  });
}

async function compactPostedMessageIndexUnlocked(
  indexPath: string,
  maxEntries: number,
  hooks: { readonly beforeReplace?: () => Promise<void> } = {},
): Promise<PostedMessageIndexState | undefined> {
  const entries = await tryReadEntries(indexPath);
  const size = await postedMessageIndexSize(indexPath);
  if (entries === undefined || size === undefined) {
    return undefined;
  }
  if (entries.length <= maxEntries) {
    return { count: entries.length, size };
  }
  // Newest entry per (channel, ts), then newest-first, then cap.
  const latest = new Map<string, PostedMessageEntry>();
  for (const entry of entries) {
    const key = `${entry.channelId} ${entry.ts}`;
    const prior = latest.get(key);
    if (prior === undefined || entry.writtenAt >= prior.writtenAt) {
      latest.set(key, entry);
    }
  }
  const kept = [...latest.values()]
    .sort((a, b) => (a.writtenAt < b.writtenAt ? 1 : a.writtenAt > b.writtenAt ? -1 : 0))
    .slice(0, Math.max(0, maxEntries));
  const body = kept.map((entry) => JSON.stringify(entry)).join("\n");
  const nextBody = kept.length === 0 ? "" : `${body}\n`;
  const tmpPath = `${indexPath}.tmp-${String(kept.length)}`;

  try {
    await hooks.beforeReplace?.();
    await writeFile(tmpPath, nextBody, "utf8");
    await rename(tmpPath, indexPath);
    return { count: kept.length, size: Buffer.byteLength(nextBody) };
  } catch {
    // Best-effort; leave the original file in place on failure.
    return undefined;
  }
}

function normalizedAppendCap(maxEntries: number): number {
  return Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : DEFAULT_COMPACT_MAX_ENTRIES;
}

function amortizedCompactTarget(maxEntries: number): number {
  const headroom = Math.max(1, Math.ceil(maxEntries / COMPACT_HEADROOM_DIVISOR));
  return Math.max(0, maxEntries - headroom);
}

async function loadPostedMessageIndexState(
  database: PostedMessageIndexDatabase,
  indexPath: string,
): Promise<PostedMessageIndexState | undefined> {
  const size = await postedMessageIndexSize(indexPath);
  if (size === undefined) {
    return undefined;
  }
  const persisted = readPostedMessageIndexState(database);
  if (persisted !== undefined && persisted.size === size) {
    return persisted;
  }
  const entries = await tryReadEntries(indexPath);
  return entries === undefined ? undefined : { count: entries.length, size };
}

function readPostedMessageIndexState(
  database: PostedMessageIndexDatabase,
): PostedMessageIndexState | undefined {
  const row = database.prepare(`
    SELECT entry_count AS count, index_size AS size
    FROM index_state
    WHERE id = 1
  `).get() as Record<string, unknown> | undefined;
  return row !== undefined && Number.isSafeInteger(row.count) && (row.count as number) >= 0 &&
    Number.isSafeInteger(row.size) && (row.size as number) >= 0
    ? { count: row.count as number, size: row.size as number }
    : undefined;
}

function writePostedMessageIndexState(
  database: PostedMessageIndexDatabase,
  state: PostedMessageIndexState,
): void {
  database.prepare(`
    INSERT INTO index_state (id, entry_count, index_size)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      entry_count = excluded.entry_count,
      index_size = excluded.index_size
  `).run(state.count, state.size);
}

async function postedMessageIndexSize(indexPath: string): Promise<number | undefined> {
  try {
    return (await stat(indexPath)).size;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 0 : undefined;
  }
}

async function withPostedMessageIndexLock(
  indexPath: string,
  action: (database: PostedMessageIndexDatabase) => Promise<void>,
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
    let commit = false;
    try {
      await action(lock.database);
      commit = true;
    } finally {
      await lock.release(commit);
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
  try {
    await mkdir(dirname(indexPath), { recursive: true });
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return undefined;
  }
  const lockPath = `${indexPath}.lock.sqlite`;
  const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
  while (true) {
    let database: PostedMessageIndexDatabase | undefined;
    try {
      database = new DatabaseSync(lockPath, { timeout: 0 });
      if (process.platform !== "win32") {
        await chmod(lockPath, 0o600);
      }
      // SQLite owns the cross-process arbitration: the kernel releases this lock
      // automatically on close or process death, with no stale-path cleanup race.
      database.exec("BEGIN IMMEDIATE");
      database.exec(`
        CREATE TABLE IF NOT EXISTS index_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          entry_count INTEGER NOT NULL,
          index_size INTEGER NOT NULL
        )
      `);
      return postedMessageIndexLock(database);
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

function postedMessageIndexLock(database: PostedMessageIndexDatabase): PostedMessageIndexLock {
  let released = false;
  return {
    database,
    async release(commit) {
      if (released) {
        return;
      }
      released = true;
      try {
        if (database.isTransaction) {
          database.exec(commit ? "COMMIT" : "ROLLBACK");
        }
      } catch {
        // close() is the authoritative kernel-lock release. A failed commit leaves
        // the old count state, whose size mismatch triggers a JSONL recount.
      }
      try {
        database.close();
      } catch {
        // The connection is no longer reusable.
      }
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
  return (await tryReadEntries(indexPath)) ?? [];
}

async function tryReadEntries(
  indexPath: string,
): Promise<readonly PostedMessageEntry[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? []
      : undefined;
  }
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
