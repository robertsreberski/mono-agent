import type { SecretEnvRefusalCode, InitFileChange } from "./types.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";

import { readVerifiedFile, secureFileReplace } from "../durable-state/secure-file-replace.js";
import { syncDirectoryBestEffort } from "./file-sync.js";

export class SecretEnvPersistenceRefusedError extends Error {
  readonly code: SecretEnvRefusalCode;

  constructor(code: SecretEnvRefusalCode, message: string) {
    super(message);
    this.name = "SecretEnvPersistenceRefusedError";
    this.code = code;
  }
}

export class SecretEnvConcurrentModificationError extends Error {
  readonly ownerPid: number | undefined;
  readonly ownerCreatedAt: string | undefined;
  readonly recoveryPath: string | undefined;

  constructor(
    path: string,
    owner?: { readonly pid: number; readonly createdAt: string },
    recoveryPath?: string,
  ) {
    super(recoveryPath !== undefined
      ? `Secret persistence detected a concurrent or interrupted change to ${path}; bytes were retained at ${recoveryPath}. Inspect both paths before retrying.`
      : owner === undefined
        ? `Refusing to replace ${path} because it changed during secret persistence.`
        : `Secret persistence for ${path} is already held by live PID ${owner.pid} since ${owner.createdAt}; retry after that process exits.`);
    this.name = "SecretEnvConcurrentModificationError";
    this.ownerPid = owner?.pid;
    this.ownerCreatedAt = owner?.createdAt;
    this.recoveryPath = recoveryPath;
  }
}

/** Recover the typed concurrency cause through bounded cleanup-error wrapping. */
export function secretEnvConcurrentModificationCause(
  error: unknown,
): SecretEnvConcurrentModificationError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 16 && current !== undefined && !seen.has(current); depth += 1) {
    if (current instanceof SecretEnvConcurrentModificationError) return current;
    seen.add(current);
    try {
      current = current instanceof Error ? current.cause : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Exact `.env` bytes an operator previously reviewed, used as an optimistic-concurrency guard. */
export type ExpectedSecretEnvRevision =
  | { readonly exists: false }
  | { readonly exists: true; readonly contents: string | Buffer };

interface SecretEnvPersistenceOptions {
  /** Preview the exact safety checks and changes without writing. */
  readonly dryRun?: boolean;
  /** Platform seam used to enforce the Windows fail-closed policy. */
  readonly platform?: NodeJS.Platform;
  /** Filesystem capability seam; defaults to false on Windows and true elsewhere. */
  readonly ownerOnlyPermissionsSupported?: boolean;
  /** Test seam invoked after a temporary file is durable and before optimistic verification. */
  readonly beforeCommit?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
  /** Apply git/path/mode hardening to an existing file even when no values need merging. */
  readonly secureExistingFile?: boolean;
  /** Test seam after all optimistic checks and immediately before identity-bound promotion. */
  readonly beforePromotion?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
  /** Test seam after target claim and immediately before exclusive replacement link. */
  readonly beforeInstallLink?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
  /** Test seam after exclusive replacement link and before claimed-inode cleanup. */
  readonly afterInstallLink?: (targetPath: string, temporaryPath: string) => void | Promise<void>;
  /**
   * Names of supplied keys whose non-empty values may be replaced. Defaults to
   * none, which preserves existing operator values. Only listed keys are ever
   * overwritten; every other non-empty submitted key is reported as skipped.
   * Combine with `expectedEnvRevision` to reject the merge when the file
   * changed since an operator reviewed it.
   */
  readonly replaceKeys?: readonly string[];
  /**
   * Reject the merge when the current `.env` bytes differ from a previously
   * observed revision. Rechecked inside the writer lock before committing.
   */
  readonly expectedEnvRevision?: ExpectedSecretEnvRevision;
}

interface SecretEnvMergeResult {
  readonly changes: readonly InitFileChange[];
  /** Number of supplied values that would be or were written. */
  readonly valuesChanged: number;
  /** Submitted keys whose non-empty values were overwritten. Names only. */
  readonly replacedKeys: readonly string[];
  /** Submitted keys with non-empty values that were left untouched. Names only. */
  readonly skippedKeys: readonly string[];
}

/**
 * Securely merge required secrets into `.env` without replacing non-empty
 * operator values. The destination and its git-ignore guard are preflighted,
 * then each changed file is committed through an exclusive same-directory
 * temporary file. The `.env` commit is always mode 0600 on supported systems.
 *
 * Pass `replaceKeys` to opt into replacing non-empty values, but only for
 * the listed keys. Unrelated keys, comments, and line endings are preserved;
 * ambiguous duplicate or multiline assignments for a targeted key refuse
 * safely instead of corrupting the file. Combine with
 * `expectedEnvRevision` to reject the merge when the file changed since an
 * operator reviewed it. The result reports which keys were replaced and
 * which were skipped, as names only.
 */
export async function mergeSecretEnvFile(
  path: string,
  secretValues: Readonly<Record<string, string>>,
  options: SecretEnvPersistenceOptions = {},
): Promise<SecretEnvMergeResult> {
  const secretEntries = Object.entries(secretValues);
  if (secretEntries.length === 0 && options.secureExistingFile !== true) {
    if (options.expectedEnvRevision === undefined) {
      return { changes: [], valuesChanged: 0, replacedKeys: [], skippedKeys: [] };
    }
    // Nothing would change, but the caller still asked for a revision check:
    // verify it under the writer lock without touching either file.
    await verifyExpectedEnvRevisionAlone(path, options.expectedEnvRevision, options.dryRun === true);
    return { changes: [], valuesChanged: 0, replacedKeys: [], skippedKeys: [] };
  }
  const platform = options.platform ?? process.platform;
  const ownerOnlyPermissionsSupported = options.ownerOnlyPermissionsSupported ?? platform !== "win32";
  if (!ownerOnlyPermissionsSupported) {
    throw new SecretEnvPersistenceRefusedError(
      "owner-only-permissions-unsupported",
      "Automatic secret persistence requires verifiable owner-only file permissions.",
    );
  }

  const renderedValues = new Map<string, string>();
  for (const [name, value] of secretEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new SecretEnvPersistenceRefusedError(
        "invalid-secret-name",
        `Automatic secret persistence refused an invalid environment variable name: ${name}.`,
      );
    }
    renderedValues.set(name, renderDotenvValue(name, value));
  }

  const replaceKeys = new Set<string>();
  for (const key of options.replaceKeys ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new SecretEnvPersistenceRefusedError(
        "invalid-secret-name",
        `Automatic secret persistence refused an invalid environment variable name: ${key}.`,
      );
    }
    replaceKeys.add(key);
  }

  const target = await resolveSafeSecretEnvTarget(path);

  // A dry run has no commit to serialize and must remain write-free. Real
  // persistence holds one same-directory lock across both snapshots, the git
  // safety check, the ignore-file commit, and the env-file commit. Without this
  // boundary two writers can read the same old .env, both pass the optimistic
  // comparison, then rename over one another and silently lose one update.
  return options.dryRun === true
    ? await mergeSecretEnvFileLocked(target.path, path, renderedValues, replaceKeys, target.ownerUid, options)
    : await withSecretEnvFileLock(
        target.path,
        target.ownerUid,
        () => mergeSecretEnvFileLocked(target.path, path, renderedValues, replaceKeys, target.ownerUid, options),
      );
}

