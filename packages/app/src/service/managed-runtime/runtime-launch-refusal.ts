import process from "node:process";

import { deriveLaunchdLabel, launchdPathsFor } from "../launchd/launchd.js";
import type { LaunchdPaths } from "../launchd/launchd.js";
import { runtimeProofRefusalMessage, writeLaunchdStartupRefusal } from "../launchd/launchd-snapshot-refusal.js";

export const RUNTIME_PROOF_REFUSAL_EXIT_CODE = 78;
export const RUNTIME_PROOF_REFUSAL_COOLDOWN_MS = 5 * 60 * 1_000;

/** Keep the failure visible without launchd's ten-second unsuccessful-exit loop. */
export async function refuseManagedRuntimeLaunch(
  configPath: string,
  target: Pick<LaunchdPaths, "logDir"> = launchdPathsFor(deriveLaunchdLabel(configPath)),
): Promise<number> {
  // Install signal handlers before asynchronous publication, so a controller can
  // replace a refused worker promptly even during the durable write.
  const cooldown = waitForRuntimeProofRefusalCooldown();
  process.stderr.write(`${runtimeProofRefusalMessage(configPath)} Retrying in five minutes unless stopped.\n`);
  try {
    await writeLaunchdStartupRefusal(deriveLaunchdLabel(configPath), target, "runtime-proof-refused");
  } catch {
    // Failure to persist diagnostics must not turn an integrity refusal into a
    // clean exit or an immediate restart loop. Do not forward filesystem prose.
    process.stderr.write("Could not publish managed runtime-proof-refused status.\n");
  }
  await cooldown;
  return RUNTIME_PROOF_REFUSAL_EXIT_CODE;
}

export function waitForRuntimeProofRefusalCooldown(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      process.removeListener("SIGTERM", finish);
      process.removeListener("SIGINT", finish);
      resolve();
    };
    const timer = setTimeout(finish, RUNTIME_PROOF_REFUSAL_COOLDOWN_MS);
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
  });
}
