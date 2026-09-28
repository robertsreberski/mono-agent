import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

/**
 * Owner-only, versioned `node:sqlite` state under an agent's `.mono-agent/`.
 *
 * A smaller sibling of the cron control store's secure pattern for app-owned
 * state that has no initialization marker protocol: the directory and files
 * must be real, single-link, owned by the current user and not readable by
 * anyone else; the schema version is checked on every open; a writer holds an
 * exclusive SQLite lease so two live processes never own the same state; and
 * anything unexpected fails closed instead of being repaired silently.
 */

export type OwnedStateErrorKind = "corrupt" | "insecure" | "lease_conflict" | "unsupported_schema";

export class OwnedStateError extends Error {
  readonly kind: OwnedStateErrorKind;

  constructor(kind: OwnedStateErrorKind, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "OwnedStateError";
    this.kind = kind;
  }
}

export interface OwnedStatePaths {
  readonly root: string;
  readonly database: string;
  readonly lease: string;
}

const DATABASE_FILE = "state.sqlite";
const LEASE_FILE = "lease.sqlite";
const READ_BUSY_TIMEOUT_MS = 500;
const WRITE_BUSY_TIMEOUT_MS = 5_000;

/** `<cwd>/.mono-agent/<name>` and its database/lease files. */
export function resolveOwnedStatePaths(cwd: string, name: string): OwnedStatePaths {
  return ownedStatePathsAt(resolve(cwd, ".mono-agent", name));
}

export function ownedStatePathsAt(root: string): OwnedStatePaths {
  return { root, database: join(root, DATABASE_FILE), lease: join(root, LEASE_FILE) };
}

export interface OpenOwnedStateOptions {
  readonly cwd: string;
  /** Directory name under `.mono-agent/`, e.g. `telegram-topics-v1`. */
  readonly name: string;
  /** Human label used in diagnostics. */
  readonly label: string;
  readonly schemaVersion: number;
  /** Create every table; runs once, inside a transaction, on an empty database. */
  readonly createSchema: (database: DatabaseSync) => void;
}

export interface OwnedStateHandle {
  readonly paths: OwnedStatePaths;
  readonly database: DatabaseSync;
  /** Run `operation` in one `BEGIN IMMEDIATE` transaction. */
  transaction<T>(operation: () => T): T;
  close(): void;
}

/**
 * Open (creating when absent) the writer side of an owned state directory and
 * take its exclusive lease. Throws {@link OwnedStateError} with
 * `lease_conflict` when another live process already owns it.
 */
export async function openOwnedState(options: OpenOwnedStateOptions): Promise<OwnedStateHandle> {
  const canonicalCwd = await realpath(resolve(options.cwd));
  const paths = resolveOwnedStatePaths(canonicalCwd, options.name);
  await ensureOwnedRoot(paths.root, options.label);
  await ensureOwnedFile(paths.database, options.label);
  await ensureOwnedFile(paths.lease, options.label);

  const lease = new DatabaseSync(paths.lease, { timeout: 0 });
  try {
    lease.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (error) {
    lease.close();
    throw new OwnedStateError(
      "lease_conflict",
      `${options.label} is already owned by another live process: ${paths.root}`,
      { cause: error },
    );
  }
  const releaseLease = (): void => {
    try {
      if (lease.isTransaction) lease.exec("ROLLBACK");
    } finally {
      lease.close();
    }
  };

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(paths.database, { timeout: WRITE_BUSY_TIMEOUT_MS });
  } catch (error) {
    releaseLease();
    throw new OwnedStateError("corrupt", `${options.label} database cannot be opened: ${paths.database}`, { cause: error });
  }
  try {
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;");
    assertHealthy(database, options.label);
    const version = userVersion(database);
    if (version === 0) {
      if (userTableNames(database).length > 0) {
        throw new OwnedStateError("corrupt", `${options.label} database has tables but no schema version.`);
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        options.createSchema(database);
        database.exec(`PRAGMA user_version=${String(options.schemaVersion)}`);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    } else if (version !== options.schemaVersion) {
      throw new OwnedStateError(
        "unsupported_schema",
        `${options.label} schema version ${String(version)} is not supported (expected ${String(options.schemaVersion)}).`,
      );
    }
  } catch (error) {
    database.close();
    releaseLease();
    throw error;
  }

  let closed = false;
  return {
    paths,
    database,
    transaction<T>(operation: () => T): T {
      if (closed) throw new OwnedStateError("corrupt", `${options.label} is closed.`);
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = operation();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } finally {
        releaseLease();
      }
    },
  };
}

