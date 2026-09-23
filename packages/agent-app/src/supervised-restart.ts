import { deriveLaunchdLabel, launchdManagedWorkerInfo, type LaunchctlRunner } from "./launchd.js";
import {
  inspectSystemd,
  isSystemdUserManagerUnavailable,
  runSystemdTool,
  systemdUnitName,
} from "./systemd.js";

/**
 * The exit code a supervised worker returns after a console-initiated
 * restart. This MUST stay nonzero, and nothing else about it is load-bearing:
 *
 * - launchd plists are generated with `KeepAlive.SuccessfulExit=false`, so a
 *   clean `exit(0)` is NOT relaunched — only an unsuccessful exit brings the
 *   worker back. See `renderLaunchdPlist`.
 * - systemd user units use `Restart=on-failure`, so again only a nonzero exit
 *   relaunches. See `renderSystemdUnit`.
 *
 * The value itself (42) is arbitrary but grep-able: it distinguishes "the
 * worker ended itself for a supervised restart" from a genuine failure (1) or
 * a usage refusal (2) in logs and `status` output. Changing this value to zero
 * prevents launchd and systemd from relaunching the worker: a clean exit reads
 * as a successful exit, which both supervisors are configured to leave retired.
 */
export interface SupervisedRestartVerification {
  readonly supported: boolean;
  readonly reason?: string;
}

export interface SupervisedRestartDeps {
  /** Canonical worker config identity (the same path the supervisor installed). */
  readonly configPath: string;
  /** Worker boot time, carried on the restart acceptance for comeback tracing. */
  readonly startedAt: string;
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  readonly getuid?: () => number | undefined;
  readonly launchdRunner?: LaunchctlRunner;
  readonly systemdRun?: typeof runSystemdTool;
  readonly logger?: {
    warn(message: string, metadata?: Record<string, unknown>): void;
  };
}

/**
 * Verify that the loaded supervised service actually owns THIS process before
 * the adapter may advertise restart as supported. Every refusal fails closed
 * with a human-readable reason and never throws: an unverifiable worker is an
 * unsupported worker, not a broken boot.
 */
export async function verifySupervisedRestart(
  deps: SupervisedRestartDeps,
): Promise<SupervisedRestartVerification> {
  const platform = deps.platform ?? process.platform;
  const pid = deps.pid ?? process.pid;
  if (platform === "darwin") {
    return await verifyLaunchdRestart(deps, pid);
  }
  if (platform === "linux") {
    return await verifySystemdRestart(deps, pid);
  }
  return {
    supported: false,
    reason: "Agent restart is supported only on supervised macOS and Linux workers.",
  };
}

async function verifyLaunchdRestart(
  deps: SupervisedRestartDeps,
  pid: number,
): Promise<SupervisedRestartVerification> {
  const runner = deps.launchdRunner;
  const uid = deps.getuid?.() ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (runner === undefined || uid === undefined) {
    return { supported: false, reason: "Agent restart needs the supervised-service check, which is unavailable." };
  }
  const label = deriveLaunchdLabel(deps.configPath);
  let info: Awaited<ReturnType<typeof launchdManagedWorkerInfo>>;
  try {
    info = await launchdManagedWorkerInfo(runner, label, uid);
  } catch (error) {
    deps.logger?.warn("Supervised restart check failed; advertising restart as unsupported.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { supported: false, reason: "The supervised-service check failed for this worker." };
  }
  if (!info.loaded) {
    return { supported: false, reason: "No supervised service is registered for this worker." };
  }
  if (info.pid !== pid) {
    return { supported: false, reason: "The supervised service does not own this process." };
  }
  if (info.definition === undefined) {
    return { supported: false, reason: "The loaded service definition is not a managed mono-agent worker." };
  }
  if (info.definition.configPath !== deps.configPath) {
    return { supported: false, reason: "The loaded service definition does not match this worker." };
  }
  if (info.relaunchOnFailure !== true) {
    return { supported: false, reason: "The loaded launchd service does not verify relaunch on failure." };
  }
  return { supported: true };
}

async function verifySystemdRestart(
  deps: SupervisedRestartDeps,
  pid: number,
): Promise<SupervisedRestartVerification> {
  const run = deps.systemdRun ?? runSystemdTool;
  let service: Awaited<ReturnType<typeof inspectSystemd>>;
  try {
    service = await inspectSystemd(deps.configPath, { run });
  } catch (error) {
    if (isSystemdUserManagerUnavailable(error)) {
      return { supported: false, reason: "Agent restart needs a running systemd user manager." };
    }
    deps.logger?.warn("Supervised restart check failed; advertising restart as unsupported.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { supported: false, reason: "The supervised-service check failed for this worker." };
  }
  if (service.loadState === "not-found" || service.loadState !== "loaded") {
    return { supported: false, reason: "No supervised service is registered for this worker." };
  }
  if (service.pid !== pid) {
    return { supported: false, reason: "The supervised service does not own this process." };
  }
  if (service.activeState !== "active") {
    return { supported: false, reason: "The supervised service for this worker is not active." };
  }
  // The loaded unit must be OURS, not just any unit that happens to own this
  // PID: compare the fragment basename against the unit name derived from this
  // worker's config identity. A full-path comparison would false-negative on
  // the `default.target.wants` symlinks enablement creates; the basename is
  // the stable part.
  const fragmentName = service.fragmentPath.split("/").pop() ?? "";
  if (fragmentName !== systemdUnitName(deps.configPath)
    || !service.execStart.includes(`--config ${deps.configPath}`)
    || !service.execStart.includes("--expected-background-snapshot")) {
    return { supported: false, reason: "The loaded service definition does not match this worker." };
  }
  // Only a relaunch policy that brings back a nonzero exit may advertise
  // support: with `Restart=no` (or `on-success`/`on-abnormal`, which likewise
  // ignore a plain nonzero exit) the worker's exit 42 would retire the agent
  // instead of restarting it. An unreadable policy fails closed.
  if (service.restart !== "on-failure" && service.restart !== "always") {
    return {
      supported: false,
      reason: `The supervised service is not configured to relaunch this worker (Restart=${service.restart === "" ? "unknown" : service.restart}).`,
    };
  }
  return { supported: true };
}
