import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { snapshot, unchanged, privateTemp, protectBackup } from "./settings-json-files.js";
import { syncDirectory } from "./sync-directory.js";
import { withSettingsJsonLock } from "./settings-json-lock.js";
export { withSettingsJsonLock } from "./settings-json-lock.js";
import type { SettingsJson } from "./types.js";
import { findDuplicateJsonKeyPaths, readSettingsJson, SettingsJsonError } from "./json-read.js";

export interface GuardedSettingsJsonWrite {
  readonly expectedVersion: string;
  /** Must validate the entire rebuilt candidate, not just the owned patch. No runtime starts. */
  readonly validate: (candidate: SettingsJson, candidatePath: string) => Promise<void>;
  /** Fixed, content-free audit line; never pass config values or paths. */
  readonly log?: (message: string) => void;
}
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const refuse = (): never => { throw new SettingsJsonError("unsafe_config_write", "Configuration write refused; inspect the config and backup in the owner terminal."); };
const conflict = (): never => { throw new SettingsJsonError("config_conflict", "Configuration changed; refresh the preview."); };

/** Opt-in optimistic, private-backup publication. Legacy patch semantics stay unchanged. */
export async function writeGuardedSettingsJson(
  path: string, candidate: (existing: SettingsJson) => SettingsJson, guard: GuardedSettingsJsonWrite,
): Promise<{ readonly version: string }> {
  path = resolve(path);
  const directoryPath = dirname(path);
  const directoryIdentity = await lstat(directoryPath);
  const assertDirectory = async (): Promise<void> => {
    const current = await lstat(directoryPath);
    if (!current.isDirectory() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
      || (current.mode & 0o022) !== 0 || (process.getuid !== undefined && current.uid !== process.getuid())
      || await realpath(directoryPath) !== directoryPath) refuse();
  };
  await assertDirectory();
  return await withSettingsJsonLock(path, async () => {
    const before = await snapshot(path);
    const version = before === undefined ? "" : digest(before.bytes);
    if (version !== guard.expectedVersion) conflict();
    const source = await readSettingsJson(path);
    if (source.version !== version) conflict();
    if (source.duplicateKeyPaths.length > 0) refuse();
    const rebuilt = candidate(source.json);
    const serialized = `${JSON.stringify(rebuilt, null, 2)}\n`;
    if (findDuplicateJsonKeyPaths(serialized).length > 0) refuse();
    const resultHash = digest(serialized);
    // Ignore secret-bearing candidate temps before they exist, not only before backup publication.
    await protectBackup(path);
    const temp = await privateTemp(path, serialized);
    try {
      await guard.validate(rebuilt, temp);
      await unchanged(path, before);
      await protectBackup(path);
      const backupPath = `${path}.bak`;
      const backupBefore = await snapshot(backupPath);
      const backupTemp = await privateTemp(path, `${JSON.stringify({ version: 1, previousMissing: before === undefined, previousBase64: (before?.bytes ?? Buffer.alloc(0)).toString("base64"), intendedSha256: resultHash })}\n`);
      try { await unchanged(backupPath, backupBefore); await rename(backupTemp, backupPath); }
      finally { await unlink(backupTemp).catch(() => undefined); }
      try {
        await assertDirectory();
        await unchanged(path, before);
        // Check immediately before rename. Uncooperative editors can still race this
        // final await; the .bak envelope retains the prior bytes for recovery.
        await rename(temp, path);
        await syncDirectory(directoryPath);
      } catch (error) {
        // A save that never publishes its config must not leave a slot for
        // bytes no file ever had: restore the previous backup state, or clear
        // the slot when there was none, before reporting the failure.
        try {
          if (backupBefore === undefined) {
            await unlink(backupPath).catch(() => undefined);
          } else {
            const restoreTemp = await privateTemp(path, backupBefore.bytes);
            try { await rename(restoreTemp, backupPath); }
            finally { await unlink(restoreTemp).catch(() => undefined); }
          }
          await syncDirectory(directoryPath);
        } catch { /* Best effort: the throw below reports the save failure. */ }
        throw error;
      }
    } finally { await unlink(temp).catch(() => undefined); }
    // Logging must not turn a committed write into a reported failure.
    try { guard.log?.("Capability configuration saved; activation requires a fresh start."); } catch { /* committed */ }
    return { version: resultHash };
  });
}

/** The single private backup slot published by a guarded console save. */
export interface SettingsJsonBackup {
  readonly version: 1;
  readonly previousMissing: boolean;
  readonly previousBase64: string;
  readonly intendedSha256: string;
}

