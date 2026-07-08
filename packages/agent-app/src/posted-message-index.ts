import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
 * adapter both only ever append (small `O_APPEND` writes are atomic), and only the
 * single adapter process compacts. A `.jsonl` file is ignored by the
 * `.summary.json` artifact scanners (see `seen-conversations.ts`), so it never
 * collides with run-artifact tooling.
 */

export const POSTED_MESSAGE_INDEX_FILENAME = "posted-message-index.jsonl";

/** Daily-rollover bucket suffix the responder appends (`…#2026-06-22`). */
const ROLLOVER_BUCKET = /#\d{4}-\d{2}-\d{2}$/u;

const DEFAULT_COMPACT_MAX_ENTRIES = 5000;

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
 * Record that `conversationId` posted a message at `(channelId, ts)`. Best-effort:
 * a failed index write must never fail the Slack post, so callers should not await
 * this in a way that surfaces its errors — it swallows them. The stored
 * conversationId is de-bucketed so the consumer can let the responder re-bucket to
 * the reply's own day (consistent with daily session rollover).
 */
export async function appendPostedMessage(
  indexPath: string,
  entry: { channelId: string; ts: string; conversationId: string },
  now: () => Date = () => new Date(),
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
  try {
    await appendFile(indexPath, line, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return; // best-effort
    }
    // Artifact dir not created yet (agent never wrote a summary here). Create it
    // and retry once; still best-effort.
    try {
      await mkdir(dirname(indexPath), { recursive: true });
      await appendFile(indexPath, line, "utf8");
    } catch {
      // Give up silently.
    }
  }
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
 * (by write time, de-duped to the newest entry per `channel+ts`). Consumer-only —
 * a single process compacts, via temp-file + rename so a concurrent append is
 * never interleaved with a partial rewrite. Best-effort.
 */
export async function compactPostedMessageIndex(
  indexPath: string,
  maxEntries: number = DEFAULT_COMPACT_MAX_ENTRIES,
): Promise<void> {
  const entries = await readEntries(indexPath);
  if (entries.length <= maxEntries) {
    return;
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
    .slice(0, maxEntries);
  const body = kept.map((entry) => JSON.stringify(entry)).join("\n");
  const tmpPath = `${indexPath}.tmp-${String(kept.length)}`;
  try {
    await writeFile(tmpPath, kept.length === 0 ? "" : `${body}\n`, "utf8");
    await rename(tmpPath, indexPath);
  } catch {
    // Best-effort; leave the original file in place on failure.
  }
}

async function readEntries(indexPath: string): Promise<readonly PostedMessageEntry[]> {
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    return []; // missing/unreadable → nothing recorded yet
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
