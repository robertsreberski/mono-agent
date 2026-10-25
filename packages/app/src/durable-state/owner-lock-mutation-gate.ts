import { type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/**
 * Kernel-released cross-process gate for owner-private lock mutations.
 *
 * The gate is one empty, owner-only regular file. Holding it means one
 * node:sqlite connection holds `BEGIN EXCLUSIVE` on that file; the transaction
 * is always rolled back and never writes, so the file stays empty and there is
 * no journal to recover. The OS drops the lock when the holder exits or is
 * killed, so a crashed holder never needs reclaiming.
 *
 * Never open the gate file through `fs` while a connection may hold it: closing
 * any descriptor on the inode drops every POSIX lock this process holds on it.
 */

const DEFAULT_BUSY_TIMEOUT_MS = 3_000;
const MIN_BUSY_TIMEOUT_MS = 0;
const MAX_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 10;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export interface OwnerLockMutationGate {
  /** Gate file path, normally a dot-file beside the lock directories it serializes. */
  readonly path: string;
  /** Total wait for the in-process mutex plus the OS lock; clamped to 0-5000 ms. Defaults to 3000 ms. */
  readonly busyTimeoutMs?: number;
  readonly retryIntervalMs?: number;
  /** Test-only seam between opening the connection and taking the OS lock. */
  readonly beforeLock?: (path: string) => void | Promise<void>;
}

/** The gate stayed held by another holder for the whole bounded wait. Never means "owned elsewhere". */
export class OwnerLockCoordinationBusyError extends Error {
  readonly code = "OWNER_LOCK_COORDINATION_BUSY";
  constructor(label: string, options?: ErrorOptions) {
    super(`${label} coordination is busy: another process is updating this lock. Retry shortly.`, options);
    this.name = "OwnerLockCoordinationBusyError";
  }
}

/** The gate file is missing its safety properties or cannot be locked; callers fail closed. */
export class OwnerLockGateUnavailableError extends Error {
  readonly code = "OWNER_LOCK_GATE_UNAVAILABLE";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OwnerLockGateUnavailableError";
  }
}

interface Waiter { readonly grant: () => void }
interface MutexState { held: boolean; readonly waiters: Waiter[] }

/** One in-process holder per gate path, so this process never opens two connections on it at once. */
const mutexes = new Map<string, MutexState>();

/** Run `operation` while holding the gate. Fails closed: the operation never runs unguarded. */
export async function withOwnerLockMutationGate<T>(
  gate: OwnerLockMutationGate,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = resolve(gate.path);
  const timeout = busyTimeout(gate.busyTimeoutMs);
  const deadline = performance.now() + timeout;
  const releaseMutex = await acquireMutex(path, label, deadline);
  try {
    const connection = await lockGate(path, gate, label, deadline);
    try {
      return await operation();
    } finally {
      // ROLLBACK ends the never-written transaction; close drops the OS lock.
      try { if (connection.isTransaction) connection.exec("ROLLBACK"); } catch { /* close still drops the lock */ }
      try { connection.close(); } catch { /* process exit drops the lock */ }
    }
  } finally {
    releaseMutex();
  }
}

function busyTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isFinite(value)) throw new Error("Owner-lock gate busy timeout must be finite.");
  return Math.min(MAX_BUSY_TIMEOUT_MS, Math.max(MIN_BUSY_TIMEOUT_MS, value));
}

async function acquireMutex(path: string, label: string, deadline: number): Promise<() => void> {
  let state = mutexes.get(path);
  if (state === undefined) {
    state = { held: false, waiters: [] };
    mutexes.set(path, state);
  }
  const current = state;
  if (!current.held) {
    current.held = true;
    return () => releaseMutex(path, current);
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const waiter: Waiter = {
      grant: () => {
        clearTimeout(timer);
        resolvePromise();
      },
    };
    const timer = setTimeout(() => {
      const index = current.waiters.indexOf(waiter);
      if (index >= 0) current.waiters.splice(index, 1);
      rejectPromise(new OwnerLockCoordinationBusyError(label));
    }, Math.max(0, deadline - performance.now()));
    current.waiters.push(waiter);
  });
  return () => releaseMutex(path, current);
}

