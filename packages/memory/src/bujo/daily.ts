import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { parseDailyFile, serializeBullet, serializeDailyFile } from "./grammar.js";
import type { Bullet } from "./types.js";

export function dailyFilePath(root: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return join(root, "daily", `${day}.md`);
}

export function auditFilePath(root: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return join(root, "audit", `${day}.md`);
}

export function normalizedContentHash(text: string): string {
  const normalized = text.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Append a bullet to today's daily file (creating it with a heading if absent). Returns the bullet. */
export function appendBullet(root: string, bullet: Bullet, when: Date): Bullet {
  const path = dailyFilePath(root, when);
  mkdirSync(dirname(path), { recursive: true });
  // existsSync (not read-and-catch) so a permission/IO error surfaces instead of being mistaken for a new file.
  const header = existsSync(path) ? "" : `# ${when.toISOString().slice(0, 10)}\n\n`;
  appendFileSync(path, `${header}${serializeBullet(bullet)}\n`, "utf8");
  return bullet;
}

/** Append an immutable raw host observation outside the curated recall source. */
export function appendAuditBullet(root: string, bullet: Bullet, when: Date): Bullet {
  const path = auditFilePath(root, when);
  mkdirSync(dirname(path), { recursive: true });
  const header = existsSync(path) ? "" : `# ${when.toISOString().slice(0, 10)}\n\n`;
  appendFileSync(path, `${header}${serializeBullet(bullet)}\n`, "utf8");
  return bullet;
}

/**
 * Serialize Journal's markdown append + SQLite hash reservation across local
 * processes. A stale marker is recovered only when its owning pid is gone.
 */
export function withJournalWriteLock<T>(root: string, write: () => T): T {
  const lockPath = join(root, ".journal-write.lock");
  mkdirSync(root, { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLockOwner(lockPath);
      if (existing?.pid !== undefined && processIsAlive(existing.pid)) {
        throw new Error(`memory-bujo: journal write lock is held by pid ${existing.pid}.`);
      }
      // A missing/malformed freshly-published owner is treated as locked. Only
      // an identity-stable file older than the stale grace can be reclaimed.
      if (existing === undefined || Date.now() - existing.mtimeMs < 30_000 || !unlinkIfSame(lockPath, existing)) {
        throw new Error("memory-bujo: journal write lock is held or has an unverified owner.");
      }
    }
  }
  if (fd === undefined) throw new Error("memory-bujo: could not acquire journal write lock.");
  const identity = fstatSync(fd);
  try {
    writeSync(fd, `${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`, null, "utf8");
    fsyncSync(fd);
    return write();
  } finally {
    try {
      const current = lstatSync(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
    } catch {
      // A removed/replaced lock is not ours to clean up.
    }
    closeSync(fd);
  }
}

interface LockOwner {
  readonly pid?: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const before = lstatSync(lockPath);
    let pid: number | undefined;
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
      const value = Number(parsed.pid);
      if (Number.isInteger(value) && value > 0) pid = value;
    } catch {
      // Preserve stable identity/mtime so an abandoned malformed lock can be
      // reclaimed after the grace period without stealing a fresh publish.
    }
    const after = lstatSync(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino) return undefined;
    return {
      ...(pid === undefined ? {} : { pid }),
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

function unlinkIfSame(lockPath: string, owner: LockOwner): boolean {
  try {
    const current = lstatSync(lockPath);
    if (current.dev !== owner.dev || current.ino !== owner.ino) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Rewrite a single bullet inside an existing daily file.
 *
 * Reads `<root>/<file>`, parses it, finds the line whose `bullet.id === id`,
 * applies `patch` onto that Bullet (object spread), serializes and writes back.
 *
 * Returns `true` if the bullet was found and the file was rewritten, `false` if
 * no bullet with `id` was found (file is not modified in that case).
 *
 * Non-bullet lines (prose, headings, blank lines) are preserved verbatim.
 */
export function rewriteBullet(
  root: string,
  file: string,
  id: string,
  patch: Partial<Pick<Bullet, "text" | "status" | "salience" | "isInsight" | "dueAt" | "refs">>,
): boolean {
  const path = join(root, file);
  const content = readFileSync(path, "utf8");
  const parsed = parseDailyFile(content);

  let found = false;
  const newLines = parsed.lines.map((line) => {
    if (line.bullet === undefined || line.bullet.id !== id) return line;
    found = true;
    // Build the merged bullet by applying only the defined patch keys so that
    // exactOptionalPropertyTypes is satisfied (no undefined values injected).
    const merged: Bullet = { ...line.bullet, ...patch };
    return { raw: line.raw, lineNumber: line.lineNumber, bullet: merged };
  });

  if (!found) return false;

  writeFileSync(path, serializeDailyFile({ lines: newLines }), "utf8");
  return true;
}
