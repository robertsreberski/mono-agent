// @ts-check
// Streaming JSONL validation plus offset-backed lookup. No transcript/line caps.
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
const fail = () => { throw new Error("Harness journal read unavailable"); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const decoder = new TextDecoder("utf-8", { fatal: true });
const secure = (stat, directory, ownerOnly = true) => {
  if (!(directory ? stat.isDirectory() : stat.isFile()) || (ownerOnly && (stat.mode & 0o077) !== 0)
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail();
};
function parse(bytes) {
  if (!bytes.length) fail();
  // Invalid UTF-8, JSON, memory/size limits remain explicit errors, never omissions.
  return JSON.parse(decoder.decode(bytes));
}
export class JournalReader {
  constructor(path, root, handle, identity, directories, ownerOnly = true) {
    this.path = path; this.root = root; this.handle = handle;
    this.identity = identity; this.directories = directories; this.ownerOnly = ownerOnly;
  }
  /** @param {string} filename @param {string} sessionsRoot @param {{ownerOnly?:boolean}} [options] */
  static async open(filename, sessionsRoot, { ownerOnly = true } = {}) {
    const path = resolve(filename), root = resolve(sessionsRoot);
    if (!path.startsWith(`${root}${sep}`)) fail();
    const directories = new Map();
    for (let directory = dirname(path);;) {
      const identity = await lstat(directory); secure(identity, true, ownerOnly); directories.set(directory, identity);
      if (directory === root) break;
      directory = dirname(directory);
      if (directory.length < root.length) fail();
    }
    const before = await lstat(path); secure(before, false, ownerOnly);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = await handle.stat(); secure(identity, false, ownerOnly);
      const canonicalRoot = await realpath(root);
      if (!same(before, identity) || await realpath(path) !== join(canonicalRoot, relative(root, path))) fail();
      const reader = new JournalReader(path, root, handle, identity, directories, ownerOnly);
      await reader.assertIdentity(); return reader;
    } catch (error) { await handle.close(); throw error; }
  }
  async assertIdentity() {
    for (const [path, identity] of this.directories) {
      const current = await lstat(path); secure(current, true, this.ownerOnly); if (!same(current, identity)) fail();
    }
    const current = await lstat(this.path); secure(current, false, this.ownerOnly);
    const opened = await this.handle.stat(); secure(opened, false, this.ownerOnly);
    if (!same(current, this.identity) || !same(opened, this.identity)) fail();
    return opened;
  }
  /**
   * Consume records one at a time. The callback may retain small catalogs of
   * IDs/offsets; retaining native envelopes would defeat the storage boundary.
   * @param {(record:any, address:{offset:number, length:number}) => Promise<void>|void} visit
   */
  async scan(visit) {
    const before = await this.assertIdentity();
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0, lineOffset = 0, completeBytes = 0, fragments = [], fragmentBytes = 0;
    while (offset < before.size) {
      const { bytesRead } = await this.handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!bytesRead) fail();
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(10, start);
        if (end < 0 || end >= bytesRead) break;
        const last = chunk.subarray(start, end);
        const bytes = fragments.length ? Buffer.concat([...fragments, last], fragmentBytes + last.length) : last;
        await visit(parse(bytes), { offset: lineOffset, length: bytes.length });
        completeBytes = offset + end + 1; lineOffset = completeBytes;
        fragments = []; fragmentBytes = 0; start = end + 1;
      }
      if (start < bytesRead) {
        const fragment = Buffer.from(chunk.subarray(start, bytesRead));
        fragments.push(fragment); fragmentBytes += fragment.length;
      }
      offset += bytesRead;
    }
    const after = await this.assertIdentity();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
    return { identity: before, completeBytes, torn: fragmentBytes > 0 };
  }
  async fingerprint() {
    const before = await this.assertIdentity();
    const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < before.size;) {
      const { bytesRead } = await this.handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!bytesRead) fail(); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await this.assertIdentity();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
    return { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, sha256: hash.digest("hex") };
  }
  async readHeader() {
    const before = await this.assertIdentity();
    let offset = 0, parts = [];
    while (offset < before.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - offset));
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) fail();
      const end = chunk.subarray(0, bytesRead).indexOf(10);
      if (end >= 0) {
        parts.push(chunk.subarray(0, end));
        await this.assertIdentity(); return parse(Buffer.concat(parts));
      }
      parts.push(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    fail();
  }
  /** @param {{offset:number,length:number}} address */
  async read(address) {
    const stat = await this.assertIdentity();
    const { offset, length } = address;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
      || offset + length >= stat.size) fail();
    const bytes = Buffer.alloc(length + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await this.handle.read(bytes, count, bytes.length - count, offset + count);
      if (!bytesRead) fail(); count += bytesRead;
    }
    if (bytes[length] !== 10) fail();
    await this.assertIdentity(); return parse(bytes.subarray(0, length));
  }
  async close() { await this.handle.close(); }
}
