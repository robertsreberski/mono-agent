import type {
  MessageDelta,
  MessageDeltaOp,
  MessagePart,
  RunState,
  ThreadDetail,
  ThreadSummary,
  WebMessage,
} from "./types";

/**
 * What ONE conversation costs this tab to keep, and what it is worth.
 *
 * The console used to hold exactly one conversation's transcript. Leaving it
 * and coming back re-read it in full, every time, and every refresh replaced
 * every message OBJECT -- which assistant-ui reads as "everything changed", so
 * it re-converted the whole transcript on each one.
 *
 * This is the other half of the fix the server made when it started sending
 * deltas: a small per-conversation store that merges rather than replaces, so
 * an untouched message keeps the identity its conversion is cached under, and
 * a `message.delta` can be applied to it without asking for anything at all.
 *
 * Deliberately free of React, the DOM and `api`. Everything here is a decision
 * about CONTENT -- what a delta means, which projection is newer, what a window
 * read may and may not drop -- and none of it needs a component to be true.
 */

/** How many conversations one tab keeps, before the least recent is dropped. */
export const THREAD_CACHE_ENTRIES = 8;

export interface ThreadCacheEntry {
  readonly thread: ThreadSummary;
  readonly messages: readonly WebMessage[];
  /** The keyset cursor for the next OLDER page, absent at the transcript's start. */
  readonly messagesNextCursor?: string;
  /** The validator a conditional re-read may quote. Task 8 fills this in. */
  readonly etag?: string;
  /**
   * Something changed here that this tab did not apply. A conversation on
   * screen re-reads immediately; one in the background re-reads when it is
   * opened again.
   */
  readonly stale: boolean;
  readonly syncedAt: number;
  /**
   * Tool calls whose whole body this tab fetched with "Load full output".
   *
   * The server sends the DEFAULT shape in every read and in every delta, so a
   * later write of a repaired slot arrives as the preview again. Remembering
   * which calls were repaired is what lets the untruncated body be put back
   * rather than silently reverting to 4 KB of it.
   */
  readonly repairedToolCallIds: ReadonlySet<string>;
}

/**
 * What a `message.delta` did, or why it could not be applied.
 *
 * - `applied`: the ops replayed onto the version they named.
 * - `gap`: this copy is BEHIND and the ops do not describe the step it missed
 *   -- a mismatched `baseSeq`, a message this console minted and cannot
 *   version, or a replay these parts cannot mean. The caller re-reads that one
 *   message; it never guesses.
 * - `stale`: this copy is already AT or PAST the version the delta produces, so
 *   there is nothing to apply and nothing to ask for. Told apart from `gap`
 *   because the two want opposite things: a delta still in flight when a repair
 *   read answered would otherwise buy another read, and then another.
 * - `unknown`: the message is not held at all -- a bootstrap that raced the
 *   write, or a conversation this tab is not keeping. The caller reads that
 *   message.
 */
export type DeltaOutcome = "applied" | "gap" | "stale" | "unknown";

/** A delta that cannot be replayed onto the message it names. */
export class MessageDeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageDeltaError";
  }
}

/**
 * Where a message the console learned about on its own belongs.
 *
 * NOT a sort. The server orders a transcript by four keys -- the TURN's start,
 * a role rank that puts a user's message ahead of the answer to it, the
 * message's own stamp, and finally its storage row -- and only the first and
 * third of those are on the wire at all. A client that re-sorts by what it can
 * see swaps a question and its answer whenever both were written inside the
 * same millisecond, which is every turn started from this console.
 *
 * So the server's order is preserved exactly as given, and this is used only to
 * place a message no answer positioned: after the last one that is not newer,
 * which keeps a same-stamp sibling where the server put it and still puts a
 * genuinely older row in front of what follows it.
 */
