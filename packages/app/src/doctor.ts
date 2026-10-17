import { assertSupportedSessionsRoot } from "./conversation-admin/sessions-root.js";
import { computerUseSection } from "./host/computer-use.js";
import { join } from "node:path";
import {
  buildMonoAgentConfigView,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
} from "./composition/app-config.js";
import { collectChannelConfigViews } from "./channel-config-view.js";
import { resolveChannelDrivers } from "./channels.js";
import { readSettingsJson } from "@mono-agent/contracts";
import { runsSection } from "./doctor-runs.js";
import { sessionToolHistorySection } from "./doctor-session-history.js";
import type { ValidationReport, ValidationSection } from "./doctor-types.js";
import type { ValidateMonoAgentFolderOptions } from "./doctor/options.js";
import { runtimeProvenanceSection, runtimeSection } from "./doctor/runtime.js";
import { collectStaticTriggerCredentialRefs, applyRequestModelOverrideCompatibilityChecks, applyToolChannelCrossChecks } from "./doctor/cross-checks.js";
import { credentialsSection } from "./doctor/credentials.js";
import { contextSection } from "./doctor/context.js";
import { memorySection } from "./doctor/memory.js";
import { toolsSection } from "./doctor/tools.js";
import { webToolsSection } from "./doctor/web-tools.js";
import { sandboxSection } from "./doctor/sandbox.js";
import { launchdLogsSection } from "./doctor/launchd-logs.js";
import { channelSection } from "./doctor/channels.js";
import { continuationSection } from "./doctor/continuations.js";
import { processJobsSection } from "./doctor/process-jobs.js";

/**
 * Loads every config section the app would use at start and reports it
 * per-section, so an engineer can see exactly what would run, wait, or fail —
 * before starting anything.
 */
export async function validateMonoAgentFolder(
  options: ValidateMonoAgentFolderOptions,
): Promise<ValidationReport> {
  const sections: ValidationSection[] = [];
  const drivers = options.drivers ?? await resolveChannelDrivers(options);
  const liveness = options.liveness ?? true;
  const allowFilesystemWrites = options.allowFilesystemWrites ?? true;

  let coreConfig: MonoAgentConfig | undefined;
  try {
    // Validation returns structured diagnostics; do not emit loader prose.
    coreConfig = await loadAppCoreConfig(options, { warnOnDeprecatedConfig: false, warnOnDuplicateConfig: false });
    await assertSupportedSessionsRoot(coreConfig.runtime.session.root);
    sections.push({ id: "core", label: "Core config", status: "ok", details: [`Loaded ${options.configPath}.`] });
  } catch (error) {
    if (!isAppCoreConfigError(error)) {
      throw error;
    }
    sections.push({ id: "core", label: "Core config", status: "error", details: [error.message] });
  }
  // Duplicates are an error-level finding even though runtime keeps last-wins
  // semantics. Keep other section diagnostics available for the same config.
  if (options.ignoreDuplicateKeys !== true) {
    try {
      const { duplicateKeyPaths } = await readSettingsJson(options.configPath);
      if (duplicateKeyPaths.length > 0) {
        const core = sections[0]!;
        sections[0] = {
          ...core,
          status: "error",
          details: [
            ...core.details,
            ...duplicateKeyPaths.slice(0, 20).map((path) => `Duplicate JSON key: ${path.slice(0, 200)} (last value wins at runtime).`),
            ...(duplicateKeyPaths.length > 20 ? [`${duplicateKeyPaths.length - 20} more duplicate JSON key paths.`] : []),
          ],
        };
      }
    } catch {
      // Core already reports malformed or unavailable JSON above.
    }
  }

  sections.push(await runtimeProvenanceSection(options.verifiedRuntimeProvenanceDetail));

  if (coreConfig !== undefined) {
    const staticTriggerCredentialRefs = await collectStaticTriggerCredentialRefs(coreConfig, drivers, options);
    const jsonResult = await readMonoAgentConfigJson(options.configPath);
    // Channel secrets (bot tokens, API keys) live outside the core view, so the
    // placement check spans both: core sections + every channel's config view.
    const configWarnings = [
      ...findJsonSecretConfigWarnings([
        ...buildMonoAgentConfigView({
          redacted: redactMonoAgentConfig(coreConfig),
          json: jsonResult.json,
        }),
        ...(await collectChannelConfigViews(drivers, options)),
      ]),
      ...findRemovedConfigWarnings({ json: jsonResult.json }),
    ];
    if (configWarnings.length > 0) {
      sections.push({ id: "secret-placement", label: "Config warnings", status: "waiting", details: configWarnings });
    }
    sections.push(runtimeSection(coreConfig));
    sections.push(await credentialsSection(
      coreConfig,
      options.env,
      options.verifiedCredentialModelRefs,
      staticTriggerCredentialRefs,
    ));
    sections.push(await contextSection(coreConfig, options.cwd));
    sections.push(await memorySection(
      coreConfig,
      options.cwd,
      options.env,
      liveness,
      allowFilesystemWrites,
    ));
    sections.push(await toolsSection(coreConfig, options));
    sections.push(await computerUseSection(coreConfig.tools.computerUse));
    sections.push(await sessionToolHistorySection({
      historyRoot: join(coreConfig.artifacts.dir, "..", "history"),
      requestScopedToolSupported: true,
    }));
    sections.push(await webToolsSection(coreConfig, options, liveness));
    sections.push(await continuationSection(coreConfig, options));
    sections.push(await processJobsSection(coreConfig, options));
    sections.push(await sandboxSection(coreConfig, options));
  }

  sections.push(await runsSection(options, coreConfig));
  sections.push(await launchdLogsSection(options.configPath));

  for (const driver of drivers) {
    sections.push(await channelSection(driver, options));
  }

  if (coreConfig !== undefined) {
    await applyRequestModelOverrideCompatibilityChecks(sections, coreConfig, drivers, options);
  }

  // Cross-check the built `channel:*` statuses against the tool policy and annotate
  // the tools section (send-tool-allowed-but-channel-disabled, or channel-enabled-
  // but-no-send-tool). Only meaningful once coreConfig — and thus the tools section
  // and the tool policy — loaded.
  if (coreConfig !== undefined) {
    applyToolChannelCrossChecks(sections, coreConfig.tools.allowedTools, coreConfig.tools.disallowedTools);
  }

  const structurallyValid = sections.every((section) => section.status !== "error");
  const operationallyReady = structurallyValid && sections.every((section) => section.status !== "waiting");
  return {
    sections,
    structurallyValid,
    operationallyReady,
    ok: structurallyValid,
  };
}
