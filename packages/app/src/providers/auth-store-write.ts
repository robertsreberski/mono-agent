import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isBoundedCredentialValue, isRecord, isUsableStoredPiCredential } from "./credential-values.js";
import type { PersistPiProviderCredentialOptions, PiAuthPromotionHooks } from "./setup-types.js";

/**
 * The single mutation path for Pi provider credentials. Login remains inside
 * the lock so two processes cannot both authenticate from the same snapshot
 * and silently clobber each other's successful result.
 */
export async function persistPiProviderCredential(
  options: PersistPiProviderCredentialOptions,
): Promise<void> {
  assertOwnerOnlyPersistenceSupported(options.platform ?? process.platform);
  const hooks: PiAuthPromotionHooks = options;
  await withPiAuthFileLock(options.authPath, async (authPath, ownerUid, assertLockHeld) => {
    const original = await readPiAuthStore(authPath, piAuthSingleLinkPolicy(ownerUid));
    throwIfProviderAuthAborted(options.abortSignal);
    const credential = await resolveProviderCredentialWithAbort(options.resolveCredential, options.abortSignal);
    throwIfProviderAuthAborted(options.abortSignal);
    if (!isUsableStoredPiCredential(options.provider, credential)) {
      throw new Error(`Provider authentication returned an invalid credential for ${options.provider}.`);
    }
    const next = { ...original.auth, [options.provider]: credential };
    if (!isBoundedCredentialValue(next)) {
      throw new Error(`Provider authentication would exceed the Pi credential store safety limit for ${options.provider}.`);
    }
    await writePiAuthStoreAtomically(
      authPath,
      next,
      original,
      ownerUid,
      assertLockHeld,
      hooks,
      options.abortSignal,
      options.onCredentialStoreMutation,
    );
  }, hooks);
}

async function resolveProviderCredentialWithAbort(
  resolveCredential: PersistPiProviderCredentialOptions["resolveCredential"],
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfProviderAuthAborted(signal);
  const pending = Promise.resolve().then(async () => await resolveCredential(signal));
  if (signal === undefined) return await pending;
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(signal.reason ?? new Error("Provider authentication was cancelled.")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(
      (credential) => finish(() => resolve(credential)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function throwIfProviderAuthAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("Provider authentication was cancelled.");
  }
}

interface PiAuthStoreSnapshot {
  readonly exists: boolean;
  readonly contents: string;
  readonly auth: Readonly<Record<string, unknown>>;
  readonly dev?: number;
  readonly ino?: number;
  readonly uid?: number;
  readonly nlink?: number;
  readonly mode?: number;
  readonly size?: number;
}

interface PiAuthStoreReadPolicy {
  readonly ownerUid: number;
  readonly allowedLinkCounts: readonly number[];
}

interface PiAuthLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly ownerUid: number;
  readonly dev: number;
  readonly ino: number;
  readonly token: string;
  readonly contents: Buffer;
}

export class PiAuthCleanupError extends Error {
  readonly paths: readonly string[];
  readonly path: string;
  readonly detail: string;

  constructor(path: string | readonly string[], detail: string) {
    const paths = [...new Set(typeof path === "string" ? [path] : path)];
    const primaryPath = paths[0] ?? "unknown credential artifact";
    super(`Pi credential${paths.length === 1 && primaryPath.endsWith(".mono-agent.lock") ? " lock" : ""} cleanup for ${paths.join(", ")} is uncertain: ${detail}`);
    this.name = "PiAuthCleanupError";
    this.paths = paths;
    this.path = primaryPath;
    this.detail = detail;
  }
}

export function combinePiAuthCleanupError(
  earlier: unknown,
  cleanup: PiAuthCleanupError,
): PiAuthCleanupError {
  if (earlier instanceof PiAuthCleanupError) {
    return new PiAuthCleanupError(
      [...earlier.paths, ...cleanup.paths],
      `${earlier.detail}; additionally, ${cleanup.detail}`,
    );
  }
  if (earlier === undefined) return cleanup;
  return new PiAuthCleanupError(
    cleanup.paths,
    `${cleanup.detail}; the preceding provider operation also failed: ${earlier instanceof Error ? earlier.message : String(earlier)}`,
  );
}

type AssertPiAuthLockHeld = () => Promise<void>;

export function assertOwnerOnlyPersistenceSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(
      "Automatic Pi credential persistence is unavailable because owner-only file permissions cannot be verified on Windows. Complete authentication manually and rerun validation.",
    );
  }
}

