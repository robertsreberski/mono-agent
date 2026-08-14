import { assertWebPlistIdentity } from "./launchd.js";

export interface WebLogMaintenanceCommandArgs {
  readonly expectedManagedRuntimeLaunch: string;
  readonly expectedWebPlistIdentity: string;
}

/** Exact private argv shape shared by the attested entry and hidden CLI gate. */
export function parseWebLogMaintenanceArguments(argv: readonly string[]): WebLogMaintenanceCommandArgs {
  if (argv.length !== 5
    || argv[1] !== "--expected-managed-runtime-launch"
    || argv[3] !== "--expected-web-plist-identity") {
    throw new Error(
      "Managed web log maintenance requires exact runtime-proof and composite main-plist identity arguments.",
    );
  }
  const expectedManagedRuntimeLaunch = argv[2];
  const expectedWebPlistIdentity = argv[4];
  if (expectedManagedRuntimeLaunch === undefined
    || !/^[0-9A-Za-z_-]+$/u.test(expectedManagedRuntimeLaunch)) {
    throw new Error("Managed web log maintenance received a malformed runtime launch proof.");
  }
  if (expectedWebPlistIdentity === undefined) {
    throw new Error("Managed web log maintenance is missing its composite main-plist identity.");
  }
  assertWebPlistIdentity(expectedWebPlistIdentity);
  return { expectedManagedRuntimeLaunch, expectedWebPlistIdentity };
}