function releaseMutex(path: string, state: MutexState): void {
  const next = state.waiters.shift();
  if (next !== undefined) {
    // Hand the held mutex straight to the next waiter.
    next.grant();
    return;
  }
  state.held = false;
  if (mutexes.get(path) === state) mutexes.delete(path);
}

async function lockGate(
  path: string,
  gate: OwnerLockMutationGate,
  label: string,
  deadline: number,
): Promise<import("node:sqlite").DatabaseSync> {
  const before = await existingOrCreatedGate(path, label);
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    throw new OwnerLockGateUnavailableError(`${label} mutation gate is unavailable: node:sqlite cannot be loaded.`, { cause: error });
  }
  let connection: import("node:sqlite").DatabaseSync;
  try {
    // timeout 0: a busy lock throws immediately; waiting happens asynchronously below.
    connection = new DatabaseSync(path, { timeout: 0 });
  } catch (error) {
    throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} cannot be opened.`, { cause: error });
  }
  let locked = false;
  try {
    await sameGate(path, before, label);
    await gate.beforeLock?.(path);
    const interval = Math.max(1, gate.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
    for (;;) {
      try {
        // MEMORY journaling keeps the never-written transaction from creating a journal file.
        const mode = connection.prepare("PRAGMA journal_mode=MEMORY").get() as { journal_mode?: unknown } | undefined;
        if (mode?.journal_mode !== "memory") {
          throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} refused in-memory journaling.`);
        }
        connection.exec("BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if (error instanceof OwnerLockGateUnavailableError) throw error;
        if (!isBusy(error)) {
          throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} is unusable or corrupt.`, { cause: error });
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new OwnerLockCoordinationBusyError(label, { cause: error });
        await sleep(Math.min(interval, remaining));
      }
    }
    // The lock binds an inode; prove the path still names the inode we locked.
    await sameGate(path, before, label);
    locked = true;
    return connection;
  } finally {
    if (!locked) {
      try { if (connection.isTransaction) connection.exec("ROLLBACK"); } catch { /* close drops the lock */ }
      try { connection.close(); } catch { /* nothing else holds it */ }
    }
  }
}

async function existingOrCreatedGate(path: string, label: string): Promise<BigIntStats> {
  let details = await lstatGate(path, label);
  if (details === undefined) {
    try {
      // Create-only; the descriptor is closed before any connection exists.
      await (await open(path, "wx", 0o600)).close();
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} cannot be created.`, { cause: error });
      }
    }
    details = await lstatGate(path, label);
    if (details === undefined) throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} disappeared while it was created.`);
  }
  assertSecureGate(details, path, label);
  return details;
}

async function sameGate(path: string, expected: BigIntStats, label: string): Promise<void> {
  const details = await lstatGate(path, label);
  if (details === undefined || details.dev !== expected.dev || details.ino !== expected.ino) {
    throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} was replaced while it was opened.`);
  }
  assertSecureGate(details, path, label);
}

async function lstatGate(path: string, label: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} cannot be inspected.`, { cause: error });
  }
}

function assertSecureGate(details: BigIntStats, path: string, label: string): void {
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} must be a regular file, not a link or directory.`);
  }
  if (details.nlink !== 1n) {
    throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} must have exactly one filesystem link.`);
  }
  if (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid())) {
    throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} is not owned by the current user.`);
  }
  if (process.platform !== "win32" && (details.mode & 0o777n) !== 0o600n) {
    throw new OwnerLockGateUnavailableError(`${label} mutation gate ${path} must be owner-only (mode 0600).`);
  }
}

function isBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  // Extended result codes keep the primary code in the low byte.
  return typeof errcode === "number" && [SQLITE_BUSY, SQLITE_LOCKED].includes(errcode & 0xff);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
