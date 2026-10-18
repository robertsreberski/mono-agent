import type { Stats } from "node:fs";
// @ts-check
// Narrow port of agent-harness/durable-history's SQLite kernel-lock primitive.
// Catalogue acquisition and per-journal lock reclamation use the same mutex.
import { assertSupportedSessionsRoot } from "./sessions-root.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { assertIdentity, isOwned, sameIdentity as same, syncDir } from "./owned-fs-impl.js";

const fail = (): never => { throw new Error("Harness journal ownership unavailable"); };
const secure = (stat: Stats, directory: boolean = false) => { if (!isOwned(stat, directory)) fail(); };
/**
 * Abortable poll; a cancelled waiter rejects with its signal's reason.
 */
const pause = (signal: AbortSignal | undefined) => delay(10, undefined, signal && { signal }).catch(() => signal?.throwIfAborted());
const busy = (error: any) => (error as NodeJS.ErrnoException)?.code === "ERR_SQLITE_ERROR"
  && ((error as {errcode?: number}).errcode === 5 || (error as {errcode?: number}).errcode === 6);

/** Pinned root identity prevents a late writer recreating a quarantined/purged root. */
export class JournalLocks {
  declare root: any;
  declare identities: any;
  declare directory: string;
  declare catalogPath: string;

  constructor(root: any, identities: any) {
    this.root = root;
    this.identities = identities;
    this.directory = join(root, "locks");
    this.catalogPath = join(this.directory, "catalog.sqlite");
  }
  static async open(sessionsRoot: string, onRootPermissionsTightened: () => void = () => {}): Promise<JournalLocks> {
    const root = resolve(sessionsRoot);
    assertSupportedSessionsRoot(root);
    // Validate each existing parent under the supplied trust boundary before
    // creating its child; recursive mkdir would follow an existing symlink.
    const identities = new Map();
    for (const path of [root, join(root, "locks")]) {
      try { await mkdir(path, { mode: 0o700, recursive: path === root }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      let stat = await lstat(path);
      if (path === root && (stat.mode & 0o077) !== 0) {
        // Pi 0.99 created owned roots as 0755. Tighten only a non-writable
        // owned directory through a no-follow descriptor, never a swapped path.
        if (!stat.isDirectory() || (stat.mode & 0o022) !== 0
          || (process.getuid && stat.uid !== process.getuid())) fail();
        const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          if (!same(stat, await handle.stat())) fail();
          await handle.chmod(0o700); onRootPermissionsTightened(); await handle.sync();
          const current = await lstat(path); if (!same(stat, current)) fail(); stat = current;
        } finally { await handle.close(); }
      }
      secure(stat, true); identities.set(path, stat);
    }
    const locks = new JournalLocks(root, identities);
    await locks.ensureFile(locks.catalogPath);
    return locks;
  }
  async assertRoot(): Promise<void> {
    assertSupportedSessionsRoot(this.root);
    for (const [path, identity] of this.identities) await assertIdentity(path, identity, fail);
  }
  async syncDirectory(): Promise<void> {
    await this.assertRoot(); await syncDir(this.directory, undefined, fail); await this.assertRoot();
  }
  async ensureFile(path: any): Promise<Stats> {
    await this.assertRoot();
    let handle, created = false;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true; await handle.sync();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { await handle?.close(); }
    const identity = await lstat(path); secure(identity);
    if (created) await this.syncDirectory();
    return identity;
  }
  /** A failed attempt closes its connection; never retain a SQLite waiter. */
  tryLock(path: any): Promise<{ path: any; identity: Stats; release(): void; }>;
  async tryLock(path: any): Promise<{ path: any; identity: Stats; release(): void; } | null> {
    await this.assertRoot();
    const identity = await lstat(path); secure(identity);
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE");
      await this.assertRoot();
      const current = await lstat(path); secure(current);
      if (!same(current, identity)) fail();
      let released = false;
      return { path, identity, release(): void {
        if (released) return; released = true;
        try { database.exec("ROLLBACK"); } finally { database.close(); }
      } };
    } catch (error) {
      try { database!?.close(); } catch { /* preserve the acquisition error */ }
      if (busy(error)) return null;
      throw error;
    }
  }
  /**
   * `signal` cancels only the wait: an acquisition that races cancellation is
   *  released before the callback runs, and the callback itself is never cancelled.
   */
  async withCatalog<T>(callback: () => Promise<T>, { wait = true, signal }: { wait?: boolean; signal?: AbortSignal | undefined; } = {}): Promise<T> {
    for (;;) {
      signal?.throwIfAborted();
      const lock = await this.tryLock(this.catalogPath);
      if (!lock) {
        if (!wait) throw Object.assign(new Error("Native journal catalogue ownership is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
        await pause(signal); continue;
      }
      if (signal?.aborted) { lock.release(); signal.throwIfAborted(); }
      try { return await callback(); } finally { lock.release(); }
    }
  }
  async acquireWriter(journalId: string, { wait = true, signal }: { wait?: boolean; signal?: AbortSignal | undefined; } = {}): Promise<{ path: any; identity: Stats; release(): void; }> {
    if (!/^[A-Za-z0-9_-]+$/.test(journalId)) throw new TypeError("Unsafe harness journal ID");
    const path = join(this.directory, `${journalId}.sqlite`);
    for (;;) {
      let lock;
      if (wait) {
        lock = await this.withCatalog(async () => { await this.ensureFile(path); return this.tryLock(path); }, { signal });
        if (lock && signal?.aborted) { lock.release(); signal.throwIfAborted(); }
      } else {
        const catalog = await this.tryLock(this.catalogPath);
        if (!catalog) throw Object.assign(new Error("Native journal catalogue ownership is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
        try { await this.ensureFile(path); lock = await this.tryLock(path); } finally { catalog.release(); }
      }
      if (lock) return lock;
      if (!wait) throw Object.assign(new Error("Native journal writer ownership is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
      // Release catalogue before waiting for a provider-owned writer.
      await pause(signal);
    }
  }
  /**
   * Only the already-owning writer can release/reclaim. The caller's predicate
   * must attest that matching data and aliases are durably gone under this mutex.
   */
  /**
   * Off-path reclamation after a cancelled, pre-mutation acquisition (the
   *  caller already released its writer): never blocks cancellation; on any
   *  failure the lock file simply stays, pinning no data.
   */
  reclaimLater(path: string, dataGone: () => Promise<boolean>): void {
    setImmediate(async () => {
      let lock;
      try { lock = await this.tryLock(path); if (lock) await this.releaseWriter(lock, dataGone); }
      catch { /* keep the lock file */ } finally { lock?.release(); }
    });
  }
  async releaseWriter(lock: any, dataGone: any): Promise<void> {
    if (!dataGone) { lock.release(); return; }
    await this.withCatalog(async () => {
      await this.assertRoot();
      const current = await lstat(lock.path); secure(current);
      if (!same(current, lock.identity)) fail();
      lock.release();
      if (!await dataGone()) return;
      await this.assertRoot();
      if (!same(await lstat(lock.path), lock.identity)) fail();
      await unlink(lock.path); await this.syncDirectory();
    });
  }
}
