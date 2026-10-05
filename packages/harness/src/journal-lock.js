// @ts-check
// Narrow port of agent-harness/durable-history's SQLite kernel-lock primitive.
// Catalogue acquisition and per-journal lock reclamation use the same mutex.
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const fail = () => { throw new Error("Harness journal ownership unavailable"); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function secure(stat, directory = false) {
  if (!(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail();
}
const busy = (error) => error?.code === "ERR_SQLITE_ERROR"
  && (error.errcode === 5 || error.errcode === 6);

/** Pinned root identity prevents a late writer recreating a quarantined/purged root. */
export class JournalLocks {
  constructor(root, identities) {
    this.root = root;
    this.identities = identities;
    this.directory = join(root, "mono-v2", "locks");
    this.catalogPath = join(this.directory, "catalog.sqlite");
  }
  /** @param {string} sessionsRoot */
  static async open(sessionsRoot, onRootPermissionsTightened = () => {}) {
    const root = resolve(sessionsRoot);
    // Validate each existing parent under the supplied trust boundary before
    // creating its child; recursive mkdir would follow an existing symlink.
    const identities = new Map();
    for (const path of [root, join(root, "mono-v2"), join(root, "mono-v2", "locks")]) {
      try { await mkdir(path, { mode: 0o700, recursive: path === root }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
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
  async assertRoot() {
    for (const [path, identity] of this.identities) {
      const current = await lstat(path); secure(current, true);
      if (!same(current, identity)) fail();
    }
  }
  async syncDirectory() {
    await this.assertRoot();
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    await this.assertRoot();
  }
  async ensureFile(path) {
    await this.assertRoot();
    let handle, created = false;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true; await handle.sync();
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    finally { await handle?.close(); }
    const identity = await lstat(path); secure(identity);
    if (created) await this.syncDirectory();
    return identity;
  }
  /** A failed attempt closes its connection; never retain a SQLite waiter. */
  async tryLock(path) {
    await this.assertRoot();
    const identity = await lstat(path); secure(identity);
    let database;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE");
      await this.assertRoot();
      const current = await lstat(path); secure(current);
      if (!same(current, identity)) fail();
      let released = false;
      return { path, identity, release() {
        if (released) return; released = true;
        try { database.exec("ROLLBACK"); } finally { database.close(); }
      } };
    } catch (error) {
      try { database?.close(); } catch { /* preserve the acquisition error */ }
      if (busy(error)) return null;
      throw error;
    }
  }
  async withCatalog(callback, { wait = true } = {}) {
    for (;;) {
      const lock = await this.tryLock(this.catalogPath);
      if (!lock) {
        if (!wait) throw Object.assign(new Error("Native journal catalogue ownership is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
        await delay(10); continue;
      }
      try { return await callback(); } finally { lock.release(); }
    }
  }
  /** @param {string} journalId */
  async acquireWriter(journalId, { wait = true } = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(journalId)) throw new TypeError("Unsafe harness journal ID");
    const path = join(this.directory, `${journalId}.sqlite`);
    for (;;) {
      let lock;
      if (wait) lock = await this.withCatalog(async () => { await this.ensureFile(path); return this.tryLock(path); });
      else {
        const catalog = await this.tryLock(this.catalogPath);
        if (!catalog) throw Object.assign(new Error("Native journal catalogue ownership is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
        try { await this.ensureFile(path); lock = await this.tryLock(path); } finally { catalog.release(); }
      }
      if (lock) return lock;
      if (!wait) throw Object.assign(new Error("Native journal writer ownership is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
      // Release catalogue before waiting for a provider-owned writer.
      await delay(10);
    }
  }
  /**
   * Only the already-owning writer can release/reclaim. The caller's predicate
   * must attest that matching data and aliases are durably gone under this mutex.
   * @param {any} lock
   * @param {() => Promise<boolean>} [dataGone]
   */
  async releaseWriter(lock, dataGone) {
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
