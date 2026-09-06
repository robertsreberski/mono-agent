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
export const PERSISTENCE_DB_VERSION = 1;

const THREAD_STORE = "threads";
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
  /**
   * The rows THIS instance has put, and so the only ones it may sweep.
   *
   * Every browser tab on this origin owns the same database, and a flush is one
   * tab's statement about its own eight conversations -- never about the store.
   * Read as the latter, two tabs deleted each other's rows on every flush.
   */
  const mine = new Set<string>();

  /** The connection is gone; the next call opens a new one. */
  const release = (): void => {
    connection = null;
    generation += 1;
  };

  const disable = (reason: string): void => {
    if (disabled) return;
    disabled = true;
    written.clear();
    mine.clear();
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
        if (!db.objectStoreNames.contains(THREAD_STORE)) {
          db.createObjectStore(THREAD_STORE, { keyPath: "id" });
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
        // `mine` deliberately survives both: the rows are still this instance's
        // to sweep, and a row another owner has since replaced is put back by
        // whichever tab still holds that conversation.
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
        // OWNED from here, whatever becomes of them. The device can hold more
        // than one tab's eight, a restore keeps only what the cache has room
        // for, and a hydration that answered too late is dropped without
        // restoring anything -- and a row no instance owns is a row nothing can
        // ever sweep. Claimed before any of those paths can drop it, so the
        // first flush removes what this tab read and does not hold. A row
        // another live tab is holding comes back through the absent-key path in
        // `save`, which is the convergence this store already relies on.
        for (const row of threadRows) {
          if (isRecord(row) && typeof row.id === "string") mine.add(row.id);
        }
        return {
          host: typeof hostRow === "string" ? hostRow : null,
          snapshot: readSnapshotRow(snapshotRow) ?? null,
          buckets: bucketRows.flatMap((row) => {
            const bucket = readBucketRow(row);
            return bucket === undefined ? [] : [bucket];
          }),
          threads: threadRows.flatMap((row) => {
            const entry = readThreadRow(row);
            return entry === undefined ? [] : [entry];
          }),
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
        const swept: string[] = [];
        // Issued inside the same transaction as the writes, and answered by its
        // own callback rather than an `await`: nothing else may run in between
        // or the transaction commits without them. The whole flush is decided
        // in here, because what is already on the device is what decides it.
        const keys = threads.getAllKeys();
        keys.onsuccess = () => {
          const stored = new Set(
            keys.result.filter((key): key is string => typeof key === "string"),
          );
          // ONLY what this instance wrote. A flush is one tab's statement about
          // its own eight conversations, and it used to be read as a statement
          // about the whole store: two tabs each deleted the other's rows,
          // skipped rewriting their own (the skip is per instance), and emptied
          // the device between them.
          for (const key of mine) {
            if (heldIds.has(key)) continue;
            threads.delete(key);
            swept.push(key);
          }
          for (const entry of state.entries) {
            const id = entry.thread.id;
            // The skip FIRST, so a flush during a streaming turn does not walk
            // the seven transcripts that did not move -- but only while the row
            // is still THERE. Another owner of this database may have removed
            // it, and a tab that still holds the conversation is what puts it
            // back.
            if (describesSameRow(written.get(id), entry) && stored.has(id)) {
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
        if (state.bucket !== undefined) {
          transaction.objectStore(BUCKET_STORE).put({ ...state.bucket, savedAt });
        }
        if (state.snapshot !== undefined) {
          const meta = transaction.objectStore(META_STORE);
          meta.put({ ...state.snapshot, savedAt }, SNAPSHOT_KEY);
          meta.put(state.snapshot.console.hostName, HOST_KEY);
        }
        await settled(transaction);
        // Only after it committed: what this instance owns on the device is
        // what actually landed there.
        for (const id of swept) mine.delete(id);
        for (const id of wrote) mine.add(id);
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

    markPersisted: (entries) => {
      for (const entry of entries) {
        const id = entry.thread.id;
        written.set(id, entry);
        // And OWNED, not merely known: a conversation this tab restored and
        // then dropped -- a tombstone, an eviction -- is one whose row it has
        // to take with it. A row another tab is still holding is put back by
        // that tab on its next flush.
        mine.add(id);
      }
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
      mine.clear();
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
