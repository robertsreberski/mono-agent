// Shared guarded-run mechanics; policy is selected only by a closed protocol id.
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
// Host trust: O_EXCL and pathname inode checks prevent accidental concurrent controllers.
// node:sqlite exposes no opened fd; these checks are not race-free against a same-user
// process deliberately swapping paths. Preserve DELETE-journal and POSIX-lock semantics.
const liveFiles = new Map();
const instances = new Map();
export function guardedLease(id) {
  const protocol = guardedProtocol(id);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, id));
  return instances.get(protocol);
}
function bind(protocol, id) {
  const active = new WeakMap(), filename = protocol.leaseFile;
  const fileKey = stat => `${stat.dev}/${stat.ino}`;
  const isLeaseFile = (path, stat) => basename(path) === filename || liveFiles.has(fileKey(stat));
  function markLeaseCompromised(stat) {
    const state = liveFiles.get(fileKey(stat));
    if (!state) return false;
    state.compromised = true;
    return true;
  }
  const fail = () => { throw Object.assign(new Error(protocol.codes.authorization_lease_invalid), { code: protocol.codes.authorization_lease_invalid }); };
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  async function safeRoot(root) {
    if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) fail();
    for (let path = root; ; path = dirname(path)) {
      const stat = await lstat(path), uid = userInfo().uid;
      if (!stat.isDirectory() || ![uid, 0].includes(stat.uid)
        || (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)) fail();
      if (path === root && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) fail();
      if (dirname(path) === path) break;
    }
  }
  async function locations(root) {
    await safeRoot(root);
    // POSIX locks are process-wide: closing ANY non-SQLite fd for this inode
    // would silently release the live SQLite connection's OS locks. Never open it.
    const stat = await lstat(join(root, filename)), directory = await lstat(root);
    if (liveFiles.get(fileKey(stat))?.compromised) fail();
    if (!stat.isFile() || stat.uid !== userInfo().uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail();
    if (![directory.dev, directory.ino, stat.dev, stat.ino].every(Number.isSafeInteger)) fail();
    return { outputIdentity: { dev: directory.dev, ino: directory.ino }, leaseIdentity: { dev: stat.dev, ino: stat.ino } };
  }
  function metadata(db, controller) {
    const row = db.prepare(protocol.leaseSQL.select).get();
    if (!row || row.pid !== controller.pid || row.start_identity !== controller.startIdentity
      || lookupProcessStartIdentity(controller.pid) !== controller.startIdentity) fail();
  }
  function locked(path) {
    const probe = new DatabaseSync(path);
    try {
      try { probe.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
      catch (error) { if ((error.errcode & 0xff) === 5) return; throw error; }
      probe.exec("ROLLBACK"); fail();
    } finally { probe.close(); }
  }
  async function acquireLease(root) {
    let db, key, created, path;
    try {
      await safeRoot(root);
      path = join(root, filename);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { created = await file.stat({ bigint: true }); } finally { await file.close(); }
      // Adopt only the exact inode this attempt created, before and after SQLite opens the path.
      const createdHere = id => BigInt(id.dev) === created.dev && BigInt(id.ino) === created.ino;
      const binding = await locations(root);
      if (!createdHere(binding.leaseIdentity)) fail();
      const controller = { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) };
      if (!controller.startIdentity) fail();
      db = new DatabaseSync(join(root, filename));
      // The connection's fd now pins an inode; refuse before writing into anything else.
      if (!createdHere((await locations(root)).leaseIdentity)) fail();
      const state = { compromised: false };
      key = fileKey(binding.leaseIdentity); liveFiles.set(key, state);
      db.exec(protocol.leaseSQL.create);
      db.prepare(protocol.leaseSQL.insert).run(controller.pid, controller.startIdentity);
      db.exec("BEGIN IMMEDIATE");
      if (!createdHere((await locations(root)).leaseIdentity)) fail();
      let handle;
      handle = Object.freeze({ release() {
        const ctx = active.get(handle);
        if (!ctx) return;
        active.delete(handle);
        try { ctx.db.exec("ROLLBACK"); }
        finally { try { ctx.db.close(); } finally { liveFiles.delete(fileKey(ctx.binding.leaseIdentity)); } }
      } });
      active.set(handle, { db, root, binding, controller, state });
      return handle;
    } catch {
      let closed = true;
      try { db?.close(); } catch { closed = false; }
      if (key) liveFiles.delete(key);
      // This acquisition never issued a handle, so it cannot have consumed approval.
      // Do not adopt/remove a pre-existing file or a replacement installed by another actor.
      if (closed && created) {
        try { if (same(await lstat(path, { bigint: true }), created)) await unlink(path); } catch {}
      }
      fail();
    }
  }
  async function assertLease(handle, root, controller) {
    try {
      const ctx = active.get(handle);
      if (!ctx || ctx.state.compromised) fail();
      const binding = await locations(root);
      if (ctx.state.compromised || ctx.root !== root || !ctx.db.isTransaction || controller.pid !== process.pid
        || !same(binding.outputIdentity, ctx.binding.outputIdentity) || !same(binding.leaseIdentity, ctx.binding.leaseIdentity)) fail();
      metadata(ctx.db, controller); locked(join(root, filename));
      return binding;
    } catch { fail(); }
  }
  async function readLease(root, controller) {
    let db;
    try {
      const binding = await locations(root);
      if (liveFiles.get(fileKey(binding.leaseIdentity))?.compromised) fail();
      db = new DatabaseSync(join(root, filename), { readOnly: true });
      metadata(db, controller); locked(join(root, filename));
      return binding;
    } catch { fail(); }
    finally { db?.close(); }
  }
  return Object.freeze({ isLeaseFile, markLeaseCompromised, acquireLease, assertLease, readLease });
}
