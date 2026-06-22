import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ChannelId } from "./channels.js";
import { channelIdForConversation } from "./proactive-notify.js";

/** A real conversation the agent has handled, recovered from run artifacts. */
export interface SeenConversation {
  /** The base (de-bucketed) conversationId to use as a `notify` destination. */
  readonly conversationId: string;
  readonly channelId: ChannelId;
  /** ISO timestamp of the most recent run on this conversation, if recorded. */
  readonly lastSeen?: string;
}

export interface ListSeenOptions {
  /** Cap on the number of (newest-first) summary files read. Default 2000. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 2000;
const SUMMARY_SUFFIX = ".summary.json";
const ROLLOVER_BUCKET = /#\d{4}-\d{2}-\d{2}$/u;
/** Max summary files statted concurrently, to bound open fds and avoid EMFILE. */
const STAT_BATCH_SIZE = 64;

/**
 * Distinct push-channel conversationIds the agent has actually handled, read from
 * the run-artifact summaries in `artifactDir`. Synthetic ids (`cron:`/`webhook:`/…)
 * are dropped via {@link channelIdForConversation}; daily-rollover buckets are
 * stripped to the base id (the form a `notify` destination uses) and deduped to the
 * most recent sighting. Sorted newest-first. A missing dir yields an empty list.
 */
export async function listSeenNotifyDestinations(
  artifactDir: string,
  options: ListSeenOptions = {},
): Promise<readonly SeenConversation[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  let entries: string[];
  try {
    entries = await readdir(artifactDir);
  } catch {
    // Dir absent (agent never ran) or unreadable → nothing seen yet.
    return [];
  }

  const summaries = entries.filter((name) => name.endsWith(SUMMARY_SUFFIX));
  // Summary filenames are conversationId-based with no embedded time ordering, so a
  // full stat pass is required to learn each file's mtime before we can take the
  // newest `limit`. We stat in bounded batches (not one big Promise.all over every
  // summary) to keep open file descriptors capped and avoid EMFILE/IO spikes on a
  // busy agent with thousands of artifacts.
  const withMtime: { name: string; mtimeMs: number }[] = [];
  for (let i = 0; i < summaries.length; i += STAT_BATCH_SIZE) {
    const batch = summaries.slice(i, i + STAT_BATCH_SIZE);
    const stated = await Promise.all(
      batch.map(async (name) => {
        try {
          return { name, mtimeMs: (await stat(join(artifactDir, name))).mtimeMs };
        } catch {
          return { name, mtimeMs: 0 };
        }
      }),
    );
    withMtime.push(...stated);
  }
  // Newest files first, then cap, so a busy agent's scan stays bounded.
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const latest = new Map<string, SeenConversation>();
  for (const { name } of withMtime.slice(0, limit)) {
    const parsed = await readSummary(join(artifactDir, name));
    if (parsed === undefined) {
      continue;
    }
    const channelId = channelIdForConversation(parsed.conversationId);
    if (channelId === undefined) {
      continue; // synthetic / non-push destination
    }
    const conversationId = parsed.conversationId.replace(ROLLOVER_BUCKET, "");
    const seen: SeenConversation = {
      conversationId,
      channelId,
      ...(parsed.lastSeen === undefined ? {} : { lastSeen: parsed.lastSeen }),
    };
    const prior = latest.get(conversationId);
    if (prior === undefined || isNewer(seen.lastSeen, prior.lastSeen)) {
      latest.set(conversationId, seen);
    }
  }

  return [...latest.values()].sort((a, b) => compareLastSeen(b.lastSeen, a.lastSeen));
}

async function readSummary(path: string): Promise<{ conversationId: string; lastSeen?: string } | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  const conversationId = record.conversationId;
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    return undefined;
  }
  const lastSeen = firstString(record.endedAt, record.updatedAt, record.startedAt);
  return { conversationId, ...(lastSeen === undefined ? {} : { lastSeen }) };
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isNewer(candidate: string | undefined, current: string | undefined): boolean {
  return compareLastSeen(candidate, current) > 0;
}

/** Compare ISO timestamps; a missing timestamp sorts oldest. */
function compareLastSeen(a: string | undefined, b: string | undefined): number {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }
  return a < b ? -1 : 1;
}