/**
 * Verify a previously observed revision without changing either file, so a
 * caller that submits no values still gets a meaningful check. Real
 * verification holds the writer lock; a dry run stays write-free and lock-free.
 */
async function verifyExpectedEnvRevisionAlone(
  reportedPath: string,
  expected: ExpectedSecretEnvRevision,
  dryRun: boolean,
): Promise<void> {
  const target = await resolveSafeSecretEnvTarget(reportedPath);
  const verify = async (): Promise<void> => {
    const snapshot = await readSafeFile(
      target.path,
      "unsafe-env-path",
      "malformed-env",
      target.ownerUid,
      [1],
      reportedPath,
    );
    assertExpectedEnvRevision(snapshot, expected, reportedPath);
  };
  if (dryRun === true) {
    await verify();
    return;
  }
  await withSecretEnvFileLock(target.path, target.ownerUid, verify);
}

async function mergeSecretEnvFileLocked(
  path: string,
  reportedPath: string,
  renderedValues: ReadonlyMap<string, string>,
  replaceKeys: ReadonlySet<string>,
  ownerUid: number,
  options: SecretEnvPersistenceOptions,
): Promise<SecretEnvMergeResult> {
  const envSnapshot = await readSafeFile(
    path,
    "unsafe-env-path",
    "malformed-env",
    ownerUid,
    [1],
    reportedPath,
  );
  if (await isGitTracked(path)) {
    throw new SecretEnvPersistenceRefusedError(
      "tracked-env",
      `Automatic secret persistence refused because ${path} is tracked by git.`,
    );
  }

  if (options.expectedEnvRevision !== undefined) {
    assertExpectedEnvRevision(envSnapshot, options.expectedEnvRevision, reportedPath);
  }

  const existingEnv = snapshotText(envSnapshot);
  const merged = mergeDotenvContents(existingEnv, renderedValues, replaceKeys);
  const envContents = Buffer.from(merged.contents, "utf8");
  const envNeedsWrite = !envSnapshot.exists || !envSnapshot.contents.equals(envContents) || fileMode(envSnapshot) !== 0o600;

  const gitIgnorePath = join(dirname(path), ".gitignore");
  const reportedGitIgnorePath = join(dirname(reportedPath), ".gitignore");
  const gitIgnoreSnapshot = await readSafeFile(
    gitIgnorePath,
    "unsafe-gitignore-path",
    "malformed-gitignore",
    ownerUid,
    [1],
    reportedGitIgnorePath,
  );
  const gitIgnoreContents = Buffer.from(ensureExactEnvIgnore(snapshotText(gitIgnoreSnapshot), basename(path)), "utf8");
  const gitIgnoreMode = gitIgnoreSnapshot.exists
    ? (fileMode(gitIgnoreSnapshot) || 0o644) & ~0o022
    : 0o644;
  const gitIgnoreNeedsWrite = !gitIgnoreSnapshot.exists ||
    !gitIgnoreSnapshot.contents.equals(gitIgnoreContents) ||
    fileMode(gitIgnoreSnapshot) !== gitIgnoreMode;

  const changes: InitFileChange[] = [
    changeFor(reportedGitIgnorePath, gitIgnoreSnapshot.exists, gitIgnoreNeedsWrite, options.dryRun === true),
    { ...changeFor(reportedPath, envSnapshot.exists, envNeedsWrite, options.dryRun === true), sensitive: true },
  ];

  if (options.dryRun === true) {
    return {
      changes,
      valuesChanged: merged.valuesChanged,
      replacedKeys: merged.replacedKeys,
      skippedKeys: merged.skippedKeys,
    };
  }

  if (gitIgnoreNeedsWrite) {
    await atomicReplaceFile({
      path: gitIgnorePath,
      reportedPath: reportedGitIgnorePath,
      contents: gitIgnoreContents,
      expected: gitIgnoreSnapshot,
      ownerUid,
      mode: gitIgnoreMode,
      beforeCommit: options.beforeCommit,
      beforePromotion: options.beforePromotion,
      beforeInstallLink: options.beforeInstallLink,
      afterInstallLink: options.afterInstallLink,
    });
  }
  const committedGitIgnoreSnapshot = gitIgnoreNeedsWrite
    ? await readSafeFile(
        gitIgnorePath,
        "unsafe-gitignore-path",
        "malformed-gitignore",
        ownerUid,
        [1],
        reportedGitIgnorePath,
      )
    : gitIgnoreSnapshot;
  if (
    !committedGitIgnoreSnapshot.exists ||
    !committedGitIgnoreSnapshot.contents.equals(gitIgnoreContents)
  ) {
    throw new SecretEnvConcurrentModificationError(gitIgnorePath);
  }
  if (envNeedsWrite) {
    await atomicReplaceFile({
      path,
      reportedPath,
      contents: envContents,
      expected: envSnapshot,
      ownerUid,
      mode: 0o600,
      verifyOwnerOnly: true,
      beforeCommit: options.beforeCommit,
      beforeRename: async () => {
        if (await isGitTracked(path)) {
          throw new SecretEnvPersistenceRefusedError(
            "tracked-env",
            `Automatic secret persistence refused because ${path} became tracked by git before commit.`,
          );
        }
        await assertSnapshotUnchanged(
          gitIgnorePath,
          reportedGitIgnorePath,
          committedGitIgnoreSnapshot,
          ownerUid,
        );
      },
      beforePromotion: options.beforePromotion,
      beforeInstallLink: options.beforeInstallLink,
      afterInstallLink: options.afterInstallLink,
    });
  }

  return {
    changes,
    valuesChanged: merged.valuesChanged,
    replacedKeys: merged.replacedKeys,
    skippedKeys: merged.skippedKeys,
  };
}

