import {
  bootstrap,
  deriveLaunchdMaintenanceLabel,
  kickstart,
  launchdServiceInfo,
} from "./launchd.js";
import type { LaunchctlRunner, LaunchdPaths } from "./launchd.js";
import type { LaunchdLogInspection, LaunchdLogMaintenanceIntent } from "./launchd-logs.js";
import { LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS } from "./launchd-logs.js";
import {
  lifecycleFailure,
  maintenanceErrorMessage,
  pollUntil,
  uniquePids,
  unloadLaunchdService,
} from "./background-lifecycle-utils.js";
import type { PollOptions } from "./background-lifecycle-utils.js";
import type { BackgroundDeps, BackgroundLifecycleTarget } from "./background.js";
import * as ui from "./ui.js";

export interface ManagedLaunchdLogInspectionDependencies {
  readonly inspectLaunchdLogs: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<LaunchdLogInspection>;
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  /** Monotonic clock: cooldown authority never depends on wall-clock movement. */
  readonly monotonicNow?: () => number;
  readonly wallClockNow?: () => number;
  readonly isStopped?: () => boolean;
}

export interface ManagedLaunchdLogMonitorDependencies extends ManagedLaunchdLogInspectionDependencies {
  readonly stderr: (text: string) => void | Promise<void>;
  readonly recordStatus?: (status: ManagedLaunchdLogMonitorStatus) => void | Promise<void>;
}

export interface ManagedLaunchdLogMonitor {
  stop(): void;
}

export interface AdditionalLaunchdLogInspection {
  readonly needsMaintenance: boolean;
  readonly canMaintain: boolean;
  readonly issues: readonly string[];
}

export interface AdditionalLaunchdLogMaintenanceResult {
  readonly refusals: readonly string[];
}

/** Narrow mutation port shared by agent maintenance and the isolated web helper. */
export interface LaunchdLogMaintenanceDeps {
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stderr: (text: string) => void;
  readonly inspectLaunchdLogs: BackgroundDeps["inspectLaunchdLogs"];
  readonly rotateStoppedLaunchdLogs: BackgroundDeps["rotateStoppedLaunchdLogs"];
  readonly readLaunchdLogMaintenanceIntent: BackgroundDeps["readLaunchdLogMaintenanceIntent"];
  readonly beginLaunchdLogMaintenanceIntent: BackgroundDeps["beginLaunchdLogMaintenanceIntent"];
  readonly markLaunchdLogMaintenanceStopped: BackgroundDeps["markLaunchdLogMaintenanceStopped"];
  readonly markLaunchdLogMaintenanceRestoring: BackgroundDeps["markLaunchdLogMaintenanceRestoring"];
  readonly clearLaunchdLogMaintenanceIntent: BackgroundDeps["clearLaunchdLogMaintenanceIntent"];
  readonly verifyLaunchdPlist: BackgroundDeps["verifyLaunchdPlist"];
  readonly isAlive: (pid: number) => boolean;
  /** Optional bounded compatibility seam; it cannot read or mutate intent/journal state. */
  readonly inspectAdditionalLaunchdLogArtifacts?: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<AdditionalLaunchdLogInspection>;
  /** Runs only after durable stopped-writer proof and before core rotation. */
  readonly maintainAdditionalLaunchdLogArtifacts?: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<AdditionalLaunchdLogMaintenanceResult>;
  readonly recordAdditionalLaunchdLogRefusals?: (refusals: readonly string[]) => Promise<void>;
  readonly recordMaintenancePhase?: (
    phase: "inspecting" | "stopping" | "stopped" | "rotating" | "restoring" | "complete",
  ) => Promise<void>;
}

export type ManagedLaunchdLogMonitorOutcome =
  | "idle"
  | "shared-only"
  | "pending-artifact"
  | "cooldown"
  | "stopped"
  | "helper-unloaded"
  | "helper-running"
  | "requested"
  | "request-failed"
  | "inspection-failed";

export interface ManagedLaunchdLogMonitorStatus {
  readonly version: 1;
  readonly lastInspectionAt: string;
  readonly wakeCount: number;
  readonly lastOutcome: ManagedLaunchdLogMonitorOutcome;
  readonly cooldownDeadline: string;
}

