import type { ThreadCacheEntry } from "./thread-cache";
import type {
  AgentSummary,
  ConsoleIdentity,
  MessagePart,
  PushBootstrap,
  ThreadSummary,
  UploadLimits,
  WebAttachment,
  WebMessage,
} from "./types";

/**
 * What this browser keeps of the console between visits.
 *
 * The cache in `thread-cache.ts` makes a SESSION cheap: leaving a conversation
 * and coming back costs nothing. Closing the tab threw all of it away, so every
 * cold start -- and on a phone that is every time the operating system reclaims
 * the PWA -- paid for the whole snapshot and the whole open conversation before
 * anything appeared. This is the same store written to the device: a cold start
 * renders what it had, marks all of it suspect, and lets the ordinary
 * conditional read say what actually changed (a status line, almost always).
 *
 * Rules it will not bend:
 *
 * - NOTHING here throws into the store. A browser with no `indexedDB`, a
 *   private window that answers `SecurityError`, a full quota, a database from
 *   a newer build -- each one resolves to "disabled" and the console goes on
 *   working exactly as it did before this file existed.
 * - No capability URL is ever written. The short-lived, tokenised endpoints on
 *   attachment and MCP App parts are the one thing in a transcript that is a
 *   CREDENTIAL rather than content, and they are stripped on the way out.
 * - A validator is stored only WITH the exact bytes it describes. Stripping a
 *   capability URL changes those bytes, so the entry loses its `etag` with
 *   them: a 304 could otherwise confirm a transcript this device altered.
 */

export const PERSISTENCE_DB_NAME = "mono-agent-web";
/** 2 adds the `writer` index; see {@link createThreadPersistence}. */
export const PERSISTENCE_DB_VERSION = 2;

/**
 * How long a row nothing has rewritten is kept.
 *
 * Rows are swept by the instance that wrote them, and an instance ends with its
 * page. What a closed tab left behind has no owner, so without this the device
 * grew by up to one cache's worth on every cold start that read rows and never
 * changed them. Thirty days is well past any conversation a cold start would
 * still want to draw, and losing one costs a read, never a fact.
 */
export const PERSISTED_ROW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
/**
 * A hard ceiling on stored conversations, oldest dropped first.
 *
 * The age sweep bounds the store in TIME; this bounds it in SIZE, which is what
 * a phone actually runs out of. Three tabs' worth of the cache's own eight.
 */
export const PERSISTED_THREAD_LIMIT = 24;

const THREAD_STORE = "threads";
/** Which instance last wrote a row, and so which one may sweep it. */
const WRITER_INDEX = "writer";
const BUCKET_STORE = "buckets";
const META_STORE = "meta";
/** The one snapshot row: everything a cold start needs that is not a conversation. */
const SNAPSHOT_KEY = "agents";
/** The console that wrote all of this. A different one owns none of it. */
const HOST_KEY = "host";

/** One conversation, as it is written to the device. */
export interface PersistedThread {
  readonly id: string;
  readonly thread: ThreadSummary;
  readonly messages: readonly WebMessage[];
  readonly messagesNextCursor?: string;
  /** Absent whenever the stored transcript is not byte-for-byte the served one. */
  readonly etag?: string;
  readonly repairedToolCallIds: readonly string[];
  readonly pagedInIds: readonly string[];
  readonly savedAt: number;
  /**
   * The {@link createThreadPersistence} instance that last put this row.
   *
   * Every tab on this origin owns the same database, and a flush is one tab's
   * statement about its own eight conversations. Read as a statement about the
   * store, it deleted whatever another tab was live in. Absent on rows written
   * before this field existed.
   */
  readonly writer?: string;
}

/** One (agent, archived) listing, keyed exactly as the store keys its buckets. */
export interface PersistedBucket {
  readonly key: string;
  readonly threads: readonly ThreadSummary[];
  readonly nextCursor: string | null;
  readonly savedAt: number;
}

/** Everything a cold start needs before it can draw anything at all. */
export interface PersistedSnapshot {
  readonly agents: readonly AgentSummary[];
  readonly console: ConsoleIdentity;
  readonly limits: UploadLimits;
  readonly push: PushBootstrap;
}

export interface HydratedConsole {
  /** The `console.hostName` that wrote this, or `null` when nothing has. */
  readonly host: string | null;
  readonly snapshot: PersistedSnapshot | null;
  readonly buckets: readonly PersistedBucket[];
  readonly threads: readonly PersistedThread[];
}

