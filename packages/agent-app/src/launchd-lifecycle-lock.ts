import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { deriveLaunchdMaintenanceLabel } from "./launchd.js";
import type { LaunchdPaths } from "./launchd.js";
import { ensureOwnerPrivateLaunchdDirectory } from "./launchd-private-files.js";
import { acquireOwnerPrivateLock, validateOwnerPrivateLockInputs } from "./owner-private-lock.js";
import { processIncarnationFromJson } from "./process-incarnation.js";
import type { ProcessIncarnation, SameProcessIncarnation } from "./process-incarnation.js";

export interface BackgroundLifecycleTarget {
  readonly label: string;
  readonly paths: LaunchdPaths;
}

export interface BackgroundLockAcquireOptions {
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Main LaunchAgent identity recorded when a synthetic shared lock is held. */
  readonly ownerLabel?: string;
  readonly purpose?: "lifecycle" | "shared-launchd-logs";
}

export interface FilesystemLifecycleLockOptions extends BackgroundLockAcquireOptions {
  readonly pid?: number;
  readonly now?: () => number;
  /** Permanent compatibility for owner records predating process-incarnation identity. */
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processIncarnation?: ProcessIncarnation;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
  readonly ownerlessGraceMs?: number;
  readonly randomToken?: () => string;
  /** Deterministic seam immediately after the final identity check. */
  readonly beforeStaleLockRename?: () => Promise<void>;
}

export interface LifecycleLockDependencies {
  readonly acquireLifecycleLock: (
    target: BackgroundLifecycleTarget,
    options?: BackgroundLockAcquireOptions,
  ) => Promise<(() => Promise<void>) | undefined>;
}

export const SHARED_LAUNCHD_LOG_LOCK_WAIT_MS = 18_000;
export const SHARED_LAUNCHD_LOG_LOCK_POLL_MS = 400;

/** One per-account lock key for every mutation of the shared launchd log chain. */
export function sharedLaunchdLogLockTarget(
  target: BackgroundLifecycleTarget,
): BackgroundLifecycleTarget {
  const digest = createHash("sha256").update(resolve(target.paths.logDir)).digest("hex").slice(0, 24);
  return { label: `launchd-log-shared-${digest}`, paths: target.paths };
}

export async function acquireSharedLaunchdLogLock(
  target: BackgroundLifecycleTarget,
  deps: LifecycleLockDependencies,
  mode: "automatic" | "interactive",
): Promise<(() => Promise<void>) | undefined> {
  return await deps.acquireLifecycleLock(sharedLaunchdLogLockTarget(target), {
    purpose: "shared-launchd-logs",
    ownerLabel: target.label,
    waitTimeoutMs: mode === "interactive" ? SHARED_LAUNCHD_LOG_LOCK_WAIT_MS : 0,
    pollIntervalMs: SHARED_LAUNCHD_LOG_LOCK_POLL_MS,
  });
}

