import { isBackgroundOperationalEnvName } from "./background-environment.js";

export const MANAGED_WEB_LOG_MAINTENANCE_ENV = "MONO_AGENT_MANAGED_WEB_LOG_MAINTENANCE";

/** Fixed, secret-free environment persisted in the private web helper plist. */
export function managedWebLogMaintenanceEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: "/usr/bin:/bin",
    [MANAGED_WEB_LOG_MAINTENANCE_ENV]: "1",
  };
}

/** Remove launchd ambient state before the private web controller loads heavy code. */
export function sanitizeManagedWebLogMaintenanceEnvironment(
  env: Record<string, string | undefined>,
): void {
  for (const name of Object.keys(env)) {
    if (name !== MANAGED_WEB_LOG_MAINTENANCE_ENV && !isBackgroundOperationalEnvName(name)) {
      delete env[name];
    }
  }
  delete env[MANAGED_WEB_LOG_MAINTENANCE_ENV];
}