const insertionIndexFor = (messages: readonly WebMessage[], message: WebMessage): number => {
  for (let index = messages.length; index > 0; index -= 1) {
    const previous = messages[index - 1];
    if (previous !== undefined && previous.createdAt <= message.createdAt) return index;
  }
  return 0;
};

/**
 * Whether `to` is a LATER stamp than `from`.
 *
 * Parsed rather than compared as text, because the two sides of a comparison
 * are not always the same producer's formatting. Two stamps neither of which
 * parses fall back to "different means newer", which is what the console did
 * unconditionally before there was anything better to ask.
 */
const movedForward = (from: string, to: string): boolean => {
  const before = Date.parse(from);
  const after = Date.parse(to);
  return Number.isNaN(before) || Number.isNaN(after) ? to !== from : after > before;
};

/**
 * Whether an incoming projection of one message is NEWER than the held one.
 *
 * `seq` is the server's own count of parts writes and is the authority when
 * both sides have one. A held message WITHOUT one was minted by this console
 * (a live-input receipt), so anything the server sent supersedes it -- and
 * taking it is also what lets the next delta apply, since a message with no
 * `seq` can never be one's base.
 */
const isNewerMessage = (incoming: WebMessage, held: WebMessage): boolean => {
  if (held.seq === undefined) {
    return incoming.seq !== undefined || movedForward(held.updatedAt, incoming.updatedAt);
  }
  if (incoming.seq === undefined) return false;
  if (incoming.seq !== held.seq) return incoming.seq > held.seq;
  return movedForward(held.updatedAt, incoming.updatedAt);
};

/** Everything a truncated payload and its untruncated original have in common. */
interface TruncatablePayload {
  readonly args?: unknown;
  readonly result?: unknown;
  readonly resultTruncated?: boolean;
  readonly resultBytes?: number;
  readonly argsTruncated?: boolean;
  readonly argsBytes?: number;
}

const payloadText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

/**
 * Whether the held payload is provably the SAME body the incoming preview is
 * the head of.
 *
 * Two independent checks, both from the server's own numbers: the preview says
 * how long the whole body is, and it says what its first characters are. A held
 * body that matches on both is the body this preview was cut from, so putting
 * it back is restoring what the server sent -- not inventing content. Anything
 * else fails closed: the preview stands and the row offers to fetch the rest
 * again.
 */
const sameUntruncatedBody = (
  held: unknown,
  preview: unknown,
  bytes: number | undefined,
): boolean => {
  if (bytes === undefined || held === undefined) return false;
  const text = payloadText(held);
  if (text === undefined || text.length !== bytes) return false;
  const head = typeof preview === "string" ? preview : undefined;
  // An object preview is a RESHAPED args object, not a prefix of anything, so
  // the length agreement above is all the evidence there is.
  return head === undefined || text.startsWith(head);
};

const restorePayloads = <T extends TruncatablePayload>(held: TruncatablePayload, incoming: T): T => {
  const restoreResult = incoming.resultTruncated === true
    && held.resultTruncated !== true
    && sameUntruncatedBody(held.result, incoming.result, incoming.resultBytes);
  const restoreArgs = incoming.argsTruncated === true
    && held.argsTruncated !== true
    && sameUntruncatedBody(held.args, incoming.args, incoming.argsBytes);
  if (!restoreResult && !restoreArgs) return incoming;
  const next = { ...incoming } as Record<string, unknown>;
  if (restoreResult) {
    next.result = held.result;
    delete next.resultTruncated;
    delete next.resultBytes;
  }
  if (restoreArgs) {
    next.args = held.args;
    delete next.argsTruncated;
    delete next.argsBytes;
  }
  return next as T;
};

/** Every tool call one part array holds, including a delegation's children. */
const toolCallsByIdIn = (parts: readonly MessagePart[]): Map<string, TruncatablePayload> => {
  const calls = new Map<string, TruncatablePayload>();
  for (const part of parts) {
    if (part.type === "tool-call" || part.type === "subagent") calls.set(part.toolCallId, part);
    if (part.type === "subagent") {
      for (const call of part.calls) calls.set(call.toolCallId, call);
    }
  }
  return calls;
};