export async function withPiAuthFileLock<T>(
  authPath: string,
  task: (
    canonicalAuthPath: string,
    ownerUid: number,
    assertLockHeld: AssertPiAuthLockHeld,
  ) => Promise<T>,
  hooks: PiAuthPromotionHooks = {},
  staleRepairAttempted = false,
): Promise<T> {
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(dirname(authPath));
  const ownerUid = currentProcessUidForPi(canonicalParent);
  await assertSafePiAuthParent(canonicalParent, ownerUid);
  const canonicalAuthPath = join(canonicalParent, basename(authPath));
  await assertPiAuthPathOutsideGitWorktree(canonicalAuthPath);
  const lockPath = `${canonicalAuthPath}.mono-agent.lock`;
  const token = randomUUID();
  const contents = Buffer.from(`${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerUid,
    token,
  })}\n`, "utf8");
  let handle: FileHandle | undefined;
  let identity: Pick<PiAuthLock, "dev" | "ino" | "ownerUid"> | undefined;
  try {
    handle = await open(
      lockPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const initialStat = await handle.stat();
    identity = { dev: initialStat.dev, ino: initialStat.ino, ownerUid };
    assertPiAuthLockStat(lockPath, initialStat, ownerUid);
    await handle.writeFile(contents);
    await handle.sync();
    const writtenStat = await handle.stat();
    assertPiAuthLockStat(lockPath, writtenStat, ownerUid);
    if (
      writtenStat.dev !== initialStat.dev ||
      writtenStat.ino !== initialStat.ino ||
      writtenStat.size !== contents.length
    ) {
      throw new Error(`Pi credential lock ${lockPath} changed while its owner record was written.`);
    }
    await syncDirectory(canonicalParent);
    await hooks.afterPiAuthLockCreated?.(lockPath);
  } catch (error) {
    let rollbackError: unknown;
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        rollbackError = new PiAuthCleanupError(
          lockPath,
          `the failed lock-creation handle could not be confirmed closed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
      }
      if (identity !== undefined) {
        try {
          await removePiAuthLockIfIdentity(lockPath, identity, hooks);
        } catch (removeError) {
          rollbackError ??= removeError;
        }
      } else {
        rollbackError ??= new PiAuthCleanupError(
          lockPath,
          "the failed lock-creation artifact could not be identified for safe removal",
        );
      }
    }
    if (rollbackError !== undefined) {
      throw combinePiAuthCleanupError(
        error,
        rollbackError instanceof PiAuthCleanupError
          ? rollbackError
          : new PiAuthCleanupError(lockPath, String(rollbackError)),
      );
    }
    if (isAlreadyExistsError(error)) {
      if (!staleRepairAttempted) {
        const repair = await repairStalePiAuthLock(lockPath, ownerUid, {
          ...(hooks.beforeStalePiAuthLockRemoval === undefined
            ? {}
            : { beforeRemoval: hooks.beforeStalePiAuthLockRemoval }),
          ...(hooks.afterStalePiAuthLockRemoval === undefined
            ? {}
            : { afterRemoval: hooks.afterStalePiAuthLockRemoval }),
        });
        if (repair === "removed") {
          return await withPiAuthFileLock(authPath, task, hooks, true);
        }
        if (repair === "active") {
          throw new Error(`Pi credential lock ${lockPath} already exists and belongs to an active authentication process. Wait for it to finish, then retry.`);
        }
      }
      throw new Error(
        `Pi credential lock ${lockPath} already exists and could not be proven stale. It was left untouched; inspect its owner and retry after the active authentication exits.`,
      );
    }
    throw error;
  }
  if (handle === undefined || identity === undefined) {
    throw new Error(`Pi credential lock ${lockPath} could not be established.`);
  }
  const lock: PiAuthLock = {
    path: lockPath,
    handle,
    ownerUid,
    dev: identity.dev,
    ino: identity.ino,
    token,
    contents,
  };
  let taskError: unknown;
  try {
    return await task(canonicalAuthPath, ownerUid, () => assertPiAuthLockHeld(lock));
  } catch (error) {
    taskError = error;
    throw error;
  } finally {
    let lifecycleError: PiAuthCleanupError | undefined;
    try {
      await lock.handle.close();
    } catch (error) {
      lifecycleError = new PiAuthCleanupError(
        lock.path,
        `the lock handle could not be confirmed closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await releasePiAuthLock(lock, hooks);
    } catch (error) {
      const releaseError = error instanceof PiAuthCleanupError
        ? error
        : new PiAuthCleanupError(lock.path, error instanceof Error ? error.message : String(error));
      lifecycleError = combinePiAuthCleanupError(lifecycleError, releaseError);
    }
    if (lifecycleError !== undefined) {
      throw combinePiAuthCleanupError(taskError, lifecycleError);
    }
  }
}

function currentProcessUidForPi(path: string): number {
  if (typeof process.getuid !== "function") {
    throw new Error(`Automatic Pi credential persistence cannot verify the current user for ${path}.`);
  }
  return process.getuid();
}

async function assertSafePiAuthParent(path: string, ownerUid: number): Promise<void> {
  const pathStat = await lstat(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
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
      throw new Error(
        `Refusing automatic Pi credential persistence because parent directory ${path} must be owned by the current user and not group/world-writable.`,
      );
    }
  } finally {
    await handle?.close();
  }
}