/** One flush: what the tab holds right now, and nothing incremental. */
export interface PersistableState {
  /**
   * Every conversation the cache is keeping -- at most its LRU's eight.
   *
   * A row absent from this list is deleted only when THIS instance wrote it or
   * read it back from the device; anything else on the store belongs to another
   * tab and is left to that tab. This is how an eviction, a removal and a
   * tombstone all reach the device without any of them having to say so, and
   * why two consoles open at once do not delete each other's conversations.
   */
  readonly entries: readonly ThreadCacheEntry[];
  readonly snapshot?: PersistedSnapshot;
  readonly bucket?: {
    readonly key: string;
    readonly threads: readonly ThreadSummary[];
    readonly nextCursor: string | null;
  };
}

export interface ThreadPersistence {
  /**
   * What this device has, or `null` when there is no store to read -- which is
   * the same answer a browser without IndexedDB gives, on purpose.
   */
  readonly hydrate: () => Promise<HydratedConsole | null>;
  readonly save: (state: PersistableState) => Promise<void>;
  readonly clearAll: () => Promise<void>;
  /**
   * These entries ARE what is stored, so the next flush has nothing to write
   * for them.
   *
   * What {@link ThreadPersistence.hydrate} returned comes back into the cache
   * as NEW objects, and the change tracking below is by identity -- so without
   * this every cold start rewrote all eight transcripts a second after
   * restoring them.
   */
  readonly markPersisted: (entries: readonly ThreadCacheEntry[]) => void;
  /**
   * These conversations are GONE -- deleted, or destroyed on the server.
   *
   * A sweep is an inference from what a tab still holds, and it is scoped to
   * the rows this instance wrote precisely because it cannot tell its own
   * eviction from another tab's live conversation. A tombstone is not an
   * inference: the operator asked for the conversation to stop existing, so its
   * row goes whoever wrote it.
   */
  readonly forget: (threadIds: readonly string[]) => Promise<void>;
  /**
   * Let go of the connection, WITHOUT disabling: the next call reopens.
   *
   * A connection held open blocks another tab's delete or upgrade until the
   * browser gives up on it.
   */
  readonly close: () => void;
}

export interface StrippedTranscript {
  readonly messages: readonly WebMessage[];
  /** Whether anything was actually removed -- see the `etag` rule above. */
  readonly stripped: boolean;
}

const strippedAttachment = (attachment: WebAttachment): WebAttachment | undefined => {
  if (attachment.contentUrl === undefined) return undefined;
  const { contentUrl: _contentUrl, ...rest } = attachment;
  return rest;
};

const strippedPart = (part: MessagePart): MessagePart | undefined => {
  if (part.type === "attachment") {
    if (part.contentUrl === undefined) return undefined;
    // `storedUrl` stays: it is the console's own durable copy and carries no
    // token, which is why an image that has one still renders on a cold start.
    const { contentUrl: _contentUrl, ...rest } = part;
    return rest;
  }
  if (part.type === "mcp_app") {
    if (part.resourceUrl === undefined && part.bridgeUrl === undefined) return undefined;
    const { resourceUrl: _resourceUrl, bridgeUrl: _bridgeUrl, ...rest } = part;
    return rest;
  }
  return undefined;
};

/**
 * The transcript with every capability URL removed.
 *
 * Identity preserving: a transcript with nothing to strip comes back as the
 * very array it was given, so the ordinary flush copies nothing.
 */