/**
 * Put back the untruncated payloads of any repaired call this part carries.
 *
 * Reached only for a slot a write actually touched. A part that names no
 * repaired call, or whose repaired call the server has genuinely rewritten,
 * comes back unchanged and by reference.
 */
const withRepairsRestored = (
  part: MessagePart,
  held: ReadonlyMap<string, TruncatablePayload>,
  repaired: ReadonlySet<string>,
): MessagePart => {
  if (part.type !== "tool-call" && part.type !== "subagent") return part;
  const own = repaired.has(part.toolCallId) ? held.get(part.toolCallId) : undefined;
  const restored = own === undefined ? part : restorePayloads(own, part);
  if (restored.type !== "subagent") return restored;
  const calls = restored.calls.map((call) => {
    const heldCall = repaired.has(call.toolCallId) ? held.get(call.toolCallId) : undefined;
    return heldCall === undefined ? call : restorePayloads(heldCall, call);
  });
  return calls.every((call, index) => call === restored.calls[index])
    ? restored
    : { ...restored, calls };
};

const restoreRepairs = (
  previous: readonly MessagePart[],
  next: readonly MessagePart[],
  repaired: ReadonlySet<string>,
): readonly MessagePart[] => {
  if (repaired.size === 0) return next;
  const held = toolCallsByIdIn(previous);
  if (held.size === 0) return next;
  const restored = next.map((part, index) => part === previous[index]
    ? part
    : withRepairsRestored(part, held, repaired));
  return restored.every((part, index) => part === next[index]) ? next : restored;
};

/**
 * Replay `ops` onto `parts`: the exact inverse of the server's `diffParts`.
 *
 * A deliberate re-implementation of `applyDeltaOps` rather than an import -- the
 * webapp is its own bundle and does not depend on the service package -- so
 * `message-delta-vectors.ts` is imported by BOTH sides' tests and is what keeps
 * the two readings identical. Anything the ops cannot mean against these parts
 * throws: a console that lands here has missed a write and re-reads the message
 * instead of rendering a plausible transcript.
 */
const applyDeltaOps = (
  parts: readonly MessagePart[],
  ops: readonly MessageDeltaOp[],
): readonly MessagePart[] => {
  if (ops.length === 0) return parts;
  let next = [...parts];
  for (const op of ops) {
    if (op.op === "truncate") {
      if (!Number.isInteger(op.length) || op.length < 0 || op.length > next.length) {
        throw new MessageDeltaError(
          `A message delta truncates to ${String(op.length)} parts, which is out of range for ${String(next.length)}.`,
        );
      }
      next = next.slice(0, op.length);
      continue;
    }
    if (!Number.isInteger(op.index) || op.index < 0 || op.index > next.length) {
      throw new MessageDeltaError(
        `A message delta names part ${String(op.index)}, which is out of range for ${String(next.length)}.`,
      );
    }
    if (op.op === "set") {
      next[op.index] = op.part;
      continue;
    }
    const target = next[op.index];
    if (target === undefined || (target.type !== "text" && target.type !== "reasoning")) {
      throw new MessageDeltaError(
        `A message delta appends to part ${String(op.index)}, which cannot be appended to.`,
      );
    }
    next[op.index] = { type: target.type, text: `${target.text}${op.delta}` };
  }
  return next;
};

/**
 * One message, one persisted write later.
 *
 * Throws unless the held copy is at exactly the version the delta was diffed
 * against: a client that is not at `baseSeq` has missed a write, and the ops
 * describe a step it never took.
 *
 * Always a NEW message object, because the status, the stamp and the version
 * moved even when the parts did not -- and assistant-ui's converter is keyed on
 * this object's identity, so a status that changed in place would keep
 * rendering the one it converted.
 */
