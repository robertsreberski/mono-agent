import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import type { LaunchdPaths } from "./launchd.js";
import { secureFileReplace } from "./secure-file-replace.js";

const MESSAGE = "Managed worker refused the approved startup snapshot. Run `mono-agent validate` then `mono-agent restart` from the agent folder.";
export const SNAPSHOT_REFUSAL_MESSAGE = MESSAGE;

function paths(label: string, path: Pick<LaunchdPaths, "logDir">) {
  const root = dirname(path.logDir);
  const directory = join(root, "launchd-snapshot-refusals");
  const file = join(directory, `${createHash("sha256").update(label).digest("hex").slice(0, 24)}.json`);
  return { root, directory, file, temporary: `${file}.next` };
}

function assertDirectory(stat: Stats, privateDirectory: boolean): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid !== undefined && stat.uid !== process.getuid())
    || (privateDirectory ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)) {
    throw new Error("Managed snapshot refusal state has an unsafe directory.");
  }
}
function assertFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (process.getuid !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600
    || stat.size < 1 || stat.size > 256) {
    throw new Error("Managed snapshot refusal state has an unsafe file.");
  }
}
function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}
async function prepare(label: string, target: Pick<LaunchdPaths, "logDir">, create: boolean) {
  const state = paths(label, target);
  try { assertDirectory(await lstat(state.root), false); }
  catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (create) {
    try { await mkdir(state.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  try { assertDirectory(await lstat(state.directory), true); }
  catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return state;
}

/** Content-free, owner-only durable evidence for a launchd worker that retired before readiness. */
export async function writeLaunchdSnapshotRefusal(label: string, target: Pick<LaunchdPaths, "logDir">): Promise<void> {
  const state = (await prepare(label, target, true))!;
  let previous: Stats | undefined;
  try { previous = await lstat(state.file); assertFile(previous); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await secureFileReplace({
    path: state.file, temporaryPath: state.temporary,
    contents: '{"reason":"snapshot-refused"}\n', mode: 0o600,
    target: { expected: previous === undefined ? { kind: "missing" } : {
      kind: "present", validate: async (candidate) => {
        try { const current = await lstat(candidate); assertFile(current); return same(current, previous); }
        catch { return false; }
      }, invalidError: () => new Error("Managed snapshot refusal state changed during publication."),
    }, recovery: "restore-previous" },
  });
}
export async function readLaunchdSnapshotRefusal(label: string, target: Pick<LaunchdPaths, "logDir">): Promise<boolean> {
  const state = await prepare(label, target, false);
  if (state === undefined) return false;
  let initial: Stats;
  try { initial = await lstat(state.file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  assertFile(initial);
  const handle = await open(state.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await handle.stat(); assertFile(opened);
    if (!same(initial, opened)) throw new Error("Managed snapshot refusal state changed while opened.");
    const bytes = await handle.readFile();
    if (!same(opened, await handle.stat()) || !same(opened, await lstat(state.file))
      || bytes.toString("utf8") !== '{"reason":"snapshot-refused"}\n') {
      throw new Error("Managed snapshot refusal state changed or is malformed.");
    }
    return true;
  } finally { await handle.close(); }
}
export async function clearLaunchdSnapshotRefusal(label: string, target: Pick<LaunchdPaths, "logDir">): Promise<void> {
  const state = await prepare(label, target, false);
  if (state === undefined) return;
  for (const path of [state.file, state.temporary]) {
    try { assertFile(await lstat(path)); await rm(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