export interface ManagedLaunchdLogWakeState {
  cooldownIndex: number;
  cooldownDeadlineMonotonicMs: number;
  wakeCount: number;
  lastOutcome: ManagedLaunchdLogMonitorOutcome;
  lastReportedOutcome: ManagedLaunchdLogMonitorOutcome | undefined;
}

const WAKE_COOLDOWN_MS = [5, 10, 20, 40, 60].map((minutes) => minutes * 60_000);

export function createManagedLaunchdLogWakeState(monotonicNow = defaultMonotonicNow): ManagedLaunchdLogWakeState {
  return {
    cooldownIndex: 0,
    cooldownDeadlineMonotonicMs: monotonicNow() + WAKE_COOLDOWN_MS[0]!,
    wakeCount: 0,
    lastOutcome: "idle",
    lastReportedOutcome: undefined,
  };
}

/**
 * Run the managed worker's bounded metadata fast path. The dependency surface
 * intentionally excludes config validation, snapshots, and runtime recovery:
 * only a concrete safe maintenance inventory may wake the authenticated helper.
 */
export async function requestLaunchdLogMaintenanceIfNeeded(
  target: BackgroundLifecycleTarget,
  deps: ManagedLaunchdLogInspectionDependencies,
  state: ManagedLaunchdLogWakeState = createManagedLaunchdLogWakeState(deps.monotonicNow),
): Promise<ManagedLaunchdLogMonitorOutcome> {
  const monotonicNow = deps.monotonicNow ?? defaultMonotonicNow;
  const stopped = deps.isStopped ?? (() => false);
  // Classify each pass independently. A prior kickstart failure must not make
  // a later unsafe inventory look like the same deduplicated request failure.
  setOutcome(state, "inspection-failed");
  const inspection = await deps.inspectLaunchdLogs(target.paths);
  if (stopped()) return setOutcome(state, "stopped");
  if (!inspection.canMaintain) {
    const detail = inspection.issues.length === 0
      ? "the bounded inventory is unsafe"
      : inspection.issues.join("; ");
    throw new Error(`LaunchAgent log maintenance refused unsafe inventory: ${detail}`);
  }

  const pendingArtifact = inspection.pendingMaintenance
    || inspection.pendingTransaction
    || inspection.pendingPreparation;
  if (pendingArtifact) {
    // A replacement worker can inherit stale intent or transaction artifacts.
    // Preserve the current backoff and leave recovery to the scheduled helper.
    return setOutcome(state, "pending-artifact");
  }
  if (inspection.perAgentFileReasons.length === 0) {
    resetWakeCooldown(state, monotonicNow());
    return setOutcome(state, inspection.sharedDirectoryNeedsMaintenance ? "shared-only" : "idle");
  }
  if (monotonicNow() < state.cooldownDeadlineMonotonicMs) {
    return setOutcome(state, "cooldown");
  }

  const helperLabel = deriveLaunchdMaintenanceLabel(target.label);
  const helper = await launchdServiceInfo(deps.runner, helperLabel, deps.getuid());
  if (stopped()) return setOutcome(state, "stopped");
  if (!helper.loaded) {
    advanceWakeCooldown(state, monotonicNow());
    return setOutcome(state, "helper-unloaded");
  }
  if (helper.pid !== undefined) {
    advanceWakeCooldown(state, monotonicNow());
    return setOutcome(state, "helper-running");
  }
  // Final latch closes the stop/inspect/print/kickstart resurrection window.
  if (stopped()) return setOutcome(state, "stopped");
  setOutcome(state, "request-failed");
  const requested = await kickstart(deps.runner, helperLabel, deps.getuid());
  advanceWakeCooldown(state, monotonicNow());
  if (requested.code !== 0) {
    const detail = (requested.stderr || requested.stdout).trim();
    setOutcome(state, "request-failed");
    throw new Error(
      `launchctl kickstart exited ${requested.code}${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  state.wakeCount += 1;
  return setOutcome(state, "requested");
}

/**
 * Inspect active logs in the already-running worker every five minutes. One
 * inspection may be in flight at a time, so a slow filesystem cannot build an
 * overlapping timer queue. Consecutive failures are reported only once.
 */
export function startManagedLaunchdLogMonitor(
  target: BackgroundLifecycleTarget,
  deps: ManagedLaunchdLogMonitorDependencies,
): ManagedLaunchdLogMonitor {
  let stopped = false;
  let checking = false;
  const monotonicNow = deps.monotonicNow ?? defaultMonotonicNow;
  const wallClockNow = deps.wallClockNow ?? Date.now;
  const state = createManagedLaunchdLogWakeState(monotonicNow);
  const monitoredDeps: ManagedLaunchdLogInspectionDependencies = {
    ...deps,
    monotonicNow,
    wallClockNow,
    isStopped: () => stopped || deps.isStopped?.() === true,
  };
  const inspect = async (): Promise<void> => {
    if (stopped || checking) return;
    checking = true;
    try {
      const outcome = await requestLaunchdLogMaintenanceIfNeeded(target, monitoredDeps, state);
      if (!stopped && shouldReportOutcome(state, outcome)) {
        safeReport(deps, `Managed log monitor for ${target.label}: ${outcome}.`);
      }
    } catch (error) {
      const failureOutcome = state.lastOutcome === "request-failed"
        ? "request-failed" as const
        : "inspection-failed" as const;
      setOutcome(state, failureOutcome);
      if (!stopped && shouldReportOutcome(state, failureOutcome)) {
        safeReport(
          deps,
          `Managed log inspection could not request maintenance for ${target.label}: ${safeReporterDetail(error)}`,
          true,
        );
      }
    } finally {
      if (!stopped) safeRecordStatus(deps, monitorStatus(state, monotonicNow(), wallClockNow()));
      checking = false;
    }
  };
  const guardInspect = (): void => {
    void inspect().catch((error: unknown) => {
      if (!stopped) safeReport(deps, `Managed log monitor failed: ${safeReporterDetail(error)}`, true);
    });
  };
  const interval = setInterval(
    guardInspect,
    LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS * 1_000,
  );
  interval.unref();
  guardInspect();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
  };
}

function defaultMonotonicNow(): number {
  return performance.now();
}

function resetWakeCooldown(state: ManagedLaunchdLogWakeState, now: number): void {
  state.cooldownIndex = 0;
  state.cooldownDeadlineMonotonicMs = now + WAKE_COOLDOWN_MS[0]!;
}

function advanceWakeCooldown(state: ManagedLaunchdLogWakeState, now: number): void {
  state.cooldownIndex = Math.min(state.cooldownIndex + 1, WAKE_COOLDOWN_MS.length - 1);
  state.cooldownDeadlineMonotonicMs = now + WAKE_COOLDOWN_MS[state.cooldownIndex]!;
}

function setOutcome(
  state: ManagedLaunchdLogWakeState,
  outcome: ManagedLaunchdLogMonitorOutcome,
): ManagedLaunchdLogMonitorOutcome {
  state.lastOutcome = outcome;
  return outcome;
}

function shouldReportOutcome(
  state: ManagedLaunchdLogWakeState,
  outcome: ManagedLaunchdLogMonitorOutcome,
): boolean {
  if (outcome === "idle" || outcome === "shared-only" || outcome === "cooldown" || outcome === "stopped") {
    state.lastReportedOutcome = undefined;
    return false;
  }
  if (state.lastReportedOutcome === outcome) return false;
  state.lastReportedOutcome = outcome;
  return true;
}

function monitorStatus(
  state: ManagedLaunchdLogWakeState,
  monotonicNow: number,
  wallClockNow: number,
): ManagedLaunchdLogMonitorStatus {
  const remaining = Math.max(0, state.cooldownDeadlineMonotonicMs - monotonicNow);
  return {
    version: 1,
    lastInspectionAt: new Date(wallClockNow).toISOString(),
    wakeCount: state.wakeCount,
    lastOutcome: state.lastOutcome,
    cooldownDeadline: new Date(wallClockNow + remaining).toISOString(),
  };
}

function safeRecordStatus(
  deps: ManagedLaunchdLogMonitorDependencies,
  status: ManagedLaunchdLogMonitorStatus,
): void {
  try {
    const recorded = deps.recordStatus?.(status);
    if (recorded !== undefined) void Promise.resolve(recorded).catch(() => undefined);
  } catch {
    // Observability must never alter worker lifecycle or become unhandled.
  }
}

function safeReport(
  deps: ManagedLaunchdLogMonitorDependencies,
  message: string,
  error = false,
): void {
  const safeMessage = safeReporterText(message);
  const rendered = error ? ui.errorLine(safeMessage) : ui.style.dim(`${safeMessage}\n`);
  try {
    const reported = deps.stderr(rendered);
    if (reported !== undefined) void Promise.resolve(reported).catch(() => undefined);
  } catch {
    // Reporter failures are explicitly non-fatal and never escape.
  }
}

function safeReporterDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return safeReporterText(raw);
}

function safeReporterText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\b(token|secret|password|api[-_]?key|authorization)\s*[=:]\s*\S+/giu, "$1=<redacted>")
    .replace(/\bBearer\s+\S+/giu, "Bearer <redacted>")
    .replace(/(?:\/[A-Za-z0-9._~!$&'()+,;=:@%-]+){2,}/gu, "<path>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}

/** Run one authenticated, crash-recoverable stopped-writer log rotation pass. */
export async function maintainLaunchdLogsOperation(
  target: BackgroundLifecycleTarget,
  deps: BackgroundDeps,
  poll: PollOptions,
  acquireSharedLogLock: () => Promise<(() => Promise<void>) | undefined>,
): Promise<number> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) return 0;
  try {
    return await maintainLaunchdLogsWithLifecycleLockOperation(
      target,
      deps,
      poll,
      acquireSharedLogLock,
    );
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

/** Acquire the shared lease after the caller already owns this agent's lifecycle. */
export async function maintainLaunchdLogsWithLifecycleLockOperation(
  target: BackgroundLifecycleTarget,
  deps: BackgroundDeps,
  poll: PollOptions,
  acquireSharedLogLock: () => Promise<(() => Promise<void>) | undefined>,
): Promise<number> {
  let releaseSharedLogLock: (() => Promise<void>) | undefined;
  try {
    try {
      releaseSharedLogLock = await acquireSharedLogLock();
    } catch (error) {
      reportMaintenanceFailure(target, deps, "acquire the shared launchd-log mutation lock", error);
      return 1;
    }
    // Scheduled work defers cleanly. Staggering controls recurring cadence;
    // this lease protects only the mutation, never expensive helper work.
    if (releaseSharedLogLock === undefined) return 0;
    return await maintainLaunchdLogsWithSharedLockOperation(target, deps, poll);
  } finally {
    await releaseSharedLogLock?.().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release the shared launchd-log mutation lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

/** Execute log maintenance only while the caller owns per-agent then shared leases. */
export async function maintainLaunchdLogsWithSharedLockOperation(
  target: BackgroundLifecycleTarget,
  deps: LaunchdLogMaintenanceDeps,
  poll: PollOptions,
): Promise<number> {
  await deps.recordMaintenancePhase?.("inspecting");
  const uid = deps.getuid();
  const service = await launchdServiceInfo(deps.runner, target.label, uid);

  let inspection: LaunchdLogInspection;
  try {
    inspection = await deps.inspectLaunchdLogs(target.paths);
  } catch (error) {
    reportMaintenanceFailure(target, deps, "inspect launchd logs", error);
    return 1;
  }
  let additionalInspection: AdditionalLaunchdLogInspection = {
    needsMaintenance: false,
    canMaintain: true,
    issues: [],
  };
  try {
    additionalInspection = await deps.inspectAdditionalLaunchdLogArtifacts?.(target.paths)
      ?? additionalInspection;
  } catch (error) {
    reportMaintenanceFailure(target, deps, "inspect bounded legacy log artifacts", error);
    return 1;
  }
  let additionalRefused = !additionalInspection.canMaintain;
  if (additionalRefused) {
    try {
      await deps.recordAdditionalLaunchdLogRefusals?.(additionalInspection.issues);
    } catch (error) {
      reportMaintenanceFailure(target, deps, "record bounded legacy log refusals", error);
      return 1;
    }
  }
  let maintenanceIntent: LaunchdLogMaintenanceIntent | undefined;
  try {
    maintenanceIntent = await deps.readLaunchdLogMaintenanceIntent(target.paths);
  } catch (error) {
    reportMaintenanceFailure(target, deps, "read durable launchd-log maintenance intent", error);
    return 1;
  }
  if (inspection.pendingMaintenance && maintenanceIntent === undefined) {
    reportMaintenanceFailure(
      target,
      deps,
      "read durable launchd-log maintenance intent",
      new Error("The maintenance marker disappeared after inventory."),
    );
    return 1;
  }
  if (!service.loaded && maintenanceIntent === undefined) return 0;

  let originalPlistIdentity: string;
  try {
    originalPlistIdentity = await deps.verifyLaunchdPlist(target.paths.plistPath);
  } catch (error) {
    reportMaintenanceFailure(target, deps, "verify the existing main LaunchAgent", error);
    return 1;
  }
  if (maintenanceIntent !== undefined
    && (maintenanceIntent.label !== target.label
      || maintenanceIntent.plistFingerprint !== originalPlistIdentity)) {
    reportMaintenanceFailure(
      target,
      deps,
      "authenticate durable launchd-log maintenance intent",
      new Error("The pending intent does not match the exact main LaunchAgent definition."),
    );
    return 1;
  }
  if (maintenanceIntent?.phase === "stopping" && !service.loaded) {
    reportMaintenanceFailure(
      target,
      deps,
      "recover interrupted launchd-log maintenance",
      new Error("The prior maintainer did not durably prove every old writer PID dead; refusing rotation."),
    );
    return 1;
  }
  if (maintenanceIntent?.phase === "restoring") {
    const replacement = await launchdServiceInfo(deps.runner, target.label, uid);
    if (!replacement.loaded || replacement.pid === undefined || !deps.isAlive(replacement.pid)) {
      reportMaintenanceFailure(
        target,
        deps,
        "recover interrupted launchd-log restoration",
        new Error("The replacement writer identity was lost before live-worker proof; refusing stale rotation authority."),
      );
      return 1;
    }
    try {
      await deps.clearLaunchdLogMaintenanceIntent(target.paths, maintenanceIntent);
    } catch (error) {
      reportMaintenanceFailure(target, deps, "clear recovered launchd-log restoration intent", error);
      return 1;
    }
    return 0;
  }
  if (maintenanceIntent?.phase === "stopped" && service.loaded) {
    reportMaintenanceFailure(
      target,
      deps,
      "recover interrupted launchd-log maintenance",
      new Error("launchd reports a writer loaded after durable stopped-writer proof; refusing rotation."),
    );
    return 1;
  }

  if (!inspection.canMaintain) {
    deps.stderr(ui.errorLine(`Scheduled log maintenance refused unsafe paths for ${target.label}.`));
    for (const issue of inspection.issues) deps.stderr(ui.style.dim(issue) + "\n");
    return 1;
  }
  if (!inspection.needsMaintenance
    && !additionalInspection.needsMaintenance
    && maintenanceIntent === undefined) return additionalRefused ? 1 : 0;

  if (maintenanceIntent === undefined) {
    maintenanceIntent = {
      version: 1,
      phase: "stopping",
      label: target.label,
      plistFingerprint: originalPlistIdentity,
    };
    try {
      await deps.recordMaintenancePhase?.("stopping");
      await deps.beginLaunchdLogMaintenanceIntent(target.paths, maintenanceIntent);
    } catch (error) {
      reportMaintenanceFailure(target, deps, "publish durable launchd-log maintenance intent", error);
      return 1;
    }
  }

  if (maintenanceIntent.phase === "stopping") {
    const stopped = await unloadLaunchdService(
      target.label,
      service,
      uniquePids([service.pid]),
      deps,
      uid,
      poll,
    );
    if (!stopped.ok) {
      reportMaintenanceFailure(target, deps, "prove the launchd log writer stopped", stopped.failure);
      return 1;
    }
    try {
      maintenanceIntent = await deps.markLaunchdLogMaintenanceStopped(target.paths, maintenanceIntent);
      await deps.recordMaintenancePhase?.("stopped");
    } catch (error) {
      reportMaintenanceFailure(target, deps, "record durable stopped-writer proof", error);
      return 1;
    }
  } else {
    const current = await launchdServiceInfo(deps.runner, target.label, uid);
    if (current.loaded || (current.pid !== undefined && deps.isAlive(current.pid))) {
      reportMaintenanceFailure(
        target,
        deps,
        "recheck durable stopped-writer proof",
        new Error("launchd exposed a live writer before recovered rotation."),
      );
      return 1;
    }
  }

  try {
    await deps.recordMaintenancePhase?.("rotating");
    if (additionalInspection.canMaintain && additionalInspection.needsMaintenance) {
      const result = await deps.maintainAdditionalLaunchdLogArtifacts?.(target.paths);
      if (result === undefined) {
        throw new Error("The bounded legacy inspection had no matching stopped-writer maintainer.");
      }
      if (result.refusals.length > 0) {
        additionalRefused = true;
        await deps.recordAdditionalLaunchdLogRefusals?.(result.refusals);
      }
    }
    await deps.rotateStoppedLaunchdLogs(target.paths);
    const currentPlistIdentity = await deps.verifyLaunchdPlist(target.paths.plistPath);
    if (currentPlistIdentity !== originalPlistIdentity) {
      throw new Error("The main LaunchAgent plist changed during stopped-writer maintenance.");
    }
  } catch (error) {
    reportMaintenanceFailure(target, deps, "commit bounded stopped-writer logs", error);
    return 1;
  }

  try {
    maintenanceIntent = await deps.markLaunchdLogMaintenanceRestoring(target.paths, maintenanceIntent);
    await deps.recordMaintenancePhase?.("restoring");
  } catch (error) {
    reportMaintenanceFailure(target, deps, "invalidate stopped-writer proof before restoration", error);
    return 1;
  }

  const booted = await bootstrap(deps.runner, target.paths.plistPath, uid);
  const observedRestorePids = new Set<number>();
  const running = await pollUntil(deps, poll, async () => {
    const current = await launchdServiceInfo(deps.runner, target.label, uid);
    if (current.pid !== undefined) observedRestorePids.add(current.pid);
    return current.loaded && current.pid !== undefined && deps.isAlive(current.pid);
  });
  if (!running) {
    const current = await launchdServiceInfo(deps.runner, target.label, uid);
    if (current.pid !== undefined) observedRestorePids.add(current.pid);
    const cleanedUp = await unloadLaunchdService(
      target.label,
      current,
      [...observedRestorePids],
      deps,
      uid,
      poll,
    );
    reportMaintenanceFailure(
      target,
      deps,
      "restore the exact main LaunchAgent after rotation",
      lifecycleFailure(booted, "launchd did not expose a live replacement worker"),
    );
    if (!cleanedUp.ok) {
      reportMaintenanceFailure(target, deps, "remove the failed replacement worker", cleanedUp.failure);
    }
    return 1;
  }
  try {
    const restoredPlistIdentity = await deps.verifyLaunchdPlist(target.paths.plistPath);
    if (restoredPlistIdentity !== originalPlistIdentity) {
      throw new Error("The main LaunchAgent plist changed while launchd restored the worker.");
    }
  } catch (error) {
    const restoredService = await launchdServiceInfo(deps.runner, target.label, uid);
    const stoppedAgain = await unloadLaunchdService(
      target.label,
      restoredService,
      uniquePids([restoredService.pid, ...observedRestorePids]),
      deps,
      uid,
      poll,
    );
    reportMaintenanceFailure(target, deps, "prove the restored main LaunchAgent definition", error);
    if (!stoppedAgain.ok) {
      reportMaintenanceFailure(target, deps, "stop the worker after its definition changed", stoppedAgain.failure);
    }
    return 1;
  }
  try {
    await deps.clearLaunchdLogMaintenanceIntent(target.paths, maintenanceIntent);
    await deps.recordMaintenancePhase?.("complete");
  } catch (error) {
    reportMaintenanceFailure(target, deps, "clear durable launchd-log maintenance intent", error);
    return 1;
  }
  return additionalRefused ? 1 : 0;
}

export function reportMaintenanceFailure(
  target: BackgroundLifecycleTarget,
  deps: Pick<LaunchdLogMaintenanceDeps, "stderr">,
  action: string,
  error: unknown,
): void {
  deps.stderr(ui.errorLine(
    `Scheduled log maintenance could not ${action} for ${target.label}: ${maintenanceErrorMessage(error)}`,
  ));
}
