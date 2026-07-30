import { chmodSync, lstatSync } from "node:fs";

/**
 * Every file this package writes itself is owner-only (see path-safety's DEFAULT_FILE_MODE), and
 * the BuJo guards refuse to adopt or rebuild a database family that is not exactly 0600.
 *
 * SQLite is the one writer that does not follow that convention: better-sqlite3 delegates creation
 * to SQLite's C layer, which applies the process umask. Under the common default of 022 the
 * database and its `-wal`/`-shm` sidecars land 0644, so the package's own guards reject the very
 * files it just created — the checks only passed for operators running umask 077.
 *
 * Re-assert the intended mode after any writable open instead of depending on ambient umask.
 */
const SQLITE_FAMILY_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const OWNER_ONLY_FILE_MODE = 0o600;

export function enforceOwnerOnlySqliteFamily(path: string): void {
  if (path === ":memory:" || path === "") {
    return;
  }
  for (const suffix of SQLITE_FAMILY_SUFFIXES) {
    const candidate = `${path}${suffix}`;
    try {
      // Never follow a symlink into chmod'ing something outside the family.
      const stat = lstatSync(candidate);
      if (!stat.isFile() || (stat.mode & 0o777) === OWNER_ONLY_FILE_MODE) {
        continue;
      }
      chmodSync(candidate, OWNER_ONLY_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
