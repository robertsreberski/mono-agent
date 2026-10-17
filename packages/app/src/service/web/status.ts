import process from "node:process";

import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, DEFAULT_WEB_THEME } from "../../web-service-definition.js";
import {
  launchdServiceInfo,
  launchdWebMaintenanceInfo,
  makeLaunchctlRunner,
  WEB_LAUNCHD_LABEL,
} from "../../launchd.js";
import type { LaunchdServiceInfo, LaunchdWebMaintenanceInfo } from "../../launchd.js";
import { inspectOwnerPrivateLaunchdPlist } from "../launchd/plist-files.js";
import { inspectLaunchdLogs, readLaunchdLogMaintenanceIntent } from "../../launchd-logs.js";
import { inspectLegacyManagedWebLogArtifacts } from "../../managed-web-logs.js";
import { managedWebPaths } from "../../web-maintenance-paths.js";
import {
  readWebLogMaintenanceStatus,
  readWebLogMonitorStatus,
} from "../../web-log-maintenance-status.js";
import { webHealthStatus } from "./health.js";
import { healthUrl, inspectInstalledWebMaintenanceHelper, installedWebDefinition, requiredUid } from "./inspection.js";
import { printWebUrls, urlHost } from "./presentation.js";
import { readOptionalText, readServiceRecord } from "./record.js";
import { inspectOwnedTailscaleRoute, readTailscaleOwnership } from "./tailscale.js";
import type { RunWebCommandDeps, RunWebCommandOptions } from "./types.js";
import * as ui from "../../ui.js";

