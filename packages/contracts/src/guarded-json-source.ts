import { createHash } from "node:crypto";
import { lstat, realpath, rename, unlink } from "node:fs/promises";
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
      await assertDirectory();
      await unchanged(path, before);
      // Check immediately before rename. Uncooperative editors can still race this
      // final await; the .bak envelope retains the prior bytes for recovery.
      await rename(temp, path);
      await syncDirectory(directoryPath);
    } finally { await unlink(temp).catch(() => undefined); }
    // Logging must not turn a committed write into a reported failure.
    try { guard.log?.("Capability configuration saved; activation requires a fresh start."); } catch { /* committed */ }
    return { version: resultHash };
  });
}