export const stripCapabilityUrls = (
  messages: readonly WebMessage[],
): StrippedTranscript => {
  let stripped = false;
  const next = messages.map((message) => {
    const parts = message.parts.map((part) => strippedPart(part) ?? part);
    const attachments = message.attachments.map((item) => strippedAttachment(item) ?? item);
    const partsMoved = parts.some((part, index) => part !== message.parts[index]);
    const attachmentsMoved = attachments.some((item, index) => item !== message.attachments[index]);
    if (!partsMoved && !attachmentsMoved) return message;
    stripped = true;
    return { ...message, parts, attachments };
  });
  return stripped ? { messages: next, stripped } : { messages, stripped };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A summary the sidebar and the header can actually draw.
 *
 * `runState.status` is read unconditionally by every row and by the chat
 * header, and the title and stamp by every row -- a stored summary without them
 * does not render as a degraded row, it throws. These rows were written by THIS
 * console, so this is not a trust boundary; it is what keeps one interrupted
 * write from taking the cold start down.
 */
const isSummary = (value: unknown): value is ThreadSummary =>
  isRecord(value)
  && typeof value.id === "string"
  && typeof value.sourceId === "string"
  && typeof value.title === "string"
  && typeof value.updatedAt === "string"
  && isRecord(value.runState)
  && typeof value.runState.status === "string";

const stringsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const isStoredMessage = (value: unknown): value is WebMessage =>
  isRecord(value)
  && typeof value.id === "string"
  && typeof value.role === "string"
  && typeof value.createdAt === "string"
  // The two the renderer AND the write path walk unconditionally. A row that
  // reached the cache without them turned the next flush into a `TypeError` --
  // an unhandled rejection, with persistence dead behind it.
  && Array.isArray(value.parts)
  && Array.isArray(value.attachments);

/**
 * A row this build can actually use, or nothing.
 *
 * These rows were written by THIS console, so the checks are not a trust
 * boundary; they are what keeps one interrupted write, or a row from a build
 * that shaped things differently, from taking the whole hydration -- and with
 * it the cold start -- down with it.
 */
const readThreadRow = (value: unknown): PersistedThread | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !isSummary(value.thread)) return undefined;
  if (!Array.isArray(value.messages) || !value.messages.every(isStoredMessage)) return undefined;
  return {
    id: value.id,
    thread: value.thread,
    messages: value.messages as readonly WebMessage[],
    ...(typeof value.messagesNextCursor === "string"
      ? { messagesNextCursor: value.messagesNextCursor }
      : {}),
    ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
    repairedToolCallIds: stringsOf(value.repairedToolCallIds),
    pagedInIds: stringsOf(value.pagedInIds),
    savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
    ...(typeof value.writer === "string" ? { writer: value.writer } : {}),
  };
};

const readBucketRow = (value: unknown): PersistedBucket | undefined => {
  if (!isRecord(value) || typeof value.key !== "string") return undefined;
  if (!Array.isArray(value.threads) || !value.threads.every(isSummary)) return undefined;
  return {
    key: value.key,
    threads: value.threads,
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
    savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
  };
};

const readSnapshotRow = (value: unknown): PersistedSnapshot | undefined => {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.agents) || !isRecord(value.console) || !isRecord(value.limits)) {
    return undefined;
  }
  if (typeof value.console.hostName !== "string" || !isRecord(value.push)) return undefined;
  return {
    agents: value.agents as readonly AgentSummary[],
    console: value.console as unknown as ConsoleIdentity,
    limits: value.limits as unknown as UploadLimits,
    push: value.push as unknown as PushBootstrap,
  };
};

/**
 * What one hydration decides the device should stop keeping.
 *
 * Three rules, none of them about what any tab currently holds:
 *
 * - **Age.** A row more than {@link PERSISTED_ROW_MAX_AGE_MS} older than the
 *   NEWEST row here is past any cold start that would still draw it. Measured
 *   against the store's own newest stamp rather than against this browser's
 *   clock: both stamps were written by the same kind of clock, and a device
 *   whose clock jumps forward -- or a test with a fixed one -- must not be able
 *   to decide the whole store is ancient.
 * - **Ceiling.** Conversations beyond {@link PERSISTED_THREAD_LIMIT}, oldest
 *   first. Rows are swept by the instance that wrote them and an instance ends
 *   with its page, so what a closed tab left behind has no owner; this is what
 *   keeps that from growing without a bound.
 * - **Agents that are gone.** A listing for an agent the stored snapshot no
 *   longer names can never be shown again, and nothing else ever removed it.
 *
 * Losing any of these costs a read, never a fact: everything restored is marked
 * suspect and revalidated anyway.
 */
