import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open as openFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
export const MAX_FORGET_PLAN_BYTES = 1024 * 1024;

export function memoryRootFingerprint(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

export async function writePrivateJsonExclusive(path: string, value: unknown, maxBytes = MAX_FORGET_PLAN_BYTES): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error("private plan exceeds size limit");
  const handle = await openFile(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    const opened = await handle.stat();
    const current = await lstat(path);
    assertPinnedFile(opened, current, path, true, maxBytes);
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => {});
    throw error;
  }
  await handle.close();
  try { await fsyncParentDirectory(path); }
  catch (error) { await unlink(path).catch(() => {}); throw error; }
}

export async function readPrivateJson(path: string, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readPinnedFile(path, maxBytes, true)) as unknown;
}

export async function readPinnedFile(path: string, maxBytes: number, ownerPrivate: boolean): Promise<string> {
  const before = await lstat(path);
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assertPinnedFile(before, opened, path, ownerPrivate, maxBytes);
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    const current = await lstat(path);
    assertPinnedFile(opened, after, path, ownerPrivate, maxBytes);
    assertPinnedFile(opened, current, path, ownerPrivate, maxBytes);
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error("private artifact changed while it was read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function assertPinnedFile(
  expected: Stats,
  actual: Stats,
  path: string,
  ownerPrivate: boolean,
  maxBytes: number,
): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1 || actual.size > maxBytes
    || expected.dev !== actual.dev || expected.ino !== actual.ino
    || (ownerPrivate && (actual.mode & 0o077) !== 0)
    || (uid !== undefined && actual.uid !== uid)) {
    throw new Error(`private artifact is unsafe: ${path}`);
  }
}

export async function fsyncParentDirectory(path: string): Promise<void> {
  const handle = await openFile(dirname(path), constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function canonicalProspectivePath(path: string): Promise<string> {
  const parent = await realpath(dirname(path));
  return join(parent, basename(path));
}

export function isSameOrUnderDirectory(parent: string, child: string): boolean {
  return parent === child || isUnderDirectory(parent, child);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isCanonicalIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isUnderDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