async function withSecretEnvFileLock<T>(
  path: string,
  ownerUid: number,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = await secretEnvLockPathForCanonical(path, ownerUid);
  const owner: SecretEnvLockOwner = {
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerUid,
    token: randomUUID(),
  };
  const lock = await acquireSecretEnvLock(path, lockPath, owner);
  try {
    return await task();
  } finally {
    try {
      await lock.handle.close();
    } finally {
      await releaseSecretEnvLock(lockPath, lock);
    }
  }
}

interface SecretEnvLockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly createdAt: string;
  readonly ownerUid: number;
  readonly token: string;
}

interface SecretEnvLockSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly contents: Buffer;
  readonly owner: SecretEnvLockOwner;
}

interface AcquiredSecretEnvLock extends SecretEnvLockSnapshot {
  readonly handle: FileHandle;
}

const MAX_SECRET_ENV_LOCK_BYTES = 4096;
const MAX_SECRET_ENV_LOCK_ACQUIRE_ATTEMPTS = 4;

async function acquireSecretEnvLock(
  envPath: string,
  lockPath: string,
  owner: SecretEnvLockOwner,
): Promise<AcquiredSecretEnvLock> {
  for (let attempt = 0; attempt < MAX_SECRET_ENV_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ELOOP") throw error;
      let existing: SecretEnvLockSnapshot | undefined;
      try {
        existing = await readSecretEnvLockSnapshot(lockPath, owner.ownerUid);
      } catch (readError) {
        // O_EXCL publishes the directory entry just before its owner record is
        // written. Give that tiny creation window a bounded retry so a real
        // concurrent owner is reported as live instead of as malformed.
        if (
          readError instanceof SecretEnvPersistenceRefusedError &&
          readError.code === "unsafe-lock-path" &&
          attempt + 1 < MAX_SECRET_ENV_LOCK_ACQUIRE_ATTEMPTS
        ) {
          await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, 10));
          continue;
        }
        throw readError;
      }
      if (existing === undefined) continue;
      const ownerState = secretEnvLockOwnerState(existing.owner.pid);
      if (ownerState === "live") {
        throw new SecretEnvConcurrentModificationError(envPath, existing.owner);
      }
      if (ownerState === "unknown") {
        throw unsafeSecretEnvLockError(
          lockPath,
          `the owner process state for PID ${existing.owner.pid} could not be verified`,
        );
      }
      throw unsafeSecretEnvLockError(
        lockPath,
        `the recorded owner PID ${existing.owner.pid} is no longer running`,
      );
    }

    const contents = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
    let identity: { readonly dev: number; readonly ino: number } | undefined;
    try {
      const initialStat = await handle.stat();
      identity = { dev: initialStat.dev, ino: initialStat.ino };
      assertSecretEnvLockFileStat(lockPath, initialStat, owner.ownerUid);
      await handle.writeFile(contents);
      await handle.sync();
      const writtenStat = await handle.stat();
      assertSecretEnvLockFileStat(lockPath, writtenStat, owner.ownerUid);
      if (
        writtenStat.dev !== initialStat.dev ||
        writtenStat.ino !== initialStat.ino ||
        writtenStat.size !== contents.length
      ) {
        throw unsafeSecretEnvLockError(lockPath, "the durable owner record changed while it was being created");
      }
      await syncDirectoryBestEffort(dirname(lockPath));
      return {
        handle,
        dev: writtenStat.dev,
        ino: writtenStat.ino,
        contents,
        owner,
      };
    } catch (error) {
      try {
        await handle.close();
      } finally {
        if (identity !== undefined) {
          await removeSecretEnvLockWithIdentity(lockPath, identity);
        }
      }
      throw error;
    }
  }
  throw new SecretEnvConcurrentModificationError(envPath);
}

function currentProcessUid(lockPath: string): number {
  if (typeof process.getuid !== "function") {
    throw unsafeSecretEnvLockError(lockPath, "the current operating-system user id is unavailable");
  }
  return process.getuid();
}

function assertSecretEnvLockFileStat(
  lockPath: string,
  lockStat: Stats,
  ownerUid: number,
): void {
  if (
    !lockStat.isFile() ||
    lockStat.uid !== ownerUid ||
    (lockStat.mode & 0o777) !== 0o600 ||
    lockStat.nlink !== 1
  ) {
    throw unsafeSecretEnvLockError(lockPath, "it is not a same-user, owner-only regular file with one link");
  }
}

