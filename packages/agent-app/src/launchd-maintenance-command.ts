export const MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE = "launchd-maintenance-entry.js";

export interface LaunchdMaintenanceCommandArgs {
  readonly configPath: string;
  readonly controllerCliPath: string;
  readonly agentCwd: string;
  readonly agentPath: string;
  readonly expectedManagedRuntimeLaunch: string;
  readonly envFile?: string;
}