export const sweepableRows = (
  threads: readonly PersistedThread[],
  buckets: readonly PersistedBucket[],
  snapshot: PersistedSnapshot | null,
): { readonly threads: ReadonlySet<string>; readonly buckets: ReadonlySet<string> } => {
  // Seeded at zero, NOT at the reader's clock: seeded at `at`, a store whose
  // rows were all written by a fixed or a slow clock reads as entirely ancient
  // and the first hydration empties it.
  const newest = [...threads, ...buckets].reduce((latest, row) => Math.max(latest, row.savedAt), 0);
  const oldest = newest - PERSISTED_ROW_MAX_AGE_MS;
  const doomedThreads = new Set(
    [...threads]
      .sort((left, right) => right.savedAt - left.savedAt)
      .filter((row, index) => row.savedAt < oldest || index >= PERSISTED_THREAD_LIMIT)
      .map((row) => row.id),
  );
  // Only when there IS a snapshot: with none, this device knows no agent list
  // and every bucket would look orphaned.
  const known = snapshot === null
    ? undefined
    : new Set(snapshot.agents.map((agent) => agent.sourceId));
  const doomedBuckets = new Set(
    buckets
      .filter((row) => row.savedAt < oldest
        || (known !== undefined && !known.has(bucketSourceId(row.key))))
      .map((row) => row.key),
  );
  return { threads: doomedThreads, buckets: doomedBuckets };
};

/** The agent half of a bucket key; see `threadBucketKey` in the store. */
const bucketSourceId = (key: string): string => key.split("\u0000", 1)[0] ?? key;

/**
 * Remove what {@link sweepableRows} named, best effort.
 *
 * Its own transaction, after the read that decided it: a failure here means the
 * device keeps a few rows longer than it should, which is not a reason to give
 * up on the store or to fail a cold start.
 */
const discard = async (
  db: IDBDatabase,
  doomed: { readonly threads: ReadonlySet<string>; readonly buckets: ReadonlySet<string> },
): Promise<void> => {
  const transaction = db.transaction([THREAD_STORE, BUCKET_STORE], "readwrite");
  const threads = transaction.objectStore(THREAD_STORE);
  const buckets = transaction.objectStore(BUCKET_STORE);
  for (const id of doomed.threads) threads.delete(id);
  for (const key of doomed.buckets) buckets.delete(key);
  await settled(transaction);
};

const asPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The device store refused a read."));
  });

const settled = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("The device store refused a write."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("The device store abandoned a write."));
  });

