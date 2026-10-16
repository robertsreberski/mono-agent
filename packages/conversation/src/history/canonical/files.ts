import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

export interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

export async function createAndVerifyRoot(root: string): Promise<DirectoryIdentity> {
  await createDirectoryPathWithoutSymlinks(root);
  const info = await lstat(root);
  assertSecureHistoryDirectory(info, root);
  return { dev: info.dev, ino: info.ino };
}

async function createDirectoryPathWithoutSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    let created = false;
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
      }
      if (created) {
        await chmod(current, 0o700);
        await fsyncParentDirectory(current);
      }
      info = await lstat(current);
    }
    // macOS exposes root-owned compatibility links such as /var -> /private/var.
    // Those are outside the caller's control; user-owned links anywhere in the
    // configured path remain fail-closed.
    if (info.isSymbolicLink()) {
      const uid = process.getuid?.();
      if (uid === undefined || info.uid !== 0 || uid === 0) {
        throw new Error(`History path component ${current} must not be a user-controlled symbolic link.`);
      }
      continue;
    }
    if (!info.isDirectory()) throw new Error(`History path component ${current} must be a directory.`);
  }
}

export function assertSecureHistoryDirectory(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`History root ${path} must be a non-symlink directory.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error(`History root ${path} must have owner-only mode 0700.`);
  }
}

export function assertSecureHistoryFile(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`History path ${path} must be a non-symlink regular file.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (info.nlink !== 1) throw new Error(`History file ${path} must have exactly one hard link.`);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`History file ${path} must have owner-only mode 0600.`);
  }
}

export function assertSecureTransientHistoryFile(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`History path ${path} must be a non-symlink regular file.`);
  }
  assertOwnedByCurrentUser(info, path);
  // A concurrent SQLite DELETE-journal commit may unlink the path immediately
  // after lstat; APFS can report that transient inode with zero remaining
  // links. Multiple links are never legitimate and remain fail-closed.
  if (info.nlink > 1) throw new Error(`History file ${path} must not have multiple hard links.`);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`History file ${path} must have owner-only mode 0600.`);
  }
}

function assertOwnedByCurrentUser(info: Stats, path: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`History path ${path} must be owned by the current user.`);
}

export async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const info = await lstat(path);
  assertSecureHistoryDirectory(info, path);
  if (info.dev !== expected.dev || info.ino !== expected.ino) {
    throw new Error(`History root ${path} changed while it was in use.`);
  }
}

export function assertSameIdentity(before: Stats, after: Stats, path: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new ConcurrentHistoryMutationError(`History file ${path} changed while it was being read.`);
  }
}

export class ConcurrentHistoryMutationError extends Error {}

export async function fsyncDirectory(path: string, expected: DirectoryIdentity): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag());
    const info = await handle.stat();
    assertSecureHistoryDirectory(info, path);
    if (info.dev !== expected.dev || info.ino !== expected.ino) {
      throw new Error(`History root ${path} changed while it was in use.`);
    }
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fsyncParentDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  let handle;
  try {
    handle = await open(parent, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag());
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

export function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

/** Owned-file readers may wrap OS failures; preserve operational errors at bootstrap. */
function causedErrno(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && typeof error.code === "string" && /^E[A-Z]+$/u.test(error.code)) return error.code;
    error = "cause" in error ? error.cause : undefined;
  }
  return undefined;
}

/** Absence is not damage; resource/device failures retain their original cause. */
export function entryAbsentOrThrowOperational(error: unknown): boolean {
  const code = causedErrno(error);
  if (code && !["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(code)) throw error;
  return code === "ENOENT";
}
