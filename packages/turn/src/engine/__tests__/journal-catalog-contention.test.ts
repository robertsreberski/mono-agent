import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JournalLocks } from "../journal-lock.js";
import { JsonlSessionRepo } from "../session-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "catalog-contention-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const session = await repo.create({ id: "fictional-session" }), metadata = session.metadata;
  await session.close();
  const locks = await repo.ensureDirectory();
  return { repo, locks, metadata };
}

it("opens a non-waiting journal after short catalogue contention", async () => {
  const { repo, locks, metadata } = await fixture();
  const held = (await locks.tryLock(locks.catalogPath))!;
  const attempt = locks.tryLock.bind(locks); let attempts = 0;
  vi.spyOn(locks, "tryLock").mockImplementation(async (path) => {
    // Two real SQLite busy results, then the other owner finishes its operation.
    if (path === locks.catalogPath && ++attempts === 3) held.release();
    return attempt(path);
  });
  try {
    const session = await repo.open(metadata, { repair: false, wait: false });
    try { expect(session.metadata.id).toBe(metadata.id); expect(attempts).toBe(3); }
    finally { await session.close(); }
  } finally { held.release(); }
});

it("bounds catalogue contention and preserves the foreign owner and lock files", async () => {
  const { repo, locks, metadata } = await fixture();
  const held = (await locks.tryLock(locks.catalogPath))!, before = await readdir(locks.directory);
  const attempt = vi.spyOn(locks, "tryLock");
  try {
    const started = performance.now();
    await expect(repo.open(metadata, { repair: false, wait: false })).rejects.toMatchObject({
      code: "ERR_HARNESS_WRITER_BUSY", retryable: true, message: expect.stringContaining("catalogue"),
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expect(attempt.mock.calls.length).toBeGreaterThan(1);
    expect(await locks.tryLock(locks.catalogPath)).toBeNull();
    expect(await readdir(locks.directory)).toEqual(before);
  } finally { held.release(); }
  const session = await repo.open(metadata, { repair: false, wait: false }); await session.close();
});

it("aborts a bounded catalogue wait promptly without releasing the foreign owner", async () => {
  const { repo, locks, metadata } = await fixture();
  const held = (await locks.tryLock(locks.catalogPath))!, controller = new AbortController();
  const reason = new Error("Fictional cancellation"), attempt = locks.tryLock.bind(locks);
  vi.spyOn(locks, "tryLock").mockImplementation(async (path) => {
    const lock = await attempt(path);
    if (path === locks.catalogPath && !lock) setImmediate(() => controller.abort(reason));
    return lock;
  });
  try {
    const opening = repo.open(metadata, { repair: false, wait: false, signal: controller.signal });
    // A non-abortable bounded sleep would hit this deadline instead of settling.
    await expect(Promise.race([opening, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Abort did not settle promptly")), 200); timer.unref();
    })])).rejects.toBe(reason);
    expect(await attempt(locks.catalogPath)).toBeNull();
  } finally { held.release(); }
  vi.restoreAllMocks();
  const session = await repo.open(metadata, { repair: false, wait: false }); await session.close();
});

it("keeps the storage catalogue probe immediate and never waits for a journal writer", async () => {
  const { locks, metadata } = await fixture();
  const catalog = (await locks.tryLock(locks.catalogPath))!, callback = vi.fn(async () => {});
  const attempt = vi.spyOn(locks, "tryLock");
  try {
    await expect(locks.withCatalog(callback, { wait: false })).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" });
    expect(attempt).toHaveBeenCalledTimes(1); expect(callback).not.toHaveBeenCalled();
  } finally { catalog.release(); }
  const writer = await locks.acquireWriter(metadata.journalId);
  attempt.mockClear();
  try {
    await expect(locks.acquireWriter(metadata.journalId, { wait: false })).rejects.toMatchObject({
      code: "ERR_HARNESS_WRITER_BUSY", retryable: true, message: expect.stringContaining("writer ownership"),
    });
    expect(attempt.mock.calls.map(([path]) => path)).toEqual([locks.catalogPath, writer.path]);
    expect(await locks.tryLock(writer.path)).toBeNull();
  } finally { writer.release(); }
});

it("does not attempt acquisition for an already aborted non-waiting writer", async () => {
  const { locks, metadata } = await fixture(), attempt = vi.spyOn(locks, "tryLock");
  const reason = new Error("Fictional pre-cancellation");
  await expect(locks.acquireWriter(metadata.journalId, { wait: false, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  expect(attempt).not.toHaveBeenCalled();
});
