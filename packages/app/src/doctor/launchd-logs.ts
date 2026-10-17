import { describeMaintenanceActivity, readLaunchdMaintenanceActivityStatus } from "../launchd-maintenance-activity.js";
import { basename } from "node:path";
import {
  DEFAULT_LAUNCHD_LOG_POLICY,
  inspectLaunchdLogs,
  LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS,
  launchdLogPathsForConfig,
} from "../launchd-logs.js";
import type { LaunchdLogInspection, LaunchdLogStreamInspection } from "../launchd-logs.js";
import { readLaunchdLogMonitorStatus } from "../launchd-log-monitor-status.js";
import type { ManagedLaunchdLogMonitorStatus } from "../launchd-log-monitor-status.js";
import type { ValidationSection } from "../doctor-types.js";

/** Read-only launchd log inventory used by both `validate` and its `doctor` alias. */
export async function launchdLogsSection(configPath: string): Promise<ValidationSection> {
  let maintenanceDetail: string | undefined;
  let inspection: LaunchdLogInspection;
  let monitorStatus: ManagedLaunchdLogMonitorStatus | "unavailable" | undefined;
  try {
    const paths = await launchdLogPathsForConfig(configPath);
    inspection = await inspectLaunchdLogs(paths);
    const stdoutName = basename(paths.stdoutPath);
    const mainLabel = stdoutName.endsWith(".out.log")
      ? stdoutName.slice(0, -".out.log".length)
      : "";
    try {
      monitorStatus = await readLaunchdLogMonitorStatus(mainLabel, paths);

    } catch {
      monitorStatus = "unavailable";
    }
    try {
      const maintenanceStatus = await readLaunchdMaintenanceActivityStatus(mainLabel, paths);
      if (maintenanceStatus !== undefined) maintenanceDetail = describeMaintenanceActivity(maintenanceStatus);
    } catch { maintenanceDetail = "Maintenance: owner-private status is unavailable or unsafe."; }
  } catch {
    return {
      id: "launchd-logs",
      label: "Launchd logs",
      status: "waiting",
      details: ["[WARN] Managed launchd log metadata could not be inspected safely."],
    };
  }

  const section = launchdLogsSectionFromInspection(inspection, monitorStatus);
  return { ...section, details: [...section.details, ...(maintenanceDetail === undefined ? [] : [maintenanceDetail])] };
}

/** Pure renderer kept separate so exact byte accounting is deterministic in tests. */
export function launchdLogsSectionFromInspection(
  inspection: LaunchdLogInspection,
  monitorStatus?: ManagedLaunchdLogMonitorStatus | "unavailable",
): ValidationSection {
  const policy = DEFAULT_LAUNCHD_LOG_POLICY;
  const details = [
    `Policy: ${policy.maxBytes} bytes per file, ${policy.rotationCount} retained generations, checked every ${LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS} seconds.`,
    streamSizeDetail("stdout", inspection.stdout),
    streamSizeDetail("stderr", inspection.stderr),
    ...monitorStatusDetails(monitorStatus),
    ...inspection.issues.map((issue) => `[WARN] ${issue}.`),
    ...oversizedLogDetails("stdout", inspection.stdout, policy.maxBytes),
    ...oversizedLogDetails("stderr", inspection.stderr, policy.maxBytes),
  ];
  if (!inspection.present && inspection.issues.length === 0) {
    return {
      id: "launchd-logs",
      label: "Launchd logs",
      status: "disabled",
      details: [...details, "No managed launchd log files exist yet."],
    };
  }
  return {
    id: "launchd-logs",
    label: "Launchd logs",
    status: inspection.canMaintain && !inspection.needsMaintenance ? "ok" : "waiting",
    details,
  };
}

function monitorStatusDetails(
  status: ManagedLaunchdLogMonitorStatus | "unavailable" | undefined,
): string[] {
  if (status === "unavailable") {
    return ["Monitor: owner-private status is unavailable or unsafe."];
  }
  if (status === undefined) return ["Monitor: no observational snapshot has been recorded yet."];
  return [
    `Monitor last inspection: ${status.lastInspectionAt}.`,
    `Monitor wake count: ${status.wakeCount}.`,
    `Monitor last outcome: ${status.lastOutcome}.`,
    `Monitor cooldown deadline: ${status.cooldownDeadline}.`,
  ];
}

function streamSizeDetail(label: string, stream: LaunchdLogStreamInspection): string {
  if (!stream.byteAccountingComplete) {
    return `${label}: byte inventory unavailable because one or more paths could not be inspected safely.`;
  }
  return `${label}: active=${stream.activeBytes} bytes, retained=${stream.retainedBytes} bytes, total=${stream.totalBytes} bytes.`;
}

function oversizedLogDetails(
  label: string,
  stream: LaunchdLogStreamInspection,
  maxBytes: number,
): string[] {
  if (!stream.byteAccountingComplete) return [];
  return stream.files.flatMap((file) => file.bytes <= maxBytes
    ? []
    : [`[WARN] ${label}${file.generation === 0 ? "" : `.${file.generation}`} is ${file.bytes} bytes; maintenance limit is ${maxBytes} bytes.`]);
}
