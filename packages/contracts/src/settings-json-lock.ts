import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { protectSettingsJsonArtifacts } from "./settings-json-files.js";
import { syncDirectory } from "./sync-directory.js";
import { SettingsJsonError } from "./json-read.js";

const run = promisify(execFile);
const writers = new Map<string, Promise<void>>();
const refuse = (): never => { throw new SettingsJsonError("unsafe_config_write", "Configuration write refused; inspect the config and backup in the owner terminal."); };
const conflict = (): never => { throw new SettingsJsonError("config_conflict", "Configuration changed or another writer is busy; refresh the preview."); };
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

interface Owner {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly createdAt: string;
  readonly processStartId?: string;
}

/** Best-effort PID-reuse evidence. Unavailable identity is never evidence of death. */
async function processStartId(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === "linux") {
      const [boot, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[19];
      return ticks !== undefined && /^\d+$/u.test(ticks) ? `linux:${boot.trim()}:${ticks}` : undefined;
    }
    if (process.platform === "darwin") {
      const options = { timeout: 500, maxBuffer: 1024, env: { ...process.env, TZ: "UTC", LC_ALL: "C" } };
      const [boot, start] = await Promise.all([
        run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], options),
        run("/bin/ps", ["-p", String(pid), "-o", "lstart="], options),
      ]);
      const normalized = start.stdout.trim().replace(/\s+/gu, " ");
      if (boot.stdout.trim() && normalized) return `darwin:${boot.stdout.trim()}:${normalized}`;
    }
  } catch { /* Only kill(0) ESRCH may prove death when identity cannot be read. */ }
  return undefined;
}
let ownStartId: Promise<string | undefined> | undefined;
function missingProcess(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) { return code(error) === "ESRCH"; }
}
async function gone(owner: Owner): Promise<boolean> {
  if (missingProcess(owner.pid)) return true;
  const actual = owner.processStartId === undefined ? undefined : await processStartId(owner.pid);
  return actual !== undefined && actual !== owner.processStartId;
}
async function removeOwner(lock: string, name: string): Promise<void> {
  // Unique owner names matter: another reclaimer cannot unlink a successor's owner.
  await unlink(`${lock}/${name}`).catch((error: unknown) => { if (code(error) !== "ENOENT") throw error; });
  await rmdir(lock).catch((error: unknown) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error;
  });
}
async function holder(lock: string): Promise<{ name: string; owner: Owner } | "empty" | undefined> {
  const directory = await lstat(lock).catch((error: unknown) => { if (code(error) === "ENOENT") return undefined; throw error; });
  if (directory === undefined) return undefined;
  if (!directory.isDirectory() || (process.getuid !== undefined && directory.uid !== process.getuid()) || (directory.mode & 0o077) !== 0) refuse();
  const names = await readdir(lock).catch((error: unknown) => { if (code(error) === "ENOENT") return undefined; throw error; });
  if (names === undefined) return undefined;
  if (names.length === 0) return "empty";
  const name = names[0]!;
  if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/u.test(name)) refuse();
  let handle;
  try { handle = await open(`${lock}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (code(error) === "ENOENT") return undefined; if (["ELOOP", "EMLINK"].includes(code(error) ?? "")) refuse(); throw error; }
  try {
    const stat = await handle.stat();
    if (stat.nlink === 0) return undefined; // Holder released between open and fstat.
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o777) !== 0o600 || (process.getuid !== undefined && stat.uid !== process.getuid())) refuse();
    let value: Owner;
    try { value = JSON.parse(await handle.readFile("utf8")) as Owner; } catch { return refuse(); }
    if (value === null || typeof value !== "object" || value.version !== 1 || `owner-${value.token}.json` !== name || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || (value.processStartId !== undefined && (typeof value.processStartId !== "string" || value.processStartId.length > 512))) refuse();
    return { name, owner: value };
  } finally { await handle.close(); }
}

/** Queue locally; across processes try atomically, recover dead owners, then wait at most 1.5s. */
export async function withSettingsJsonLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  path = resolve(path);
  const previous = writers.get(path) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  writers.set(path, tail);
  await previous;
  const token = randomUUID();
  const lock = `${path}.write-lock`;
  const prepared = `${path}.mono-agent-${token}.tmp`;
  const name = `owner-${token}.json`;
  let acquired = false;
  let preparedCreated = false;
  try {
    await protectSettingsJsonArtifacts(path);
    const identity = await (ownStartId ??= processStartId(process.pid));
    const owner: Owner = { version: 1, token, pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString(), createdAt: new Date().toISOString(), ...(identity === undefined ? {} : { processStartId: identity }) };
    // Publish a complete nonempty directory, never mkdir(lock) followed by a crash-prone owner write.
    await mkdir(prepared, { mode: 0o700 }); preparedCreated = true;
    const file = await open(`${prepared}/${name}`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await file.writeFile(JSON.stringify(owner)); await file.sync(); } finally { await file.close(); }
    await syncDirectory(prepared);
    const deadline = performance.now() + 1500;
    const checkedLive = new Set<string>();
    while (!acquired) {
      try { await rename(prepared, lock); acquired = true; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) throw error;
        const current = await holder(lock);
        if (current === "empty") {
          // Published live locks are always nonempty. rmdir cannot remove a live successor.
          await rmdir(lock).catch((error: unknown) => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error; });
        } else if (current !== undefined && (missingProcess(current.owner.pid) || (!checkedLive.has(current.owner.token) && await gone(current.owner)))) {
          await removeOwner(lock, current.name);
        } else if (current !== undefined) checkedLive.add(current.owner.token);
        if (performance.now() >= deadline) conflict();
        await wait(30);
      }
    }
    return await work();
  } finally {
    try {
      if (acquired) await removeOwner(lock, name);
      else if (preparedCreated) await removeOwner(prepared, name);
    } finally { release(); if (writers.get(path) === tail) writers.delete(path); }
  }
}
