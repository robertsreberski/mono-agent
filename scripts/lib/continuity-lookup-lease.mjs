// Private SQLite writer leases. A filename or a structurally similar object is not a lease.
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";

const active = new WeakMap(), filename = "controller-lock.sqlite";
const fail = () => { throw Object.assign(new Error("lookup_authorization_lease_invalid"), { code: "lookup_authorization_lease_invalid" }); };
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
  const path = join(root, filename), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(), named = await lstat(path);
    if (!stat.isFile() || stat.uid !== userInfo().uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || !same(stat, named)) fail();
    const directory = await lstat(root);
    if (![directory.dev, directory.ino, stat.dev, stat.ino].every(Number.isSafeInteger)) fail();
    return { outputIdentity: { dev: directory.dev, ino: directory.ino }, leaseIdentity: { dev: stat.dev, ino: stat.ino } };
  } finally { await file.close(); }
}
function metadata(db, controller) {
  const row = db.prepare("SELECT pid, start_identity FROM lookup_controller WHERE id = 1").get();
  if (!row || row.pid !== controller.pid || row.start_identity !== controller.startIdentity
    || lookupProcessStartIdentity(controller.pid) !== controller.startIdentity) fail();
}
function locked(path) {
  const probe = new DatabaseSync(path);
  try {
    try { probe.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    catch (error) { if (error.errcode === 5 || error.code === "SQLITE_BUSY") return; throw error; }
    probe.exec("ROLLBACK"); fail();
  } finally { probe.close(); }
}
/** Acquire before consuming; retain until controller shutdown. Never adopts a pre-existing lock file. */
export async function acquireLookupPilotLease(root) {
  let db;
  try {
    await safeRoot(root);
    const file = await open(join(root, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.close();
    const binding = await locations(root), controller = { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) };
    if (!controller.startIdentity) fail();
    db = new DatabaseSync(join(root, filename));
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE lookup_controller (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, start_identity TEXT NOT NULL)");
    db.prepare("INSERT INTO lookup_controller VALUES (1, ?, ?)").run(controller.pid, controller.startIdentity);
    db.exec("BEGIN IMMEDIATE");
    let handle;
    handle = Object.freeze({ release() { const ctx = active.get(handle); if (ctx) { active.delete(handle); try { ctx.db.exec("ROLLBACK"); } finally { ctx.db.close(); } } } });
    active.set(handle, { db, root, binding, controller });
    return handle;
  } catch { try { db?.close(); } catch {} fail(); }
}
/** Verify an unforgeable local handle, transaction, on-disk controller and exclusive SQLite lock. */
export async function assertLookupPilotLease(handle, root, controller) {
  try {
    const ctx = active.get(handle), binding = await locations(root);
    if (!ctx || ctx.root !== root || !ctx.db.isTransaction || controller.pid !== process.pid
      || !same(binding.outputIdentity, ctx.binding.outputIdentity) || !same(binding.leaseIdentity, ctx.binding.leaseIdentity)) fail();
    metadata(ctx.db, controller); locked(join(root, filename));
    return binding;
  } catch { fail(); }
}
/** Child-side read prerequisite: the recorded live controller must still hold the SQLite writer lock. */
export async function readLookupPilotLease(root, controller) {
  let db;
  try {
    const binding = await locations(root);
    db = new DatabaseSync(join(root, filename), { readOnly: true });
    metadata(db, controller); locked(join(root, filename));
    return binding;
  } catch { fail(); }
  finally { db?.close(); }
}