function assertPiAuthLockStat(path: string, value: Stats, ownerUid: number): void {
  if (
    !value.isFile() ||
    value.uid !== ownerUid ||
    (value.mode & 0o777) !== 0o600 ||
    value.nlink !== 1
  ) {
    throw new Error(
      `Refusing to use Pi credential lock ${path} because it is not a current-user, owner-only regular file with one link.`,
    );
  }
}

async function readPiAuthLockPath(
  path: string,
  ownerUid: number,
): Promise<{ readonly dev: number; readonly ino: number; readonly contents: Buffer } | undefined> {
  let pathStat: Stats;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  assertPiAuthLockStat(path, pathStat, ownerUid);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const handleStat = await handle.stat();
    assertPiAuthLockStat(path, handleStat, ownerUid);
    if (pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) {
      throw new Error(`Pi credential lock ${path} changed identity while it was opened.`);
    }
    const contents = await handle.readFile();
    if (contents.length !== handleStat.size) {
      throw new Error(`Pi credential lock ${path} changed while its contents were read.`);
    }
    if (contents.length > 4096) {
      throw new Error(`Pi credential lock ${path} exceeds the 4096-byte safety limit.`);
    }
    return { dev: handleStat.dev, ino: handleStat.ino, contents };
  } finally {
    await handle?.close();
  }
}

interface StalePiAuthLockRecord {
  readonly version: 1;
  readonly pid: number;
  readonly ownerUid: number;
  readonly token: string;
}

type StalePiAuthLockRepairResult = "removed" | "active" | "unverifiable";

/**
 * Remove only a secure, identity-stable lock whose recorded process is proven
 * gone with ESRCH. Active, EPERM, malformed and racing locks are untouched.
 *
 * @internal Exported as a narrow deterministic test seam.
 */
