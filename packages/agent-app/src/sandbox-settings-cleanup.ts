import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

/**
 * Remove one persisted sandbox settings directory, and nothing else.
 *
 * This runs against a path read back from durable state, so it treats that path
 * as untrusted input rather than as a filename it wrote itself. Every property
 * the real path has is re-proved before anything is deleted: the exact
 * `settings.json` basename, the generated parent directory name, a parent that
 * canonicalizes to a known sandbox root, owner-only permissions, no symlinks,
 * and no unexpected sibling entries. A corrupted record therefore cannot turn
 * recovery into an arbitrary-file delete.
 *
 * Shared by process jobs and monitors so both fail closed identically.
 */
export async function cleanupPersistedSandboxSettings(path: string | null): Promise<boolean> {
  if (path === null) return true;
  const directory = dirname(path);
  if (resolve(path) !== path
    || basename(path) !== "settings.json"
    || !/^mono-agent-srt-settings-[A-Za-z0-9_-]{6,}$/u.test(basename(directory))) {
    return false;
  }
  try {
    const canonicalDirectory = await realpath(directory);
    // macOS exposes the system temporary directory through `/var` while its
    // canonical spelling is `/private/var`. The final generated directory is
    // still lstat-checked below and its canonical parent must be the exact known
    // sandbox root, so requiring the input spelling itself to be canonical adds
    // no safety and makes every legitimate temp profile unreleasable.
    if (!await isAllowedSandboxSettingsDirectory(directory, canonicalDirectory)) {
      return false;
    }
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return false;
    if (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()) return false;
    if (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0) return false;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name !== "settings.json")) return false;
    const settings = entries.find((entry) => entry.name === "settings.json");
    if (settings !== undefined) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false;
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) return false;
    }
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      await lstat(directory);
      return false;
    } catch (directoryError) {
      return (directoryError as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
}

async function isAllowedSandboxSettingsDirectory(
  directory: string,
  canonicalDirectory: string,
): Promise<boolean> {
  for (const base of [tmpdir(), resolve(homedir(), ".cache")]) {
    try {
      // Require both spellings to be direct children of the same approved root.
      // This permits macOS's fixed `/var` -> `/private/var` system alias without
      // accepting an arbitrary attacker-controlled symlink to the temp root.
      const lexicalBase = resolve(base);
      const canonicalBase = await realpath(base);
      const inputParent = dirname(directory);
      if ((inputParent === lexicalBase || inputParent === canonicalBase)
        && dirname(canonicalDirectory) === canonicalBase) return true;
    } catch { /* unavailable fallback root */ }
  }
  return false;
}
