import type { MaintenanceActivityRequest } from "../launchd/launchd-maintenance-activity.js";
import type { LaunchctlRunner, LaunchdPaths } from "../launchd/launchd.js";
import type { LaunchdLogInspection, LaunchdLogMaintenanceIntent } from "../launchd/launchd-logs.js";
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
  /** Agent helper only; deliberately absent from web and explicit lifecycle mutations. */
  readonly maintenanceNotNeeded?: () => Promise<void>;
  readonly maintenanceCompleted?: () => Promise<void>;
  readonly unattendedLogStop?: (request: MaintenanceActivityRequest) => Promise<boolean>;
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stderr: (text: string) => void;
  readonly inspectLaunchdLogs: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<LaunchdLogInspection>;
  readonly rotateStoppedLaunchdLogs: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<void>;
  readonly readLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
  ) => Promise<LaunchdLogMaintenanceIntent | undefined>;
  readonly beginLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    intent: LaunchdLogMaintenanceIntent,
  ) => Promise<void>;
  readonly markLaunchdLogMaintenanceStopped: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected: LaunchdLogMaintenanceIntent,
  ) => Promise<LaunchdLogMaintenanceIntent>;
  readonly markLaunchdLogMaintenanceRestoring: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected: LaunchdLogMaintenanceIntent,
  ) => Promise<LaunchdLogMaintenanceIntent>;
  readonly clearLaunchdLogMaintenanceIntent: (
    paths: Pick<LaunchdPaths, "logDir" | "stdoutPath" | "stderrPath">,
    expected?: LaunchdLogMaintenanceIntent,
  ) => Promise<void>;
  readonly verifyLaunchdPlist: (path: string) => Promise<string>;
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
