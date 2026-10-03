import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { access, lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import type { BackgroundLifecycleTarget } from "./background.js";
import { deriveLaunchdMaintenanceLabel } from "./launchd.js";
import type { LaunchdPaths } from "./launchd.js";
import { secureFileReplace } from "./secure-file-replace.js";

const STATUS_MAX_BYTES = 8192;
const STATUS_TEMPORARY_SUFFIX = ".next";

export async function writePrivateLaunchdState(
  target: BackgroundLifecycleTarget,
  directory: string,
  status: unknown,
  maxBytes = STATUS_MAX_BYTES,
): Promise<void> {
  const paths = statusPaths(target.label, target.paths, directory);
  await assertSafeStatusRoot(paths.root);
  await ensurePrivateDirectory(paths.directory);
  const contents = `${JSON.stringify(status)}\n`;
  if (Buffer.byteLength(contents) > maxBytes) {
    throw new Error("Private launchd state exceeds its fixed size bound.");
  }
  let expected: Stats | undefined;
  try {
    expected = await lstat(paths.file);
    assertPrivateFile(expected, paths.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await secureFileReplace({
    path: paths.file,
    temporaryPath: paths.temporary,
    contents,
    mode: 0o600,
    target: {
      expected: expected === undefined
        ? { kind: "missing" }
        : {
            kind: "present",
            validate: async (candidate, claimed) => {
              try {
                const current = await lstat(candidate);
                assertPrivateFile(current, candidate);
                // rename changes ctime on Darwin; all content/owner identity
                // fields must still match after secure-file-replace claims it.
                return sameFile(current, expected, claimed);
              } catch {
                return false;
              }
            },
            invalidError: () => new Error("Private launchd state changed before replacement."),
          },
      recovery: "restore-previous",
    },
  });
}

export async function readPrivateLaunchdState(
  mainLabel: string,
  paths: Pick<LaunchdPaths, "logDir">,
  directory: string,
  maxBytes = STATUS_MAX_BYTES,
): Promise<unknown> {
  const status = statusPaths(mainLabel, paths, directory);
  await assertSafeStatusRoot(status.root);
  try {
    assertPrivateDirectory(await lstat(status.directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let initial: Stats;
  try {
    initial = await lstat(status.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  assertPrivateFile(initial, status.file);
  if (initial.size < 1 || initial.size > maxBytes) {
    throw new Error("Private launchd state violates its fixed size bound.");
  }
  const handle = await open(status.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    assertPrivateFile(opened, status.file);
    if (!sameFile(initial, opened)) throw new Error("Private launchd state changed while opened.");
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) throw new Error("Private launchd state ended during its bounded read.");
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(status.file);
    if (!sameFile(opened, after) || !sameFile(after, current) || contents.length !== after.size) {
      throw new Error("Private launchd state changed while read.");
    }
    const parsed: unknown = JSON.parse(contents.toString("utf8"));
    return parsed;
  } finally {
    await handle.close();
  }
}

/** Activity-only mutability proof; ordinary status readers remain read-only tolerant. */
export async function assertPrivateLaunchdStateWritable(
  mainLabel: string,
  paths: Pick<LaunchdPaths, "logDir">,
  directory: string,
): Promise<void> {
  const status = statusPaths(mainLabel, paths, directory);
  await access(status.directory, fsConstants.W_OK);
  await access(status.file, fsConstants.W_OK);
}

/**
 * Inspect but never create or chmod the shared ~/.mono-agent root. An owned
 * read-only/traversable root such as 0755 can still contain a private 0700
 * status directory while scheduled maintenance owns any root permission repair.
 */
async function assertSafeStatusRoot(path: string): Promise<void> {
  const details = await lstat(path);
  const uid = process.getuid?.();
  if (!details.isDirectory() || details.isSymbolicLink()
    || (uid !== undefined && details.uid !== uid)
    || (details.mode & 0o022) !== 0) {
    throw new Error("Private launchd state root is unavailable or unsafe.");
  }
}

export async function removePrivateLaunchdState(target: BackgroundLifecycleTarget, directory: string): Promise<void> {
  const paths = statusPaths(target.label, target.paths, directory);
  try {
    await assertSafeStatusRoot(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    assertPrivateDirectory(await lstat(paths.directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Retire the authoritative snapshot before inspecting a poisoned leftover
  // temporary. Temporary cleanup failure must not preserve an old idle record.
  for (const path of [paths.file, paths.temporary]) {
    try {
      assertPrivateFile(await lstat(path), path);
      await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function statusPaths(mainLabel: string, paths: Pick<LaunchdPaths, "logDir">, directoryName: string): {
  readonly root: string;
  readonly directory: string;
  readonly file: string;
  readonly temporary: string;
} {
  deriveLaunchdMaintenanceLabel(mainLabel);
  if (!/^[a-z][a-z-]*$/u.test(directoryName)) throw new Error("Invalid private launchd state namespace.");
  const root = resolve(dirname(paths.logDir));
  const directory = resolve(root, directoryName);
  const key = createHash("sha256").update(mainLabel).digest("hex").slice(0, 24);
  const file = resolve(directory, `${key}.json`);
  return { root, directory, file, temporary: `${file}${STATUS_TEMPORARY_SUFFIX}` };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const details = await lstat(path);
  assertPrivateDirectory(details);
}

function assertPrivateDirectory(details: Stats): void {
  const uid = process.getuid?.();
  if (!details.isDirectory() || details.isSymbolicLink()
    || (uid !== undefined && details.uid !== uid)
    || (details.mode & 0o777) !== 0o700) {
    throw new Error("Private launchd state directory must be a real owner-private directory.");
  }
}

function assertPrivateFile(details: Stats, path: string): void {
  const uid = process.getuid?.();
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || (uid !== undefined && details.uid !== uid)
    || (details.mode & 0o777) !== 0o600) {
    throw new Error(`Private launchd state ${path} must be one owner-private regular file.`);
  }
}

function sameFile(
  left: Stats,
  right: Stats,
  claimed = false,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && (claimed || left.ctimeMs === right.ctimeMs);
}
