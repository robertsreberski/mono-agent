import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, thread, uploadLimits } from "./test/fixtures";
import type { ThreadCacheEntry } from "./thread-cache";
import {
  createThreadPersistence,
  PERSISTED_THREAD_LIMIT,
  PERSISTENCE_DB_NAME,
  PERSISTENCE_DB_VERSION,
  stripCapabilityUrls,
  type PersistedSnapshot,
} from "./thread-persistence";
import type { ConsoleIdentity, MessagePart, PushBootstrap, WebMessage } from "./types";

const consoleIdentity: ConsoleIdentity = { hostName: "kitchen", theme: "evergreen" };
const push: PushBootstrap = {
  applicationServerKey: "B".repeat(87),
  keyFingerprint: "fingerprint",
  serviceWorkerVersion: 2,
};

const snapshot = (identity: ConsoleIdentity = consoleIdentity): PersistedSnapshot => ({
  agents: [agent("alpha")],
  console: identity,
  limits: uploadLimits,
  push,
});

const message = (id: string, parts: readonly MessagePart[] = [{ type: "text", text: id }]): WebMessage => ({
  id,
  threadId: "alpha-thread",
  role: "assistant",
  parts,
  attachments: [],
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
  status: "complete",
  seq: 3,
});

const entry = (id: string, overrides: Partial<ThreadCacheEntry> = {}): ThreadCacheEntry => ({
  thread: thread(id, "alpha"),
  messages: [message(`${id}-message`)],
  stale: false,
  syncedAt: 10,
  repairedToolCallIds: new Set<string>(),
  pagedInIds: new Set<string>(),
  ...overrides,
});

const deleteDatabase = (): Promise<void> => new Promise((resolve) => {
  const request = indexedDB.deleteDatabase(PERSISTENCE_DB_NAME);
  request.onsuccess = () => resolve();
  request.onerror = () => resolve();
  request.onblocked = () => resolve();
});

