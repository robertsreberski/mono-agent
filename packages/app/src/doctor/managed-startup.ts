import process from "node:process";

import { canonicalBackgroundConfigPath } from "../service/background/target.js";
import { deriveLaunchdLabel, launchdPathsFor } from "../service/launchd/launchd.js";
import type { LaunchdPaths } from "../service/launchd/launchd.js";
import { readLaunchdStartupRefusal, runtimeProofRefusalMessage, SNAPSHOT_REFUSAL_MESSAGE } from "../service/launchd/launchd-snapshot-refusal.js";
import type { ValidationSection } from "./doctor-types.js";

/** CLI-only diagnostic: a persisted refusal must not block repair preflight. */
export async function managedRuntimeRefusalSection(
  configPath: string,
  target?: Pick<LaunchdPaths, "logDir">,
  platform: NodeJS.Platform = process.platform,
): Promise<ValidationSection | undefined> {
  if (platform !== "darwin") return undefined;
  const canonical = await canonicalBackgroundConfigPath(process.cwd(), configPath);
  const label = deriveLaunchdLabel(canonical);
  try {
    const reason = await readLaunchdStartupRefusal(label, target ?? launchdPathsFor(label));
    if (reason === undefined) return undefined;
    return {
      id: "managed-runtime-launch",
      label: "Managed runtime launch",
      status: "error",
      details: [reason === "snapshot-refused" ? SNAPSHOT_REFUSAL_MESSAGE : runtimeProofRefusalMessage(canonical)],
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
