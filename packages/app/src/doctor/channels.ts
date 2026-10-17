import type { MonoAgentAppConfigInput } from "../app-config.js";
import type { ChannelDriver } from "../channels/types.js";
import type { ValidationSection } from "../doctor-types.js";

export async function channelSection(
  driver: ChannelDriver,
  input: MonoAgentAppConfigInput,
): Promise<ValidationSection> {
  const id = `channel:${driver.id}`;
  try {
    const config = await driver.loadConfig(input);
    const disabledReason = driver.disabledReason?.(config);
    if (disabledReason !== undefined) {
      return { id, label: driver.label, status: "disabled", details: [disabledReason] };
    }
    const waitingReason = driver.waitingReason?.(config);
    if (waitingReason !== undefined) {
      return { id, label: driver.label, status: "waiting", details: [waitingReason] };
    }
    // A structural issue (e.g. a typo'd per-trigger model override) fails
    // validate loudly here; `start` still runs the channel and warn-ignores
    // the bad value at run time.
    const issues = driver.configIssues?.(config) ?? [];
    if (issues.length > 0) {
      return { id, label: driver.label, status: "error", details: [...issues] };
    }
    return { id, label: driver.label, status: "ok", details: ["Configured; will start with the app."] };
  } catch (error) {
    if (driver.isConfigError(error)) {
      const reason = error instanceof Error ? error.message : String(error);
      return { id, label: driver.label, status: "waiting", details: [reason] };
    }
    throw error;
  }
}