describe("createThreadPersistence", () => {
  beforeEach(async () => {
    await deleteDatabase();
  });

  it("takes over a database a previous build wrote at version 1", async () => {
    // The upgrade is the one path no other case exercises: every other test
    // starts from an empty database and creates version 2 outright. A phone
    // that had this console installed before this build has real rows in a real
    // version-1 store, written with no `writer` and with no index to put them
    // in, and a failure here does not degrade -- `disable()` takes the whole
    // device store down for the session.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(PERSISTENCE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("threads", { keyPath: "id" });
        db.createObjectStore("buckets", { keyPath: "key" });
        db.createObjectStore("meta");
      };
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(["threads", "buckets", "meta"], "readwrite");
        // Exactly the shape version 1 wrote: no `writer` anywhere.
        transaction.objectStore("threads").put({
          id: "legacy-thread",
          thread: thread("legacy-thread", "alpha"),
          messages: [message("legacy-message")],
          repairedToolCallIds: [],
          pagedInIds: [],
          savedAt: 1_000,
        });
        transaction.objectStore("buckets").put({
          key: "alpha\u0000active",
          threads: [thread("legacy-thread", "alpha")],
          nextCursor: null,
          savedAt: 1_000,
        });
        const meta = transaction.objectStore("meta");
        meta.put({ ...snapshot(), savedAt: 1_000 }, "agents");
        meta.put("kitchen", "host");
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error ?? new Error("seed failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("seed aborted"));
      };
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    // Stamped like the rows already there, so the age sweep has nothing to say
    // about this and the upgrade is the only thing under test.
    const store = createThreadPersistence({ now: () => 1_000 });
    const restored = await store.hydrate();

    // Everything the old build wrote is still there and still usable.
    expect(restored?.host).toBe("kitchen");
    expect(restored?.snapshot?.console.hostName).toBe("kitchen");
    expect(restored?.threads.map((row) => row.id)).toEqual(["legacy-thread"]);
    expect(restored?.threads[0]?.messages.map((row) => row.id)).toEqual(["legacy-message"]);
    expect(restored?.buckets.map((row) => row.key)).toEqual(["alpha\u0000active"]);
    expect(restored?.threads[0]?.writer).toBeUndefined();

    // And the index the upgrade added really works: this instance writes its
    // own conversation, sweeps it when it stops holding it, and leaves the
    // writer-less row -- which belongs to nobody -- exactly where it is.
    await store.save({ entries: [entry("alpha-thread"), entry("beta-thread")] });
    await store.save({ entries: [entry("alpha-thread")] });

    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id).sort())
      .toEqual(["alpha-thread", "legacy-thread"]);
    // Nothing about any of that disabled the device store.
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });

  it("hands back the conversations it was given, with their cursors and validators", async () => {
    const writer = createThreadPersistence({ now: () => 1_000 });
    await writer.save({
      entries: [
        entry("alpha-thread", {
          messagesNextCursor: "cursor-older",
          etag: 'W/"alpha-1"',
          repairedToolCallIds: new Set(["call-1"]),
          pagedInIds: new Set(["alpha-thread-message"]),
        }),
        entry("beta-thread"),
      ],
      snapshot: snapshot(),
      bucket: { key: "alpha\0active", threads: [thread("alpha-thread", "alpha")], nextCursor: "page-2" },
    });

    const restored = await createThreadPersistence().hydrate();

    expect(restored?.host).toBe("kitchen");
    expect(restored?.snapshot?.agents.map((item) => item.sourceId)).toEqual(["alpha"]);
    expect(restored?.snapshot?.console).toEqual(consoleIdentity);
    expect(restored?.snapshot?.limits).toEqual(uploadLimits);
    expect(restored?.snapshot?.push).toEqual(push);
    expect(restored?.buckets).toEqual([{
      key: "alpha\0active",
      threads: [thread("alpha-thread", "alpha")],
      nextCursor: "page-2",
      savedAt: 1_000,
    }]);
    const alpha = restored?.threads.find((item) => item.id === "alpha-thread");
    expect(restored?.threads.map((item) => item.id).sort()).toEqual(["alpha-thread", "beta-thread"]);
    expect(alpha?.messages.map((item) => item.id)).toEqual(["alpha-thread-message"]);
    expect(alpha?.messagesNextCursor).toBe("cursor-older");
    expect(alpha?.etag).toBe('W/"alpha-1"');
    expect(alpha?.repairedToolCallIds).toEqual(["call-1"]);
    expect(alpha?.pagedInIds).toEqual(["alpha-thread-message"]);
    expect(alpha?.savedAt).toBe(1_000);
  });

  it("does not sweep away the conversations another tab is keeping", async () => {
    // Two tabs, each flushing its own eight. The sweep was a WHOLE-STORE
    // statement while the write-skip was per instance, so each tab deleted the
    // other's rows and then skipped rewriting its own -- alternating saves
    // emptied the device between them.
    const tabA = createThreadPersistence();
    const tabB = createThreadPersistence();
    // The same entry OBJECTS each time, which is what the cache hands a tab
    // that has not changed the conversation.
    const alpha = entry("alpha-thread");
    const beta = entry("beta-thread");

    await tabA.save({ entries: [alpha] });
    await tabB.save({ entries: [beta] });
    await tabA.save({ entries: [alpha] });
    await tabB.save({ entries: [beta] });

    const restored = await createThreadPersistence().hydrate();
    expect(restored?.threads.map((row) => row.id).sort())
      .toEqual(["alpha-thread", "beta-thread"]);
  });

  it("never removes a row another tab is live in", async () => {
    // A hydration reads the WHOLE store, and the sweep used to be scoped to
    // what it had read: a tab opened second deleted the conversation the first
    // one was live in, that tab put it back on its next flush, and the two did
    // that to each other for as long as both stayed open.
    //
    // The row says who wrote it now, and a flush removes only rows carrying
    // this instance's own name.
    const tabB = createThreadPersistence();
    await tabB.save({ entries: [entry("beta-thread")] });

    const tabA = createThreadPersistence();
    await tabA.hydrate();
    await tabA.save({ entries: [entry("alpha-thread")] });
    await tabA.save({ entries: [entry("alpha-thread")] });

    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id).sort())
      .toEqual(["alpha-thread", "beta-thread"]);
  });

  it("still takes its own conversation off the device when it stops holding it", async () => {
    // The other half of the same rule: a row this instance WROTE is its own to
    // remove, so an eviction still reaches the device.
    const store = createThreadPersistence();
    await store.save({ entries: [entry("alpha-thread"), entry("beta-thread")] });

    await store.save({ entries: [entry("alpha-thread")] });

    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id))
      .toEqual(["alpha-thread"]);
  });

  it("puts back a held conversation whose row went away under it", async () => {
    const store = createThreadPersistence({ now: () => 1_000 });
    const alpha = entry("alpha-thread");
    await store.save({ entries: [alpha] });

    // Another owner of the same database removed it. The write-skip is a
    // statement about what THIS instance wrote, and it is only good while the
    // row is still there.
    await createThreadPersistence().clearAll();

    await store.save({ entries: [alpha] });
    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id))
      .toEqual(["alpha-thread"]);
  });

  it("leaves a row it did not write, and keeps the store under a ceiling anyway", async () => {
    // The device can hold more than one tab's eight, and a flush cannot tell
    // this tab's own eviction from another tab's live conversation -- so rows
    // this instance did not write are not its to remove, and the ceiling is
    // what keeps that from growing without a bound. Oldest first, because the
    // most recently written row is the one a live tab most likely still holds.
    const older = createThreadPersistence({ now: () => 1_000 });
    await older.save({
      entries: Array.from({ length: 20 }, (_, index) => entry(`old-${String(index)}`)),
    });
    const newer = createThreadPersistence({ now: () => 2_000 });
    await newer.save({
      entries: Array.from({ length: 8 }, (_, index) => entry(`new-${String(index)}`)),
    });

    const restored = await createThreadPersistence().hydrate();

    expect(restored?.threads).toHaveLength(PERSISTED_THREAD_LIMIT);
    // Everything the newer flush wrote survived; the ceiling came out of the
    // older ones.
    expect(restored?.threads.filter((row) => row.id.startsWith("new-"))).toHaveLength(8);
    // And it really left the device, rather than merely being withheld.
    expect((await createThreadPersistence().hydrate())?.threads).toHaveLength(PERSISTED_THREAD_LIMIT);
  });

  it("takes a deleted conversation off the device whoever wrote its row", async () => {
    // The one removal that is not an inference. A sweep asks "does this tab
    // still hold it", which cannot distinguish an eviction from another tab's
    // live conversation; a tombstone is the operator saying the conversation
    // should stop existing, so its row goes even though this instance never
    // wrote it.
    const writer = createThreadPersistence();
    await writer.save({ entries: [entry("alpha-thread"), entry("beta-thread")] });

    const reader = createThreadPersistence();
    await reader.hydrate();
    await reader.forget(["beta-thread"]);

    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id))
      .toEqual(["alpha-thread"]);
  });

  it("forgets nothing when it is asked about nothing", async () => {
    const writer = createThreadPersistence();
    await writer.save({ entries: [entry("alpha-thread")] });

    await writer.forget([]);
    await writer.forget(["never-stored"]);

    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id))
      .toEqual(["alpha-thread"]);
  });

  it("stops keeping a listing for an agent this console no longer has", async () => {
    // Nothing but "Clear cached data" ever removed a bucket row, so an agent
    // taken out of the fleet left its listing on every phone that had opened
    // it, for ever.
    const store = createThreadPersistence();
    await store.save({
      entries: [],
      snapshot: snapshot(),
      bucket: { key: "alpha\u0000active", threads: [], nextCursor: null },
    });
    await store.save({
      entries: [],
      bucket: { key: "retired\u0000active", threads: [], nextCursor: null },
    });

    const restored = await createThreadPersistence().hydrate();

    expect(restored?.buckets.map((bucket) => bucket.key)).toEqual(["alpha\u0000active"]);
    expect((await createThreadPersistence().hydrate())?.buckets.map((bucket) => bucket.key))
      .toEqual(["alpha\u0000active"]);
  });

  it("clears the whole device when the operator asks, whichever tab asked", async () => {
    // Deliberately NOT instance-scoped: "Clear cached data" means this browser
    // is not keeping conversations, not "this tab is not".
    const tabA = createThreadPersistence();
    const tabB = createThreadPersistence();
    await tabA.save({ entries: [entry("alpha-thread")], snapshot: snapshot() });
    await tabB.save({ entries: [entry("beta-thread")] });

    await tabA.clearAll();

    expect(await createThreadPersistence().hydrate())
      .toEqual({ host: null, snapshot: null, buckets: [], threads: [] });
  });

  it("drops the row for a conversation the cache stopped holding", async () => {
    const store = createThreadPersistence();
    await store.save({ entries: [entry("alpha-thread"), entry("beta-thread")] });
    await store.save({ entries: [entry("alpha-thread")] });

    const restored = await createThreadPersistence().hydrate();
    expect(restored?.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
  });

  it("empties the device when the operator clears it", async () => {
    const store = createThreadPersistence();
    await store.save({
      entries: [entry("alpha-thread")],
      snapshot: snapshot(),
      bucket: { key: "alpha\0active", threads: [], nextCursor: null },
    });

    await store.clearAll();

    const restored = await createThreadPersistence().hydrate();
    expect(restored).toEqual({ host: null, snapshot: null, buckets: [], threads: [] });
  });

  it("names the console that wrote what is stored", async () => {
    const store = createThreadPersistence();
    await store.save({ entries: [], snapshot: snapshot({ hostName: "studio", theme: "ocean" }) });

    expect((await createThreadPersistence().hydrate())?.host).toBe("studio");
  });

  it("writes no capability URL, and keeps no validator for a transcript it had to strip", async () => {
    const attachmentPart: MessagePart = {
      type: "attachment",
      id: "part-1",
      artifactId: "artifact-1",
      name: "shot.png",
      mediaType: "image/png",
      sizeBytes: 12,
      integrityId: "integrity-1",
      storedUrl: "/api/v1/uploads/upload-1/content",
      contentUrl: "/api/v1/replies/attachment/part-1/content?token=secret",
    };
    const appPart: MessagePart = {
      type: "mcp_app",
      id: "app-1",
      invocationId: "invocation-1",
      connectionId: "connection-1",
      serverName: "server",
      toolName: "tool",
      resourceUri: "ui://app",
      mediaType: "text/html;profile=mcp-app",
      protocolVersion: "2026-01-26",
      resourceUrl: "/api/v1/replies/mcp_app/app-1/resource?token=secret",
      bridgeUrl: "/api/v1/replies/mcp_app/app-1/bridge?token=secret",
    };
    const store = createThreadPersistence();
    await store.save({
      entries: [
        entry("alpha-thread", {
          etag: 'W/"alpha-1"',
          messages: [{
            ...message("rich", [attachmentPart, appPart]),
            attachments: [{
              id: "upload-1",
              name: "shot.png",
              contentType: "image/png",
              sizeBytes: 12,
              kind: "image",
              status: "committed",
              uploaded: true,
              createdAt: "2026-09-01T10:00:00.000Z",
              contentUrl: "/api/v1/uploads/upload-1/content?token=secret",
            }],
          }],
        }),
        entry("beta-thread", { etag: 'W/"beta-1"' }),
      ],
    });

    const restored = await createThreadPersistence().hydrate();
    const alpha = restored?.threads.find((item) => item.id === "alpha-thread");
    const written = JSON.stringify(alpha);

    expect(written).not.toContain("token=secret");
    expect(alpha?.messages[0]?.parts[0]).toEqual({ ...attachmentPart, contentUrl: undefined });
    expect(alpha?.messages[0]?.parts[1]).toEqual({
      ...appPart,
      resourceUrl: undefined,
      bridgeUrl: undefined,
    });
    // The validator describes the answer the server served, capability URLs and
    // all. This copy is not that answer any more, so a 304 must not be able to
    // confirm it.
    expect(alpha?.etag).toBeUndefined();
    expect(restored?.threads.find((item) => item.id === "beta-thread")?.etag).toBe('W/"beta-1"');
  });

  it("skips a row it cannot read rather than failing the whole hydration", async () => {
    const store = createThreadPersistence();
    await store.save({ entries: [entry("alpha-thread")] });
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(PERSISTENCE_DB_NAME);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("threads", "readwrite");
        tx.objectStore("threads").put({ id: "broken", messages: "not a transcript" });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });

    const restored = await createThreadPersistence().hydrate();
    expect(restored?.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
  });

  it("skips a summary the sidebar could not draw", async () => {
    const store = createThreadPersistence();
    await store.save({ entries: [entry("alpha-thread")] });
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(PERSISTENCE_DB_NAME);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("threads", "readwrite");
        // Everything a row needs EXCEPT the run state every row and the chat
        // header read unconditionally.
        const { runState: _runState, ...withoutRunState } = thread("no-run-state", "alpha");
        tx.objectStore("threads").put({
          id: "no-run-state",
          thread: withoutRunState,
          messages: [],
          repairedToolCallIds: [],
          pagedInIds: [],
          savedAt: 1,
        });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });

    const restored = await createThreadPersistence().hydrate();
    expect(restored?.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
  });

  it("skips a row whose messages are the wrong shape, however well-formed the row is", async () => {
    // The row that mattered: a well-formed ARRAY of malformed messages. It used
    // to pass the "record with a string id" check, restore into the cache, and
    // make the next flush throw a `TypeError` out of the strip walk -- an
    // unhandled rejection with persistence dead behind it.
    const store = createThreadPersistence();
    await store.save({ entries: [entry("alpha-thread")] });
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(PERSISTENCE_DB_NAME);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("threads", "readwrite");
        tx.objectStore("threads").put({
          id: "half-written",
          thread: thread("half-written", "alpha"),
          messages: [{ id: "m1" }],
          repairedToolCallIds: [],
          pagedInIds: [],
          savedAt: 1,
        });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });

    const restored = await createThreadPersistence().hydrate();
    expect(restored?.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
  });

  it("never throws out of a save, whatever the cache hands it", async () => {
    // The row build -- the strip walk above all -- used to run OUTSIDE the try,
    // so one malformed message anywhere in the cache became an unhandled
    // rejection and killed persistence for the session.
    const store = createThreadPersistence();
    const malformed = entry("alpha-thread", {
      messages: [{ id: "m1" } as unknown as WebMessage],
    });

    await expect(store.save({ entries: [malformed] })).resolves.toBeUndefined();
    // And it stays usable for everything else rather than dying silently.
    await expect(store.hydrate()).resolves.not.toBeNull();
  });

  it("writes nothing when only the suspicion about a conversation changed", async () => {
    // `markAllStale` replaces all eight entry OBJECTS on every app switch, and
    // `stale`/`syncedAt` are the two things the device does not keep -- so by
    // entry identity alone every switch re-stripped and rewrote eight identical
    // transcripts.
    let clock = 1_000;
    const store = createThreadPersistence({ now: () => clock });
    const alpha = entry("alpha-thread");
    await store.save({ entries: [alpha] });

    clock = 2_000;
    await store.save({ entries: [{ ...alpha, stale: true, syncedAt: 42 }] });

    expect((await createThreadPersistence().hydrate())?.threads[0]?.savedAt).toBe(1_000);

    // And a real change still lands.
    clock = 3_000;
    await store.save({ entries: [{ ...alpha, messages: [message("later")] }] });
    expect((await createThreadPersistence().hydrate())?.threads[0]?.savedAt).toBe(3_000);
  });

  it("writes nothing for the rows it just handed back", async () => {
    const writer = createThreadPersistence({ now: () => 1_000 });
    const entries = [entry("alpha-thread"), entry("beta-thread")];
    await writer.save({ entries });

    const reader = createThreadPersistence({ now: () => 2_000 });
    const restored = await reader.hydrate();
    // What hydration handed back comes into the cache as NEW objects, so the
    // store has to be told they are the stored ones or every cold start
    // rewrites all eight transcripts a second later.
    reader.markPersisted(entries);
    await reader.save({ entries });

    expect(restored?.threads.every((row) => row.savedAt === 1_000)).toBe(true);
    const after = await createThreadPersistence().hydrate();
    expect(after?.threads.map((row) => row.savedAt)).toEqual([1_000, 1_000]);

    // What it restored is NOT its to sweep: the row still carries the writer
    // that put it there, and a flush cannot tell this tab's own eviction from
    // another tab's live conversation. Dropping one leaves its row where it is,
    // for that writer or for the ceiling; removing it takes {@link forget}.
    await reader.save({ entries: [entries[0]!] });
    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id).sort())
      .toEqual(["alpha-thread", "beta-thread"]);
    await reader.forget(["beta-thread"]);
    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id))
      .toEqual(["alpha-thread"]);
  });

  it("reopens after the connection is let go", async () => {
    const store = createThreadPersistence();
    await store.save({ entries: [entry("alpha-thread")] });

    store.close();

    // NOT a disable: closing is how another tab's delete stops being blocked.
    await expect(store.hydrate()).resolves.not.toBeNull();
    await store.save({ entries: [entry("alpha-thread"), entry("beta-thread")] });
    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id).sort())
      .toEqual(["alpha-thread", "beta-thread"]);
  });

  it("skips a flush whose connection was let go, rather than giving up on the device", async () => {
    // A flush holding a connection that is being closed gets
    // `InvalidStateError` back. That is a fact about THAT connection -- and
    // StrictMode tears the provider down and sets it back up on the same
    // instance -- so reading it as "this browser cannot store anything" would
    // kill the device store for the rest of the session.
    let opens = 0;
    const factory = () => ({
      open: () => {
        opens += 1;
        const request: Record<string, unknown> = {
          result: {
            close: () => undefined,
            transaction: () => {
              throw new DOMException("The database connection is closing.", "InvalidStateError");
            },
          },
          onsuccess: null,
          onerror: null,
          onblocked: null,
          onupgradeneeded: null,
        };
        setTimeout(() => (request.onsuccess as (() => void) | undefined)?.(), 5);
        return request as unknown as IDBOpenDBRequest;
      },
    }) as unknown as IDBFactory;
    const store = createThreadPersistence({ factory });

    const flush = store.save({ entries: [entry("alpha-thread")] });
    // While the open is still out, which is the only way to be holding a
    // connection nobody owns any more.
    store.close();
    await expect(flush).resolves.toBeUndefined();

    // Not disabled: the next call opens again rather than short-circuiting.
    expect(opens).toBe(1);
    await store.hydrate();
    expect(opens).toBe(2);
  });

  it("lets go of the database when another tab needs the version", async () => {
    const store = createThreadPersistence();
    await store.save({ entries: [entry("alpha-thread")] });

    // A delete from "another tab" is blocked by any open connection, so this
    // resolves only because the store answers `versionchange` by closing.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(PERSISTENCE_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error("delete failed"));
      request.onblocked = () => reject(new Error("delete stayed blocked"));
    });

    // And the store reopens rather than being dead: what it holds now is what
    // this session writes.
    await store.save({ entries: [entry("beta-thread")] });
    expect((await createThreadPersistence().hydrate())?.threads.map((row) => row.id))
      .toEqual(["beta-thread"]);
  });

  it("works memory-only when an open is blocked, and closes the connection it is later given", async () => {
    let late: { result: unknown; onsuccess: (() => void) | null } | undefined;
    let closed = false;
    const factory = () => ({
      open: () => {
        const request: Record<string, unknown> = {
          result: { close: () => { closed = true; }, transaction: () => { throw new Error("unused"); } },
          onsuccess: null,
          onerror: null,
          onblocked: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => (request.onblocked as (() => void) | undefined)?.());
        late = request as unknown as { result: unknown; onsuccess: (() => void) | null };
        return request as unknown as IDBOpenDBRequest;
      },
    }) as unknown as IDBFactory;
    const store = createThreadPersistence({ factory });

    await expect(store.hydrate()).resolves.toBeNull();
    late?.onsuccess?.();

    // A blocked open that succeeds afterwards hands back a connection nobody
    // holds -- and that connection is exactly what blocks the next tab.
    expect(closed).toBe(true);
  });

  it("works memory-only against a database a newer build owns", async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(PERSISTENCE_DB_NAME, PERSISTENCE_DB_VERSION + 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("future"); };
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    const store = createThreadPersistence();

    await expect(store.hydrate()).resolves.toBeNull();
    await expect(store.save({ entries: [entry("alpha-thread")] })).resolves.toBeUndefined();
  });

  it("works memory-only when the browser has no IndexedDB at all", async () => {
    // One line, once, when it gives up. A store that silently stops keeping
    // anything is a support question nobody can answer.
    const said = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const injected = createThreadPersistence({ factory: () => undefined });

    await expect(injected.hydrate()).resolves.toBeNull();
    expect(said).toHaveBeenCalledTimes(1);
    expect(said.mock.calls[0]?.[0]).toContain("on-device conversation store disabled");
    said.mockRestore();
    await expect(injected.save({ entries: [entry("alpha-thread")], snapshot: snapshot() }))
      .resolves.toBeUndefined();
    await expect(injected.clearAll()).resolves.toBeUndefined();

    // And through the accessor the browser actually uses, which is the one that
    // is missing on the platforms this is written for.
    const real = globalThis.indexedDB;
    try {
      Reflect.deleteProperty(globalThis, "indexedDB");
      const store = createThreadPersistence();
      await expect(store.hydrate()).resolves.toBeNull();
      await expect(store.save({ entries: [entry("alpha-thread")] })).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: real });
    }
  });

  it("works memory-only when opening the database is refused", async () => {
    const injected = createThreadPersistence({
      factory: () => { throw new DOMException("Storage is not allowed here.", "SecurityError"); },
    });

    await expect(injected.hydrate()).resolves.toBeNull();
    await expect(injected.save({ entries: [entry("alpha-thread")] })).resolves.toBeUndefined();

    // Reaching the global is itself what throws in a browser that refuses
    // storage, so the guard has to be around the ACCESS, not around `open`.
    const real = globalThis.indexedDB;
    try {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
      });
      const store = createThreadPersistence();
      await expect(store.hydrate()).resolves.toBeNull();
      await expect(store.save({ entries: [entry("alpha-thread")] })).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: real });
    }
  });

  it("works memory-only when the database refuses a write", async () => {
    const refusing = {
      close: () => undefined,
      transaction: () => { throw new DOMException("Quota exceeded.", "QuotaExceededError"); },
    };
    const factory = () => ({
      open: () => {
        const request: Record<string, unknown> = { result: refusing };
        queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
        return request as unknown as IDBOpenDBRequest;
      },
    }) as unknown as IDBFactory;
    const store = createThreadPersistence({ factory });

    await expect(store.save({ entries: [entry("alpha-thread")] })).resolves.toBeUndefined();
    await expect(store.hydrate()).resolves.toBeNull();
  });
});

describe("stripCapabilityUrls", () => {
  it("hands back the very transcript it was given when there is nothing to strip", () => {
    const messages = [message("plain")];
    const stripped = stripCapabilityUrls(messages);

    expect(stripped.messages).toBe(messages);
    expect(stripped.stripped).toBe(false);
  });
});