export const applyMessageDelta = (
  message: WebMessage,
  delta: MessageDelta,
  repaired: ReadonlySet<string> = new Set<string>(),
): WebMessage => {
  if (message.seq === undefined) {
    throw new MessageDeltaError(
      `Message ${message.id} carries no version, so a delta cannot be applied to it.`,
    );
  }
  if (message.seq !== delta.baseSeq) {
    throw new MessageDeltaError(
      `Message ${message.id} is at version ${String(message.seq)}, and this delta applies to ${String(delta.baseSeq)}.`,
    );
  }
  const replayed = applyDeltaOps(message.parts, delta.ops);
  return {
    ...message,
    parts: restoreRepairs(message.parts, replayed, repaired),
    status: delta.status,
    updatedAt: delta.updatedAt,
    seq: delta.seq,
  };
};

export interface MergeMessagesOptions {
  /**
   * The incoming array is the newest WINDOW of the transcript rather than the
   * whole of it -- what `GET /threads/:id` answers with.
   *
   * Held messages that come BEFORE that window are kept, because they are the
   * pages this tab walked back to and the answer says nothing about them. Held
   * messages INSIDE it that the answer does not carry were deleted, and go.
   *
   * Where the window starts is read from the HELD array's own order -- the
   * first held message the answer also carries -- and never from a key the
   * client would have to invent. See {@link insertionIndexFor}.
   */
  readonly resetWindow?: boolean;
  /** See {@link ThreadCacheEntry.repairedToolCallIds}. */
  readonly repaired?: ReadonlySet<string>;
}

/**
 * The held transcript and one whole-conversation answer about it, as one
 * transcript.
 *
 * The answer's ORDER is the server's and is preserved exactly; the only thing
 * that goes in front of it is history this tab paged back to, in the order it
 * already had. Nothing is re-sorted -- see {@link insertionIndexFor} for why a
 * client cannot reproduce the server's ordering from what is on the wire.
 *
 * The other contract is IDENTITY: a message the answer did not move comes back
 * as the very object that was held, and the array comes back as the very array
 * that was held when nothing at all changed. assistant-ui caches each message's
 * conversion in a `WeakMap` keyed on the message object and short-circuits its
 * whole store update when the array is the same one, so a merge that rebuilt
 * either re-converted a transcript nothing had touched -- on every refresh, for
 * every message, for the whole of a running turn.
 */
export const mergeMessages = (
  held: readonly WebMessage[],
  incoming: readonly WebMessage[],
  options: MergeMessagesOptions = {},
): readonly WebMessage[] => {
  const repaired = options.repaired ?? new Set<string>();
  const incomingIds = new Set(incoming.map((message) => message.id));
  const windowStart = held.findIndex((message) => incomingIds.has(message.id));
  const kept = windowStart < 0
    // The answer overlaps nothing this tab holds. Either the transcript was
    // replaced wholesale or the window has moved entirely past what was kept,
    // and neither is something to reconstruct an order from: the answer is the
    // transcript, exactly as it used to be before there was a cache.
    ? []
    : held.slice(0, windowStart).concat(
        // Only a window read claims to be complete over its own range, so only
        // a window read may read an absence as a deletion.
        options.resetWindow === true
          ? []
          : held.slice(windowStart).filter((message) => !incomingIds.has(message.id)),
      );
  const heldById = new Map(held.map((message) => [message.id, message]));
  const merged = [
    ...kept,
    ...incoming.map((message) => {
      const previous = heldById.get(message.id);
      if (previous === undefined) return message;
      if (!isNewerMessage(message, previous)) return previous;
      const parts = restoreRepairs(previous.parts, message.parts, repaired);
      return parts === message.parts ? message : { ...message, parts };
    }),
  ];
  return merged.length === held.length && merged.every((message, index) => message === held[index])
    ? held
    : merged;
};

