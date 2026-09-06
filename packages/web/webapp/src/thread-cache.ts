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

/**
 * How many conversations an observation is remembered for.
 *
 * An observation outlives the ENTRY -- that is the whole point: a delta that
 * arrives while the cold read of the conversation the operator just opened is
 * on the wire has nowhere to land, and the only way that read does not land
 * looking current is for the observation to still be there when it does.
 * Bounded oldest-first, so a tab that watches a busy fleet all day cannot grow
 * it; losing the oldest costs at most one read that lands fresher than it
 * should, which the next event corrects.
 */
export const OBSERVED_CONVERSATIONS = 256;

/** The statuses a message -- and so a delta that finishes one -- may carry. */
const MESSAGE_STATUSES: ReadonlySet<string> = new Set<WebMessage["status"]>([
  "running", "complete", "failed", "cancelled", "interrupted",
]);

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
  /**
   * This entry came off the DEVICE and no server answer has touched it yet.
   *
   * Deliberately separate from {@link ThreadCacheEntry.stale}, which
   * `markAllStale` sets on genuinely live entries during a reconnect. What this
   * marks is different and stronger: nothing here has ever been confirmed by
   * anything, so a field like `runState` is only as true as it was when the tab
   * was last closed -- and a tab killed mid-turn stored `running` for a turn
   * that has long since finished, for which no event will ever arrive. Cleared
   * by the first server-sourced write for the conversation.
   */
  readonly fromDevice?: boolean;
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
  /**
   * The messages this tab reached by paging BACKWARDS.
   *
   * One of the two things that put a held row outside what a windowed answer
   * can speak for -- see {@link MergeMessagesOptions.pagedIn} and
   * `outsideAnswer` in {@link mergeMessages}. The other is the answer's own
   * oldest stamp, and neither implies the other: this set is what keeps a
   * recovered row that landed in FRONT of paged history from taking that
   * history with it.
   */
  readonly pagedInIds: ReadonlySet<string>;
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
 * - `unknown`: the CONVERSATION is held but this message is not -- a read that
 *   raced the write that created it. The caller reads that one message.
 * - `unheld`: the conversation itself is not held, so there is nowhere for a
 *   message read to land and no request worth spending: whatever read is on the
 *   wire (or is coming) owns it, and the observation this leaves behind is what
 *   makes that read land stale. Told apart from `unknown` because answering it
 *   with a message GET spent a request and then dropped its answer on the floor.
 */
export type DeltaOutcome = "applied" | "gap" | "stale" | "unknown" | "unheld";

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
 *
 * THE ONLY client-side placement decision in this module, and the only one that
 * can be wrong: it has nothing to go on but `createdAt`, so ties are appended
 * and a row whose stamp disagrees with the server's ordering keys lands in the
 * wrong slot until the next whole-conversation answer repositions it. Nothing
 * else may grow a second opinion about order -- `mergeMessages` guards against
 * this one going wrong by never letting a position alone decide that history
 * was deleted.
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

/**
 * The later of two projections of one conversation, by the SERVER's revision.
 *
 * Ordered by the revision and not by arrival, because two answers about one row
 * are not ordered against each other: the POST that renamed it, the event
 * carrying the same row, and a listing page all describe it, and the last one
 * to reach the tab is not the newest one the server made. An EQUAL revision is
 * the same server state, and the incoming one wins so an optimistic edit made
 * at the revision it patches still lands.
 */
export const newerProjection = (
  held: ThreadSummary,
  fetched: ThreadSummary | undefined,
): ThreadSummary => (fetched === undefined || fetched.revision < held.revision ? held : fetched);

/** Everything a truncated payload and its untruncated original have in common. */
interface TruncatablePayload {
  readonly args?: unknown;
  readonly result?: unknown;
  readonly resultTruncated?: boolean;
  readonly resultBytes?: number;
  readonly resultDigest?: string;
  readonly argsTruncated?: boolean;
  readonly argsBytes?: number;
  readonly argsDigest?: string;
}

