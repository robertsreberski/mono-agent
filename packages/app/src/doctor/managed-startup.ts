import process from "node:process";

import { canonicalBackgroundConfigPath } from "../service/background/target.js";
import { deriveLaunchdLabel, launchdPathsFor } from "../service/launchd/launchd.js";
import type { LaunchdPaths } from "../service/launchd/launchd.js";
import { readLaunchdStartupRefusal, runtimeProofRefusalMessage } from "../service/launchd/launchd-snapshot-refusal.js";
import type { ValidationSection } from "./doctor-types.js";

/** CLI-only diagnostic: a persisted refusal must not block repair preflight. */
export async function managedRuntimeRefusalSection(
  configPath: string,
  target?: Pick<LaunchdPaths, "logDir">,
): Promise<ValidationSection | undefined> {
  const canonical = await canonicalBackgroundConfigPath(process.cwd(), configPath);
  const label = deriveLaunchdLabel(canonical);
  try {
    if (await readLaunchdStartupRefusal(label, target ?? launchdPathsFor(label)) !== "runtime-proof-refused") return undefined;
    return {
      id: "managed-runtime-launch",
      label: "Managed runtime launch",
      status: "error",
      details: [runtimeProofRefusalMessage(canonical)],
    };
  } catch {
    return {
      id: "managed-runtime-launch",
      label: "Managed runtime launch",
      status: "error",
      details: ["Managed startup refusal status is unavailable or unsafe; inspect the service logs before restarting."],
    };
  }
}