async function readSecretEnvLockSnapshot(
  lockPath: string,
  ownerUid: number,
): Promise<SecretEnvLockSnapshot | undefined> {
  let pathStat;
  try {
    pathStat = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.uid !== ownerUid ||
    (pathStat.mode & 0o777) !== 0o600 ||
    pathStat.nlink !== 1
  ) {
    throw unsafeSecretEnvLockError(lockPath, "same-user ownership and owner-only regular-file identity could not be proven");
  }
  if (pathStat.size <= 0 || pathStat.size > MAX_SECRET_ENV_LOCK_BYTES) {
    throw unsafeSecretEnvLockError(lockPath, "the durable owner record has an invalid size");
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const handleStat = await handle.stat();
    assertSecretEnvLockFileStat(lockPath, handleStat, ownerUid);
    if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) return undefined;
    const contents = await handle.readFile();
    if (contents.length !== handleStat.size) return undefined;
    const owner = parseSecretEnvLockOwner(lockPath, contents, ownerUid);
    return { dev: handleStat.dev, ino: handleStat.ino, contents, owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw unsafeSecretEnvLockError(lockPath, "the lock path became a symbolic link");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseSecretEnvLockOwner(
  lockPath: string,
  contents: Buffer,
  ownerUid: number,
): SecretEnvLockOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
  } catch {
    throw unsafeSecretEnvLockError(lockPath, "the durable owner record is not valid UTF-8 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unsafeSecretEnvLockError(lockPath, "the durable owner record is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const createdAtMs = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : Number.NaN;
  if (
    record.version !== 1 ||
    !Number.isInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.createdAt !== "string" ||
    record.createdAt.length > 64 ||
    !Number.isFinite(createdAtMs) ||
    record.ownerUid !== ownerUid ||
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    record.token.length > 128
  ) {
    throw unsafeSecretEnvLockError(lockPath, "the durable owner record is malformed or belongs to another user");
  }
  return {
    version: 1,
    pid: record.pid as number,
    createdAt: record.createdAt,
    ownerUid,
    token: record.token,
  };
}

function secretEnvLockOwnerState(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

async function releaseSecretEnvLock(
  lockPath: string,
  expected: SecretEnvLockSnapshot,
): Promise<void> {
  let current: SecretEnvLockSnapshot | undefined;
  try {
    current = await readSecretEnvLockSnapshot(lockPath, expected.owner.ownerUid);
  } catch {
    // Never remove a path whose ownership changed while this process held the
    // original descriptor; it may now be another process's live lock.
    return;
  }
  if (current === undefined || !sameSecretEnvLockSnapshot(current, expected)) return;
  try {
    await rm(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await syncDirectoryBestEffort(dirname(lockPath));
}

export async function resolveSafeSecretEnvTarget(
  path: string,
): Promise<{ readonly path: string; readonly ownerUid: number }> {
  const canonicalParent = await realpath(dirname(path));
  const ownerUid = currentProcessUid(canonicalParent);
  const pathStat = await lstat(canonicalParent);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      canonicalParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const handleStat = await handle.stat();
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      !handleStat.isDirectory() ||
      pathStat.dev !== handleStat.dev ||
      pathStat.ino !== handleStat.ino ||
      handleStat.uid !== ownerUid ||
      (handleStat.mode & 0o022) !== 0
    ) {
      throw new SecretEnvPersistenceRefusedError(
        "unsafe-env-path",
        `Automatic secret persistence requires parent directory ${canonicalParent} to be owned by the current user and not group/world-writable.`,
      );
    }
  } finally {
    await handle?.close();
  }
  return { path: join(canonicalParent, basename(path)), ownerUid };
}

export async function secretEnvLockPathForCanonical(path: string, ownerUid: number): Promise<string> {
  const root = join(tmpdir(), `mono-agent-secret-env-locks-${ownerUid}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.uid !== ownerUid ||
    (rootStat.mode & 0o077) !== 0
  ) {
    throw unsafeSecretEnvLockError(root, "the repository-external lock directory is not private to the current user");
  }
  const key = createHash("sha256")
    .update(dirname(path))
    .update("\0")
    .update(basename(path))
    .digest("hex");
  return join(root, `${key}.lock`);
}

function sameSecretEnvLockSnapshot(
  left: SecretEnvLockSnapshot,
  right: SecretEnvLockSnapshot,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.owner.token === right.owner.token &&
    left.contents.equals(right.contents);
}

async function removeSecretEnvLockWithIdentity(
  lockPath: string,
  expected: { readonly dev: number; readonly ino: number },
): Promise<void> {
  try {
    const current = await lstat(lockPath);
    if (current.dev !== expected.dev || current.ino !== expected.ino) return;
    await rm(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unsafeSecretEnvLockError(lockPath: string, detail: string): SecretEnvPersistenceRefusedError {
  return new SecretEnvPersistenceRefusedError(
    "unsafe-lock-path",
    `Automatic secret persistence cannot safely use lock ${lockPath}: ${detail}. Verify no mono-agent init is running, then remove the stale lock manually and retry.`,
  );
}

interface MissingFileSnapshot {
  readonly exists: false;
}

interface ExistingFileSnapshot {
  readonly exists: true;
  readonly contents: Buffer;
  readonly mode: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

type SafeFileSnapshot = MissingFileSnapshot | ExistingFileSnapshot;

interface AtomicReplaceOptions {
  readonly path: string;
  readonly reportedPath: string;
  readonly contents: Buffer;
  readonly expected: SafeFileSnapshot;
  readonly ownerUid: number;
  readonly mode: number;
  readonly verifyOwnerOnly?: boolean;
  readonly beforeCommit?: SecretEnvPersistenceOptions["beforeCommit"];
  /** Final cross-file safety check before the shared target-claim sequence. */
  readonly beforeRename?: () => void | Promise<void>;
  readonly beforePromotion?: SecretEnvPersistenceOptions["beforePromotion"];
  readonly beforeInstallLink?: SecretEnvPersistenceOptions["beforeInstallLink"];
  readonly afterInstallLink?: SecretEnvPersistenceOptions["afterInstallLink"];
}

async function readSafeFile(
  path: string,
  unsafeCode: Extract<SecretEnvRefusalCode, "unsafe-env-path" | "unsafe-gitignore-path">,
  malformedCode: Extract<SecretEnvRefusalCode, "malformed-env" | "malformed-gitignore">,
  ownerUid: number,
  allowedLinkCounts: readonly number[] = [1],
  reportedPath: string = path,
): Promise<SafeFileSnapshot> {
  try {
    const snapshot = await readVerifiedFile(path, {
      validate: (details) => assertSafeSecretFileStat(
        reportedPath,
        details,
        unsafeCode,
        ownerUid,
        allowedLinkCounts,
      ),
      changedError: () => new SecretEnvConcurrentModificationError(reportedPath),
    });
    if (snapshot === undefined) return { exists: false };
    decodeUtf8(snapshot.contents, reportedPath, malformedCode);
    return {
      exists: true,
      contents: snapshot.contents,
      mode: snapshot.details.mode,
      dev: snapshot.details.dev,
      ino: snapshot.details.ino,
      uid: snapshot.details.uid,
      nlink: snapshot.details.nlink,
      size: snapshot.details.size,
      mtimeNs: snapshot.details.mtimeNs,
      ctimeNs: snapshot.details.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SecretEnvPersistenceRefusedError(unsafeCode, `Automatic secret persistence refused unsafe path ${reportedPath}.`);
    }
    throw error;
  }
}

function assertSafeSecretFileStat(
  path: string,
  value: BigIntStats,
  unsafeCode: Extract<SecretEnvRefusalCode, "unsafe-env-path" | "unsafe-gitignore-path">,
  ownerUid: number,
  allowedLinkCounts: readonly number[],
): void {
  if (value.isSymbolicLink() || !value.isFile()) {
    throw new SecretEnvPersistenceRefusedError(
      unsafeCode,
      `Automatic secret persistence refused unsafe path ${path}.`,
    );
  }
  if (value.uid !== BigInt(ownerUid)) {
    throw new SecretEnvPersistenceRefusedError(
      unsafeCode,
      `Automatic secret persistence refused ${path} because it is not owned by the current user.`,
    );
  }
  if (!allowedLinkCounts.some((linkCount) => value.nlink === BigInt(linkCount))) {
    throw new SecretEnvPersistenceRefusedError(
      unsafeCode,
      `Automatic secret persistence refused ${path} because its hard-link identity is unsafe.`,
    );
  }
}

function snapshotText(snapshot: SafeFileSnapshot): string {
  if (!snapshot.exists) return "";
  return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.contents);
}

function decodeUtf8(contents: Buffer, path: string, code: SecretEnvRefusalCode): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new SecretEnvPersistenceRefusedError(code, `Automatic secret persistence requires UTF-8 text at ${path}.`);
  }
}

function fileMode(snapshot: ExistingFileSnapshot): number;
function fileMode(snapshot: MissingFileSnapshot): 0;
function fileMode(snapshot: SafeFileSnapshot): number {
  return snapshot.exists ? Number(snapshot.mode & 0o777n) : 0;
}

function changeFor(path: string, exists: boolean, needsWrite: boolean, dryRun: boolean): InitFileChange {
  if (!needsWrite) return { path, kind: "unchanged" };
  if (dryRun) return { path, kind: exists ? "planned-update" : "planned-create" };
  return { path, kind: exists ? "updated" : "created" };
}

function renderDotenvValue(name: string, value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new SecretEnvPersistenceRefusedError(
      "unrepresentable-secret-value",
      `Automatic secret persistence requires a non-empty dotenv-safe value for ${name}.`,
    );
  }
  const candidates = [
    ...(value.includes("'") ? [] : [`'${value}'`]),
    ...(value.includes('"') ? [] : [`"${value}"`]),
    value,
  ];
  for (const candidate of candidates) {
    try {
      if (parseEnv(`${name}=${candidate}\n`)[name] === value) return candidate;
    } catch {
      // Try the next representation. Some values have no lossless dotenv form.
    }
  }
  throw new SecretEnvPersistenceRefusedError(
    "unrepresentable-secret-value",
    `Automatic secret persistence cannot represent the supplied value for ${name} losslessly.`,
  );
}

function mergeDotenvContents(
  existing: string,
  renderedValues: ReadonlyMap<string, string>,
  replaceKeys: ReadonlySet<string>,
): {
  readonly contents: string;
  readonly valuesChanged: number;
  readonly replacedKeys: readonly string[];
  readonly skippedKeys: readonly string[];
} {
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(existing);
  } catch {
    throw new SecretEnvPersistenceRefusedError(
      "malformed-env",
      "Automatic secret persistence refused a malformed .env file.",
    );
  }

  const lines = splitLinesPreservingEndings(existing);
  const preferredNewline = lines.find((line) => line.ending.length > 0)?.ending ?? "\n";
  let valuesChanged = 0;
  const replacedKeys: string[] = [];
  const skippedKeys: string[] = [];

  for (const [name, renderedValue] of renderedValues) {
    if ((parsed[name] ?? "").length > 0) {
      if (!replaceKeys.has(name)) {
        skippedKeys.push(name);
        continue;
      }
      // renderDotenvValue already proved this single-line form round-trips,
      // so it reproduces the exact submitted value.
      if (parsed[name] === parseEnv(`${name}=${renderedValue}\n`)[name]) {
        continue;
      }
      replaceDotenvValue(lines, name, renderedValue);
      replacedKeys.push(name);
      valuesChanged += 1;
      continue;
    }
    const matcher = new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=)(.*)$`, "u");
    let index = -1;
    for (let candidate = lines.length - 1; candidate >= 0; candidate -= 1) {
      const body = lines[candidate]?.body ?? "";
      const assignment = matcher.exec(body);
      if (assignment === null) continue;
      const placeholder = /^\s*(?:''|"")?\s*(#.*)?$/u.exec(assignment[2] ?? "");
      if (placeholder === null) continue;
      const marker = `__MONO_AGENT_EMPTY_${name}__`;
      const markedLines = lines.map((line, lineIndex) => lineIndex === candidate
        ? { ...line, body: `${assignment[1]}'${marker}'${placeholder[1] === undefined ? "" : ` ${placeholder[1]}`}` }
        : line);
      try {
        if (parseEnv(joinPreservedLines(markedLines))[name] === marker) {
          index = candidate;
          break;
        }
      } catch {
        // The full file validation below reports malformed input without writing.
      }
    }
    if (index === -1) {
      if (parsed[name] !== undefined) {
        throw new SecretEnvPersistenceRefusedError(
          "malformed-env",
          `Automatic secret persistence could not safely replace the empty placeholder for ${name}.`,
        );
      }
      const last = lines[lines.length - 1];
      if (last !== undefined && last.ending.length === 0) last.ending = preferredNewline;
      lines.push({ body: `${name}=${renderedValue}`, ending: preferredNewline });
      valuesChanged += 1;
      continue;
    }

    const currentLine = lines[index];
    const assignment = matcher.exec(currentLine?.body ?? "");
    const placeholder = /^\s*(?:''|"")?\s*(#.*)?$/u.exec(assignment?.[2] ?? "");
    if (currentLine === undefined || assignment === null || placeholder === null) {
      throw new SecretEnvPersistenceRefusedError(
        "malformed-env",
        `Automatic secret persistence could not safely replace the empty placeholder for ${name}.`,
      );
    }
    const comment = placeholder[1];
    currentLine.body = `${assignment[1]}${renderedValue}${comment === undefined ? "" : ` ${comment}`}`;
    valuesChanged += 1;
  }

  const contents = joinPreservedLines(lines);
  if (replaceKeys.size > 0) {
    assertReplacementMergeValid(
      contents,
      parsed,
      renderedValues,
      new Set(replacedKeys),
      new Set(skippedKeys),
    );
  }
  return { contents, valuesChanged, replacedKeys, skippedKeys };
}

/**
 * Replace the single-line assignment for a targeted key in place, preserving
 * the `export`/assignment prefix, the original gap after `=`, the longest
 * trailing span that still parses as a comment, and the line ending (only the
 * line body is edited). Lookalike lines that fail the lone-line value test
 * (for example inside a quoted multiline value) are discarded first; refusal
 * happens only when the survivors are not exactly one genuine assignment,
 * or when the matched value does not span exactly that line. The marker
 * substitution proves control without ever printing the secret value.
 */
function replaceDotenvValue(
  lines: PreservedLine[],
  name: string,
  renderedValue: string,
): void {
  const matcher = new RegExp(
    "^(\\s*(?:export\\s+)?" + escapeRegExp(name) + "\\s*=)(.*)$",
    "u",
  );
  const matches: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (matcher.test(lines[index]?.body ?? "")) matches.push(index);
  }
  let currentParsed: Record<string, string | undefined>;
  try {
    currentParsed = parseEnv(joinPreservedLines(lines));
  } catch {
    throw new SecretEnvPersistenceRefusedError(
      "malformed-env",
      `Automatic secret persistence refused to replace ${name} because its current assignment is not a single line.`,
    );
  }
  // Keep only candidates whose lone line reproduces the live value: lookalikes
  // inside quoted multiline values fail this test and are discarded. Refuse
  // only when the survivors are not exactly one genuine assignment.
  const genuine = matches.filter((candidate) => {
    const body = lines[candidate]?.body ?? "";
    let lone: Record<string, string | undefined>;
    try {
      lone = parseEnv(`${body}\n`);
    } catch {
      return false;
    }
    return lone[name] === currentParsed[name];
  });
  const index = genuine.length === 1 ? genuine[0] : undefined;
  const current = index === undefined ? undefined : lines[index];
  const assignment = current === undefined ? null : matcher.exec(current.body);
  if (index === undefined || current === undefined || assignment === null) {
    throw new SecretEnvPersistenceRefusedError(
      "malformed-env",
      `Automatic secret persistence refused to replace ${name} because it has an ambiguous assignment.`,
    );
  }
  const prefix = assignment[1] ?? "";
  const rest = assignment[2] ?? "";
  const gap = /^\s*/u.exec(rest)?.[0] ?? "";
  const marker = `__MONO_AGENT_REPLACE_${name}__`;
  for (let split = gap.length; split <= rest.length; split += 1) {
    const tail = rest.slice(split);
    if (tail !== "" && !/^\s*(#.*)?$/u.test(tail)) continue;
    // Tie the tail to the end of the old value: the discarded span must
    // reproduce it, so a `#` inside the quoted value cannot be mistaken for
    // a trailing comment and left behind.
    const head = rest.slice(gap.length, split);
    if (head.length === 0) continue;
    let headParsed: Record<string, string | undefined>;
    try {
      headParsed = parseEnv(`${name}=${head}\n`);
    } catch {
      continue;
    }
    if (headParsed[name] !== currentParsed[name]) continue;
    const markedLines = lines.map((line, lineIndex) => lineIndex === index
      ? { ...line, body: `${prefix}${gap}'${marker}'${tail}` }
      : line);
    let marked: Record<string, string | undefined>;
    try {
      marked = parseEnv(joinPreservedLines(markedLines));
    } catch {
      continue;
    }
    if (marked[name] !== marker || !sameKeysExcept(marked, currentParsed, name)) continue;
    current.body = `${prefix}${gap}${renderedValue}${tail}`;
    return;
  }
  throw new SecretEnvPersistenceRefusedError(
    "malformed-env",
    `Automatic secret persistence refused to replace ${name} because its current assignment is not a single line.`,
  );
}

function sameKeysExcept(
  left: Record<string, string | undefined>,
  right: Record<string, string | undefined>,
  except: string,
): boolean {
  for (const key of Object.keys(left)) {
    if (key !== except && left[key] !== right[key]) return false;
  }
  for (const key of Object.keys(right)) {
    if (key !== except && !Object.hasOwn(left, key)) return false;
  }
  return true;
}

/**
 * Reparse a replacement merge and prove every supplied key now holds its
 * intended value while every other key — and the overall key set — is
 * unchanged. Error messages name keys only, never secret values.
 */
function assertReplacementMergeValid(
  contents: string,
  original: Record<string, string | undefined>,
  renderedValues: ReadonlyMap<string, string>,
  replaced: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
): void {
  let merged: Record<string, string | undefined>;
  try {
    merged = parseEnv(contents);
  } catch {
    throw new SecretEnvPersistenceRefusedError(
      "malformed-env",
      "Automatic secret persistence could not safely verify the replaced .env file.",
    );
  }
  for (const [name, renderedValue] of renderedValues) {
    if (skipped.has(name)) {
      if (merged[name] !== original[name]) {
        throw new SecretEnvPersistenceRefusedError(
          "malformed-env",
          `Automatic secret persistence refused to replace secrets because it unexpectedly changed ${name}.`,
        );
      }
      continue;
    }
    // renderDotenvValue already proved this single-line form round-trips.
    const expected = parseEnv(`${name}=${renderedValue}\n`)[name];
    if (merged[name] !== expected) {
      throw new SecretEnvPersistenceRefusedError(
        "malformed-env",
        `Automatic secret persistence could not safely verify the replacement for ${name}.`,
      );
    }
  }
  for (const key of Object.keys(original)) {
    if (renderedValues.has(key)) continue;
    if (merged[key] !== original[key]) {
      throw new SecretEnvPersistenceRefusedError(
        "malformed-env",
        `Automatic secret persistence refused to replace secrets because it could not preserve ${key}.`,
      );
    }
  }
  for (const key of Object.keys(merged)) {
    if (!renderedValues.has(key) && !Object.hasOwn(original, key)) {
      throw new SecretEnvPersistenceRefusedError(
        "malformed-env",
        `Automatic secret persistence refused to replace secrets because it could not preserve ${key}.`,
      );
    }
  }
}

interface PreservedLine {
  body: string;
  ending: string;
}

function splitLinesPreservingEndings(value: string): PreservedLine[] {
  if (value.length === 0) return [];
  const lines: PreservedLine[] = [];
  const endings = /\r\n|\n|\r/gu;
  let cursor = 0;
  for (const match of value.matchAll(endings)) {
    const index = match.index;
    lines.push({ body: value.slice(cursor, index), ending: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) lines.push({ body: value.slice(cursor), ending: "" });
  return lines;
}

function joinPreservedLines(lines: readonly PreservedLine[]): string {
  return lines.map((line) => `${line.body}${line.ending}`).join("");
}

/**
 * Escape a dotenv basename for use inside a `.gitignore` pattern so custom
 * names keep matching literally. Every rule below is root-anchored, so only
 * the mid-pattern metacharacters `*`, `?`, `[`, `]` and the escape character
 * itself need handling. Control characters and backslashes are rejected
 * before building rules, and need no escape path here.
 */
function escapeGitignoreBasename(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/[*?[\]]/gu, (character) => `\\${character}`);
}

function hasUnsafeGitignoreBasenameChar(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 92) return true;
  }
  return false;
}

/**
 * Root-anchored ignore rules for the secret file and its same-directory
 * transaction artifacts. The dot-prefixed temporary rule matches the actual
 * `.${basename}.mono-agent-*.tmp` staging name created by atomicReplaceFile,
 * and the backup rule matches the non-dot `${basename}.mono-agent-*.backup`
 * claim name; for `.env` this is byte-identical to the long-standing block so
 * existing installs are not rewritten. Basename metacharacters are escaped so
 * custom dotenv names keep matching literally. Control characters and
 * backslashes are refused before any rule is built, so a hostile basename
 * cannot inject extra gitignore lines.
 */
function secretEnvIgnoreRulesFor(envBasename: string): readonly string[] {
  if (hasUnsafeGitignoreBasenameChar(envBasename)) {
    throw new SecretEnvPersistenceRefusedError(
      "unsafe-env-path",
      `Automatic secret persistence refused an unsafe dotenv file name: ${envBasename}.`,
    );
  }
  const escaped = escapeGitignoreBasename(envBasename);
  return [
    `/${escaped}`,
    `/.${escaped}.mono-agent-*.tmp`,
    `/${escaped}.mono-agent-*.backup`,
  ];
}

function ensureExactEnvIgnore(existing: string, envBasename: string): string {
  const rules = secretEnvIgnoreRulesFor(envBasename);
  const lines = existing.length === 0 ? [] : existing.split(/\r?\n/u);
  // Keep the whole secret-file transaction block as the final effective rules.
  // An earlier rule can be cancelled by a later negation, while the temporary
  // and rollback names can contain the same secret bytes as the final .env.
  const meaningful: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    meaningful.push(trimmed);
  }
  if (
    meaningful.length >= rules.length &&
    rules.every(
      (rule, ruleIndex) => meaningful[meaningful.length - rules.length + ruleIndex] === rule,
    )
  ) return existing;
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  return `${existing}${existing.length > 0 && !existing.endsWith("\n") ? newline : ""}` +
    `${rules.join(newline)}${newline}`;
}

async function atomicReplaceFile(options: AtomicReplaceOptions): Promise<void> {
  const temporaryPath = join(dirname(options.path), `.${basename(options.path)}.mono-agent-${randomUUID()}.tmp`);
  const backupPath = join(dirname(options.path), `${basename(options.path)}.mono-agent-${randomUUID()}.backup`);
  const expected = options.expected;
  const unsafeCode = basename(options.path) === ".gitignore" ? "unsafe-gitignore-path" : "unsafe-env-path";
  const malformedCode = basename(options.path) === ".gitignore" ? "malformed-gitignore" : "malformed-env";
  await secureFileReplace({
    path: options.path,
    temporaryPath,
    contents: options.contents,
    mode: options.mode,
    validateTemporary: (details) => {
      if (options.verifyOwnerOnly === true && (details.mode & 0o777n) !== 0o600n) {
        throw new SecretEnvPersistenceRefusedError(
          "owner-only-permissions-unsupported",
          "Automatic secret persistence could not verify owner-only permissions.",
        );
      }
    },
    beforeCommit: async (temporary) => {
      await options.beforeCommit?.(options.reportedPath, temporary);
      await assertSnapshotUnchanged(options.path, options.reportedPath, options.expected, options.ownerUid);
      await options.beforeRename?.();
      // beforeRename may perform async Git and cross-file checks. Re-read the
      // target afterwards so an editor cannot win that widened window silently.
      await assertSnapshotUnchanged(options.path, options.reportedPath, options.expected, options.ownerUid);
    },
    target: {
      expected: expected.exists
        ? {
            kind: "present",
            claimPath: backupPath,
            validate: async (candidate, moved) => {
              const current = await readSafeFile(
                candidate,
                unsafeCode,
                malformedCode,
                options.ownerUid,
              );
              return current.exists && sameExpectedFileSnapshot(current, expected, moved);
            },
            invalidError: () => new SecretEnvConcurrentModificationError(options.reportedPath),
            mismatchRecovery: (phase) => phase === "claimed" || phase === "pre-publish"
              ? "restore-previous"
              : "preserve-current",
          }
        : { kind: "missing" },
      recovery: "preserve-current",
      beforeClaim: (_target, temporary) => options.beforePromotion?.(options.reportedPath, temporary),
      ...(expected.exists ? {
        beforePublish: (_target: string, temporary: string) => options.beforeInstallLink?.(options.reportedPath, temporary),
        afterPublish: (_target: string, temporary: string) => options.afterInstallLink?.(options.reportedPath, temporary),
      } : {}),
      protectRecovery: tightenFileOwnerOnlyBestEffort,
      makeError: ({ cause, recoveryPaths }) => recoveryPaths.length === 0
        && (cause instanceof SecretEnvConcurrentModificationError
          || cause instanceof SecretEnvPersistenceRefusedError)
        ? cause
        : new SecretEnvConcurrentModificationError(options.reportedPath, undefined, recoveryPaths[0]),
    },
  });
  await syncDirectoryBestEffort(dirname(options.path));
}

function sameExpectedFileSnapshot(
  current: ExistingFileSnapshot,
  expected: ExistingFileSnapshot,
  moved = false,
): boolean {
  return current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.uid === expected.uid &&
    current.nlink === expected.nlink &&
    current.size === expected.size &&
    current.mode === expected.mode &&
    (moved || current.mtimeNs === expected.mtimeNs) &&
    (moved || current.ctimeNs === expected.ctimeNs) &&
    current.contents.equals(expected.contents);
}

async function tightenFileOwnerOnlyBestEffort(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if ((await handle.stat()).isFile()) await handle.chmod(0o600);
  } catch {
    // The recovery copy is already fail-closed and ignored; preserve bytes.
  } finally {
    await handle?.close();
  }
}

/**
 * Reject when the `.env` snapshot taken inside the writer lock differs from a
 * previously observed revision, so an operator confirmation cannot apply to a
 * file that changed underneath it. Names the path only, never secret values.
 */
function assertExpectedEnvRevision(
  snapshot: SafeFileSnapshot,
  expected: ExpectedSecretEnvRevision,
  reportedPath: string,
): void {
  if (expected.exists !== snapshot.exists) {
    throw new SecretEnvConcurrentModificationError(reportedPath);
  }
  if (expected.exists && snapshot.exists) {
    const expectedContents = Buffer.isBuffer(expected.contents)
      ? expected.contents
      : Buffer.from(expected.contents, "utf8");
    if (!snapshot.contents.equals(expectedContents)) {
      throw new SecretEnvConcurrentModificationError(reportedPath);
    }
  }
}

async function assertSnapshotUnchanged(
  path: string,
  reportedPath: string,
  expected: SafeFileSnapshot,
  ownerUid: number,
): Promise<void> {
  let current: SafeFileSnapshot;
  try {
    current = await readSafeFile(
      path,
      basename(path) === ".gitignore" ? "unsafe-gitignore-path" : "unsafe-env-path",
      basename(path) === ".gitignore" ? "malformed-gitignore" : "malformed-env",
      ownerUid,
      [1],
      reportedPath,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!expected.exists) return;
      throw new SecretEnvConcurrentModificationError(reportedPath);
    }
    throw error;
  }
  if (current.exists !== expected.exists) throw new SecretEnvConcurrentModificationError(reportedPath);
  if (!current.exists || !expected.exists) return;
  if (!sameExpectedFileSnapshot(current, expected)) {
    throw new SecretEnvConcurrentModificationError(reportedPath);
  }
}

async function isGitTracked(path: string): Promise<boolean> {
  const directory = dirname(path);
  const repository = await runGit(["-C", directory, "rev-parse", "--show-toplevel"]);
  if (!repository.ok) {
    if (await hasGitMetadata(directory)) {
      throw new SecretEnvPersistenceRefusedError(
        "git-safety-unavailable",
        `Automatic secret persistence could not verify git tracking for ${path}.`,
      );
    }
    return false;
  }
  const root = repository.stdout.replace(/\r?\n$/u, "");
  const canonicalPath = join(await realpath(directory), basename(path));
  const tracked = await runGit(["-C", root, "ls-files", "--error-unmatch", "--", relative(root, canonicalPath)]);
  if (tracked.ok) return true;
  if (Number(tracked.code) === 1) return false;
  throw new SecretEnvPersistenceRefusedError(
    "git-safety-unavailable",
    `Automatic secret persistence could not verify git tracking for ${path}.`,
  );
}

/** Recheck the complete durable dotenv guard without changing either file. */
export async function verifySecretEnvPersistenceGuard(path: string): Promise<boolean> {
  const target = await resolveSafeSecretEnvTarget(path);
  const envSnapshot = await readSafeFile(
    target.path,
    "unsafe-env-path",
    "malformed-env",
    target.ownerUid,
  );
  if (!envSnapshot.exists || fileMode(envSnapshot) !== 0o600 || await isGitTracked(target.path)) {
    return false;
  }
  const gitIgnorePath = join(dirname(target.path), ".gitignore");
  const gitIgnoreSnapshot = await readSafeFile(
    gitIgnorePath,
    "unsafe-gitignore-path",
    "malformed-gitignore",
    target.ownerUid,
  );
  return gitIgnoreSnapshot.exists && ensureExactEnvIgnore(snapshotText(gitIgnoreSnapshot), basename(target.path)) === snapshotText(gitIgnoreSnapshot);
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly code?: number | string;
}

function runGit(args: readonly string[]): Promise<GitResult> {
  return new Promise((resolveResult) => {
    execFile("git", [...args], { encoding: "utf8" }, (error, stdout) => {
      if (error === null) {
        resolveResult({ ok: true, stdout });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number }).code;
      resolveResult({ ok: false, stdout, ...(code === undefined ? {} : { code }) });
    });
  });
}

async function hasGitMetadata(start: string): Promise<boolean> {
  let current = resolve(start);
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