export async function repairStalePiAuthLock(
  path: string,
  ownerUid: number,
  options: {
    readonly kill?: (pid: number, signal: 0) => true;
    readonly beforeRemoval?: (lockPath: string) => void | Promise<void>;
    readonly afterRemoval?: (lockPath: string) => void | Promise<void>;
  } = {},
): Promise<StalePiAuthLockRepairResult> {
  const kill = options.kill ?? ((pid: number, signal: 0) => process.kill(pid, signal));
  let initial;
  try {
    initial = await readPiAuthLockPath(path, ownerUid);
  } catch {
    return "unverifiable";
  }
  if (initial === undefined) return "unverifiable";
  const record = parseStalePiAuthLockRecord(initial.contents, ownerUid);
  if (record === undefined) return "unverifiable";
  const liveness = piLockProcessLiveness(record.pid, kill);
  if (liveness !== "stale") return liveness;

  await options.beforeRemoval?.(path);

  let current;
  try {
    current = await readPiAuthLockPath(path, ownerUid);
  } catch {
    return "unverifiable";
  }
  if (
    current === undefined
    || current.dev !== initial.dev
    || current.ino !== initial.ino
    || !current.contents.equals(initial.contents)
  ) {
    return "unverifiable";
  }
  const currentRecord = parseStalePiAuthLockRecord(current.contents, ownerUid);
  if (
    currentRecord === undefined
    || currentRecord.pid !== record.pid
    || currentRecord.token !== record.token
    || piLockProcessLiveness(currentRecord.pid, kill) !== "stale"
  ) {
    return "unverifiable";
  }
  try {
    await rm(path);
  } catch {
    return "unverifiable";
  }
  try {
    await options.afterRemoval?.(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new PiAuthCleanupError(
      path,
      `the proven-stale lock was removed but directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return "removed";
}

function parseStalePiAuthLockRecord(contents: Buffer, ownerUid: number): StalePiAuthLockRecord | undefined {
  if (contents.length === 0 || contents.length > 4096) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || value.ownerUid !== ownerUid
    || typeof value.token !== "string"
    || value.token.length < 8
    || value.token.length > 200
  ) {
    return undefined;
  }
  return {
    version: 1,
    pid: value.pid as number,
    ownerUid,
    token: value.token,
  };
}

function piLockProcessLiveness(
  pid: number,
  kill: (pid: number, signal: 0) => true,
): "active" | "stale" | "unverifiable" {
  try {
    kill(pid, 0);
    return "active";
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ESRCH") return "stale";
    if (code === "EPERM") return "active";
    return "unverifiable";
  }
}

async function assertPiAuthLockHeld(lock: PiAuthLock): Promise<void> {
  const handleStat = await lock.handle.stat();
  assertPiAuthLockStat(lock.path, handleStat, lock.ownerUid);
  const current = await readPiAuthLockPath(lock.path, lock.ownerUid);
  if (
    current === undefined ||
    handleStat.dev !== lock.dev ||
    handleStat.ino !== lock.ino ||
    current.dev !== lock.dev ||
    current.ino !== lock.ino ||
    !current.contents.equals(lock.contents)
  ) {
    throw new Error(
      `Pi credential lock ${lock.path} changed during credential setup; its replacement was left untouched.`,
    );
  }
}

async function releasePiAuthLock(lock: PiAuthLock, hooks: PiAuthPromotionHooks): Promise<void> {
  let current;
  try {
    current = await readPiAuthLockPath(lock.path, lock.ownerUid);
  } catch (error) {
    throw new PiAuthCleanupError(
      lock.path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (current === undefined) {
    await confirmMissingPiAuthLockDurable(lock.path, hooks);
    return;
  }
  if (
    current.dev !== lock.dev ||
    current.ino !== lock.ino ||
    !current.contents.equals(lock.contents)
  ) {
    throw new PiAuthCleanupError(
      lock.path,
      "the lock identity changed; its replacement was left untouched",
    );
  }
  try {
    await rm(lock.path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new PiAuthCleanupError(
        lock.path,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  try {
    await syncDirectory(dirname(lock.path));
  } catch (error) {
    throw new PiAuthCleanupError(
      lock.path,
      `the lock was removed but directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function removePiAuthLockIfIdentity(
  path: string,
  expected: Pick<PiAuthLock, "dev" | "ino" | "ownerUid">,
  hooks: PiAuthPromotionHooks,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      await confirmMissingPiAuthLockDurable(path, hooks);
      return;
    }
    throw new PiAuthCleanupError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !current.isFile() ||
    current.uid !== expected.ownerUid ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.nlink !== 1 ||
    (current.mode & 0o777) !== 0o600
  ) {
    throw new PiAuthCleanupError(
      path,
      "the failed lock-creation artifact changed identity; its replacement was left untouched",
    );
  }
  try {
    await rm(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new PiAuthCleanupError(
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new PiAuthCleanupError(
      path,
      `the failed lock-creation artifact was removed but directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function confirmMissingPiAuthLockDurable(
  path: string,
  hooks: PiAuthPromotionHooks,
): Promise<void> {
  try {
    await hooks.beforePiAuthMissingLockSync?.(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new PiAuthCleanupError(
      path,
      `the lock path is absent but parent-directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function readPiAuthStore(
  path: string,
  policy: PiAuthStoreReadPolicy,
): Promise<PiAuthStoreSnapshot> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false, contents: "", auth: {} };
    }
    if (isSymlinkOpenError(error)) {
      throw new Error(`Refusing to use Pi auth path ${path} because the final path is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    assertPiAuthStoreStat(path, fileStat, policy);
    const contents = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`Unable to parse Pi auth file ${path}; the original file was left unchanged.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Pi auth file ${path} must contain a JSON object; the original file was left unchanged.`);
    }
    const pathStat = await lstat(path);
    assertPiAuthStoreStat(path, pathStat, policy);
    if (pathStat.dev !== fileStat.dev || pathStat.ino !== fileStat.ino) {
      throw new Error(`Pi auth file ${path} changed while it was being read; the newer path was preserved.`);
    }
    return {
      exists: true,
      contents,
      auth: parsed as Record<string, unknown>,
      dev: fileStat.dev,
      ino: fileStat.ino,
      uid: fileStat.uid,
      nlink: fileStat.nlink,
      mode: fileStat.mode,
      size: fileStat.size,
    };
  } finally {
    await handle.close();
  }
}

function assertPiAuthStoreStat(
  path: string,
  value: Stats,
  policy: PiAuthStoreReadPolicy,
): void {
  if (!value.isFile()) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is not a regular file.`);
  }
  if (value.uid !== policy.ownerUid) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is not owned by the current user.`);
  }
  if ((value.mode & 0o022) !== 0) {
    throw new Error(`Refusing to use Pi auth path ${path} because it is writable by another user.`);
  }
  if (!policy.allowedLinkCounts.includes(value.nlink)) {
    throw new Error(`Refusing to use Pi auth path ${path} because its hard-link identity is unsafe.`);
  }
}

async function writePiAuthStoreAtomically(
  path: string,
  auth: Readonly<Record<string, unknown>>,
  original: PiAuthStoreSnapshot,
  ownerUid: number,
  assertLockHeld: AssertPiAuthLockHeld,
  hooks: PiAuthPromotionHooks,
  abortSignal?: AbortSignal,
  onCredentialStoreMutation?: () => void,
): Promise<void> {
  throwIfProviderAuthAborted(abortSignal);
  await assertPiAuthStoreUnchanged(path, original, ownerUid);
  throwIfProviderAuthAborted(abortSignal);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  throwIfProviderAuthAborted(abortSignal);
  const tempDir = await mkdtemp(join(dir, ".mono-agent-pi-auth-write-"));
  const tempPath = join(tempDir, "auth.json");
  let promotionInstalled = false;
  let operationError: unknown;
  try {
    throwIfProviderAuthAborted(abortSignal);
    await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    throwIfProviderAuthAborted(abortSignal);
    await syncFile(tempPath);
    throwIfProviderAuthAborted(abortSignal);
    await assertPiAuthStoreUnchanged(path, original, ownerUid);
    throwIfProviderAuthAborted(abortSignal);
    await promotePiAuthStoreWithoutClobber(
      tempPath,
      path,
      original,
      ownerUid,
      assertLockHeld,
      undefined,
      hooks,
      abortSignal,
      onCredentialStoreMutation,
    );
    promotionInstalled = true;
    try {
      await hooks.beforePiAuthPostMutationSync?.(path);
      await syncDirectory(dir);
    } catch (error) {
      throw new PiAuthCleanupError(
        path,
        `credentials were installed but parent-directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await hooks.beforePiAuthTempCleanup?.(tempDir);
      await rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      throw combinePiAuthCleanupError(operationError, new PiAuthCleanupError(
        tempDir,
        `${promotionInstalled ? "credentials were installed, and " : ""}the credential-bearing transaction directory could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }
}

export async function assertPiAuthStoreUnchanged(
  path: string,
  original: PiAuthStoreSnapshot,
  ownerUid: number,
): Promise<void> {
  const current = await readPiAuthStore(path, piAuthSingleLinkPolicy(ownerUid));
  if (!samePiAuthStoreSnapshot(current, original)) {
    throw new Error(`Pi auth file ${path} changed during credential setup; the newer file was preserved.`);
  }
}

function samePiAuthStoreSnapshot(left: PiAuthStoreSnapshot, right: PiAuthStoreSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.contents === right.contents;
}

export async function promotePiAuthStoreWithoutClobber(
  stagedPath: string,
  targetPath: string,
  expected: PiAuthStoreSnapshot,
  ownerUid: number,
  assertLockHeld: AssertPiAuthLockHeld,
  intendedInput?: PiAuthStoreSnapshot,
  hooks: PiAuthPromotionHooks = {},
  abortSignal?: AbortSignal,
  onCredentialStoreMutation?: () => void,
): Promise<void> {
  const intended = intendedInput ?? await readPiAuthStore(stagedPath, piAuthSingleLinkPolicy(ownerUid));
  throwIfProviderAuthAborted(abortSignal);
  if (!intended.exists) {
    throw new Error(`Pi auth staging file ${stagedPath} disappeared before promotion.`);
  }
  if (!expected.exists) {
    let installed = false;
    try {
      await hooks.beforePiAuthPromotion?.(targetPath, stagedPath);
      await assertLockHeld();
      // This is the last safe cancellation point. Once target mutation starts,
      // the existing promotion/recovery transaction must run to completion.
      throwIfProviderAuthAborted(abortSignal);
      installed = await linkPiFileIfAbsent(stagedPath, targetPath);
      if (!installed) {
        throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
      }
      onCredentialStoreMutation?.();
      await hooks.afterPiAuthLink?.(targetPath, stagedPath);
      await assertPromotedPiAuthStore(intended, stagedPath, targetPath, ownerUid);
      return;
    } catch (error) {
      if (installed && !(error instanceof PiAuthCleanupError)) {
        throw new PiAuthCleanupError(
          targetPath,
          `new credentials were linked but their final state could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.mono-agent-${randomUUID()}.backup`);
  let preserveConcurrentBackup = true;
  let backupCreated = false;
  let targetMutationStarted = false;
  let promotionError: unknown;
  try {
    await hooks.beforePiAuthPromotion?.(targetPath, stagedPath);
    await assertLockHeld();
    // Abort cannot safely split the rename/install/recovery sequence below.
    throwIfProviderAuthAborted(abortSignal);
    try {
      await rename(targetPath, backupPath);
      backupCreated = true;
      targetMutationStarted = true;
      // Renaming the existing target is the first credential mutation, even
      // if a later validation fails and recovery restores that same inode.
      onCredentialStoreMutation?.();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
      }
      throw error;
    }

    let moved: PiAuthStoreSnapshot;
    try {
      moved = await readPiAuthStore(backupPath, piAuthSingleLinkPolicy(ownerUid));
    } catch {
      if (await linkPiFileIfAbsent(backupPath, targetPath)) {
        await rm(backupPath, { force: true });
        preserveConcurrentBackup = false;
      } else {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
      }
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    if (!samePiAuthStoreSnapshotAfterMove(moved, expected)) {
      if (await linkPiFileIfAbsent(backupPath, targetPath)) {
        await rm(backupPath, { force: true });
        preserveConcurrentBackup = false;
      } else {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
      }
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }

    if (!await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid)) {
      try {
        if (await linkPiFileIfAbsent(backupPath, targetPath)) {
          preserveConcurrentBackup = false;
        } else {
          await tightenPiFileOwnerOnlyBestEffort(backupPath);
        }
      } catch {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
        throw new Error(`Pi auth promotion failed; credentials were retained at ${backupPath}.`);
      }
      throw new Error(preserveConcurrentBackup
        ? `Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`
        : `Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }

    let installed: boolean;
    try {
      installed = await linkPiFileIfAbsent(stagedPath, targetPath);
    } catch {
      await tightenPiFileOwnerOnlyBestEffort(backupPath);
      throw new Error(`Pi auth promotion failed; the original credentials were retained at ${backupPath}.`);
    }
    if (!installed) {
      preserveConcurrentBackup = false;
      throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    try {
      await hooks.afterPiAuthLink?.(targetPath, stagedPath);
      await assertPromotedPiAuthStore(intended, stagedPath, targetPath, ownerUid);
    } catch {
      const backupStillExpected = await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid);
      try {
        const restored = await linkPiFileIfAbsent(backupPath, targetPath);
        if (restored || backupStillExpected) {
          preserveConcurrentBackup = false;
        } else {
          await tightenPiFileOwnerOnlyBestEffort(backupPath);
        }
      } catch {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
        throw new Error(`Pi auth promotion failed; credentials were retained at ${backupPath}.`);
      }
      throw new Error(preserveConcurrentBackup
        ? `Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`
        : `Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
    }
    if (!await claimedPiAuthBackupStillMatches(backupPath, expected, ownerUid)) {
      await tightenPiFileOwnerOnlyBestEffort(backupPath);
      throw new Error(`Pi auth promotion failed; concurrent credentials were retained at ${backupPath}.`);
    }
    preserveConcurrentBackup = false;
  } catch (error) {
    promotionError = targetMutationStarted && !(error instanceof PiAuthCleanupError)
      ? new PiAuthCleanupError(
        preserveConcurrentBackup ? backupPath : targetPath,
        `credential promotion changed filesystem state but did not complete cleanly: ${error instanceof Error ? error.message : String(error)}`,
      )
      : error;
    throw promotionError;
  } finally {
    if (backupCreated && preserveConcurrentBackup) {
      try {
        await tightenPiFileOwnerOnlyBestEffort(backupPath);
      } catch {
        // The fatal result below remains authoritative and names the residue.
      }
      throw combinePiAuthCleanupError(promotionError, new PiAuthCleanupError(
        backupPath,
        `concurrent credentials were retained at ${backupPath} for manual recovery`,
      ));
    }
    if (backupCreated) {
      try {
        await hooks.beforePiAuthBackupCleanup?.(backupPath);
        await rm(backupPath, { force: true });
      } catch (error) {
        throw combinePiAuthCleanupError(promotionError, new PiAuthCleanupError(
          backupPath,
          `credential backup could not be removed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  }
}

async function claimedPiAuthBackupStillMatches(
  backupPath: string,
  expected: PiAuthStoreSnapshot,
  ownerUid: number,
): Promise<boolean> {
  try {
    const current = await readPiAuthStore(backupPath, piAuthSingleLinkPolicy(ownerUid));
    return samePiAuthStoreSnapshotAfterMove(current, expected);
  } catch {
    return false;
  }
}

function samePiAuthStoreSnapshotAfterMove(
  current: PiAuthStoreSnapshot,
  expected: PiAuthStoreSnapshot,
): boolean {
  return current.exists && expected.exists &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.uid === expected.uid &&
    current.nlink === expected.nlink &&
    current.mode === expected.mode &&
    current.size === expected.size &&
    current.contents === expected.contents;
}

async function linkPiFileIfAbsent(source: string, target: string): Promise<boolean> {
  try {
    await link(source, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function assertPromotedPiAuthStore(
  intended: PiAuthStoreSnapshot,
  stagedPath: string,
  targetPath: string,
  ownerUid: number,
): Promise<void> {
  // Exclusive-link installation deliberately gives the same inode two names
  // until the private staging directory is removed. Exactly two links prove
  // that no third alias can retain or mutate credential bytes after cleanup.
  const twoLinkPolicy: PiAuthStoreReadPolicy = { ownerUid, allowedLinkCounts: [2] };
  const staged = await readPiAuthStore(stagedPath, twoLinkPolicy);
  const promoted = await readPiAuthStore(targetPath, twoLinkPolicy);
  if (
    !intended.exists ||
    !staged.exists ||
    !promoted.exists ||
    intended.uid !== ownerUid ||
    intended.nlink !== 1 ||
    staged.dev !== intended.dev ||
    staged.ino !== intended.ino ||
    promoted.dev !== intended.dev ||
    promoted.ino !== intended.ino ||
    staged.contents !== intended.contents ||
    intended.contents !== promoted.contents ||
    ((promoted.mode ?? 0) & 0o777) !== 0o600
  ) {
    throw new Error(`Pi auth file ${targetPath} changed during credential setup; the newer file was preserved.`);
  }
}

export function piAuthSingleLinkPolicy(ownerUid: number): PiAuthStoreReadPolicy {
  return { ownerUid, allowedLinkCounts: [1] };
}

async function tightenPiFileOwnerOnlyBestEffort(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if ((await handle.stat()).isFile()) await handle.chmod(0o600);
  } catch {
    // Preserve recovery bytes even if their metadata cannot be tightened.
  } finally {
    await handle?.close();
  }
}

async function assertPiAuthPathOutsideGitWorktree(path: string): Promise<void> {
  const result = await runGitForPi(["-C", dirname(path), "rev-parse", "--show-toplevel"]);
  if (result.ok) {
    throw new Error(
      `Refusing automatic Pi credential persistence inside Git worktree ${result.stdout.trim()}. Choose providers.piAuthPath outside the repository.`,
    );
  }
  if (await hasGitMetadataForPi(dirname(path))) {
    throw new Error(`Cannot prove Git safety for Pi auth path ${path}; choose a credential path outside the repository.`);
  }
}

function runGitForPi(args: readonly string[]): Promise<{ readonly ok: boolean; readonly stdout: string }> {
  return new Promise((resolveResult) => {
    execFile("git", [...args], { encoding: "utf8" }, (error, stdout) => {
      resolveResult({ ok: error === null, stdout });
    });
  });
}

async function hasGitMetadataForPi(start: string): Promise<boolean> {
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

export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymlinkOpenError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}
