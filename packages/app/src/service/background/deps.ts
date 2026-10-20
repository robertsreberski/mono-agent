import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

import { listRecordedRuns, listTraceSources } from "@mono-agent/observability";

import { resolveApprovedBackgroundSnapshot, invalidateApprovedBackgroundSnapshots } from "./approved-background-snapshot.js";
import { clearMaintenanceDeferral, allowUnattendedMaintenanceStop } from "../launchd/launchd-maintenance-activity.js";
import { makeLaunchctlRunner } from "../launchd/launchd.js";
import {
  beginLaunchdLogMaintenanceIntent,
  clearLaunchdLogMaintenanceIntent,
  inspectLaunchdLogs,
  markLaunchdLogMaintenanceRestoring,
  markLaunchdLogMaintenanceStopped,
  markLaunchdLogMaintenanceStopping,
  readLaunchdLogMaintenanceIntent,
  rotateStoppedLaunchdLogs,
} from "../launchd/launchd-logs.js";
import {
  ensureManagedBackgroundRuntime,
  inspectManagedRuntimeSourceIdentity,
  verifyManagedRuntimeLaunch,
} from "../managed-runtime/background-runtime.js";
import { resolveConfiguredManagedRuntimePackages } from "../managed-runtime/managed-runtime-packages.js";
import { removeLaunchdLogMonitorStatus } from "../launchd/launchd-log-monitor-status.js";
import { acquireManagedRuntimePublicationBarrier } from "../managed-runtime/managed-runtime-publication.js";
import { ensureOwnerPrivateLaunchdDirectory } from "../launchd/launchd-private-files.js";
import { acquireFilesystemLifecycleLock } from "../launchd/launchd-lifecycle-lock.js";
import { isErrno } from "./background-lifecycle-utils.js";
import { inspectOwnerPrivateLaunchdPlist, writeOwnerPrivateLaunchdFile } from "../launchd/plist-files.js";
import type { BackgroundDeps } from "./types.js";

export function defaultBackgroundDeps(): BackgroundDeps {
  const deps: BackgroundDeps = {
    clearMaintenanceDeferral,
    allowUnattendedStop: async (target, request) => allowUnattendedMaintenanceStop(target, deps, request),
    runner: makeLaunchctlRunner(),
    getuid: () => process.getuid?.() ?? 0,
    currentPid: () => process.pid,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    listRecordedRuns,
    listTraceSources,
    writeFile: writeOwnerPrivateLaunchdFile,
    mkdir: ensureOwnerPrivateLaunchdDirectory,
    rm: (path) => rm(path, { force: true }),
    inspectLaunchdLogs: async (paths) => await inspectLaunchdLogs(paths),
    rotateStoppedLaunchdLogs: async (paths) => {
      await rotateStoppedLaunchdLogs(paths);
    },
    readLaunchdLogMaintenanceIntent: async (paths) => await readLaunchdLogMaintenanceIntent(paths),
    beginLaunchdLogMaintenanceIntent: async (paths, intent) => {
      await beginLaunchdLogMaintenanceIntent(paths, intent);
    },
    markLaunchdLogMaintenanceStopped: async (paths, expected) =>
      await markLaunchdLogMaintenanceStopped(paths, expected),
    markLaunchdLogMaintenanceRestoring: async (paths, expected) =>
      await markLaunchdLogMaintenanceRestoring(paths, expected),
    markLaunchdLogMaintenanceStopping: async (paths, expected) =>
      await markLaunchdLogMaintenanceStopping(paths, expected),
    clearLaunchdLogMaintenanceIntent: async (paths, expected) => {
      await clearLaunchdLogMaintenanceIntent(paths, expected);
    },
    removeLaunchdLogMonitorStatus,
    verifyLaunchdPlist: inspectOwnerPrivateLaunchdPlist,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM means the process exists but is owned by someone else.
        return isErrno(error, "EPERM");
      }
    },
    ensureManagedRuntime: (input) => ensureManagedBackgroundRuntime(input),
    inspectManagedRuntimeSourceIdentity,
    verifyManagedRuntimeLaunch,
    resolveManagedRuntimePackages: (target) => resolveConfiguredManagedRuntimePackages({
      cwd: target.cwd,
      configPath: target.configPath,
      env: target.configurationEnvironment,
    }),
    acquireLifecycleLock: acquireFilesystemLifecycleLock,
    resolveApprovedSnapshot: resolveApprovedBackgroundSnapshot,
    invalidateApprovedSnapshots: (target) => invalidateApprovedBackgroundSnapshots({ label: target.label, managedRoot: dirname(target.paths.logDir) }),
    acquireRuntimePublicationBarrier: (target) => acquireManagedRuntimePublicationBarrier({
      label: target.label,
      managedRoot: dirname(target.paths.logDir),
    }),
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    spawnTail: (args) =>
      new Promise<number>((resolvePromise) => {
        const child = spawn("tail", [...args], { stdio: "inherit" });
        child.on("error", () => resolvePromise(127));
        child.on("close", (code) => resolvePromise(code ?? 0));
      }),
  };
  return deps;
}