export interface ThreadCache {
  readonly get: (threadId: string) => ThreadCacheEntry | undefined;
  /** Whether this conversation holds a projection of that message. */
  readonly holdsMessage: (threadId: string, messageId: string) => boolean;
  readonly ids: () => readonly string[];
  /**
   * The conversation on screen. It is never evicted, however long ago it was
   * last read: dropping what the operator is LOOKING AT to keep a background
   * conversation would be the one eviction that costs a visible refetch.
   */
  readonly setSelected: (threadId: string | null) => void;
  readonly touch: (threadId: string) => void;
  /**
   * A whole-conversation answer. `reset` marks it a WINDOW read -- see
   * {@link MergeMessagesOptions.resetWindow} -- which is what every
   * `GET /threads/:id` is.
   */
  readonly upsertFull: (
    detail: ThreadDetail,
    options?: { readonly reset?: boolean; readonly etag?: string },
  ) => ThreadCacheEntry | undefined;
  /**
   * One message: a repair read, a live-input receipt, a cron run's card.
   *
   * Merged by version like any other answer, so a projection older than the
   * one held cannot walk the transcript backwards. `replace` is for an answer
   * that is authoritative WITHOUT being a later version -- the cron activity
   * read returns the same row at the same version with its run detail filled
   * in, and merging it would discard exactly what was asked for.
   */
  readonly upsertMessage: (
    threadId: string,
    message: WebMessage,
    options?: { readonly replace?: boolean },
  ) => boolean;
  readonly prependOlder: (
    threadId: string,
    page: { readonly messages: readonly WebMessage[]; readonly nextCursor?: string },
  ) => boolean;
  /** The summary only. Never inserts: a conversation not held stays not held. */
  readonly patchThread: (threadId: string, thread: ThreadSummary) => boolean;
  readonly patchRunState: (threadId: string, runState: RunState) => boolean;
  readonly applyDelta: (threadId: string, delta: MessageDelta) => DeltaOutcome;
  /** Put one untruncated tool call back, and remember that it was fetched. */
  readonly repairToolCall: (
    threadId: string,
    messageId: string,
    toolCallId: string,
    part: MessagePart,
  ) => boolean;
  readonly markStale: (threadId: string) => void;
  /**
   * Everything held is suspect: a reconnect, or coming back online. Nothing
   * was observed while the link was down, so no entry can say it is current.
   */
  readonly markAllStale: () => void;
  readonly evict: (threadId: string) => void;
  readonly clear: () => void;
}

/**
 * Whether a message is the one that owns a tool call -- as a part of its own,
 * or as one of a delegation's children.
 *
 * The full-body route is addressed by (conversation, message, call) because a
 * tool-call id is not a capability, so the console has to name the message it
 * already holds the preview in.
 */
export const holdsToolCall = (message: WebMessage, toolCallId: string): boolean =>
  message.parts.some((part) =>
    (part.type === "tool-call" || part.type === "subagent")
      && (part.toolCallId === toolCallId
        || (part.type === "subagent"
          && part.calls.some((call) => call.toolCallId === toolCallId))));

/**
 * Put an untruncated tool call back where its preview was, as NEW objects.
 *
 * Shared with the store's own repair path: assistant-ui caches its part
 * conversions by object identity, so a transcript repaired in place goes on
 * rendering the preview it already converted.
 */
export const mergeToolCallPart = (existing: MessagePart, full: MessagePart): MessagePart => {
  if (full.type !== "tool-call" && full.type !== "subagent") return existing;
  if (existing.type !== "tool-call" && existing.type !== "subagent") return existing;
  if (existing.toolCallId === full.toolCallId) return full;
  if (existing.type !== "subagent" || full.type !== "tool-call") return existing;
  if (!existing.calls.some((call) => call.toolCallId === full.toolCallId)) return existing;
  // A delegation's child owns no part of its own, so the route answers with the
  // tool call it would have been and it goes back into the group.
  const { type: _type, ...call } = full;
  return {
    ...existing,
    calls: existing.calls.map((candidate) =>
      candidate.toolCallId === full.toolCallId ? call : candidate),
  };
};