/**
 * Open an existing owned state database read-only without taking its lease.
 * Returns undefined when the state was never created. The same ownership and
 * schema checks apply; readers never create or repair anything.
 */
export async function openOwnedStateReadOnly(
  root: string,
  label: string,
  schemaVersion: number,
): Promise<DatabaseSync | undefined> {
  // Canonicalize everything above the state directory itself (e.g. macOS
  // /var -> /private/var); a link AT the state directory is still rejected.
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(resolve(root)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const paths = ownedStatePathsAt(join(canonicalParent, basename(root)));
  const rootInfo = await lstatIfPresent(paths.root);
  if (rootInfo === undefined) return undefined;
  assertOwnedDirectory(rootInfo, paths.root, label);
  if (await realpath(paths.root) !== paths.root) {
    throw new OwnedStateError("insecure", `${label} path contains a symbolic-link hop: ${paths.root}`);
  }
  if (await lstatIfPresent(paths.database) === undefined) return undefined;
  await assertOwnedFile(paths.database, label);
  const database = new DatabaseSync(paths.database, { readOnly: true, timeout: READ_BUSY_TIMEOUT_MS });
  try {
    const version = userVersion(database);
    if (version === 0) {
      database.close();
      return undefined;
    }
    if (version !== schemaVersion) {
      throw new OwnedStateError(
        "unsupported_schema",
        `${label} schema version ${String(version)} is not supported (expected ${String(schemaVersion)}).`,
      );
    }
    return database;
  } catch (error) {
    if (database.isOpen) database.close();
    throw error;
  }
}

async function ensureOwnedRoot(root: string, label: string): Promise<void> {
  const parent = dirname(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new OwnedStateError("insecure", `${label} parent is not a real directory: ${parent}`);
  }
  assertOwner(parentInfo, parent, label);
  // Another user able to write the parent could swap our directory out.
  if (process.platform !== "win32" && (parentInfo.mode & 0o022) !== 0) {
    throw new OwnedStateError("insecure", `${label} parent is writable by other users: ${parent}`);
  }
  if (await realpath(parent) !== parent) {
    throw new OwnedStateError("insecure", `${label} parent contains a symbolic-link hop: ${parent}`);
  }
  if (await lstatIfPresent(root) === undefined) {
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  assertOwnedDirectory(await lstat(root), root, label);
  if (await realpath(root) !== root) {
    throw new OwnedStateError("insecure", `${label} path contains a symbolic-link hop: ${root}`);
  }
}

async function ensureOwnedFile(path: string, label: string): Promise<void> {
  if (await lstatIfPresent(path) === undefined) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  await assertOwnedFile(path, label);
}

async function assertOwnedFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new OwnedStateError("insecure", `${label} file is not a single-link regular file: ${path}`);
  }
  assertOwner(info, path, label);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new OwnedStateError("insecure", `${label} file permissions are not owner-only: ${path}`);
  }
}

function assertOwnedDirectory(info: Stats, path: string, label: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new OwnedStateError("insecure", `${label} path is not a real directory: ${path}`);
  }
  assertOwner(info, path, label);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new OwnedStateError("insecure", `${label} directory permissions are not owner-only: ${path}`);
  }
}

function assertOwner(info: { readonly uid: number }, path: string, label: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new OwnedStateError("insecure", `${label} path is not owned by the current user: ${path}`);
  }
}

function assertHealthy(database: DatabaseSync, label: string): void {
  const check = database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
  if (check === undefined || Object.values(check)[0] !== "ok") {
    throw new OwnedStateError("corrupt", `${label} database failed its integrity check.`);
  }
}

function userVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

function userTableNames(database: DatabaseSync): readonly string[] {
  return (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
