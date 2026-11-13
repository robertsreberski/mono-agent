import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { SettingsJson } from "./types.js";
import { findDuplicateJsonKeyPaths, readSettingsJson, SettingsJsonError } from "./json-read.js";

export interface GuardedSettingsJsonWrite {
  readonly expectedVersion: string;
  /** Must validate the entire rebuilt candidate, not just the owned patch. No runtime starts. */
  readonly validate: (candidate: SettingsJson, candidatePath: string) => Promise<void>;
  /** Fixed, content-free audit line; never pass config values or paths. */
  readonly log?: (message: string) => void;
}
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);
const refuse = (): never => { throw new SettingsJsonError("unsafe_config_write", "Configuration write refused; inspect the config and backup in the owner terminal."); };
const conflict = (): never => { throw new SettingsJsonError("config_conflict", "Configuration changed; refresh the preview."); };

async function snapshot(path: string): Promise<{ bytes: Buffer; identity: string } | undefined> {
  let stat;
  try { stat = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid !== undefined && stat.uid !== process.getuid())) refuse();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) refuse();
    return { bytes: await handle.readFile(), identity: `${stat.dev}:${stat.ino}:${stat.mode}` };
  } finally { await handle.close(); }
}
async function unchanged(path: string, before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
  const after = await snapshot(path);
  if (after?.identity !== before?.identity || (after !== undefined && !after.bytes.equals(before!.bytes))) conflict();
}
async function privateTemp(path: string, bytes: Uint8Array | string): Promise<string> {
  const temp = `${path}.mono-agent-${randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
  finally { await handle.close(); }
  return temp;
}
async function hasRepository(path: string): Promise<boolean> {
  let directory = dirname(path);
  while (true) {
    try { await lstat(resolve(directory, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse(); }
    const parent = dirname(directory); if (parent === directory) return false; directory = parent;
  }
}
async function tracked(path: string): Promise<boolean> {
  try { await run("git", ["-C", dirname(path), "ls-files", "--error-unmatch", "--", basename(path)], { maxBuffer: 4096 }); return true; }
  catch (error) { if (Number((error as { code?: unknown }).code) === 1) return false;
    if (Number((error as { code?: unknown }).code) === 128 && !await hasRepository(path)) return false;
    return refuse(); }
}
async function protectBackup(path: string): Promise<void> {
  const name = basename(path);
  if (!/^[A-Za-z0-9_.-]+$/u.test(name) || name === ".gitignore") refuse();
  const backup = `${path}.bak`;
  if (await tracked(backup)) refuse();
  const prior = await snapshot(backup);
  if (prior !== undefined) {
    const stat = await lstat(backup);
    if ((stat.mode & 0o777) !== 0o600) refuse();
  }
  const ignore = resolve(dirname(path), ".gitignore");
  const before = await snapshot(ignore);
  const text = before?.bytes.toString("utf8") ?? "";
  if (before !== undefined && !Buffer.from(text).equals(before.bytes)) refuse();
  const rules = `/${name}.bak\n/${name}.mono-agent-*.tmp\n/${name}.write-lock/\n`;
  if (!text.endsWith(rules)) {
    const temp = await privateTemp(ignore, `${text}${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${rules}`);
    try { await unchanged(ignore, before); await rename(temp, ignore); }
    finally { await unlink(temp).catch(() => undefined); }
  }
  // Verify effective ignore rules in repositories (including ancestor negations).
  try { await run("git", ["-C", dirname(path), "rev-parse", "--show-toplevel"], { maxBuffer: 4096 }); }
  catch (error) { if (Number((error as { code?: unknown }).code) === 128 && !await hasRepository(path)) return; refuse(); }
  try { await run("git", ["-C", dirname(path), "check-ignore", "--no-index", "--quiet", "--", basename(backup)]); }
  catch { refuse(); }
}

const writers = new Map<string, Promise<void>>();

/** Cooperative per-config process lock. No stale lock is removed automatically. */
export async function withSettingsJsonLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  path = resolve(path);
  const previous = writers.get(path) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  writers.set(path, tail);
  await previous;
  const lock = `${path}.write-lock`;
  let acquired = false;
  try {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") conflict(); throw error; }
    return await work();
  } finally {
    try { if (acquired) await rmdir(lock); } finally { release(); if (writers.get(path) === tail) writers.delete(path); }
  }
}

/** Opt-in optimistic, private-backup publication. Legacy patch semantics stay unchanged. */
export async function writeGuardedSettingsJson(
  path: string, candidate: (existing: SettingsJson) => SettingsJson, guard: GuardedSettingsJsonWrite,
): Promise<{ readonly version: string }> {
  path = resolve(path);
  const directoryPath = dirname(path);
  const directoryIdentity = await lstat(directoryPath);
  const assertDirectory = async (): Promise<void> => {
    const current = await lstat(directoryPath);
    if (!current.isDirectory() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
      || (current.mode & 0o022) !== 0 || (process.getuid !== undefined && current.uid !== process.getuid())
      || await realpath(directoryPath) !== directoryPath) refuse();
  };
  await assertDirectory();
  return await withSettingsJsonLock(path, async () => {
    const before = await snapshot(path);
    const version = before === undefined ? "" : digest(before.bytes);
    if (version !== guard.expectedVersion) conflict();
    const source = await readSettingsJson(path);
    if (source.version !== version) conflict();
    if (source.duplicateKeyPaths.length > 0) refuse();
    const rebuilt = candidate(source.json);
    const serialized = `${JSON.stringify(rebuilt, null, 2)}\n`;
    if (findDuplicateJsonKeyPaths(serialized).length > 0) refuse();
    const resultHash = digest(serialized);
    // Ignore secret-bearing candidate temps before they exist, not only before backup publication.
    await protectBackup(path);
    const temp = await privateTemp(path, serialized);
    try {
      await guard.validate(rebuilt, temp);
      await unchanged(path, before);
      await protectBackup(path);
      const backupPath = `${path}.bak`;
      const backupBefore = await snapshot(backupPath);
      const backupTemp = await privateTemp(path, `${JSON.stringify({ version: 1, previousMissing: before === undefined, previousBase64: (before?.bytes ?? Buffer.alloc(0)).toString("base64"), intendedSha256: resultHash })}\n`);
      try { await unchanged(backupPath, backupBefore); await rename(backupTemp, backupPath); }
      finally { await unlink(backupTemp).catch(() => undefined); }
      await unchanged(path, before);
      await assertDirectory();
      // Cooperative writers hold the lock; a final identity/byte guard detects manual edits.
      await rename(temp, path);
      const directory = await open(dirname(path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(() => undefined); }
    // Logging must not turn a committed write into a reported failure.
    try { guard.log?.("Capability configuration saved; activation requires a fresh start."); } catch { /* committed */ }
    return { version: resultHash };
  });
}
