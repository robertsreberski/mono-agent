import type { ThreadSummary } from "./types";

/**
 * Which conversations have moved since THIS DEVICE last looked at them.
 *
 * Device-local on purpose. The server has no idea what a person has read: the
 * same account is a phone, a laptop and a tab left open on a second monitor,
 * and a marker the server owned would clear on all three the moment one of them
 * was looked at. So this is one browser's memory of one number per conversation
 * -- the `revision` it was last SEEN at -- and nothing about it leaves the
 * device.
 *
 * What follows from that, and is not a defect:
 *
 * - It is per browser ORIGIN, and clearing site data clears it.
 * - A conversation this device has never seen is NOT unread. First sight seeds
 *   the marker at whatever revision it is at, because the alternative is a
 *   fresh console where every conversation in the fleet is shouting.
 * - It can only speak for conversations this console has been told about. The
 *   fleet listing and the loaded pages are what it sees; there is no unread
 *   count for an agent whose conversations have never been listed here.
 */

/**
 * How many conversations one device remembers having seen.
 *
 * The map is written to the device with the rest of the console's metadata, so
 * it has to be bounded like everything else there. Least-recently-touched goes
 * first; losing an entry makes a conversation read rather than unread, which is
 * the harmless direction -- the alternative is a marker that grows for every
 * conversation the fleet has ever had.
 */
export const SEEN_THREAD_LIMIT = 200;

/** One conversation, and the revision this device last saw of it. */
export interface SeenRevision {
  readonly id: string;
  readonly revision: number;
}

export interface UnreadMarker {
  /** Adopt what the device remembered. Replaces whatever is held. */
  readonly restore: (seen: readonly SeenRevision[]) => void;
  /** What to write back, least-recently-touched first. */
  readonly entries: () => readonly SeenRevision[];
  /** Whether this summary has moved since this device saw it. */
  readonly unread: (thread: ThreadSummary) => boolean;
  /**
   * This conversation is being LOOKED AT: its current revision counts as seen.
   *
   * Returns whether anything actually moved, so a caller can decide whether the
   * device is owed a write.
   */
  readonly see: (thread: ThreadSummary) => boolean;
  /**
   * First sight of these conversations, which seeds them as read.
   *
   * Only ever seeds: a conversation already known keeps the revision it was
   * seen at, or this would mark everything read as it scrolled past.
   */
  readonly note: (threads: readonly ThreadSummary[]) => boolean;
  /** These conversations are gone; stop remembering them. */
  readonly forget: (threadIds: readonly string[]) => boolean;
  /** Which of these the operator has not seen the current state of. */
  readonly unreadIds: (threads: readonly ThreadSummary[]) => ReadonlySet<string>;
}

/** Rows a device wrote, which a newer or interrupted build may have shaped differently. */
export const readSeenRevisions = (value: unknown): readonly SeenRevision[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return [];
    const { id, revision } = row as { id?: unknown; revision?: unknown };
    return typeof id === "string" && typeof revision === "number" && Number.isFinite(revision)
      ? [{ id, revision }]
      : [];
  });
};

export const createUnreadMarker = (): UnreadMarker => {
  /**
   * Insertion order IS the recency order: every touch deletes and re-inserts,
   * so the first key out is always the least recently touched one. The same
   * trick the store's unlisted-thread memory uses.
   */
  const seen = new Map<string, number>();

  const touch = (id: string, revision: number): void => {
    seen.delete(id);
    seen.set(id, revision);
    while (seen.size > SEEN_THREAD_LIMIT) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  };

  return {
    restore: (restored) => {
      seen.clear();
      for (const row of restored) touch(row.id, row.revision);
    },
    entries: () => [...seen].map(([id, revision]) => ({ id, revision })),
    unread: (thread) => {
      const marked = seen.get(thread.id);
      return marked !== undefined && thread.revision > marked;
    },
    see: (thread) => {
      if (seen.get(thread.id) === thread.revision) return false;
      touch(thread.id, thread.revision);
      return true;
    },
    note: (threads) => {
      let moved = false;
      for (const thread of threads) {
        if (seen.has(thread.id)) continue;
        touch(thread.id, thread.revision);
        moved = true;
      }
      return moved;
    },
    forget: (threadIds) => {
      let moved = false;
      for (const id of threadIds) moved = seen.delete(id) || moved;
      return moved;
    },
    unreadIds: (threads) => {
      const unread = new Set<string>();
      for (const thread of threads) {
        const marked = seen.get(thread.id);
        if (marked !== undefined && thread.revision > marked) unread.add(thread.id);
      }
      return unread;
    },
  };
};

/** How many of these conversations are unread, per agent. */
export const unreadCountsBySource = (
  threads: readonly ThreadSummary[],
  unread: ReadonlySet<string>,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (!unread.has(thread.id)) continue;
    counts.set(thread.sourceId, (counts.get(thread.sourceId) ?? 0) + 1);
  }
  return counts;
};
