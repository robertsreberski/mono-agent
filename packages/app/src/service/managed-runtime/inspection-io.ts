import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat as filesystemLstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";

import { reportRuntimeWork } from "./preparation-progress.js";
import type { SourcePackageProofEntry } from "./types.js";
export const RUNTIME_REUSE_STAT_CONCURRENCY = 64;
export const RUNTIME_FILE_READ_CONCURRENCY = 16;

// Shared across nested traversals (and concurrent callers), not one pool per directory.
export const limitRuntimeRead = createWorkLimiter(RUNTIME_FILE_READ_CONCURRENCY);
export const limitRuntimeStat = createWorkLimiter(RUNTIME_REUSE_STAT_CONCURRENCY);
export const lstat: typeof filesystemLstat = ((...args: Parameters<typeof filesystemLstat>) =>
  limitRuntimeStat(async () => {
    const result = await filesystemLstat(...args);
    reportRuntimeWork();
    return result;
  })) as typeof filesystemLstat;

export function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`The ${label} is not valid JSON.`);
  }
}

export function sourceProofEntry(
  path: string,
  type: SourcePackageProofEntry["type"],
  details: BigIntStats,
  target?: string,
): SourcePackageProofEntry {
  return {
    path,
    type,
    dev: details.dev.toString(),
    ino: details.ino.toString(),
    nlink: details.nlink.toString(),
    mode: details.mode.toString(),
    size: details.size.toString(),
    mtimeNs: details.mtimeNs.toString(),
    ctimeNs: details.ctimeNs.toString(),
    ...(target === undefined ? {} : { target }),
  };
}

export function sameSourceIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameSourceStats(left: BigIntStats, right: BigIntStats): boolean {
  return sameSourceIdentity(left, right)
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function sameSourceProofEntry(left: SourcePackageProofEntry, right: SourcePackageProofEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function captureFilesystemPathProof(
  path: string,
  logicalPath: string,
): Promise<SourcePackageProofEntry> {
  const before = await lstat(path, { bigint: true });
  const type = before.isSymbolicLink()
    ? "symlink"
    : before.isDirectory()
      ? "directory"
      : before.isFile()
        ? "file"
        : undefined;
  if (type === undefined) {
    throw new Error(`Managed runtime package path ${logicalPath} has an unsupported filesystem type.`);
  }
  const target = type === "symlink" ? await readlink(path) : undefined;
  const [after, targetAfter] = await Promise.all([
    lstat(path, { bigint: true }),
    type === "symlink" ? readlink(path) : Promise.resolve(undefined),
  ]);
  if (
    !sameSourceStats(before, after)
    || (type === "symlink" && (!after.isSymbolicLink() || targetAfter !== target))
    || (type === "directory" && (!after.isDirectory() || after.isSymbolicLink()))
    || (type === "file" && (!after.isFile() || after.isSymbolicLink()))
  ) {
    throw new Error(`Managed runtime package path ${logicalPath} changed while it was inspected.`);
  }
  const portableTarget = target?.split(sep).join("/");
  return sourceProofEntry(logicalPath, type, after, portableTarget);
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (failed || index >= values.length) return;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  // No in-flight work may survive rejection and race staging cleanup/release.
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

function createWorkLimiter(concurrency: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolvePromise) => waiting.push(resolvePromise));
    else active += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next(); // Transfer this permit, keeping the active count unchanged.
    }
  };
}

export function privateRuntimeDirectory(details: BigIntStats): boolean {
  const owned = typeof process.getuid !== "function" || details.uid === BigInt(process.getuid());
  return details.isDirectory()
    && !details.isSymbolicLink()
    && (details.mode & 0o077n) === 0n
    && owned;
}

export function assertPathInsideRoot(root: string, path: string, label: string): void {
  const pathRelative = relative(resolve(root), resolve(path));
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    throw new Error(`Managed runtime ${label} escapes its private root.`);
  }
}

export function fileMode(mode: number | bigint): string {
  return (Number(mode) & 0o777).toString(8).padStart(4, "0");
}

export async function assertRegularFile(path: string, label: string): Promise<void> {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    throw new Error(`Cannot inspect ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} at ${path} must be a regular, non-symlink file.`);
  }
}

export function ownedPrivately(details: Awaited<ReturnType<typeof lstat>>): boolean {
  const owned = typeof process.getuid !== "function" || Number(details.uid) === process.getuid();
  return owned && (Number(details.mode) & 0o077) === 0;
}

export function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
