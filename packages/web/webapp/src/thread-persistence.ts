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
   * Every conversation the cache is keeping -- at most its LRU's eight. Rows
   * for anything absent are deleted, which is how an eviction, a removal and a
   * tombstone all reach the device without any of them having to say so.
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

const isSummary = (value: unknown): value is ThreadSummary =>
  isRecord(value) && typeof value.id === "string" && typeof value.sourceId === "string";

const stringsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

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
  if (!Array.isArray(value.messages)) return undefined;
  if (!value.messages.every((message) => isRecord(message) && typeof message.id === "string")) {
    return undefined;
  }
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
   * What each conversation looked like when it was last written, BY IDENTITY.
   * The cache replaces an entry object whenever anything in it moves, so this
   * is what keeps a flush during a streaming turn to the one transcript that
   * actually changed rather than all eight.
   */
  const written = new Map<string, ThreadCacheEntry>();

  const disable = (): void => {
    disabled = true;
    written.clear();
    const pending = connection;
    connection = null;
    void pending?.then((db) => db?.close()).catch(() => undefined);
  };

  const open = (): Promise<IDBDatabase | null> => {
    if (disabled) return Promise.resolve(null);
    if (connection !== null) return connection;
    connection = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        const factory = reachFactory();
        if (factory === undefined || factory === null) {
          disabled = true;
          resolve(null);
          return;
        }
        request = factory.open(PERSISTENCE_DB_NAME, PERSISTENCE_DB_VERSION);
      } catch {
        disabled = true;
        resolve(null);
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
        db.onversionchange = () => {
          db.close();
          connection = null;
          written.clear();
        };
        db.onclose = () => {
          connection = null;
          written.clear();
        };
        resolve(db);
      };
      // A version error (a database a newer build owns), storage that is not
      // there, a corrupt file: all the same answer.
      request.onerror = () => {
        disabled = true;
        resolve(null);
      };
      request.onblocked = () => {
        connection = null;
        resolve(null);
      };
    });
    return connection;
  };

  return {
    hydrate: async () => {
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
      } catch {
        disable();
        return null;
      }
    },

    save: async (state) => {
      const db = await open();
      if (db === null) return;
      const savedAt = now();
      const rows = state.entries.map((entry) => {
        const transcript = stripCapabilityUrls(entry.messages);
        return {
          entry,
          row: {
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
          } satisfies PersistedThread,
        };
      });
      try {
        const transaction = db.transaction(
          [THREAD_STORE, BUCKET_STORE, META_STORE],
          "readwrite",
        );
        const threads = transaction.objectStore(THREAD_STORE);
        const held = new Set(rows.map(({ row }) => row.id));
        // Issued inside the same transaction as the writes, and answered by its
        // own callback rather than an `await`: nothing else may run in between
        // or the transaction commits without the deletes.
        const keys = threads.getAllKeys();
        keys.onsuccess = () => {
          for (const key of keys.result) {
            if (typeof key === "string" && !held.has(key)) threads.delete(key);
          }
        };
        for (const { entry, row } of rows) {
          if (written.get(row.id) === entry) continue;
          threads.put(row);
        }
        if (state.bucket !== undefined) {
          transaction.objectStore(BUCKET_STORE).put({ ...state.bucket, savedAt });
        }
        if (state.snapshot !== undefined) {
          const meta = transaction.objectStore(META_STORE);
          meta.put({ ...state.snapshot, savedAt }, SNAPSHOT_KEY);
          meta.put(state.snapshot.console.hostName, HOST_KEY);
        }
        await settled(transaction);
        written.clear();
        for (const { entry, row } of rows) written.set(row.id, entry);
      } catch {
        // A full quota, a database that went away, a value the browser refused
        // to clone. What is already stored stays stored -- it is a valid, older
        // copy, and every restored entry is read conditionally anyway -- and
        // this tab stops writing rather than retrying into the same wall.
        disable();
      }
    },

    clearAll: async () => {
      const db = await open();
      if (db === null) return;
      try {
        const transaction = db.transaction(
          [THREAD_STORE, BUCKET_STORE, META_STORE],
          "readwrite",
        );
        transaction.objectStore(THREAD_STORE).clear();
        transaction.objectStore(BUCKET_STORE).clear();
        transaction.objectStore(META_STORE).clear();
        await settled(transaction);
        written.clear();
      } catch {
        disable();
      }
    },
  };
};
