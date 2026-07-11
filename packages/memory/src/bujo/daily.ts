import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import { parseDailyFile, serializeBullet, serializeDailyFile } from "./grammar.js";
import {
  appendCanonicalFile,
  assertCanonicalDailySourcePath,
  canonicalMemoryRootPath,
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
} from "./path-safety.js";
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
  const day = when.toISOString().slice(0, 10);
  appendCanonicalFile(root, `daily/${day}.md`, (existingSize) => {
    const header = existingSize === 0 ? `# ${day}\n\n` : "";
    return `${header}${serializeBullet(bullet)}\n`;
  });
  return bullet;
}

/** Append an immutable raw host observation outside the curated recall source. */
export function appendAuditBullet(root: string, bullet: Bullet, when: Date): Bullet {
  const day = when.toISOString().slice(0, 10);
  appendCanonicalFile(root, `audit/${day}.md`, (existingSize) => {
    const header = existingSize === 0 ? `# ${day}\n\n` : "";
    return `${header}${serializeBullet(bullet)}\n`;
  });
  return bullet;
}

/**
 * Serialize Journal's markdown append + SQLite hash reservation across local
 * processes. A stale marker is recovered only when its owning pid is gone.
 */
export function withJournalWriteLock<T>(root: string, write: () => T): T {
  const canonicalRoot = canonicalMemoryRootPath(root, true);
  const lockPath = join(canonicalRoot, ".journal-write.lock");
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const opened = fstatSync(fd);
      if (!safeOwnedLock(opened)) throw new Error("memory-bujo: journal write lock has an unsafe identity.");
      const published = lstatSync(lockPath);
      if (published.dev !== opened.dev || published.ino !== opened.ino) {
        throw new Error("memory-bujo: journal write lock was replaced during acquisition.");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (fd !== undefined) {
          try {
            const opened = fstatSync(fd);
            const current = lstatSync(lockPath);
            if (current.dev === opened.dev && current.ino === opened.ino) unlinkSync(lockPath);
          } catch {
            // Never unlink an identity we cannot prove is the one just opened.
          }
          try { closeSync(fd); } catch { /* already closed */ }
          fd = undefined;
        }
        throw error;
      }
      const existing = readLockOwner(canonicalRoot);
      if (existing?.pid !== undefined && processIsAlive(existing.pid)) {
        throw new Error(`memory-bujo: journal write lock is held by pid ${existing.pid}.`);
      }
      // A missing/malformed freshly-published owner is treated as locked. Only
      // an identity-stable file older than the stale grace can be reclaimed.
      if (existing === undefined || Date.now() - existing.mtimeMs < 30_000 || !unlinkIfSame(canonicalRoot, existing)) {
        throw new Error("memory-bujo: journal write lock is held or has an unverified owner.");
      }
    }
  }
  if (fd === undefined) throw new Error("memory-bujo: could not acquire journal write lock.");
  const identity = fstatSync(fd);
  try {
    writeSync(fd, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
      token: randomUUID(),
    })}\n`, null, "utf8");
    fsyncSync(fd);
    return write();
  } finally {
    try {
      const current = lstatSync(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) {
        unlinkSync(lockPath);
      }
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

function readLockOwner(root: string): LockOwner | undefined {
  try {
    const snapshot = readCanonicalFileSnapshot(root, ".journal-write.lock", { maxBytes: 4_096 });
    if (snapshot === undefined
      || (snapshot.identity.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) return undefined;
    let pid: number | undefined;
    try {
      const parsed = JSON.parse(snapshot.content) as { pid?: unknown; uid?: unknown };
      if (typeof process.getuid === "function"
        && parsed.uid !== undefined
        && parsed.uid !== process.getuid()) return undefined;
      const value = Number(parsed.pid);
      if (Number.isInteger(value) && value > 0) pid = value;
    } catch {
      // Preserve stable identity/mtime so an abandoned malformed lock can be
      // reclaimed after the grace period without stealing a fresh publish.
    }
    return {
      ...(pid === undefined ? {} : { pid }),
      dev: snapshot.identity.dev,
      ino: snapshot.identity.ino,
      mtimeMs: snapshot.identity.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

function unlinkIfSame(root: string, owner: LockOwner): boolean {
  const lockPath = join(root, ".journal-write.lock");
  try {
    const current = lstatSync(lockPath);
    if (!safeOwnedLock(current) || current.dev !== owner.dev || current.ino !== owner.ino) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function safeOwnedLock(stat: Stats): boolean {
  return !stat.isSymbolicLink()
    && stat.isFile()
    && stat.nlink === 1
    && (stat.mode & 0o777) === 0o600
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
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
  assertCanonicalDailySourcePath(file);
  const snapshot = readCanonicalFileSnapshot(root, file);
  if (snapshot === undefined) throw new Error(`memory-bujo: canonical rewrite source "${file}" is missing.`);
  const parsed = parseDailyFile(snapshot.content);

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

  writeCanonicalFileAtomic(root, file, serializeDailyFile({ lines: newLines }), snapshot.identity);
  return true;
}

/** Read one exact canonical bullet without following links or accepting non-daily paths. */
export function readBullet(root: string, file: string, id: string): Bullet | undefined {
  assertCanonicalDailySourcePath(file);
  const snapshot = readCanonicalFileSnapshot(root, file);
  if (snapshot === undefined) throw new Error(`memory-bujo: canonical source "${file}" is missing.`);
  return parseDailyFile(snapshot.content).bullets.find((bullet) => bullet.id === id);
}