/**
 * Whether the held payload is provably the SAME body the incoming preview is
 * the head of.
 *
 * The SERVER decides this, and says so: it names the untruncated payload with a
 * sha-256 of its serialized text, on the whole body the repair read answers with
 * and on every preview cut from it. Equal names is the same content.
 *
 * It replaced a length-and-prefix comparison, which asked a question those two
 * facts cannot answer: a rewritten result of exactly the same size beginning
 * with the same characters -- a directory listing whose last line changed, a
 * retried command -- restored the OLD body under the NEW preview, and the
 * operator read stale output with nothing to say it was stale.
 *
 * FAIL CLOSED. A name missing on either side is not weak evidence, it is none:
 * the preview stands as the preview it is and the row offers to fetch the rest
 * again, which costs one request and cannot be wrong.
 */
const sameUntruncatedBody = (
  held: unknown,
  heldDigest: string | undefined,
  previewDigest: string | undefined,
): boolean => held !== undefined
  && heldDigest !== undefined
  && previewDigest !== undefined
  && heldDigest === previewDigest;

/**
 * Whether two run states say the same thing.
 *
 * Compared field by field rather than by identity, because every projection of
 * a conversation builds a new one -- and the field the console actually turns
 * on, `status`, is the same string in almost all of them.
 */
const sameRunState = (held: RunState, next: RunState): boolean =>
  held.status === next.status
  && held.id === next.id
  && held.startedAt === next.startedAt
  && held.finishedAt === next.finishedAt
  && held.model === next.model
  && held.effort === next.effort
  && held.error?.code === next.error?.code
  && held.error?.message === next.error?.message;

const restorePayloads = <T extends TruncatablePayload>(held: TruncatablePayload, incoming: T): T => {
  const restoreResult = incoming.resultTruncated === true
    && held.resultTruncated !== true
    && sameUntruncatedBody(held.result, held.resultDigest, incoming.resultDigest);
  const restoreArgs = incoming.argsTruncated === true
    && held.argsTruncated !== true
    && sameUntruncatedBody(held.args, held.argsDigest, incoming.argsDigest);
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
    // Only the write that finishes the turn carries one, so a delta without it
    // is SILENT about the stamp rather than clearing a stamp already held.
    ...(delta.finishedAt === undefined ? {} : { finishedAt: delta.finishedAt }),
    seq: delta.seq,
  };
};

/**
 * Whether a part a `set` op carries is one this transcript could render.
 *
 * A frame carrying a part the renderer cannot read is not something to apply
 * halfway: an op that names a shape this console does not understand means the
 * message has to be re-read, the same as any other unreadable frame. An
 * unrecognised `type` is refused for the same reason -- a newer server's new
 * part kind costs one message read here rather than a slot the transcript
 * cannot draw.
 */
const isMessagePart = (value: unknown): value is MessagePart => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  const text = (key: string): boolean => typeof part[key] === "string";
  const status = (): boolean =>
    part.status === "running" || part.status === "complete" || part.status === "failed";
  switch (part.type) {
    case "text":
    case "reasoning":
      return text("text");
    case "tool-call":
      return text("toolCallId") && text("toolName") && status();
    case "subagent":
      return text("toolCallId") && text("name") && status() && Array.isArray(part.calls);
    case "process-job":
      return typeof part.job === "object" && part.job !== null;
    case "monitor-activity":
      return Array.isArray(part.monitors);
    case "telemetry":
      return text("event");
    case "error":
      return text("message");
    case "attachment":
      return text("id") && text("artifactId") && text("name") && text("mediaType")
        && text("integrityId") && typeof part.sizeBytes === "number";
    case "mcp_app":
      return text("id") && text("invocationId") && text("connectionId") && text("serverName")
        && text("toolName") && text("resourceUri") && text("mediaType")
        && text("protocolVersion");
    case "failure":
      return text("id") && text("code") && text("message");
    default:
      return false;
  }
};

/** The ops a `message.delta` carries, refused rather than half-read. */
const readDeltaOps = (value: unknown): readonly MessageDeltaOp[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  for (const candidate of value as readonly unknown[]) {
    if (candidate === null || typeof candidate !== "object") return undefined;
    const op = candidate as Record<string, unknown>;
    if (op.op === "truncate") {
      if (typeof op.length !== "number") return undefined;
      continue;
    }
    if (typeof op.index !== "number") return undefined;
    if (op.op === "append") {
      if (typeof op.delta !== "string") return undefined;
      continue;
    }
    if (op.op !== "set" || !isMessagePart(op.part)) return undefined;
  }
  return value as readonly MessageDeltaOp[];
};

