// Bounded read-only evidence reader, extracted from session-salvage's policy.
import { constants } from "node:fs";
import { lstat, open, realpath, stat as statPath } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const MAX_FILE = 32 * 1024 * 1024;
export const MAX_LINE = 2 * 1024 * 1024;
export async function readBoundedJsonl(path, root) {
  const fail = () => { throw new Error("Invalid Pi session evidence"); };
  if (!(await lstat(root)).isDirectory()) fail();
  const canonicalRoot = await realpath(root);
  const before = await lstat(path);
  if (!before.isFile() || before.size > MAX_FILE) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_FILE) fail();
    const canonicalFile = await realpath(path);
    if (!canonicalFile.startsWith(`${resolve(canonicalRoot)}${sep}`)) fail();
    const current = await statPath(canonicalFile);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) fail();
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail();
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail();
  } finally { await handle.close(); }
  const last = bytes.lastIndexOf(10);
  if (last < 0) fail();
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, last)).split("\n");
  if (lines.some((line) => !line || Buffer.byteLength(line) > MAX_LINE)) fail();
  return { records: lines.map((line) => JSON.parse(line)), torn: last !== bytes.length - 1,
    completeBytes: last + 1, identity: { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs } };
}
