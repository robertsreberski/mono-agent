import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { syncDirectory } from "./sync-directory.js";
import { SettingsJsonError } from "./json-read.js";

const run = promisify(execFile);
const refuse = (): never => { throw new SettingsJsonError("unsafe_config_write", "Configuration write refused; inspect the config and backup in the owner terminal."); };
const conflict = (): never => { throw new SettingsJsonError("config_conflict", "Configuration changed; refresh the preview."); };

export async function snapshot(path: string): Promise<{ bytes: Buffer; identity: string; mode: number } | undefined> {
  let stat;
  try { stat = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid !== undefined && stat.uid !== process.getuid())) refuse();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP" || error.code === "EMLINK") refuse();
    throw error;
  });
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) refuse();
    return { bytes: await handle.readFile(), identity: `${stat.dev}:${stat.ino}:${stat.mode}`, mode: stat.mode };
  } finally { await handle.close(); }
}
export async function unchanged(path: string, before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
  const after = await snapshot(path);
  if (after?.identity !== before?.identity || (after !== undefined && !after.bytes.equals(before!.bytes))) conflict();
}
export async function privateTemp(path: string, bytes: Uint8Array | string): Promise<string> {
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
function gitUnavailable(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "127"].includes(String((error as { code?: unknown }).code));
}
async function tracked(path: string): Promise<boolean> {
  try { await run("git", ["-C", dirname(path), "ls-files", "--error-unmatch", "--", basename(path)], { maxBuffer: 4096 }); return true; }
  catch (error) { if (gitUnavailable(error)) return false;
    if (Number((error as { code?: unknown }).code) === 1) return false;
    if (Number((error as { code?: unknown }).code) === 128 && !await hasRepository(path)) return false;
    return refuse(); }
}
/** Install protection before any lock, staging directory, or config temp exists. */
export async function protectSettingsJsonArtifacts(path: string): Promise<void> {
  const name = basename(path);
  if (/[\r\n\0]/u.test(name) || name === ".gitignore") refuse();
  const literal = name.replace(/[\\*?[\]#! ]/gu, "\\$&");
  const ignore = resolve(dirname(path), ".gitignore");
  const before = await snapshot(ignore);
  if (before !== undefined && (before.mode & 0o022) !== 0) refuse();
  const text = before?.bytes.toString("utf8") ?? "";
  if (before !== undefined && !Buffer.from(text).equals(before.bytes)) refuse();
  const rules = `/${literal}.bak\n/${literal}.tmp\n/${literal}.mono-agent-*.tmp\n/${literal}.write-lock/\n`;
  if (!text.endsWith(rules)) {
    const temp = await privateTemp(ignore, `${text}${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${rules}`);
    try { await unchanged(ignore, before); await rename(temp, ignore); await syncDirectory(dirname(path)); }
    finally { await unlink(temp).catch(() => undefined); }
  }
}

export async function protectBackup(path: string): Promise<void> {
  const name = basename(path);
  if (!/^[A-Za-z0-9_.-]+$/u.test(name) || name === ".gitignore") refuse();
  const backup = `${path}.bak`;
  if (await tracked(backup)) refuse();
  const prior = await snapshot(backup);
  if (prior !== undefined) {
    const stat = await lstat(backup);
    if ((stat.mode & 0o777) !== 0o600) refuse();
  }
  await protectSettingsJsonArtifacts(path);
  // Verify effective ignore rules in repositories (including ancestor negations).
  try { await run("git", ["-C", dirname(path), "rev-parse", "--show-toplevel"], { maxBuffer: 4096 }); }
  catch (error) { if (gitUnavailable(error) || (Number((error as { code?: unknown }).code) === 128 && !await hasRepository(path))) return; refuse(); }
  try { await run("git", ["-C", dirname(path), "check-ignore", "--no-index", "--quiet", "--", basename(backup)]); }
  catch (error) { if (gitUnavailable(error)) return; refuse(); }
}
