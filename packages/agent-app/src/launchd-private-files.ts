import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

/** Secure one account-owned launchd state directory without following links. */
export async function ensureOwnerPrivateLaunchdDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  const parentDetails = await lstat(parent);
  assertOwnerDirectory(parentDetails, parent, "LaunchAgent parent");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const parentAfter = await lstat(parent);
  assertOwnerDirectory(parentAfter, parent, "LaunchAgent parent");
  if (!sameFilesystemIdentity(parentDetails, parentAfter)) {
    throw new Error(`LaunchAgent parent ${parent} changed while ${path} was created.`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    assertOwnerDirectory(before, path, "LaunchAgent directory");
    await handle.chmod(0o700);
    const secured = await handle.stat();
    if (!sameFilesystemIdentity(before, secured)) {
      throw new Error(`LaunchAgent directory ${path} changed while it was secured.`);
    }
    assertOwnerDirectory(secured, path, "LaunchAgent directory");
    if ((secured.mode & 0o077) !== 0) {
      throw new Error(`LaunchAgent directory ${path} must be owner-only.`);
    }
    const current = await lstat(path);
    if (!sameFilesystemIdentity(secured, current)) {
      throw new Error(`LaunchAgent directory ${path} changed while it was secured.`);
    }
  } finally {
    await handle.close();
  }
}

function assertOwnerDirectory(details: Stats, path: string, description: string): void {
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${description} ${path} must be a real directory.`);
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${description} ${path} is not owned by the current user.`);
  }
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