export async function statusWeb(
  options: RunWebCommandOptions,
  deps: RunWebCommandDeps,
  strictExit: boolean,
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const paths = managedWebPaths(deps.homeDir);
  const recordRead = await readServiceRecord(paths.recordPath);
  const record = recordRead.kind === "valid" ? recordRead.record : undefined;
  // A stopped install can retain its LaunchAgent definition without a service
  // record. Decode it with the same validator the start path uses; an
  // unreadable definition stays unknown and is never advertised as the fresh
  // default.
  const installedPlist = record === undefined ? await readOptionalText(paths.launchd.plistPath) : undefined;
  const recoveredDefinition = installedPlist === undefined ? undefined : installedWebDefinition(installedPlist);
  const definitionUnknown = installedPlist !== undefined && recoveredDefinition === undefined;
  const configured = record ?? recoveredDefinition;
  const listenerSource = definitionUnknown
    ? "unknown"
    : record !== undefined
      ? "service record"
      : recoveredDefinition !== undefined
        ? "installed definition"
        : "fresh default";
  const host = configured?.host ?? DEFAULT_WEB_HOST;
  const port = configured?.port ?? DEFAULT_WEB_PORT;
  const theme = configured?.theme ?? DEFAULT_WEB_THEME;
  const consoleName = configured?.name;
  let service: LaunchdServiceInfo = { loaded: false };
  let helper: LaunchdWebMaintenanceInfo = { loaded: false };
  if ((deps.platform ?? process.platform) === "darwin") {
    const runner = deps.launchctl ?? makeLaunchctlRunner();
    const uid = (deps.getuid ?? requiredUid)();
    [service, helper] = await Promise.all([
      launchdServiceInfo(runner, WEB_LAUNCHD_LABEL, uid),
      (deps.inspectMaintenanceService ?? launchdWebMaintenanceInfo)(runner, uid),
    ]);
  }
  const healthState = recordRead.kind === "invalid" || definitionUnknown || !service.loaded
    ? "unavailable"
    : deps.healthcheck === undefined
      ? await webHealthStatus(healthUrl(host, port))
      : await deps.healthcheck(healthUrl(host, port)) ? "ok" : "unavailable";
  const healthy = healthState === "ok";
  const maintenanceProblems: string[] = [];
  let maintenanceSummary = helper.loaded ? "idle" : "helper missing";
  let pendingIntent: Awaited<ReturnType<typeof readLaunchdLogMaintenanceIntent>>;
  let pendingRecoveryRequiresStopStart = false;
  try {
    pendingIntent = await readLaunchdLogMaintenanceIntent(paths.launchd);
  } catch {
    pendingIntent = undefined;
    maintenanceProblems.push("maintenance intent is unreadable or unsafe");
  }
  const maintenanceStatus = await readWebLogMaintenanceStatus(paths.maintenanceStatusPath);
  const monitorStatus = await readWebLogMonitorStatus(paths.monitorStatusPath);
  if (helper.loaded) {
    try {
      await inspectInstalledWebMaintenanceHelper(
        paths,
        undefined,
        deps.verifyMaintenanceEntrypoint,
        helper.definition,
        true,
      );
    } catch {
      maintenanceProblems.push("helper definition or managed-runtime closure is invalid");
    }
  } else {
    maintenanceProblems.push("maintenance helper is not loaded");
  }
  if (pendingIntent !== undefined) {
    pendingRecoveryRequiresStopStart = pendingIntent.phase === "stopping";
    if (!pendingRecoveryRequiresStopStart) {
      try {
        pendingRecoveryRequiresStopStart = pendingIntent.plistFingerprint
          !== await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath);
      } catch {
        pendingRecoveryRequiresStopStart = true;
      }
    }
    if (helper.pid !== undefined) {
      maintenanceSummary = `maintenance in progress (${pendingIntent.phase})`;
    } else {
      maintenanceSummary = "maintenance recovery required";
      maintenanceProblems.push("durable maintenance intent has no live helper");
    }
  } else if (helper.pid !== undefined) {
    maintenanceSummary = maintenanceStatus.kind === "valid" && maintenanceStatus.status.state === "running"
      ? `maintenance in progress (${maintenanceStatus.status.phase})`
      : "maintenance in progress";
  } else if (maintenanceStatus.kind === "valid") {
    if (maintenanceStatus.status.state === "failed" || maintenanceStatus.status.state === "degraded") {
      maintenanceSummary = maintenanceStatus.status.state;
      maintenanceProblems.push(maintenanceStatus.status.detail ?? "the last maintenance pass did not complete cleanly");
    }
    if ((maintenanceStatus.status.refusals?.length ?? 0) > 0) {
      maintenanceProblems.push("bounded legacy artifacts were refused and preserved");
    }
  } else if (maintenanceStatus.kind === "invalid") {
    maintenanceProblems.push("maintenance status is unreadable or unsafe");
  }
  if (monitorStatus.kind === "invalid") {
    maintenanceProblems.push("worker monitor status is unreadable or unsafe");
  } else if (monitorStatus.kind === "valid"
    && ["helper-unloaded", "request-failed", "inspection-failed"].includes(monitorStatus.status.lastOutcome)) {
    maintenanceProblems.push(`worker monitor reports ${monitorStatus.status.lastOutcome}`);
  }
  try {
    const [logs, legacy] = await Promise.all([
      inspectLaunchdLogs(paths.launchd),
      inspectLegacyManagedWebLogArtifacts(paths.launchd),
    ]);
    if (!logs.canMaintain || !legacy.canMaintain) maintenanceProblems.push("managed web log inventory is unsafe");
    else if (logs.needsMaintenance || legacy.needsMaintenance) {
      maintenanceSummary = maintenanceSummary === "idle"
        ? "due"
        : `${maintenanceSummary}; due`;
    }
  } catch {
    maintenanceProblems.push("managed web log inventory could not be inspected");
  }
  const owned = await readTailscaleOwnership(paths.tailscalePath);
  let ownedRoute: {
    readonly state: "none" | "exact" | "missing" | "changed" | "unverifiable" | "invalid";
    readonly url?: string;
    readonly detail?: string;
  };
  if (owned.kind === "absent") {
    ownedRoute = { state: "none" };
  } else if (owned.kind === "invalid") {
    ownedRoute = { state: "invalid", detail: owned.detail };
  } else {
    const inspection = await inspectOwnedTailscaleRoute(owned.ownership, deps);
    if (inspection.kind === "exact") {
      ownedRoute = { state: "exact", url: owned.ownership.url };
    } else if (inspection.kind === "absent") {
      ownedRoute = {
        state: "missing",
        detail: "the recorded handler is no longer present; the ownership record was left untouched",
      };
    } else if (inspection.kind === "changed") {
      ownedRoute = {
        state: "changed",
        detail: "the ownership record does not match the current handler; existing handlers were not changed",
      };
    } else {
      // An inspection failure is not evidence of a mismatch.
      ownedRoute = { state: "unverifiable", detail: inspection.detail };
    }
  }
  const serviceState = service.loaded
    ? healthState === "degraded" ? "running, push degraded" : healthy ? "running" : "loaded, not healthy"
    : "stopped";
  const code = (strictExit && (!healthy || maintenanceProblems.length > 0))
    || recordRead.kind === "invalid"
    || definitionUnknown
    ? 1
    : 0;
  const uniqueProblems = [...new Set(maintenanceProblems)];
  const listenerDetail = recordRead.kind === "invalid"
    ? "invalid service record"
    : definitionUnknown
      ? "unknown (installed LaunchAgent definition could not be validated)"
      : `${host}:${String(port)} (${service.loaded && healthy ? "running" : "configured; not proven running"})`;
  if (options.json === true) {
    // Listener and exact owned route are reported separately; their mere
    // absence proves nothing about other proxies, tunnels, or routes.
    stdout.write(`${JSON.stringify({
      ok: code === 0,
      action: "status",
      listener: definitionUnknown || recordRead.kind === "invalid"
        ? { host: null, port: null, url: null, source: listenerSource, provenRunning: false }
        : {
            host,
            port,
            url: `http://${urlHost(host)}:${String(port)}/`,
            source: listenerSource,
            provenRunning: service.loaded && healthy,
          },
      console: {
        theme: recordRead.kind === "invalid" ? null : theme,
        name: consoleName ?? null,
        state: paths.stateDir,
      },
      service: { state: serviceState, pid: service.pid ?? null, healthy },
      authentication: "none",
      ownedTailscaleRoute: ownedRoute,
      maintenance: { summary: maintenanceSummary, problems: uniqueProblems },
      recordError: recordRead.kind === "invalid" ? recordRead.detail : null,
      definitionError: definitionUnknown
        ? "the installed LaunchAgent definition could not be validated"
        : null,
      note: "other proxies and routes are not inspected; network reachability is the access boundary",
    }, null, 2)}\n`);
    return code;
  }
  stdout.write(ui.rule("Web console status"));
  stdout.write(ui.keyValue([
    ["service", serviceState],
    ["listener", listenerDetail],
    ["theme", recordRead.kind === "invalid" ? "invalid service record" : theme],
    ["name", recordRead.kind === "invalid"
      ? "invalid service record"
      : consoleName ?? "— (machine hostname)"],
    ["state", paths.stateDir],
    ["pid", service.pid === undefined ? "—" : String(service.pid)],
    ["log maintenance", maintenanceSummary],
    ["authentication", "none (no application login; network reachability is the access boundary)"],
  ]));
  if (recordRead.kind === "invalid") stdout.write(ui.errorLine(recordRead.detail));
  else if (definitionUnknown) {
    stdout.write(ui.errorLine(
      "The installed LaunchAgent definition could not be validated; the effective listener is unknown and was not probed.",
    ));
  } else {
    printWebUrls(
      stdout,
      `http://${urlHost(host)}:${String(port)}/`,
      port,
      host,
      deps.discoverNetworkAddresses,
    );
  }
  if (ownedRoute.state === "none") {
    stdout.write("mono-agent-owned Tailscale route: none (other proxies and routes are not inspected).\n");
  } else if (ownedRoute.state === "exact") {
    stdout.write(`mono-agent-owned Tailscale route: ${ownedRoute.url ?? ""}\n`);
  } else {
    stdout.write(
      `mono-agent-owned Tailscale route: ${ownedRoute.state} - ${ownedRoute.detail ?? "unverifiable"} (other proxies and routes are not inspected).\n`,
    );
  }
  if (!service.loaded) stdout.write(ui.hint("Start it with: mono-agent web start"));
  else if (!healthy) stdout.write(ui.hint("Inspect: mono-agent web logs"));
  for (const problem of uniqueProblems) stdout.write(ui.errorLine(problem));
  if (pendingIntent !== undefined && helper.pid === undefined) {
    stdout.write(pendingRecoveryRequiresStopStart
      ? ui.hint("Recover it with `mono-agent web stop`, then `mono-agent web start`; the prior stop or plist identity is unproven.")
      : ui.hint("Recover it with exactly: mono-agent web restart"));
  }
  return code;
}
