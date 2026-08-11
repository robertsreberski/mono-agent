import process from "node:process";

import {
  deriveLaunchdMaintenanceLabel,
  launchdServiceInfo,
  makeLaunchctlRunner,
} from "./launchd.js";
import type { LaunchctlRunner } from "./launchd.js";
import {
  acquireFilesystemLifecycleLock,
} from "./launchd-lifecycle-lock.js";
import type {
  BackgroundLifecycleTarget,
  BackgroundLockAcquireOptions,
} from "./launchd-lifecycle-lock.js";
import { maintenanceErrorMessage } from "./background-lifecycle-utils.js";
import * as ui from "./ui.js";

const OWNED_MAINTENANCE_LIFECYCLE = Symbol("owned-launchd-maintenance-lifecycle");

export interface LaunchdMaintenanceLifecycleLease {
  readonly label: string;
  readonly pid: number;
  readonly [OWNED_MAINTENANCE_LIFECYCLE]: true;
}

export interface LaunchdMaintenanceGateDependencies {
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly currentPid: () => number;
  readonly isAlive: (pid: number) => boolean;
  readonly acquireLifecycleLock: (
    target: BackgroundLifecycleTarget,
    options?: BackgroundLockAcquireOptions,
  ) => Promise<(() => Promise<void>) | undefined>;
  readonly stderr: (text: string) => void | Promise<void>;
}

export function defaultLaunchdMaintenanceGateDependencies(): LaunchdMaintenanceGateDependencies {
  return {
    runner: makeLaunchctlRunner(),
    getuid: () => process.getuid?.() ?? 0,
    currentPid: () => process.pid,
    isAlive: processIsAlive,
    acquireLifecycleLock: acquireFilesystemLifecycleLock,
    stderr: (text) => void process.stderr.write(text),
  };
}

/**
 * Authenticate the exact launchd-owned helper, then own its per-agent lifecycle
 * lock nonblocking before invoking any caller-supplied inspection or import.
 * The account-wide log lock is deliberately acquired later, only around the
 * shared-chain mutation that actually needs it.
 */
export async function withLaunchdMaintenanceControllerLock(
  target: BackgroundLifecycleTarget,
  deps: LaunchdMaintenanceGateDependencies,
  operation: (ownership: LaunchdMaintenanceLifecycleLease) => Promise<number>,
): Promise<number> {
  const helperLabel = deriveLaunchdMaintenanceLabel(target.label);
  const helperPid = deps.currentPid();
  const helperService = await launchdServiceInfo(deps.runner, helperLabel, deps.getuid());
  if (!helperService.loaded || helperService.pid !== helperPid || !deps.isAlive(helperPid)) {
    reportFailure(
      target,
      deps,
      "authenticate the launchd-owned recovery controller",
      new Error(`launchd does not own this helper pid ${helperPid}`),
    );
    return 1;
  }

  const releasePerAgent = await deps.acquireLifecycleLock(target, {
    purpose: "lifecycle",
    waitTimeoutMs: 0,
  });
  if (releasePerAgent === undefined) return 0;
  try {
    return await operation({
      label: target.label,
      pid: helperPid,
      [OWNED_MAINTENANCE_LIFECYCLE]: true,
    });
  } finally {
    await releasePerAgent().catch((error: unknown) => {
      safeStderr(deps, ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${maintenanceErrorMessage(error)}`,
      ));
    });
  }
}

/** Reject heavy reconciliation calls that did not cross this authenticated gate. */
export function assertLaunchdMaintenanceLifecycleLease(
  ownership: LaunchdMaintenanceLifecycleLease,
  target: BackgroundLifecycleTarget,
): void {
  if (ownership?.[OWNED_MAINTENANCE_LIFECYCLE] !== true
    || ownership.label !== target.label
    || ownership.pid !== process.pid) {
    throw new Error("Launchd maintenance requires the authenticated per-agent lifecycle capability.");
  }
}

function reportFailure(
  target: BackgroundLifecycleTarget,
  deps: Pick<LaunchdMaintenanceGateDependencies, "stderr">,
  action: string,
  error: unknown,
): void {
  safeStderr(deps, ui.errorLine(
    `Scheduled log maintenance could not ${action} for ${target.label}: ${maintenanceErrorMessage(error)}`,
  ));
}

function safeStderr(
  deps: Pick<LaunchdMaintenanceGateDependencies, "stderr">,
  text: string,
): void {
  try {
    const reported = deps.stderr(text);
    if (reported !== undefined) void Promise.resolve(reported).catch(() => undefined);
  } catch {
    // A reporter cannot change lock ownership, helper lifecycle, or rejection.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}
