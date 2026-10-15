import type { ManagedLaunchdLogMonitorStatus } from "./background-log-maintenance.js";
import type { BackgroundLifecycleTarget } from "./background.js";
import type { LaunchdPaths } from "./launchd.js";
import { readPrivateLaunchdState, writePrivateLaunchdState, removePrivateLaunchdState } from "./private-launchd-state.js";

const OUTCOMES = new Set<ManagedLaunchdLogMonitorStatus["lastOutcome"]>([
  "idle",
  "deferred-busy",
  "shared-only",
  "pending-artifact",
  "cooldown",
  "stopped",
  "helper-unloaded",
  "helper-running",
  "requested",
  "request-failed",
  "inspection-failed",
]);

export async function writeLaunchdLogMonitorStatus(target: BackgroundLifecycleTarget, status: ManagedLaunchdLogMonitorStatus): Promise<void> {
  validateStatus(status);
  await writePrivateLaunchdState(target, "launchd-log-monitor", status, 1024);
}
export async function readLaunchdLogMonitorStatus(mainLabel: string, paths: Pick<LaunchdPaths, "logDir">): Promise<ManagedLaunchdLogMonitorStatus | undefined> {
  const status = await readPrivateLaunchdState(mainLabel, paths, "launchd-log-monitor", 1024);
  if (status === undefined) return undefined;
  validateStatus(status);
  return status;
}
export async function removeLaunchdLogMonitorStatus(target: BackgroundLifecycleTarget): Promise<void> {
  await removePrivateLaunchdState(target, "launchd-log-monitor");
}

function validateStatus(value: unknown): asserts value is ManagedLaunchdLogMonitorStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Launchd log monitor status must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",")
    !== "cooldownDeadline,lastInspectionAt,lastOutcome,version,wakeCount") {
    throw new Error("Launchd log monitor status has unexpected fields.");
  }
  if (record.version !== 1
    || typeof record.lastInspectionAt !== "string"
    || !validDate(record.lastInspectionAt)
    || typeof record.wakeCount !== "number"
    || !Number.isSafeInteger(record.wakeCount)
    || record.wakeCount < 0
    || typeof record.lastOutcome !== "string"
    || !OUTCOMES.has(record.lastOutcome as ManagedLaunchdLogMonitorStatus["lastOutcome"])
    || typeof record.cooldownDeadline !== "string"
    || !validDate(record.cooldownDeadline)) {
    throw new Error("Launchd log monitor status is malformed.");
  }
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
