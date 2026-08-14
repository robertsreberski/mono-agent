import { isBackgroundOperationalEnvName } from "./background-environment.js";
import { MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV } from "./launchd.js";

/** Remove launchd ambient state before any config or controller module loads. */
export function sanitizeManagedLaunchdLogMaintenanceEnvironment(
  env: Record<string, string | undefined>,
): void {
  for (const name of Object.keys(env)) {
    if (name !== MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV && !isBackgroundOperationalEnvName(name)) {
      delete env[name];
    }
  }
  delete env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV];
}