export type SettingsJsonBackupRead =
  | { readonly status: "missing" }
  | { readonly status: "corrupt" }
  | { readonly status: "unreadable" }
  | { readonly status: "ok"; readonly backup: SettingsJsonBackup };

const BACKUP_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Read-only backup inspection for Undo eligibility. Absent, malformed and unreadable slots degrade only the Undo action, never the Enable actions. */
export async function readSettingsJsonBackup(path: string): Promise<SettingsJsonBackupRead> {
  const backupPath = `${resolve(path)}.bak`;
  try {
    const stat = await lstat(backupPath);
    if (!stat.isFile()) return { status: "unreadable" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }
  let raw: string;
  try {
    raw = await readFile(backupPath, "utf8");
  } catch {
    return { status: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Not a backup envelope.");
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || typeof record.previousMissing !== "boolean"
      || typeof record.previousBase64 !== "string" || !BACKUP_BASE64_RE.test(record.previousBase64)
      || record.previousBase64.length % 4 !== 0
      || typeof record.intendedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.intendedSha256)
      || Object.keys(record).some((key) => !["version", "previousMissing", "previousBase64", "intendedSha256"].includes(key))) {
      throw new Error("Not a backup envelope.");
    }
    return { status: "ok", backup: { version: 1, previousMissing: record.previousMissing, previousBase64: record.previousBase64, intendedSha256: record.intendedSha256 } };
  } catch {
    return { status: "corrupt" };
  }
}

/**
 * One-level Undo: publish the exact prior bytes through the guarded protocol,
 * then consume the backup slot so an Undo is never itself undoable. The fence
 * (current bytes must still hash to the backup's intended result) is checked by
 * the caller during preview and rechecked here under the writer lock.
 */
export async function restoreGuardedSettingsJson(
  path: string, prior: Buffer, guard: GuardedSettingsJsonWrite,
): Promise<{ readonly version: string }> {
  path = resolve(path);
  const directoryPath = dirname(path);
  const directoryIdentity = await lstat(directoryPath);
  const assertDirectory = async (): Promise<void> => {
    const current = await lstat(directoryPath);
    if (!current.isDirectory() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
      || (current.mode & 0o022) !== 0 || (process.getuid !== undefined && current.uid !== process.getuid())
      || await realpath(directoryPath) !== directoryPath) refuse();
  };
  await assertDirectory();
  return await withSettingsJsonLock(path, async () => {
    const before = await snapshot(path);
    const version = before === undefined ? "" : digest(before.bytes);
    if (version !== guard.expectedVersion) conflict();
    const source = await readSettingsJson(path);
    if (source.version !== version) conflict();
    if (source.duplicateKeyPaths.length > 0) refuse();
    const text = prior.toString("utf8");
    let candidate: unknown;
    try {
      candidate = text.trim().length === 0 ? {} : JSON.parse(text);
    } catch { refuse(); }
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) refuse();
    if (findDuplicateJsonKeyPaths(text.trim().length === 0 ? "{}" : text).length > 0) refuse();
    const resultHash = digest(prior);
    // Ignore secret-bearing candidate temps before they exist, not only before backup publication.
    await protectBackup(path);
    const temp = await privateTemp(path, prior);
    try {
      await guard.validate(candidate as SettingsJson, temp);
      await unchanged(path, before);
      await protectBackup(path);
      const backupPath = `${path}.bak`;
      const backupBefore = await snapshot(backupPath);
      await unchanged(backupPath, backupBefore);
      await assertDirectory();
      await unchanged(path, before);
      // Publish first: a failed rename leaves the config and the slot
      // untouched, so Undo stays usable and the failure is a definite
      // refusal, never an uncertain outcome.
      try {
        await rename(temp, path);
      } catch {
        conflict();
      }
      try {
        await syncDirectory(directoryPath);
        // Consume the one-level slot only after publication. A crash here
        // leaves a stale-fenced slot (current bytes no longer match the
        // recorded result), never a redo: the fence keeps Undo one-level.
        await unlink(backupPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        });
        await syncDirectory(directoryPath);
      } catch (error) {
        await unlink(backupPath).catch(() => undefined);
        throw error;
      }
    } finally { await unlink(temp).catch(() => undefined); }
    // Logging must not turn a committed restore into a reported failure.
    try { guard.log?.("Capability configuration saved; activation requires a fresh start."); } catch { /* committed */ }
    return { version: resultHash };
  });
}