/** Canonical owner-private implementation for per-agent and synthetic shared locks. */
export async function acquireFilesystemLifecycleLock(
  target: BackgroundLifecycleTarget,
  options: FilesystemLifecycleLockOptions = {},
): Promise<(() => Promise<void>) | undefined> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => Date.now());
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const ownerlessGraceMs = options.ownerlessGraceMs ?? 5 * 60_000;
  const randomToken = options.randomToken ?? randomUUID;
  const shared = options.purpose === "shared-launchd-logs";
  const displayName = shared ? "Shared launchd-log mutation lock" : "Lifecycle lock";
  validateOwnerPrivateLockInputs(displayName, pid, ownerlessGraceMs);
  const managedRoot = dirname(target.paths.logDir);
  const locksDir = resolve(managedRoot, "locks");
  for (const path of [managedRoot, locksDir]) await ensureOwnerPrivateLaunchdDirectory(path);

  const lockDir = resolve(locksDir, `${target.label}.lock`);
  const held = await acquireOwnerPrivateLock({
    path: lockDir,
    label: displayName,
    schemaTag: shared
      ? "mono-agent.shared-launchd-log-lock.v1"
      : "mono-agent.filesystem-lifecycle-lock.v1",
    ownerlessGraceMs,
    ...(options.waitTimeoutMs === undefined || options.waitTimeoutMs === 0
      ? { maxAcquireAttempts: 4 }
      : {}),
    waitTimeoutMs: options.waitTimeoutMs ?? 0,
    pollIntervalMs: options.pollIntervalMs ?? SHARED_LAUNCHD_LOG_LOCK_POLL_MS,
    pid,
    now,
    randomToken,
    ...(options.processIncarnation === undefined ? {} : { processIncarnation: options.processIncarnation }),
    ...(options.isSameProcessIncarnation === undefined
      ? {}
      : { isSameProcessIncarnation: options.isSameProcessIncarnation }),
    ...(shared
      ? {
          ownerFields: () => ({ label: options.ownerLabel }),
          validateOwnerFields: (record: Readonly<Record<string, unknown>>) =>
            typeof record.label === "string" && isCanonicalMainLaunchdLabel(record.label),
        }
      : {}),
    parseLegacyOwner: (record) => {
      if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
      const incarnation = processIncarnationFromJson(record.incarnation);
      return { pid: record.pid, ...(incarnation === undefined ? {} : { incarnation }) };
    },
    // Shared ownership has never accepted legacy records; retain that fail-closed floor.
    allowCurrentUserLegacyOwnerMode: !shared,
    isLegacyProcessAlive: isProcessAlive,
    invalidOwner: shared ? "error" : "ownerless",
    livenessError: () => "assume-live",
    ...(options.beforeStaleLockRename === undefined
      ? {}
      : { beforeStaleRename: options.beforeStaleLockRename }),
    staleRace: "return",
    ...(shared && (options.waitTimeoutMs ?? 0) > 0
      ? { timeoutError: (observed) => sharedLaunchdLogLockTimeoutError(observed) }
      : {}),
    stalePath: ({ now: staleAt, pid: stalePid, token }) =>
      resolve(locksDir, `${target.label}.stale-${staleAt}-${stalePid}-${token}`),
    releasedPath: ({ now: releasedAt, pid: ownerPid, token }) =>
      resolve(locksDir, `${target.label}.released-${releasedAt}-${ownerPid}-${token}`),
    abandonedPath: ({ now: abandonedAt, pid: ownerPid, token }) =>
      resolve(locksDir, `${target.label}.abandoned-${abandonedAt}-${ownerPid}-${token}`),
  });
  return held === undefined ? undefined : () => held.release();
}

function isCanonicalMainLaunchdLabel(value: string): boolean {
  try {
    deriveLaunchdMaintenanceLabel(value);
    return true;
  } catch {
    return false;
  }
}

function sharedLaunchdLogLockTimeoutError(observed: {
  readonly kind: "ownerless" | "owned";
  readonly owner?: { readonly content: string };
}): Error {
  if (observed.kind !== "owned" || observed.owner === undefined) {
    return new Error(
      `Timed out after ${SHARED_LAUNCHD_LOG_LOCK_WAIT_MS}ms waiting for an owner record to finish publishing.`,
    );
  }
  try {
    const record = JSON.parse(observed.owner.content) as Record<string, unknown>;
    const pid = typeof record.pid === "number" ? String(record.pid) : "unknown";
    const label = typeof record.label === "string" ? record.label : "unknown";
    const acquiredAt = typeof record.createdAt === "string" ? record.createdAt : "unknown";
    const incarnation = record.incarnation === undefined ? "unknown" : JSON.stringify(record.incarnation);
    return new Error(
      `Timed out after ${SHARED_LAUNCHD_LOG_LOCK_WAIT_MS}ms; holder pid=${pid} label=${label} acquiredAt=${acquiredAt} incarnation=${incarnation}.`,
    );
  } catch {
    return new Error(
      `Timed out after ${SHARED_LAUNCHD_LOG_LOCK_WAIT_MS}ms; the owner record could not be described safely.`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
