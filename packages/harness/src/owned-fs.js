// @ts-check
// The one owned-file rule shared by native journals and host stores: exact
// 0700 directories and exact 0600 single-link files owned by this user. A
// matching entry that fails it is damage to its own owner; a pinned directory
// that fails it is fatal to everything under that directory.
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** @typedef {{dev:number, ino:number}} Identity */

/** Typed per-entry refusal: only the conversation owning the entry is refused. */
export class OwnedFileDamagedError extends Error {
  /** @param {string} name @param {unknown} [cause] */
  constructor(name, cause) {
    super(`Owned storage entry unavailable: damaged identity, ownership or permissions (${name})`, { cause });
    this.name = "OwnedFileDamagedError";
    this.code = "ERR_OWNED_FILE_DAMAGED";
  }
}
/** @param {Identity} a @param {Identity} b */
export const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
/** @param {import("node:fs").Stats} a @param {import("node:fs").Stats} b */
export const unchanged = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
/** `foreign` (read-only legacy Pi input) relaxes only the mode and link count.
 * @param {import("node:fs").Stats} stat @param {boolean} [directory] @param {boolean} [foreign] */
export function isOwned(stat, directory = false, foreign = false) {
  if (!(directory ? stat.isDirectory() : stat.isFile())) return false;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
  if (foreign) return true;
  if (!directory && stat.nlink !== 1) return false;
  return process.platform === "win32" || (stat.mode & 0o777) === (directory ? 0o700 : 0o600);
}
/** Re-check a pinned path; any drift is fatal for whoever pinned it.
 * @param {string} path @param {Identity} identity @param {() => never} fail @param {boolean} [directory] */
export async function assertIdentity(path, identity, fail, directory = true) {
  const current = await lstat(path);
  if (!isOwned(current, directory) || !sameIdentity(current, identity)) fail();
  return current;
}
/** @param {string} path @param {Identity|undefined} identity @param {() => never} fail */
export async function syncDir(path, identity, fail) {
  if (identity) await assertIdentity(path, identity, fail);
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try { if (identity && !sameIdentity(await handle.stat(), identity)) fail(); await handle.sync(); }
  finally { await handle.close(); }
  if (identity) await assertIdentity(path, identity, fail);
}
/** Stable bytes of one owned file. ENOENT propagates as absence; anything else
 * wrong with the entry itself is an OwnedFileDamagedError.
 * @param {string} path @param {number} [maxBytes] */
export async function readOwned(path, maxBytes = Infinity) {
  /** @param {unknown} [cause] */
  const damaged = (cause) => new OwnedFileDamagedError(basename(path), cause);
  const before = await lstat(path);
  if (!isOwned(before) || before.size > maxBytes) throw damaged();
  let handle;
  try { handle = await open(path, constants.O_RDONLY | NOFOLLOW); }
  catch (error) { if (/** @type {any} */ (error)?.code === "ENOENT") throw error; throw damaged(error); }
  try {
    // Check the descriptor before reading so a swapped pathname never bypasses the size bound.
    const opened = await handle.stat();
    if (!isOwned(opened) || !unchanged(before, opened) || opened.size > maxBytes) throw damaged();
    const bytes = await handle.readFile(), after = await handle.stat(), named = await lstat(path);
    if (!unchanged(opened, after) || !unchanged(after, named) || !isOwned(named) || bytes.byteLength !== after.size) throw damaged();
    return { bytes, stat: named };
  } finally { await handle.close(); }
}
/** Names failing `pattern` (`.DS_Store`, foreign temps, subdirectories) are
 * skipped: never read, charged or deleted. Matching entries that fail the owned
 * rule are returned `damaged` with their bytes so callers charge them and refuse
 * only their owner. A missing or unreadable directory is the caller's concern.
 * `prefix` scopes the listing to one owner before any entry is stat'ed.
 * @param {string} directory @param {RegExp} pattern @param {number} [maxBytes] @param {string} [prefix] */
export async function listOwned(directory, pattern, maxBytes = Infinity, prefix = "") {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const match = name.startsWith(prefix) ? pattern.exec(name) : null; if (!match) continue;
    let stat;
    try { stat = await lstat(join(directory, name)); }
    catch (error) { if (/** @type {any} */ (error)?.code === "ENOENT") continue; throw error; }
    entries.push({ name, match, stat, bytes: stat.size, damaged: !isOwned(stat) || stat.size > maxBytes });
  }
  return entries;
}
/**
 * temp → fsync → rename → directory fsync. `check` runs before the rename and
 * before removing a failed temp; a failure before rename removes only the temp
 * this call created (cleanup failure leaves it charged, never masks the cause).
 * @param {{path:string, temporary:string, bytes:Uint8Array, fail:() => never,
 *   sync:() => Promise<void>, check?:() => Promise<void>,
 *   phase?:(step:"created"|"written"|"file_synced"|"renamed"|"directory_synced") => Promise<void>}} options
 */
export async function publishAtomic({ path, temporary, bytes, fail, sync, check = async () => {}, phase = async () => {} }) {
  if (dirname(path) !== dirname(temporary)) fail();
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  let created, renamed = false;
  try {
    created = await handle.stat(); await phase("created");
    await handle.writeFile(bytes); const written = await handle.stat();
    if (written.size !== bytes.byteLength || !isOwned(written)) fail();
    await phase("written"); await handle.sync(); await phase("file_synced");
    await check();
    if (!unchanged(written, await lstat(temporary))) fail();
    await rename(temporary, path); renamed = true; await phase("renamed");
    await sync(); await phase("directory_synced");
  } finally {
    await handle.close();
    if (!renamed && created) {
      try { await check(); if (sameIdentity(await lstat(temporary), created)) { await rm(temporary); await sync(); } }
      catch { /* preserve the publication failure; the temp stays charged */ }
    }
  }
}