export const createThreadPersistence = (
  options: {
    /**
     * How the factory is REACHED, not the factory itself: touching
     * `globalThis.indexedDB` is what throws `SecurityError` in a browser that
     * refuses storage, so the access has to be inside the guard.
     */
    readonly factory?: () => IDBFactory | undefined;
    readonly now?: () => number;
  } = {},
): ThreadPersistence => {
  const reachFactory = options.factory
    ?? (() => (globalThis as { indexedDB?: IDBFactory }).indexedDB);
  const now = options.now ?? (() => Date.now());
  /**
   * This instance, named on every row it writes.
   *
   * Per `createThreadPersistence()` -- so per page, not per browser: a tab that
   * reloads is a new writer and adopts a row the moment it rewrites it. What it
   * buys is the only thing a flush can honestly claim, that these eight rows are
   * MINE, and that is exactly the set it may remove from.
   */
  const writerId = `w-${Math.random().toString(36).slice(2)}-${String(Date.now())}`;
  /**
   * This device cannot keep anything, and asking again would only spend more
   * time to be told so. Set by every failure there is: no IndexedDB, storage
   * refused, a quota that is full, a database a newer build owns.
   */
  let disabled = false;
  let connection: Promise<IDBDatabase | null> | null = null;
  /**
   * Bumped every time the connection is let go -- by `close()`, by another tab
   * taking the version, by the browser closing it under us.
   *
   * An operation that started before one of those is holding a database that is
   * gone, and the `InvalidStateError` it gets back is a fact about THAT
   * connection, not about this browser's storage. Read at the start and checked
   * in the catch, it is what tells the two apart -- without it, a StrictMode
   * teardown (which reuses this same instance) could disable the device store
   * for the rest of the session.
   */
  let generation = 0;
  /**
   * What each conversation looked like when it was last written, BY IDENTITY.
   * The cache replaces an entry object whenever anything in it moves, so this
   * is what keeps a flush during a streaming turn to the one transcript that
   * actually changed rather than all eight.
   */
  const written = new Map<string, ThreadCacheEntry>();

  /** The connection is gone; the next call opens a new one. */
  const release = (): void => {
    connection = null;
    generation += 1;
  };

  const disable = (reason: string): void => {
    if (disabled) return;
    disabled = true;
    written.clear();
    // One line, once. A store that silently stops keeping anything is a
    // support question nobody can answer; this is what makes it answerable
    // without putting a failure the operator cannot act on in front of them.
    console.debug(`[mono-agent] on-device conversation store disabled: ${reason}`);
    const pending = connection;
    connection = null;
    void pending?.then((db) => db?.close()).catch(() => undefined);
  };

  /**
   * Whether these two entries would produce the very same row.
   *
   * Compared field by field rather than by entry identity, because `stale` and
   * `syncedAt` are the two things the device does NOT keep -- and `markAllStale`
   * replaces all eight entry objects on every app switch, which by identity
   * alone re-stripped and rewrote eight identical rows each time.
   */
  const describesSameRow = (
    previous: ThreadCacheEntry | undefined,
    entry: ThreadCacheEntry,
  ): boolean => previous !== undefined
    && previous.thread === entry.thread
    && previous.messages === entry.messages
    && previous.messagesNextCursor === entry.messagesNextCursor
    && previous.etag === entry.etag
    && previous.repairedToolCallIds === entry.repairedToolCallIds
    && previous.pagedInIds === entry.pagedInIds;

  /** The row this entry becomes on the device. */
  const rowFor = (entry: ThreadCacheEntry, savedAt: number): PersistedThread => {
    const transcript = stripCapabilityUrls(entry.messages);
    return {
      id: entry.thread.id,
      thread: entry.thread,
      messages: transcript.messages,
      ...(entry.messagesNextCursor === undefined
        ? {}
        : { messagesNextCursor: entry.messagesNextCursor }),
      // Only with the bytes it describes. See the file header.
      ...(entry.etag === undefined || transcript.stripped ? {} : { etag: entry.etag }),
      repairedToolCallIds: [...entry.repairedToolCallIds],
      pagedInIds: [...entry.pagedInIds],
      savedAt,
      writer: writerId,
    };
  };

  const open = (): Promise<IDBDatabase | null> => {
    if (disabled) return Promise.resolve(null);
    if (connection !== null) return connection;
    connection = new Promise<IDBDatabase | null>((resolve) => {
      // Whichever handler answers first owns this open. A blocked open that
      // later succeeds would otherwise hand back a connection nobody holds --
      // and that connection is exactly what blocks the next tab.
      let settledOpen = false;
      const answer = (db: IDBDatabase | null): void => {
        if (settledOpen) {
          db?.close();
          return;
        }
        settledOpen = true;
        resolve(db);
      };
      let request: IDBOpenDBRequest;
      try {
        const factory = reachFactory();
        if (factory === undefined || factory === null) {
          disable("this browser has no IndexedDB");
          answer(null);
          return;
        }
        request = factory.open(PERSISTENCE_DB_NAME, PERSISTENCE_DB_VERSION);
      } catch (openError) {
        disable(`opening it was refused (${String(openError)})`);
        answer(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        const upgrade = request.transaction;
        const threads = db.objectStoreNames.contains(THREAD_STORE)
          ? upgrade?.objectStore(THREAD_STORE)
          : db.createObjectStore(THREAD_STORE, { keyPath: "id" });
        // Rows written before version 2 carry no `writer` and so are absent
        // from this index: no instance owns them, and the hydration sweep is
        // what eventually takes them.
        if (threads !== undefined && !threads.indexNames.contains(WRITER_INDEX)) {
          threads.createIndex(WRITER_INDEX, "writer");
        }
        if (!db.objectStoreNames.contains(BUCKET_STORE)) {
          db.createObjectStore(BUCKET_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab (or a test) is deleting or upgrading this database. Hold
        // it open and the delete blocks forever; the next operation reopens.
        // What is on disk may be gone with it, so nothing may be assumed
        // written any more either.
        db.onversionchange = () => {
          db.close();
          release();
          written.clear();
        };
        db.onclose = () => {
          release();
          written.clear();
        };
        // Ownership survives both, because it lives on the rows rather than in
        // this instance: whatever this writer's name is still on is still its
        // to sweep, and a row another tab has taken over is that tab's now.
        answer(db);
      };
      // A version error (a database a newer build owns), storage that is not
      // there, a corrupt file: all the same answer.
      request.onerror = () => {
        disable(`it could not be opened (${String(request.error)})`);
        answer(null);
      };
      // Another connection is holding the version this open would replace.
      // Not a permanent failure: the next call opens again.
      request.onblocked = () => {
        release();
        answer(null);
      };
    });
    return connection;
  };

  return {
    hydrate: async () => {
      const heldGeneration = generation;
      const db = await open();
      if (db === null) return null;
      try {
        const transaction = db.transaction([THREAD_STORE, BUCKET_STORE, META_STORE], "readonly");
        // Every request issued before the first `await`: a transaction is only
        // alive while it has one outstanding, and reading them one at a time
        // would let it close under us.
        const meta = transaction.objectStore(META_STORE);
        const pending = [
          asPromise<unknown[]>(transaction.objectStore(THREAD_STORE).getAll()),
          asPromise<unknown[]>(transaction.objectStore(BUCKET_STORE).getAll()),
          asPromise<unknown>(meta.get(SNAPSHOT_KEY)),
          asPromise<unknown>(meta.get(HOST_KEY)),
        ] as const;
        const [threadRows, bucketRows, snapshotRow, hostRow] = await Promise.all(pending);
        const snapshot = readSnapshotRow(snapshotRow) ?? null;
        const threads = threadRows.flatMap((row) => {
          const entry = readThreadRow(row);
          return entry === undefined ? [] : [entry];
        });
        const buckets = bucketRows.flatMap((row) => {
          const bucket = readBucketRow(row);
          return bucket === undefined ? [] : [bucket];
        });
        // The janitor runs HERE, once per page, and never in a flush: it is a
        // statement about the whole store, and the only moment a tab has a
        // whole-store view is when it has just read one. Rows it takes are
        // dropped from what is handed back too, so the cache never restores a
        // conversation the device is about to stop keeping.
        const doomed = sweepableRows(threads, buckets, snapshot);
        if (doomed.threads.size > 0 || doomed.buckets.size > 0) {
          void discard(db, doomed).catch(() => undefined);
        }
        return {
          host: typeof hostRow === "string" ? hostRow : null,
          snapshot,
          buckets: buckets.filter((bucket) => !doomed.buckets.has(bucket.key)),
          threads: threads.filter((entry) => !doomed.threads.has(entry.id)),
        };
      } catch (readError) {
        // The connection was let go while this was out. Nothing is known about
        // the storage itself, so nothing is given up on.
        if (heldGeneration !== generation) return null;
        disable(`it could not be read (${String(readError)})`);
        return null;
      }
    },

    save: async (state) => {
      const heldGeneration = generation;
      const db = await open();
      if (db === null) return;
      // EVERYTHING below is inside the try, the row build included. Stripping a
      // transcript walks its parts and its attachments, and a row that reached
      // the cache malformed threw there -- outside any catch, as an unhandled
      // rejection, with persistence dead behind it.
      try {
        const savedAt = now();
        const transaction = db.transaction(
          [THREAD_STORE, BUCKET_STORE, META_STORE],
          "readwrite",
        );
        const threads = transaction.objectStore(THREAD_STORE);
        const heldIds = new Set(state.entries.map((entry) => entry.thread.id));
        const next = new Map<string, ThreadCacheEntry>();
        const wrote: string[] = [];
        // Both issued inside the same transaction as the writes, and answered by
        // their own callbacks rather than an `await`: nothing else may run in
        // between or the transaction commits without them. The whole flush is
        // decided in here, because what is already on the device is what decides
        // it. The index answers with primary keys only, so asking who owns what
        // costs nothing like reading the transcripts would.
        const keysRequest = threads.getAllKeys();
        const ownedRequest = threads.index(WRITER_INDEX).getAllKeys(writerId);
        let stored: Set<string> | undefined;
        let owned: Set<string> | undefined;
        const decide = (): void => {
          if (stored === undefined || owned === undefined) return;
          const stillStored = stored;
          // ONLY the rows carrying THIS writer's name. A flush is one tab's
          // statement about its own eight conversations, and it used to be read
          // as a statement about the whole store: a tab that had just hydrated
          // deleted whatever another tab was live in, and the two put each
          // other's conversations back for as long as both stayed open.
          for (const key of owned) {
            if (heldIds.has(key)) continue;
            threads.delete(key);
          }
          for (const entry of state.entries) {
            const id = entry.thread.id;
            // The skip FIRST, so a flush during a streaming turn does not walk
            // the seven transcripts that did not move -- but only while the row
            // is still THERE. Another owner of this database may have removed
            // it, and a tab that still holds the conversation is what puts it
            // back.
            if (describesSameRow(written.get(id), entry) && stillStored.has(id)) {
              next.set(id, entry);
              continue;
            }
            let row: PersistedThread;
            try {
              row = rowFor(entry, savedAt);
            } catch {
              // ONE conversation the device cannot represent -- a transcript
              // some other path put in the cache malformed. It is skipped, its
              // stored row (if any) is left alone because its id is still held,
              // and every other conversation is written. Deliberately not a
              // disable: this is a fact about one value, not about this
              // browser's storage.
              continue;
            }
            next.set(id, entry);
            wrote.push(id);
            threads.put(row);
          }
        };
        keysRequest.onsuccess = () => {
          stored = new Set(keysRequest.result.filter((key): key is string => typeof key === "string"));
          decide();
        };
        ownedRequest.onsuccess = () => {
          owned = new Set(ownedRequest.result.filter((key): key is string => typeof key === "string"));
          decide();
        };
        if (state.bucket !== undefined) {
          transaction.objectStore(BUCKET_STORE).put({ ...state.bucket, savedAt });
        }
        if (state.snapshot !== undefined) {
          const meta = transaction.objectStore(META_STORE);
          meta.put({ ...state.snapshot, savedAt }, SNAPSHOT_KEY);
          meta.put(state.snapshot.console.hostName, HOST_KEY);
        }
        await settled(transaction);
        // Only after it committed. Ownership itself is on the rows; this is the
        // per-instance record of what has been written, which is what keeps a
        // flush during a streaming turn to the one transcript that moved.
        void wrote;
        written.clear();
        for (const [id, entry] of next) written.set(id, entry);
      } catch (writeError) {
        // The connection was let go while this flush was in flight -- a
        // teardown, or another tab taking the version. This flush is simply
        // skipped; the next one opens again.
        if (heldGeneration !== generation) return;
        // A full quota, a database that went away, a value the browser refused
        // to clone. What is already stored stays stored -- it is a valid, older
        // copy, and every restored entry is read conditionally anyway -- and
        // this tab stops writing rather than retrying into the same wall.
        disable(`a write was refused (${String(writeError)})`);
      }
    },

    forget: async (threadIds) => {
      const ids = [...new Set(threadIds)].filter((id) => id.length > 0);
      if (ids.length === 0) return;
      for (const id of ids) written.delete(id);
      const heldGeneration = generation;
      const db = await open();
      if (db === null) return;
      try {
        const transaction = db.transaction([THREAD_STORE], "readwrite");
        const threads = transaction.objectStore(THREAD_STORE);
        for (const id of ids) threads.delete(id);
        await settled(transaction);
      } catch (forgetError) {
        if (heldGeneration !== generation) return;
        disable(`a delete was refused (${String(forgetError)})`);
      }
    },

    markPersisted: (entries) => {
      // KNOWN, not owned. These rows are byte-identical to what is stored, so
      // the next flush has nothing to write for them -- but they were written
      // by whoever wrote them, and this instance takes a row over only by
      // rewriting it. A restored conversation this tab then drops without ever
      // changing is left where it is and swept by age, not by this tab.
      for (const entry of entries) written.set(entry.thread.id, entry);
    },

    close: () => {
      const pending = connection;
      // Deliberately NOT `disable`, and `written` is deliberately kept: the
      // rows are still on disk and still exactly these entries. Only the
      // connection goes -- and the bump is what stops an operation that was
      // holding it from reading its own failure as this browser's.
      release();
      void pending?.then((db) => db?.close()).catch(() => undefined);
    },

    clearAll: async () => {
      const heldGeneration = generation;
      const db = await open();
      if (db === null) return;
      // BEFORE the transaction, not after it. A flush that starts while this
      // one is committing would otherwise skip every entry it believes is
      // already stored -- and this is about to delete exactly those rows.
      // Whole-store on purpose: "Clear cached data" means this BROWSER is not
      // keeping conversations, not that this tab has stopped.
      written.clear();
      try {
        const transaction = db.transaction(
          [THREAD_STORE, BUCKET_STORE, META_STORE],
          "readwrite",
        );
        transaction.objectStore(THREAD_STORE).clear();
        transaction.objectStore(BUCKET_STORE).clear();
        transaction.objectStore(META_STORE).clear();
        await settled(transaction);
      } catch (clearError) {
        if (heldGeneration !== generation) return;
        disable(`it could not be cleared (${String(clearError)})`);
      }
    },
  };
};
