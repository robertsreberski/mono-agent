import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import process from "node:process";

import { fileIdentity, sameFileIdentity, type FileIdentity } from "./file-identity.js";
import type { TelegramSendToolSettings } from "./types.js";

/** Resolve the upload bytes + filename from exactly one of base64 `data` or a `path`. */
export async function resolveTelegramFileBytes(input: {
  data: string | undefined;
  path: string | undefined;
  resolvedPath?: string;
  filename: string | undefined;
  requireFilename: boolean;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const hasData = input.data !== undefined;
  const hasPath = input.path !== undefined;
  if (hasData === hasPath) {
    throw new Error("provide exactly one of `data` (base64) or `path`.");
  }
  let bytes: Uint8Array;
  let filename: string;
  if (hasData) {
    bytes = new Uint8Array(Buffer.from(input.data!, "base64"));
    if (input.filename === undefined) {
      if (input.requireFilename) {
        throw new Error("`filename` is required when sending a document by `data`.");
      }
      filename = "image";
    } else {
      filename = input.filename;
    }
  } else {
    const resolved = input.resolvedPath ?? resolvePath(process.cwd(), input.path!);
    bytes = new Uint8Array(await readFile(resolved, { signal: input.signal }));
    filename = input.filename ?? basename(resolved);
  }
  if (bytes.byteLength === 0) {
    throw new Error("file is empty.");
  }
  if (bytes.byteLength > input.maxBytes) {
    throw new Error(`file exceeds the ${String(input.maxBytes)}-byte upload cap.`);
  }
  return { bytes, filename };
}

export async function resolveTelegramUploadPath(inputPath: string): Promise<string> {
  return resolvePath(process.cwd(), inputPath);
}

const STRICT_TELEGRAM_PATH_ERROR =
  "TelegramSendFile: path must be a regular file inside the current run output directory.";

/**
 * Read a strict upload through one no-follow file descriptor. Every path check
 * deliberately collapses to the same error so callers cannot use the tool as
 * an existence oracle for files outside the run directory.
 */
export async function readStrictTelegramFile(
  settings: TelegramSendToolSettings,
  inputPath: string,
  maxBytes: number,
  signal: AbortSignal,
  requestedFilename: string | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly filename: string }> {
  try {
    signal.throwIfAborted();
    if (settings.runOutputDir === undefined || settings.runOutputIdentity === undefined) {
      throw new Error(STRICT_TELEGRAM_PATH_ERROR);
    }
    const rootStats = await lstat(settings.runOutputDir);
    if (!rootStats.isDirectory()
      || rootStats.isSymbolicLink()
      || !sameFileIdentity(rootStats, settings.runOutputIdentity)) {
      throw new Error(STRICT_TELEGRAM_PATH_ERROR);
    }
    const rootReal = await realpath(settings.runOutputDir);
    const candidate = resolvePath(process.cwd(), inputPath);
    const candidateLinkStats = await lstat(candidate);
    if (!candidateLinkStats.isFile()
      || candidateLinkStats.isSymbolicLink()
      || candidateLinkStats.nlink !== 1) {
      throw new Error(STRICT_TELEGRAM_PATH_ERROR);
    }
    const candidateReal = await realpath(candidate);
    if (!pathIsInside(rootReal, candidateReal)) throw new Error(STRICT_TELEGRAM_PATH_ERROR);

    const handle = await open(candidateReal, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile()
        || openedStats.nlink !== 1
        || openedStats.size === 0
        || openedStats.size > maxBytes) {
        throw new Error(STRICT_TELEGRAM_PATH_ERROR);
      }
      if (!sameFileIdentity(openedStats, fileIdentity(candidateLinkStats))) {
        throw new Error(STRICT_TELEGRAM_PATH_ERROR);
      }
      await assertPinnedCandidate(candidateReal, openedStats);
      await assertUnchangedRunRoot(settings.runOutputDir, rootReal, settings.runOutputIdentity);
      const bytes = await readPinnedBytes(handle, openedStats.size, signal);
      await assertPinnedCandidate(candidateReal, openedStats);
      await assertUnchangedRunRoot(settings.runOutputDir, rootReal, settings.runOutputIdentity);
      const finalStats = await handle.stat();
      if (!sameFileIdentity(finalStats, fileIdentity(openedStats))
        || finalStats.nlink !== 1
        || finalStats.size !== openedStats.size
        || bytes.byteLength === 0
        || bytes.byteLength > maxBytes) {
        throw new Error(STRICT_TELEGRAM_PATH_ERROR);
      }
      return { bytes, filename: requestedFilename ?? basename(candidateReal) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw new Error(STRICT_TELEGRAM_PATH_ERROR);
  }
}

async function readPinnedBytes(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset !== size) throw new Error(STRICT_TELEGRAM_PATH_ERROR);
  return new Uint8Array(bytes);
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function assertPinnedCandidate(
  path: string,
  opened: { readonly dev: number; readonly ino: number },
): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || !sameFileIdentity(current, fileIdentity(opened))) {
    throw new Error(STRICT_TELEGRAM_PATH_ERROR);
  }
}

async function assertUnchangedRunRoot(
  path: string,
  expectedRealPath: string,
  expectedIdentity: FileIdentity,
): Promise<void> {
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, expectedIdentity)) {
    throw new Error(STRICT_TELEGRAM_PATH_ERROR);
  }
  if (await realpath(path) !== expectedRealPath) throw new Error(STRICT_TELEGRAM_PATH_ERROR);
}
