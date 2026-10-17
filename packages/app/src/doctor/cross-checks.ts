import { parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";
import type { RuntimeModelReference } from "@mono-agent/turn/host/types";
import type { MonoAgentConfig } from "@mono-agent/config";
import { MODEL_REFERENCE_ECHO_MAX_BYTES, sanitizeModelReferenceText } from "@mono-agent/turn/host/config";
import type { MonoAgentAppConfigInput } from "../app-config.js";
import { isAdapterSendToolAllowed } from "../adapter-send-tools.js";
import { isAllowAllTools } from "../modules/known-tools.js";
import type { ChannelDriver } from "../channels/types.js";
import { collectUsedProviderReferences } from "../provider-auth-status.js";
import type { ValidationSection, ValidationStatus } from "../doctor-types.js";
import { piModelResolutionIssue } from "./runtime.js";

interface StaticTriggerConfigEntry {
  readonly entryPath: string;
  readonly entry: Record<string, unknown>;
}

/** Enabled, statically configured webhook/cron entries that can actually execute. */
function staticTriggerConfigEntries(
  driverId: "webhook" | "cron",
  loaded: unknown,
): readonly StaticTriggerConfigEntry[] {
  if (!isUnknownRecord(loaded)) return [];
  if (driverId === "webhook" && loaded.enabled === false) return [];
  const entries = driverId === "webhook" ? loaded.endpoints : loaded.jobs;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry, index) => {
    if (!isUnknownRecord(entry) || entry.enabled === false) return [];
    return [{
      entryPath: `${driverId}.${driverId === "webhook" ? "endpoints" : "jobs"}[${index}]`,
      entry,
    }];
  });
}

/**
 * Collect static trigger model overrides for credential readiness. Dynamic
 * webhook request-body overrides are intentionally unavailable at validate time.
 */
export async function collectStaticTriggerCredentialRefs(
  config: MonoAgentConfig,
  drivers: readonly ChannelDriver[],
  input: MonoAgentAppConfigInput,
): Promise<readonly { label: string; ref: RuntimeModelReference }[]> {
  return (await collectUsedProviderReferences(config, drivers, input))
    .filter(({ usage }) => usage.kind === "cron" || usage.kind === "webhook")
    .map(({ usage, ref }) => ({ label: usage.label, ref }));
}

export async function applyRequestModelOverrideCompatibilityChecks(
  sections: ValidationSection[],
  config: MonoAgentConfig,
  drivers: readonly ChannelDriver[],
  input: MonoAgentAppConfigInput,
): Promise<void> {
  const piModelResolutionFailures: string[] = [];
  for (const driver of drivers) {
    if (driver.id !== "webhook" && driver.id !== "cron") continue;
    let loaded: unknown;
    try {
      loaded = await driver.loadConfig(input);
    } catch {
      // The channel section already reports malformed/unreadable config.
      continue;
    }
    for (const { entryPath, entry } of staticTriggerConfigEntries(driver.id, loaded)) {
      const hasModelOverride = typeof entry.model === "string";
      if (!hasModelOverride) continue;
      try {
        const model = parseMonoRuntimeModelReference(entry.model as string);
        const resolutionIssue = piModelResolutionIssue(config, model);
        if (resolutionIssue !== undefined) {
          // The parser accepted this value, but acceptance is no longer a length
          // guarantee: the byte ceiling was removed because no constant could
          // hold for every provider, so a legitimately long id parses. This is a
          // diagnostic, not the protocol string, so it is bounded here rather
          // than at the grammar.
          const echoed = sanitizeModelReferenceText(entry.model as string, MODEL_REFERENCE_ECHO_MAX_BYTES);
          piModelResolutionFailures.push(`${entryPath}.model=${echoed}: ${resolutionIssue}.`);
        }
      } catch {
        // Adapter configIssues owns syntax diagnostics.
      }
    }
  }
  if (piModelResolutionFailures.length === 0) return;
  const index = sections.findIndex((section) => section.id === "runtime");
  if (index < 0) return;
  const runtime = sections[index]!;
  sections[index] = {
    ...runtime,
    status: "error",
    details: [
      ...runtime.details,
      "Per-trigger Pi model overrides must resolve through providers.local or Pi's exact built-in catalog before execution.",
      ...piModelResolutionFailures,
    ],
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adapter send tools each channel owns; an allowed entry needs BOTH the tool AND the enabled channel. */
const CHANNEL_OWNED_SEND_TOOLS: Record<string, readonly string[]> = {
  slack: ["SlackSendMessage"],
  telegram: ["TelegramSendMessage", "TelegramSendFile"],
};

/**
 * Reconciles the already-built `channel:*` section statuses with the tool policy
 * and mutates the `tools` section in place:
 * - Direction A: an adapter send tool is allowed but its channel is DISABLED — the
 *   tool will never be exposed; append a note and downgrade tools to `waiting`
 *   (unless it is already `error`). This is a genuine misconfiguration.
 * - Direction B: a channel is ENABLED and not errored but no send tool is allowed —
 *   replies still work, so this is a HINT only (status unchanged). Skipped for a
 *   channel in `error` status, where "replies still work" would be misleading.
 *
 * Reads the sections built earlier (no channel re-loading). Guards for a missing
 * tools section (coreConfig failed to load), in which case there is nothing to annotate.
 */
export function applyToolChannelCrossChecks(
  sections: ValidationSection[],
  allowedTools: readonly string[],
  disallowedTools: readonly string[],
): void {
  const toolsIndex = sections.findIndex((section) => section.id === "tools");
  if (toolsIndex < 0) {
    return;
  }
  const current = sections[toolsIndex]!;
  const extraDetails: string[] = [];
  let status: ValidationStatus = current.status;

  // Under allow-all (`"*"`) the wildcard "allows" every send tool incidentally, so
  // Direction A must NOT fire for a merely-disabled channel: the user opted into
  // everything, not that specific send tool, and an unused channel is not a
  // misconfiguration. Direction B is unaffected (with send tools allowed it never fires).
  const allowAll = isAllowAllTools(allowedTools);

  for (const [channel, sendTools] of Object.entries(CHANNEL_OWNED_SEND_TOOLS)) {
    const section = sections.find((candidate) => candidate.id === `channel:${channel}`);
    if (section === undefined) {
      continue; // Driver not present — nothing to cross-check.
    }
    const allowedForCh = sendTools.filter((tool) => isAdapterSendToolAllowed(tool, { allowedTools, disallowedTools }));
    if (section.status === "disabled") {
      // Direction A: send tool EXPLICITLY allowed but channel off — the tool will not be
      // exposed. Skipped under allow-all, where the wildcard allowance is incidental.
      if (!allowAll && allowedForCh.length > 0) {
        extraDetails.push(
          `${allowedForCh.join(", ")} in allowedTools, but the ${channel} channel is disabled — the tool will not be exposed.`,
        );
        if (status !== "error") {
          status = "waiting";
        }
      }
    } else if ((section.status === "ok" || section.status === "waiting") && allowedForCh.length === 0) {
      // Direction B: channel enabled AND not errored, but no send tool allowed — a
      // non-fatal hint. An errored channel has a structural problem, so appending
      // "replies still work…" onto it would be misleading; skip it there.
      extraDetails.push(
        `${channel} is enabled without ${sendTools.join("/")} in allowedTools — replies still work, ` +
          `but the agent cannot send proactively${channel === "telegram" ? " or ask blocking questions" : ""}.`,
      );
    }
  }

  if (extraDetails.length === 0 && status === current.status) {
    return;
  }
  sections[toolsIndex] = { ...current, status, details: [...current.details, ...extraDetails] };
}
