import { join, resolve } from "node:path";

import { accountHomeDirectory } from "./account-home.js";
import {
  WEB_LAUNCHD_LABEL,
  WEB_MAINTENANCE_LAUNCHD_LABEL,
} from "./launchd.js";
import type { LaunchdPaths } from "./launchd.js";

export interface ManagedWebPaths {
  readonly stateDir: string;
  readonly recordPath: string;
  readonly tailscalePath: string;
  readonly monitorStatusPath: string;
  readonly maintenanceStatusPath: string;
  readonly maintenancePlistPath: string;
  readonly launchd: LaunchdPaths;
}

export function managedWebPaths(homeDir = accountHomeDirectory()): ManagedWebPaths {
  const stateDir = resolve(homeDir, ".mono-agent", "web");
  const logDir = join(stateDir, "logs");
  const launchAgentsDir = resolve(homeDir, "Library", "LaunchAgents");
  return {
    stateDir,
    recordPath: join(stateDir, "service.json"),
    tailscalePath: join(stateDir, "tailscale-serve.json"),
    monitorStatusPath: join(stateDir, "log-monitor-status.json"),
    maintenanceStatusPath: join(stateDir, "log-maintenance-status.json"),
    maintenancePlistPath: join(launchAgentsDir, `${WEB_MAINTENANCE_LAUNCHD_LABEL}.plist`),
    launchd: {
      launchAgentsDir,
      logDir,
      plistPath: join(launchAgentsDir, `${WEB_LAUNCHD_LABEL}.plist`),
      stdoutPath: join(logDir, "web.out.log"),
      stderrPath: join(logDir, "web.err.log"),
    },
  };
}