export const createThreadCache = (
  maxEntries: number = THREAD_CACHE_ENTRIES,
  now: () => number = () => Date.now(),
): ThreadCache => {
  // Insertion order IS recency order: every touch deletes before it sets, so
  // the first key is always the least recently used.
  const entries = new Map<string, ThreadCacheEntry>();
  let selectedId: string | null = null;

  const prune = (): void => {
    while (entries.size > maxEntries) {
      let victim: string | undefined;
      for (const candidate of entries.keys()) {
        if (candidate !== selectedId) {
          victim = candidate;
          break;
        }
      }
      // Every entry left is the selected one, which is never evicted.
      if (victim === undefined) return;
      entries.delete(victim);
    }
  };

  const touch = (threadId: string): void => {
    const entry = entries.get(threadId);
    if (entry === undefined) return;
    entries.delete(threadId);
    entries.set(threadId, entry);
  };

  const write = (threadId: string, entry: ThreadCacheEntry): void => {
    entries.delete(threadId);
    entries.set(threadId, entry);
    prune();
  };

  const patchEntry = (
    threadId: string,
    patch: (entry: ThreadCacheEntry) => ThreadCacheEntry,
  ): boolean => {
    const entry = entries.get(threadId);
    if (entry === undefined) return false;
    const next = patch(entry);
    if (next === entry) return false;
    entries.set(threadId, next);
    return true;
  };

  const withCursor = (
    entry: Omit<ThreadCacheEntry, "messagesNextCursor">,
    cursor: string | undefined,
  ): ThreadCacheEntry => (cursor === undefined ? entry : { ...entry, messagesNextCursor: cursor });

  return {
    get: (threadId) => entries.get(threadId),
    holdsMessage: (threadId, messageId) =>
      entries.get(threadId)?.messages.some((message) => message.id === messageId) === true,
    ids: () => [...entries.keys()],
    setSelected: (threadId) => {
      selectedId = threadId;
      if (threadId !== null) touch(threadId);
    },
    touch,
    upsertFull: (detail, options = {}) => {
      const threadId = detail.thread.id;
      const held = entries.get(threadId);
      const reset = options.reset === true;
      if (held === undefined) {
        const entry = withCursor(
          {
            thread: detail.thread,
            messages: detail.messages,
            stale: false,
            syncedAt: now(),
            repairedToolCallIds: new Set<string>(),
            ...(options.etag === undefined ? {} : { etag: options.etag }),
          },
          detail.messagesNextCursor,
        );
        write(threadId, entry);
        return entry;
      }
      const messages = mergeMessages(held.messages, detail.messages, {
        resetWindow: reset,
        repaired: held.repairedToolCallIds,
      });
      // The answer's cursor points at the page BEFORE its own window, which is
      // history this conversation may already have walked back to. Adopting it
      // would re-request pages already held and, worse, hide the older cursor
      // that reaches the ones it has not. The merge puts exactly the kept
      // history in front of the window, so anything longer than the answer is
      // history this tab is still protecting.
      const keptOlder = messages.length > detail.messages.length;
      const cursor = keptOlder ? held.messagesNextCursor : detail.messagesNextCursor;
      const entry = withCursor(
        {
          thread: detail.thread,
          messages,
          stale: false,
          syncedAt: now(),
          repairedToolCallIds: held.repairedToolCallIds,
          ...(options.etag === undefined
            ? (held.etag === undefined ? {} : { etag: held.etag })
            : { etag: options.etag }),
        },
        cursor,
      );
      write(threadId, entry);
      return entry;
    },
    upsertMessage: (threadId, message, options = {}) => patchEntry(threadId, (entry) => {
      const index = entry.messages.findIndex((candidate) => candidate.id === message.id);
      if (index < 0) {
        // A row no answer has positioned: a live-input receipt, or the message
        // a delta named before this tab had read it. See `insertionIndexFor`.
        const messages = [...entry.messages];
        messages.splice(insertionIndexFor(messages, message), 0, message);
        return { ...entry, messages, syncedAt: now() };
      }
      const held = entry.messages[index];
      if (held === undefined) return entry;
      const next = options.replace === true || isNewerMessage(message, held)
        ? message
        : held;
      if (next === held) return entry;
      const parts = restoreRepairs(held.parts, next.parts, entry.repairedToolCallIds);
      const messages = [...entry.messages];
      // IN PLACE: the server's ordering keys are not all on the wire, so the
      // position this row already has is the only authority for where it goes.
      messages[index] = parts === next.parts ? next : { ...next, parts };
      return { ...entry, messages, syncedAt: now() };
    }),
    prependOlder: (threadId, page) => patchEntry(threadId, (entry) => {
      const held = new Set(entry.messages.map((message) => message.id));
      const older = page.messages.filter((message) => !held.has(message.id));
      // A keyset page is everything BEFORE what is held, in the server's own
      // order, so it goes in front unchanged rather than being re-sorted.
      const messages = older.length === 0 ? entry.messages : [...older, ...entry.messages];
      const { messagesNextCursor: _cursor, ...withoutCursor } = entry;
      const next = withCursor({ ...withoutCursor, messages }, page.nextCursor);
      return messages === entry.messages && next.messagesNextCursor === entry.messagesNextCursor
        ? entry
        : next;
    }),
    patchThread: (threadId, thread) => patchEntry(threadId, (entry) => ({ ...entry, thread })),
    patchRunState: (threadId, runState) => patchEntry(threadId, (entry) =>
      ({ ...entry, thread: { ...entry.thread, runState } })),
    applyDelta: (threadId, delta) => {
      const entry = entries.get(threadId);
      if (entry === undefined) return "unknown";
      const index = entry.messages.findIndex((message) => message.id === delta.messageId);
      const held = index < 0 ? undefined : entry.messages[index];
      if (held === undefined) return "unknown";
      if (held.seq !== undefined && held.seq >= delta.seq) return "stale";
      if (held.seq === undefined || held.seq !== delta.baseSeq) return "gap";
      let next: WebMessage;
      try {
        next = applyMessageDelta(held, delta, entry.repairedToolCallIds);
      } catch (replayError) {
        // Never a plausible transcript: a replay these parts cannot mean is the
        // same evidence a version mismatch is -- this copy is not what the
        // server diffed against -- and the answer is the same read.
        if (!(replayError instanceof MessageDeltaError)) throw replayError;
        return "gap";
      }
      const messages = [...entry.messages];
      messages[index] = next;
      entries.set(threadId, { ...entry, messages, syncedAt: now() });
      return "applied";
    },
    repairToolCall: (threadId, messageId, toolCallId, part) => {
      const entry = entries.get(threadId);
      if (entry === undefined) return false;
      const index = entry.messages.findIndex((message) => message.id === messageId);
      const held = index < 0 ? undefined : entry.messages[index];
      if (held === undefined) return false;
      const parts = held.parts.map((existing) => mergeToolCallPart(existing, part));
      if (parts.every((next, slot) => next === held.parts[slot])) return false;
      const messages = [...entry.messages];
      messages[index] = { ...held, parts };
      entries.set(threadId, {
        ...entry,
        messages,
        repairedToolCallIds: new Set([...entry.repairedToolCallIds, toolCallId]),
      });
      return true;
    },
    markStale: (threadId) => {
      patchEntry(threadId, (entry) => (entry.stale ? entry : { ...entry, stale: true }));
    },
    markAllStale: () => {
      for (const [threadId, entry] of entries) {
        if (!entry.stale) entries.set(threadId, { ...entry, stale: true });
      }
    },
    evict: (threadId) => { entries.delete(threadId); },
    clear: () => { entries.clear(); },
  };
};