/**
 * A `message.delta` payload, or nothing.
 *
 * A frame this console cannot make sense of is never applied as a partial
 * reading: the message it names is re-read instead. Everything the replay
 * depends on -- both versions, the status, and every op down to the shape of
 * the parts a `set` carries -- has to be there.
 */
export const readMessageDelta = (payload: unknown): MessageDelta | undefined => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const candidate = payload as Partial<MessageDelta>;
  const ops = readDeltaOps(candidate.ops);
  if (typeof candidate.messageId !== "string"
    || typeof candidate.baseSeq !== "number"
    || typeof candidate.seq !== "number"
    || !MESSAGE_STATUSES.has(candidate.status as string)
    || typeof candidate.updatedAt !== "string"
    || (candidate.finishedAt !== undefined && typeof candidate.finishedAt !== "string")
    || ops === undefined) return undefined;
  return { ...(candidate as MessageDelta), ops };
};

export interface MergeMessagesOptions {
  /**
   * The answer is AUTHORITATIVE over the range it covers: a message it does not
   * carry, inside that range, was DELETED rather than merely unmentioned.
   *
   * Every whole-conversation read is one. A conditional or partial answer --
   * "here is what moved" -- is not, and leaves everything it did not name
   * exactly where it was.
   */
  readonly resetWindow?: boolean;
  /**
   * The answer has more transcript BEFORE it (it came with a
   * `messagesNextCursor`), so it is a window and cannot speak for anything
   * older than the oldest row it carries -- which is precisely the history the
   * operator paged back to.
   *
   * Without this an authoritative answer IS the whole transcript, and an
   * absence at any age is a deletion. That is what makes a compaction visible
   * rather than leaving rows on screen the server no longer has.
   */
  readonly bounded?: boolean;
  /**
   * The messages this tab reached by paging BACKWARDS.
   *
   * The BACKSTOP half of `outsideAnswer` (see {@link mergeMessages}), not the
   * whole of it. A bounded answer cannot speak for anything older than the
   * oldest row it carries, and that stamp boundary is the primary guard; this
   * set covers the case the stamp cannot, because `insertionIndexFor` places a
   * recovered row by `createdAt` alone and can land it in FRONT of paged
   * history whose stamp says it is newer.
   *
   * Read from what `prependOlder` actually brought in rather than inferred from
   * a position: a client cannot reproduce the server's ordering from the wire,
   * so a position may never be what decides that the operator's scrolled-back
   * history was deleted.
   */
  readonly pagedIn?: ReadonlySet<string>;
  /** See {@link ThreadCacheEntry.repairedToolCallIds}. */
  readonly repaired?: ReadonlySet<string>;
}

