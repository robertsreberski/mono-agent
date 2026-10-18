import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";

import { isErrno } from "../background/background-lifecycle-utils.js";

export async function writeOwnerPrivateLaunchdFile(path: string, data: string): Promise<void> {
  let existing: Stats | undefined;
  try {
    existing = await lstat(path);
    assertOwnerRegularFile(existing, path, "LaunchAgent plist");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const temporary = await lstat(temporaryPath);
    assertOwnerRegularFile(temporary, temporaryPath, "temporary LaunchAgent plist");
    if ((temporary.mode & 0o777) !== 0o600) {
      throw new Error(`Temporary LaunchAgent plist ${temporaryPath} must be owner-readable and owner-writable only.`);
    }

    let current: Stats | undefined;
    try {
      current = await lstat(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (
      (existing === undefined) !== (current === undefined)
      || (existing !== undefined && current !== undefined && !sameFilesystemIdentity(existing, current))
    ) {
      throw new Error(`LaunchAgent plist ${path} changed before the new definition was committed.`);
    }

    await rename(temporaryPath, path);
    const committed = await lstat(path);
    assertOwnerRegularFile(committed, path, "LaunchAgent plist");
    if (!sameFilesystemIdentity(temporary, committed)) {
      throw new Error(`LaunchAgent plist ${path} changed while the new definition was committed.`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function inspectOwnerPrivateLaunchdPlist(path: string): Promise<string> {
  return (await readOwnerPrivateLaunchdPlist(path)).identity;
}

export async function readOwnerPrivateLaunchdPlist(
  path: string,
): Promise<{ readonly identity: string; readonly contents: string }> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    assertOwnerRegularFile(before, path, "LaunchAgent plist");
    if ((before.mode & 0o777) !== 0o600) {
      throw new Error(`LaunchAgent plist ${path} must be owner-only.`);
    }
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > 1024 * 1024) {
      throw new Error(`LaunchAgent plist ${path} has an unsafe size.`);
    }
    const contents = await readExactFileHandle(handle, before.size, "LaunchAgent plist");
    const after = await handle.stat();
    assertOwnerRegularFile(after, path, "LaunchAgent plist");
    if ((after.mode & 0o777) !== 0o600
      || !sameFileSnapshot(before, after)
      || contents.length !== before.size) {
      throw new Error(`LaunchAgent plist ${path} changed while it was read.`);
    }
    const current = await lstat(path);
    assertOwnerRegularFile(current, path, "LaunchAgent plist");
    if ((current.mode & 0o777) !== 0o600 || !sameFileSnapshot(after, current)) {
      throw new Error(`LaunchAgent plist ${path} changed while it was inspected.`);
    }
    const identity = [
      String(after.dev),
      String(after.ino),
      String(after.size),
      createHash("sha256").update(contents).digest("hex"),
    ].join(":");
    return { identity, contents: contents.toString("utf8") };
  } finally {
    await handle.close();
  }
}

async function readExactFileHandle(handle: FileHandle, size: number, description: string): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${description} has an unsafe size.`);
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(contents, offset, size - offset, offset);
    if (result.bytesRead === 0) throw new Error(`${description} ended while its bounded contents were read.`);
    offset += result.bytesRead;
  }
  return contents;
}

function assertOwnerRegularFile(details: Stats, path: string, description: string): void {
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${description} ${path} must be a regular non-symbolic-link file.`);
  }
  if (details.nlink !== 1) {
    throw new Error(`${description} ${path} must have exactly one filesystem link.`);
  }
  assertCurrentUserOwns(details, path, description);
}

function assertCurrentUserOwns(details: Stats, path: string, description: string): void {
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${description} ${path} is not owned by the current user.`);
  }
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFilesystemIdentity(left, right)
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