/**
 * The held transcript and one answer about it, as one transcript.
 *
 * The answer's ORDER is the server's and is preserved exactly. Anything the
 * answer did not carry keeps the position it already had, immediately before
 * whichever answered message used to follow it -- concatenating the remainder
 * in front of the answer reordered a transcript whenever the answer was a
 * subset rather than a window, which is what a conditional read is.
 *
 * Nothing is re-sorted -- see {@link insertionIndexFor} for why a client cannot
 * reproduce the server's ordering from what is on the wire. Which is also why a
 * POSITION never decides that history was deleted: what a bounded answer's
 * silence may mean is settled by the stamp of the oldest row it carries and by
 * the ids this tab paged in, both of which are things the SERVER said. See
 * `outsideAnswer` below.
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
  const heldById = new Map(held.map((message) => [message.id, message]));
  const chosen = (message: WebMessage): WebMessage => {
    const previous = heldById.get(message.id);
    if (previous === undefined) return message;
    if (!isNewerMessage(message, previous)) return previous;
    const parts = restoreRepairs(previous.parts, message.parts, repaired);
    return parts === message.parts ? message : { ...message, parts };
  };
  const settle = (result: readonly WebMessage[]): readonly WebMessage[] =>
    (result.length === held.length && result.every((message, index) => message === held[index])
      ? held
      : result);

  // What an authoritative answer's silence CANNOT mean.
  //
  // An UNBOUNDED answer is the whole conversation, so its silence is a deletion
  // at any age -- which is what makes a compaction visible. A BOUNDED one has
  // more transcript before it and can only speak for its own range, and TWO
  // things put a held row outside that range:
  //
  // - It is OLDER than the oldest row the answer carries. This is the window
  //   contract itself, and it is what a turn makes ordinary: the window is the
  //   newest rows, so it walks forward as messages are appended and a refresh
  //   stops carrying the row it used to start at. Without this, that row is
  //   read as deleted and leaves a hole in the MIDDLE of the transcript that
  //   paging can never fill, because the older cursor is kept.
  // - This tab PAGED IT IN. `insertionIndexFor` places a recovered row by
  //   `createdAt` alone, so one can land in front of history whose stamp says
  //   it is newer; the ids `prependOlder` actually brought in are what keeps
  //   the stamp comparison from taking that history with it.
  //
  // Neither guard implies the other, so both stand.
  const pagedIn = options.pagedIn ?? new Set<string>();
  const answerStartsAt = incoming.reduce<string | undefined>(
    (oldest, message) =>
      (oldest === undefined || message.createdAt < oldest ? message.createdAt : oldest),
    undefined,
  );
  const outsideAnswer = (message: WebMessage): boolean =>
    options.bounded === true
    && (pagedIn.has(message.id)
      || (answerStartsAt !== undefined && message.createdAt < answerStartsAt));

  const positionOf = new Map(incoming.map((message, index) => [message.id, index]));
  const overlaps = held.some((message) => positionOf.has(message.id));
  if (!overlaps) {
    // Nothing to interleave against, and the same rule about what the answer
    // may speak for. A window that advanced by a WHOLE page while this tab was
    // suspended shares no id with what is held -- the ordinary app-switch case
    // -- and reading that as "the answer is the transcript" threw away every
    // row the operator had paged back to, along with their place in it.
    const kept = options.resetWindow === true ? held.filter(outsideAnswer) : [...held];
    return settle([...kept, ...incoming.map(chosen)]);
  }

  // Held rows the answer did not carry, banked until the next row it did --
  // which is the position they must keep.
  const before = new Map<number, WebMessage[]>();
  let bank: WebMessage[] = [];
  for (const message of held) {
    const at = positionOf.get(message.id);
    if (at !== undefined) {
      if (bank.length > 0) {
        before.set(at, [...(before.get(at) ?? []), ...bank]);
        bank = [];
      }
      continue;
    }
    if (options.resetWindow === true && !outsideAnswer(message)) continue;
    bank.push(message);
  }
  const trailing = bank;

  const merged: WebMessage[] = [];
  for (const [index, message] of incoming.entries()) {
    const preceding = before.get(index);
    if (preceding !== undefined) merged.push(...preceding);
    merged.push(chosen(message));
  }
  merged.push(...trailing);
  return settle(merged);
};

export interface ThreadCache {
  readonly get: (threadId: string) => ThreadCacheEntry | undefined;
  /** Whether this conversation holds a projection of that message. */
  readonly holdsMessage: (threadId: string, messageId: string) => boolean;
  /**
   * The token a read quotes when it is ISSUED, so the answer can be told
   * whether anything was observed while it was on the wire.
   *
   * The same shape as the listing's admission epoch: read it before the
   * request, hand it back when the response lands.
   */
  readonly clock: () => number;
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
    options?: {
      readonly reset?: boolean;
      readonly etag?: string;
      /** {@link ThreadCache.clock} read when this read was issued. */
      readonly issuedAt?: number;
    },
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
  /**
   * Something changed in this conversation that this tab did not apply.
   *
   * RECORDED EVEN WHEN NO ENTRY IS HELD, and that is the point: a read already
   * on the wire quotes {@link ThreadCache.clock} from before this, so it lands
   * stale rather than looking like the newest thing the server said.
   */
  readonly markStale: (threadId: string) => void;
  /**
   * A conditional read the server answered "unchanged": what is held IS the
   * current transcript.
   *
   * The entry is kept exactly as it is -- the summary, the transcript and every
   * message in it come back by reference -- and only the suspicion is answered,
   * which is the whole point of a read that cost a status line. `issuedAt` is
   * {@link ThreadCache.clock} read before the request: anything observed after
   * that is something the 304 cannot speak for, so the entry STAYS stale and
   * the caller reads again. Returns whether the entry moved.
   */
  readonly confirmFresh: (threadId: string, issuedAt: number) => boolean;
  /**
   * Everything held is suspect: a reconnect, or coming back online. Nothing
   * was observed while the link was down, so no entry can say it is current.
   */
  readonly markAllStale: () => void;
  readonly evict: (threadId: string) => void;
  /**
   * Forget everything, except optionally the conversation on screen.
   *
   * `keep` is what "Clear cached data" needs: the operator asked for what this
   * browser is holding to go, not for the transcript in front of them to be
   * replaced by a spinner and bought again.
   *
   * Like {@link ThreadCache.restore} and {@link ThreadCache.confirmFresh}, this
   * does NOT call `onCommit`: that hook means "the device store has to hear
   * about this", and none of the three changes anything the device stores.
   * Anything the CALLER derives from the held set -- see the store's
   * `hasRunningThread` -- has to be recomputed by the caller after these three.
   */
  readonly clear: (keep?: string) => void;
  /**
   * Every conversation held, least recently used first -- which is eviction
   * order, so a reader that has to bound itself drops from the front.
   *
   * The entries come back BY REFERENCE, which is what lets the device store
   * tell "this transcript moved" from "this is the same object I already
   * wrote" without comparing any content.
   */
  readonly snapshot: () => readonly ThreadCacheEntry[];
  /**
   * Put a conversation back from wherever it was kept between visits.
   *
   * ALWAYS STALE, whatever was stored: a restored transcript has missed an
   * unbounded window -- every event since the tab was last open -- so it is
   * something to draw immediately and nothing to answer with. The conditional
   * read the first open issues is what makes it current, at the cost of a
   * status line when nothing changed.
   *
   * Restored entries are marked {@link ThreadCacheEntry.fromDevice} until a
   * server answer touches them. See {@link ThreadCache.clear} for why this does
   * not call `onCommit`.
   */
  readonly restore: (entry: {
    readonly thread: ThreadSummary;
    readonly messages: readonly WebMessage[];
    readonly messagesNextCursor?: string;
    readonly etag?: string;
    readonly repairedToolCallIds?: ReadonlySet<string>;
    readonly pagedInIds?: ReadonlySet<string>;
  }) => void;
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
  /**
   * Something a conversation's CONTENT changed -- a read, a delta, a repair, an
   * eviction. Called after the write, never during a render, and deliberately
   * not for staleness: what a device store keeps is transcripts, and a
   * reconnect that suspects all eight has moved none of them.
   */
  onCommit: () => void = () => undefined,
): ThreadCache => {
  // Insertion order IS recency order: every touch deletes before it sets, so
  // the first key is always the least recently used.
  const entries = new Map<string, ThreadCacheEntry>();
  // Bumped by every observation. A read quotes it when it is ISSUED and hands
  // it back when it lands, which is the only way an answer can tell "nothing
  // changed while I was out" from "I am simply the last thing to arrive".
  let clock = 0;
  // When each conversation was last observed to have changed, INDEPENDENT of
  // whether an entry is held -- see {@link OBSERVED_CONVERSATIONS}. Insertion
  // order is recency order, so eviction takes the oldest.
  const observedAt = new Map<string, number>();
  let selectedId: string | null = null;

  const observe = (threadId: string): void => {
    clock += 1;
    observedAt.delete(threadId);
    observedAt.set(threadId, clock);
    while (observedAt.size > OBSERVED_CONVERSATIONS) {
      const oldest = observedAt.keys().next();
      if (oldest.done === true) break;
      observedAt.delete(oldest.value);
    }
  };

  /** Whether anything was observed AFTER the read that is landing was issued. */
  const overtaken = (threadId: string, issuedAt: number | undefined): boolean =>
    issuedAt !== undefined && (observedAt.get(threadId) ?? 0) > issuedAt;

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

  /**
   * The same entry, no longer merely what the device kept.
   *
   * Applied by every write whose content came from the SERVER -- which is all
   * of them except `restore` itself and the two that only move suspicion.
   */
  const confirmed = <T extends ThreadCacheEntry>(entry: T): T =>
    (entry.fromDevice === true ? { ...entry, fromDevice: false } : entry);

  /** {@link patchEntry} for a write whose input the server produced. */
  const patchFromServer = (
    threadId: string,
    patch: (entry: ThreadCacheEntry) => ThreadCacheEntry,
  ): boolean => patchEntry(threadId, (entry) => confirmed(patch(entry)));

  /** A write the device store has to hear about. See {@link onCommit}. */
  const committed = (changed: boolean): boolean => {
    if (changed) onCommit();
    return changed;
  };

  const withCursor = (
    entry: Omit<ThreadCacheEntry, "messagesNextCursor">,
    cursor: string | undefined,
  ): ThreadCacheEntry => (cursor === undefined ? entry : { ...entry, messagesNextCursor: cursor });

  return {
    get: (threadId) => entries.get(threadId),
    holdsMessage: (threadId, messageId) =>
      entries.get(threadId)?.messages.some((message) => message.id === messageId) === true,
    clock: () => clock,
    setSelected: (threadId) => {
      selectedId = threadId;
      if (threadId !== null) touch(threadId);
    },
    touch,
    upsertFull: (detail, options = {}) => {
      const threadId = detail.thread.id;
      const held = entries.get(threadId);
      const reset = options.reset === true;
      // Anything observed AFTER this read went out is something it cannot have
      // seen, so it lands stale however complete it looks.
      const stale = overtaken(threadId, options.issuedAt);
      if (held === undefined) {
        const entry = withCursor(
          {
            thread: detail.thread,
            messages: detail.messages,
            stale,
            syncedAt: now(),
            repairedToolCallIds: new Set<string>(),
            pagedInIds: new Set<string>(),
            ...(options.etag === undefined ? {} : { etag: options.etag }),
          },
          detail.messagesNextCursor,
        );
        write(threadId, entry);
        onCommit();
        return entry;
      }
      const messages = mergeMessages(held.messages, detail.messages, {
        resetWindow: reset,
        // The answer came with a cursor, so it has more transcript before it
        // and cannot speak for what this tab paged back to.
        bounded: detail.messagesNextCursor !== undefined,
        pagedIn: held.pagedInIds,
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
      // Only what SURVIVED stays remembered as paged-in, so the set cannot
      // outgrow the transcript it describes -- and when everything survived, the
      // very set it was holding. The device store compares this by identity to
      // decide whether a row has to be rewritten, so a fresh Set of the same
      // ids made a conversation re-read once a second during a turn re-strip
      // and rewrite a byte-identical row on every flush.
      const surviving = new Set(messages.map((message) => message.id));
      const pagedIn = [...held.pagedInIds].filter((id) => surviving.has(id));
      const entry = withCursor(
        {
          thread: newerProjection(held.thread, detail.thread),
          messages,
          stale,
          syncedAt: now(),
          repairedToolCallIds: held.repairedToolCallIds,
          pagedInIds: pagedIn.length === held.pagedInIds.size ? held.pagedInIds : new Set(pagedIn),
          ...(options.etag === undefined
            ? (held.etag === undefined ? {} : { etag: held.etag })
            : { etag: options.etag }),
        },
        cursor,
      );
      write(threadId, entry);
      onCommit();
      return entry;
    },
    upsertMessage: (threadId, message, options = {}) => committed(patchFromServer(threadId, (entry) => {
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
    })),
    prependOlder: (threadId, page) => committed(patchFromServer(threadId, (entry) => {
      const held = new Set(entry.messages.map((message) => message.id));
      const older = page.messages.filter((message) => !held.has(message.id));
      // A keyset page is everything BEFORE what is held, in the server's own
      // order, so it goes in front unchanged rather than being re-sorted.
      const messages = older.length === 0 ? entry.messages : [...older, ...entry.messages];
      const { messagesNextCursor: _cursor, ...withoutCursor } = entry;
      const next = withCursor({
        ...withoutCursor,
        messages,
        // Remembered by ID: this is the only thing a later windowed answer can
        // be measured against to tell paged-back history from a deletion.
        pagedInIds: older.length === 0
          ? entry.pagedInIds
          : new Set([...entry.pagedInIds, ...older.map((message) => message.id)]),
      }, page.nextCursor);
      return messages === entry.messages && next.messagesNextCursor === entry.messagesNextCursor
        ? entry
        : next;
    })),
    patchThread: (threadId, thread) => committed(patchFromServer(threadId, (entry) => {
      // ORDERED BY THE SERVER'S REVISION, exactly as the listing is. A POST
      // answer that lost its race to the event carrying the same row would
      // otherwise roll the cached summary back while the sidebar kept the newer
      // one -- and `detail.thread` is what the console falls back to for a
      // conversation the sidebar does not list at all.
      const next = newerProjection(entry.thread, thread);
      return next === entry.thread ? entry : { ...entry, thread: next };
    })),
    // A run state restated by an event that changed nothing is not news: the
    // summary comes back by reference and no commit is announced, so the flush
    // this would otherwise schedule -- several a second during a turn -- does
    // not happen.
    patchRunState: (threadId, runState) => committed(patchFromServer(threadId, (entry) =>
      (sameRunState(entry.thread.runState, runState)
        ? entry
        : { ...entry, thread: { ...entry.thread, runState } }))),
    applyDelta: (threadId, delta) => {
      const entry = entries.get(threadId);
      if (entry === undefined) return "unheld";
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
      entries.set(threadId, confirmed({ ...entry, messages, syncedAt: now() }));
      onCommit();
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
      entries.set(threadId, confirmed({
        ...entry,
        messages,
        repairedToolCallIds: new Set([...entry.repairedToolCallIds, toolCallId]),
      }));
      onCommit();
      return true;
    },
    markStale: (threadId) => {
      observe(threadId);
      patchEntry(threadId, (entry) => (entry.stale ? entry : { ...entry, stale: true }));
    },
    confirmFresh: (threadId, issuedAt) => {
      // Nothing to confirm, and nothing observed here is worth forgetting: an
      // entry that was evicted while the conditional read was out is a cold
      // read either way.
      if (entries.get(threadId) === undefined) return false;
      if (overtaken(threadId, issuedAt)) return false;
      // A 304 is the server saying the whole body -- the summary and its
      // `runState` included -- is exactly what is held, which is the strongest
      // confirmation there is that a restored entry describes something real.
      //
      // Deliberately NOT `committed`: nothing it changes -- `stale`, `syncedAt`,
      // `fromDevice` -- is stored, and a reconnect that answers eight
      // conditional reads must not rewrite eight rows. Like `restore` and
      // `clear`, the caller recomputes whatever it derives from the held set.
      return patchFromServer(threadId, (entry) => (entry.stale
        ? { ...entry, stale: false, syncedAt: now() }
        : entry));
    },
    markAllStale: () => {
      for (const [threadId, entry] of entries) {
        observe(threadId);
        if (!entry.stale) entries.set(threadId, { ...entry, stale: true });
      }
    },
    evict: (threadId) => { committed(entries.delete(threadId)); },
    clear: (keep) => {
      const kept = keep === undefined ? undefined : entries.get(keep);
      entries.clear();
      if (keep !== undefined && kept !== undefined) entries.set(keep, kept);
    },
    snapshot: () => [...entries.values()],
    restore: (stored) => {
      const threadId = stored.thread.id;
      write(threadId, withCursor(
        {
          thread: stored.thread,
          messages: stored.messages,
          // NOT NEGOTIABLE. Everything that happened while this tab was closed
          // is exactly what is missing here.
          stale: true,
          // And nothing has confirmed any of it. See `fromDevice`: a tab killed
          // mid-turn stored `running`, and no event is coming for a turn that
          // finished while the browser was shut.
          fromDevice: true,
          syncedAt: now(),
          repairedToolCallIds: stored.repairedToolCallIds ?? new Set<string>(),
          pagedInIds: stored.pagedInIds ?? new Set<string>(),
          ...(stored.etag === undefined ? {} : { etag: stored.etag }),
        },
        stored.messagesNextCursor,
      ));
    },
  };
};
