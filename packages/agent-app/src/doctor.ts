import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import type { KnownProvider as PiBuiltinProvider } from "@earendil-works/pi-ai";
import {
  getBuiltinModels as getPiBuiltinModels,
  getBuiltinProviders as getPiBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { listRecordedRuns } from "@mono-agent/observability";
import { serializeTraceSpans } from "@mono-agent/observability/otel";
import { loadToolPolicyFromJsonFile } from "@mono-agent/agent-harness";
import {
  defaultExecutionModeForModel,
  describeMonoRuntimeSupport,
  modelReferenceKey,
  networkPolicyAllowsUrl,
  parseMonoRuntimeModelReference,
  resolveModelEffortLevels,
} from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";
import {
  buildMonoAgentConfigView,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
  resolveSupermemoryContainer,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  describeSandboxEffectiveState,
  resolveSandboxEffectiveState,
  sandboxEffectiveStateWarning,
} from "@mono-agent/runtime-adapter";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import {
  describeSensitiveDataExportWarning,
  isAppCoreConfigError,
  loadAppCoreConfig,
  phoenixAppBaseUrl,
  resolveAppArtifactDir,
  resolveAppObservabilityExporters,
} from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import { adapterSendToolNames, isAdapterSendToolAllowed, resolveAdapterSendToolsSettings } from "./adapter-send-tools.js";
import { canonicalToolName, isAllowAllTools, isKnownToolName, isMcpToolName, suggestToolName } from "./modules/known-tools.js";
import { collectChannelConfigViews } from "./channel-config-view.js";
import { resolveChannelDrivers } from "./channels.js";
import type { ChannelDriver } from "./channels.js";
import { findUnknownAppConfigWarnings } from "./config-reference.js";
import { formatInteractionBridgeUrl, loadInteractionSettings } from "./interaction-bridge.js";
import { FIRST_RUN_MEMORY_INITIALIZING_MARKER } from "./first-run-managed-memory.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";
import { piAuthRecoveryCommand } from "./provider-setup.js";
import { inspectPiAuthStore, type PiAuthStoreInspection, type PiAuthStoreUnsafeReason } from "./pi-auth-store-inspection.js";
import { checkManagedProjectSkills, managedProjectSkillsExist } from "./project-skills.js";
import { configuredRuntimeFallbackModels, configuredRuntimeModels } from "./runtime-routes.js";
import { loadSupermemoryPlugin } from "./supermemory-plugin.js";

const execFile = promisify(execFileCallback);

export type ValidationStatus = "ok" | "waiting" | "disabled" | "error";

export interface ValidationSection {
  readonly id: string;
  readonly label: string;
  readonly status: ValidationStatus;
  readonly details: readonly string[];
}

export interface ValidationReport {
  readonly sections: readonly ValidationSection[];
  /** True when no section reports an error. Waiting/disabled channels are fine. */
  readonly ok: boolean;
}

export interface SdkAuthStatusExecOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly encoding: "utf8";
}

export interface SdkAuthStatusExecResult {
  readonly stdout: string;
}

/** Injectable process seam for bounded, read-only provider credential/login checks. */
export type SdkAuthStatusExecFile = (
  file: string,
  args: readonly string[],
  options: SdkAuthStatusExecOptions,
) => Promise<SdkAuthStatusExecResult>;

export interface ValidateMonoAgentFolderOptions extends MonoAgentAppConfigInput {
  readonly drivers?: readonly ChannelDriver[];
  /** Optional sandbox engine override for deterministic validation tests. */
  readonly sandboxEngine?: SandboxEngine;
  /**
   * When false, validation must not create directories or otherwise mutate the
   * target filesystem. This is used for downstream consumer validation from a
   * different working directory. Defaults to true.
   */
  readonly allowFilesystemWrites?: boolean;
  /**
   * When false, skip live probes (Ollama reachability, the Phoenix export probe,
   * and SDK external-login status checks) and validate only structure/shape.
   * Those probes can only ever downgrade a section to `waiting`, never `error`,
   * so skipping them leaves the pass/fail verdict (`ok`) unchanged — the start
   * preflight relies on this. Defaults to true.
   */
  readonly liveness?: boolean;
  /**
   * Internal readiness-probe mode. Direct Codex cannot enforce arbitrary tool
   * allowlists, but the disposable probe has a dedicated runtime contract that
   * runs read-only and fails on the first tool action.
   */
  readonly codexNoToolsProbe?: boolean;
  /** Model refs whose credentials were proven by a successful live turn. */
  readonly verifiedCredentialModelRefs?: readonly string[];
  /** Injectable subprocess seam for deterministic provider credential/login-status tests. */
  readonly sdkAuthStatusExecFile?: SdkAuthStatusExecFile;
}

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
    coreConfig = await loadAppCoreConfig(options);
    sections.push({ id: "core", label: "Core config", status: "ok", details: [`Loaded ${options.configPath}.`] });
  } catch (error) {
    if (!isAppCoreConfigError(error)) {
      throw error;
    }
    sections.push({ id: "core", label: "Core config", status: "error", details: [error.message] });
  }

  if (coreConfig !== undefined) {
    const staticTriggerCredentialRefs = await collectStaticTriggerCredentialRefs(drivers, options);
    const jsonResult = await readMonoAgentConfigJson(options.configPath);
    // Channel secrets (bot tokens, API keys) live outside the core view, so the
    // placement check spans both: core sections + every channel's config view.
    const configWarnings = [
      ...findUnknownAppConfigWarnings(jsonResult.json),
      ...findJsonSecretConfigWarnings([
        ...buildMonoAgentConfigView({
          redacted: redactMonoAgentConfig(coreConfig),
          json: jsonResult.json,
          env: options.env,
        }),
        ...(await collectChannelConfigViews(drivers, options)),
      ]),
      ...findRemovedConfigWarnings({ json: jsonResult.json, env: options.env }),
    ];
    if (configWarnings.length > 0) {
      sections.push({ id: "secret-placement", label: "Config warnings", status: "waiting", details: configWarnings });
    }
    sections.push(runtimeSection(coreConfig));
    sections.push(await credentialsSection(
      coreConfig,
      options.env,
      options.cwd,
      liveness,
      options.verifiedCredentialModelRefs,
      options.sdkAuthStatusExecFile,
      staticTriggerCredentialRefs,
    ));
    sections.push(await contextSection(coreConfig, options.cwd));
    sections.push(await memorySection(coreConfig, options.cwd, liveness, allowFilesystemWrites));
    sections.push(await toolsSection(coreConfig, options));
    sections.push(await sandboxSection(coreConfig, options.sandboxEngine));
  }

  sections.push(await exporterSection(options, liveness));
  sections.push(await runsSection(options, coreConfig));

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

  return {
    sections,
    ok: sections.every((section) => section.status !== "error"),
  };
}

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
async function collectStaticTriggerCredentialRefs(
  drivers: readonly ChannelDriver[],
  input: MonoAgentAppConfigInput,
): Promise<readonly { label: string; ref: RuntimeModelReference }[]> {
  const refs: { label: string; ref: RuntimeModelReference }[] = [];
  const seen = new Set<string>();
  for (const driver of drivers) {
    if (driver.id !== "webhook" && driver.id !== "cron") continue;
    let loaded: unknown;
    try {
      loaded = await driver.loadConfig(input);
    } catch {
      // The channel section owns malformed/unreadable config diagnostics.
      continue;
    }
    for (const { entryPath, entry } of staticTriggerConfigEntries(driver.id, loaded)) {
      if (typeof entry.model !== "string") continue;
      try {
        const ref = parseMonoRuntimeModelReference(entry.model);
        const key = `${entryPath}\u0000${modelReferenceKey(ref)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ label: entryPath, ref });
      } catch {
        // The channel section owns invalid model-reference syntax.
      }
    }
  }
  return refs;
}

async function applyRequestModelOverrideCompatibilityChecks(
  sections: ValidationSection[],
  config: MonoAgentConfig,
  drivers: readonly ChannelDriver[],
  input: MonoAgentAppConfigInput,
): Promise<void> {
  const baseIsDirectCodex = config.runtime.model.sdk === "codex";
  const routeSafety = config.runtime.routeSafety ?? "uniform";
  const directBoundaryConflicts: string[] = [];
  const sandboxBypasses: string[] = [];
  const toolPolicyBypasses: string[] = [];
  const effortBypasses: string[] = [];
  const turnCapBypasses: string[] = [];
  const mcpBypasses: string[] = [];
  const skillBypasses: string[] = [];
  const piModelResolutionFailures: string[] = [];
  const monoSandboxActive = config.sandbox !== undefined && config.sandbox.mode !== "off";
  const restrictiveToolPolicy = !hasExactAllowAllToolPolicy(config.tools);
  let configuredMcpServerNames: string[] = [];
  if (config.tools.mcpConfigPath !== undefined) {
    try {
      configuredMcpServerNames = Object.keys(
        (await loadToolPolicyFromJsonFile(config.tools.mcpConfigPath)).mcpServers ?? {},
      );
    } catch {
      // The tools section owns missing/malformed MCP-file diagnostics.
    }
  }
  let adapterToolNames: readonly string[] = [];
  try {
    const settings = await resolveAdapterSendToolsSettings(input, {
      allowedTools: config.tools.allowedTools,
      disallowedTools: config.tools.disallowedTools,
    });
    if (settings !== undefined) adapterToolNames = adapterSendToolNames(settings);
  } catch {
    // Channel/tools sections own adapter config diagnostics.
  }
  const effectiveMcpSources = effectiveMcpRuntimeSources(config, configuredMcpServerNames, adapterToolNames);
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
      const hasEffortOverride = typeof entry.effort === "string";
      if (!hasModelOverride && !hasEffortOverride) continue;
      try {
        const model = hasModelOverride
          ? parseMonoRuntimeModelReference(entry.model as string)
          : config.runtime.model;
        const location = hasModelOverride
          ? `${entryPath}.model=${entry.model as string}`
          : `${entryPath}.effort=${entry.effort as string}`;
        if (hasModelOverride) {
          const resolutionIssue = piModelResolutionIssue(config, model);
          if (resolutionIssue !== undefined) {
            piModelResolutionFailures.push(`${location}: ${resolutionIssue}.`);
          }
        }
        if (routeSafety === "uniform" && hasModelOverride && (model.sdk === "codex") !== baseIsDirectCodex) {
          directBoundaryConflicts.push(location);
        }
        if (routeSafety === "uniform" && hasModelOverride && monoSandboxActive && (model.sdk === "claude" || model.sdk === "opencode" || model.sdk === "codex")) {
          sandboxBypasses.push(location);
        }
        if (hasModelOverride && restrictiveToolPolicy && model.sdk === "opencode") {
          toolPolicyBypasses.push(location);
        }
        const effectiveEffort = hasEffortOverride ? entry.effort as string : config.runtime.effort;
        const legacyFallbacks = (config.runtime.fallbacks?.length ?? 0) > 0
          ? []
          : config.runtime.fallbackModels ?? [];
        const directOpenCodeModels = [model, ...legacyFallbacks]
          .filter((candidate) => candidate.sdk === "opencode");
        if (directOpenCodeModels.length > 0 && effectiveEffort !== undefined) {
          effortBypasses.push(
            `${location} (effective effort=${effectiveEffort}) (direct OpenCode route=${directOpenCodeModels.map(referenceOf).join(", ")})`,
          );
        }
        if (directOpenCodeModels.length > 0 && Number(config.runtime.maxTurns) > 0) {
          turnCapBypasses.push(
            `${location} (runtime.maxTurns=${config.runtime.maxTurns}; direct OpenCode route=${directOpenCodeModels.map(referenceOf).join(", ")})`,
          );
        }
        if (directOpenCodeModels.length > 0 && effectiveMcpSources.length > 0) {
          mcpBypasses.push(
            `${location} (direct OpenCode route=${directOpenCodeModels.map(referenceOf).join(", ")}; MCP sources=${effectiveMcpSources.join("; ")})`,
          );
        }
        if (
          directOpenCodeModels.length > 0
          && config.context.skillDisclosure === "index"
          && config.context.skillsRoot !== undefined
        ) {
          skillBypasses.push(location);
        }
      } catch {
        // Adapter configIssues owns syntax diagnostics.
      }
    }
  }
  if (
    directBoundaryConflicts.length === 0
    && sandboxBypasses.length === 0
    && toolPolicyBypasses.length === 0
    && effortBypasses.length === 0
    && turnCapBypasses.length === 0
    && mcpBypasses.length === 0
    && skillBypasses.length === 0
    && piModelResolutionFailures.length === 0
  ) return;
  const index = sections.findIndex((section) => section.id === "runtime");
  if (index < 0) return;
  const runtime = sections[index]!;
  sections[index] = {
    ...runtime,
    status: "error",
    details: [
      ...runtime.details,
      ...(directBoundaryConflicts.length === 0
        ? []
        : [
            "Uniform route safety cannot cross the direct-Codex runtime boundary because tool and sandbox contracts would change mid-agent. Choose per-route-native to opt into explicit route-local contracts.",
            ...directBoundaryConflicts,
          ]),
      ...(sandboxBypasses.length === 0
        ? []
        : [
            "Claude or direct OpenCode model overrides cannot run under uniform route safety while mono-agent SRT is active; direct Codex is also provider-owned. Choose per-route-native only after reviewing the explicit route-local contracts.",
            ...sandboxBypasses,
          ]),
      ...(toolPolicyBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode model overrides require exact allow-all because OpenCode's provider-owned tool loop does not consume mono-agent allowedTools/disallowedTools.",
            ...toolPolicyBypasses,
          ]),
      ...(effortBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode routes cannot receive runtime effort because the OpenCode SDK does not expose effort control.",
            ...effortBypasses,
          ]),
      ...(turnCapBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode routes cannot enforce runtime.maxTurns; omit it, set it to 0, or use a runtime with a hard turn cap.",
            ...turnCapBypasses,
          ]),
      ...(mcpBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode routes cannot receive configured or auto-provisioned MCP runtime options.",
            ...mcpBypasses,
          ]),
      ...(skillBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode routes cannot use index skill disclosure because the bridge disables external/runtime skills; use full disclosure or a Pi runtime.",
            ...skillBypasses,
          ]),
      ...(piModelResolutionFailures.length === 0
        ? []
        : [
            "Per-trigger Pi model overrides must resolve through providers.local or Pi's exact built-in catalog before execution.",
            ...piModelResolutionFailures,
          ]),
    ],
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactAllowAllToolPolicy(
  tools: Pick<MonoAgentConfig["tools"], "allowedTools" | "disallowedTools">,
): boolean {
  return tools.allowedTools.length === 1
    && tools.allowedTools[0] === "*"
    && tools.disallowedTools.length === 0;
}

/** Adapter send tools each channel owns; an allowed entry needs BOTH the tool AND the enabled channel. */
const CHANNEL_OWNED_SEND_TOOLS: Record<string, readonly string[]> = {
  slack: ["SlackSendMessage"],
  telegram: ["TelegramSendMessage", "TelegramAskButtons", "TelegramSendFile"],
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
function applyToolChannelCrossChecks(
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

function runtimeSection(config: MonoAgentConfig): ValidationSection {
  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const routes = configuredRuntimeRouteChecks(config);
  const routeSafety = config.runtime.routeSafety ?? "uniform";
  details.push(`Route safety: ${routeSafety}.`);
  if (routes.length > 1) {
    details.push(
      routeSafety === "per-route-native"
        ? "Mixed runtime families are allowed; every attempt uses its explicit route-native safety contract."
        : "Fallback routes use the uniform compatibility contract; validation fails closed when any route cannot represent a required capability.",
    );
  }
  const directOpenCodeModels = routes.filter((route) => route.model.sdk === "opencode");
  if (Number(config.runtime.maxTurns) > 0 && directOpenCodeModels.length > 0) {
    status = "error";
    details.push(
      `Direct OpenCode model${directOpenCodeModels.length === 1 ? "" : "s"} ${directOpenCodeModels.map((route) => referenceOf(route.model)).join(", ")} cannot enforce runtime.maxTurns=${config.runtime.maxTurns}; omit it, set it to 0, or use a runtime with a hard turn cap.`,
    );
  }
  if (
    directOpenCodeModels.length > 0
    && config.context.skillDisclosure === "index"
    && config.context.skillsRoot !== undefined
  ) {
    status = "error";
    details.push(
      `Direct OpenCode model${directOpenCodeModels.length === 1 ? "" : "s"} ${directOpenCodeModels.map((route) => referenceOf(route.model)).join(", ")} cannot use context.skillDisclosure=index because runtime skills are disabled; use full disclosure or a Pi runtime.`,
    );
  }
  for (const route of routes) {
    try {
      const support = describeMonoRuntimeSupport(route.model, route.executionMode);
      const resolutionIssue = piModelResolutionIssue(config, route.model);
      const effortIssue = runtimeRouteEffortIssue(config, route);
      if (support.compatible && resolutionIssue === undefined) {
        details.push(
          `${route.label} ${referenceOf(route.model)} runs on ${support.backend?.label ?? "unknown backend"} ` +
          `(effort: ${route.effort ?? "provider default"}).`,
        );
      } else {
        status = "error";
        details.push(`${route.label} ${referenceOf(route.model)}: ${resolutionIssue ?? support.incompatibilityReason ?? "unsupported"}.`);
      }
      if (effortIssue !== undefined) {
        status = "error";
        details.push(`${route.label} ${referenceOf(route.model)}: ${effortIssue}`);
      }
    } catch (error) {
      status = "error";
      details.push(`${route.label} ${referenceOf(route.model)}: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  return { id: "runtime", label: "Runtime", status, details };
}

interface ConfiguredRuntimeRouteCheck {
  readonly label: string;
  readonly model: RuntimeModelReference;
  readonly effort?: string;
  readonly executionMode?: MonoAgentConfig["runtime"]["executionMode"];
}

function configuredRuntimeRouteChecks(config: MonoAgentConfig): readonly ConfiguredRuntimeRouteCheck[] {
  const primary: ConfiguredRuntimeRouteCheck = {
    label: "Primary model",
    model: config.runtime.model,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    executionMode: config.runtime.executionMode,
  };
  if ((config.runtime.fallbacks?.length ?? 0) > 0) {
    return [
      primary,
      ...(config.runtime.fallbacks ?? []).map((fallback) => ({
        label: "Fallback model",
        model: fallback.model,
        ...(fallback.effort === undefined ? {} : { effort: fallback.effort }),
      })),
    ];
  }
  return [
    primary,
    ...(config.runtime.fallbackModels ?? []).map((model) => ({
      label: "Fallback model",
      model,
      ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    })),
  ];
}

function runtimeRouteEffortIssue(
  config: MonoAgentConfig,
  route: ConfiguredRuntimeRouteCheck,
): string | undefined {
  if (route.effort === undefined) return undefined;
  if (route.model.sdk === "opencode") {
    return `Direct OpenCode model ${referenceOf(route.model)} cannot receive runtime.effort=${route.effort}; the OpenCode SDK exposes no reasoning-effort input. Omit the route effort.`;
  }
  const metadata = resolveModelEffortLevels(route.model, config.providers?.local);
  if (metadata.effortLevels !== undefined && !metadata.effortLevels.includes(route.effort)) {
    return `effort=${route.effort} is unsupported by known model metadata; choose ${metadata.effortLevels.join(", ")}, or omit it for provider default.`;
  }
  if (metadata.reasoning === false && route.effort !== "none") {
    return `effort=${route.effort} is unsupported because known model metadata marks this route as non-reasoning; use none or provider default.`;
  }
  if (
    route.model.sdk === "claude"
    && (route.executionMode ?? defaultExecutionModeForModel(route.model)) === "sdk"
    && !["low", "medium", "high", "xhigh", "max"].includes(route.effort)
  ) {
    return `effort=${route.effort} is unsupported by the Claude Agent SDK; choose low, medium, high, xhigh, max, or provider default.`;
  }
  return undefined;
}

/**
 * Mirrors the Pi runtime's actual model-resolution boundary. Mono-agent only
 * registers a custom Pi provider from `providers.local`; it deliberately does
 * not import Pi CLI's ambient sibling `models.json`. Without a matching local
 * provider, `resolvePiRuntimeModel` performs an exact built-in catalog lookup.
 */
function piModelResolutionIssue(
  config: MonoAgentConfig,
  model: RuntimeModelReference,
): string | undefined {
  if (model.sdk !== "pi" || model.provider === undefined) {
    return undefined;
  }

  const localProvider = config.providers?.local?.find((provider) => provider.id === model.provider);
  if (localProvider !== undefined) {
    if (localProvider.enabled === false) {
      return `provider \`${model.provider}\` is disabled in providers.local`;
    }
    const localModel = localProvider.models?.find(
      (candidate) => candidate.name === model.model || candidate.alias === model.model,
    );
    if (localModel?.enabled === false) {
      return `model \`${model.model}\` is disabled in providers.local for provider \`${model.provider}\``;
    }
    return undefined;
  }

  if (
    isPiBuiltinProvider(model.provider)
    && getPiBuiltinModels(model.provider).some((candidate) => candidate.id === model.model)
  ) {
    return undefined;
  }

  return (
    `pi model not found: ${model.provider}:${model.model}; no matching providers.local entry exists and Pi's built-in catalog has no exact model. ` +
    "The sibling Pi CLI models.json is not a mono-agent runtime source; add providers.local for a self-hosted provider or choose a built-in Pi model"
  );
}

function isPiBuiltinProvider(provider: string): provider is PiBuiltinProvider {
  return (getPiBuiltinProviders() as readonly string[]).includes(provider);
}

interface PiAuthEntry {
  readonly type?: string;
  readonly key?: string;
  readonly access?: string;
  readonly expires?: number;
  readonly refresh?: string;
}

const PI_API_KEY_ENV_BY_PROVIDER: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
};

/** Inspects Pi credentials without following aliases or reading unbounded input. */
async function readPiAuthProviders(path: string): Promise<
  | { readonly status: "ok"; readonly providers: Readonly<Record<string, PiAuthEntry>> }
  | Exclude<PiAuthStoreInspection, { readonly status: "ok" }>
> {
  const inspection = await inspectPiAuthStore(path);
  if (inspection.status !== "ok") return inspection;
  return { status: "ok", providers: inspection.auth as Readonly<Record<string, PiAuthEntry>> };
}

/**
 * Static env-credential contract for an SDK-authenticated backend (claude/codex).
 * `envKeys` are the environment variables the backend accepts, in preference
 * order; `loginDetail` names the interactive OAuth path that lives OUTSIDE the
 * environment (Claude subscription / ChatGPT sign-in) and therefore CANNOT be
 * verified by a static env check; `failureHint` is what a fresh user actually
 * sees when neither is present (the opaque E1 failure).
 */
type SdkAuthName = "claude" | "codex";

interface SdkAuthScheme {
  readonly envKeys: readonly string[];
  readonly loginCommand: string;
  readonly loginDetail: string;
  readonly failureHint: string;
  readonly statusCommand: string;
  readonly statusArgs: readonly string[];
}

/**
 * What each SDK-authenticated backend truthfully reads for credentials. Only the
 * env vars are statically checkable; the login paths are recorded so the warning
 * can stay honest (a logged-in user is fine and we must not claim otherwise).
 *
 * - claude (`claude:*`, sdk + cli): the Claude Code process authenticates from
 *   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` in
 *   the env, OR from a `claude /login` subscription session stored outside the
 *   environment (macOS Keychain / `~/.claude`), OR from a Bedrock/Vertex
 *   configuration (`CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX` + cloud
 *   credentials) — none of which the env-key check can see, hence the hedge in
 *   the warning. Its own error string is verbatim: "Claude Code authentication
 *   failed. Run `claude /login` or configure ANTHROPIC_API_KEY,
 *   ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN."
 * - codex (`codex:*`, cli): the Codex app-server authenticates from
 *   `OPENAI_API_KEY` in the env, OR from a `codex login` ChatGPT session stored
 *   in `~/.codex/auth.json` — also outside the environment.
 */
const SDK_AUTH_SCHEMES: Record<SdkAuthName, SdkAuthScheme> = {
  claude: {
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    loginCommand: "claude /login",
    loginDetail:
      "a `claude /login` subscription session or a Bedrock/Vertex configuration (CLAUDE_CODE_USE_BEDROCK/VERTEX)",
    failureHint: 'the first turn fails with an opaque "Claude Code process exited with code 1" that names nothing',
    statusCommand: "claude auth status --json",
    statusArgs: ["auth", "status", "--json"],
  },
  codex: {
    envKeys: ["OPENAI_API_KEY"],
    loginCommand: "codex login",
    loginDetail: "a `codex login` ChatGPT session (`~/.codex/auth.json`, outside the environment)",
    failureHint: "the first turn fails to authenticate",
    statusCommand: "codex login status",
    statusArgs: ["login", "status"],
  },
};

const SDK_AUTH_STATUS_TIMEOUT_MS = 5_000;
const SDK_AUTH_STATUS_MAX_BUFFER_BYTES = 64 * 1024;

function isSdkAuthName(value: string): value is SdkAuthName {
  return value === "claude" || value === "codex";
}

const defaultSdkAuthStatusExecFile: SdkAuthStatusExecFile = async (file, args, options) => {
  const { stdout } = await execFile(file, [...args], options);
  return { stdout };
};

/**
 * Performs the SDK's local, read-only login-status command. A zero Codex exit
 * confirms its external login; Claude additionally requires strict JSON with
 * `loggedIn: true`. Missing binaries, timeouts, non-zero exits, and malformed
 * output all fail closed without leaking command output into validation.
 */
async function checkSdkExternalLoginStatus(
  sdk: SdkAuthName,
  env: Record<string, string | undefined>,
  cwd: string,
  run: SdkAuthStatusExecFile,
): Promise<boolean> {
  const scheme = SDK_AUTH_SCHEMES[sdk];
  try {
    const { stdout } = await run(sdk, scheme.statusArgs, {
      cwd,
      env,
      timeout: SDK_AUTH_STATUS_TIMEOUT_MS,
      maxBuffer: SDK_AUTH_STATUS_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    if (sdk === "codex") {
      return true;
    }
    const parsed: unknown = JSON.parse(stdout);
    return parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && (parsed as { readonly loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

type OpenCodeCredentialInspection =
  | { readonly status: "ok"; readonly providers: ReadonlySet<string> }
  | { readonly status: "migration_required" | "auth_missing" | "auth_invalid" | "inline_auth_unsupported" };

/** Read provider IDs directly from auth.json without launching mutation-capable OpenCode middleware. */
async function inspectOpenCodeCredentialProviders(
  env: Record<string, string | undefined>,
): Promise<OpenCodeCredentialInspection> {
  if (env.OPENCODE_AUTH_CONTENT !== undefined) {
    return { status: "inline_auth_unsupported" };
  }
  const dataHome = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : join(typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir(), ".local", "share");
  const opencodeData = join(dataHome, "opencode");
  const marker = await regularCurrentUserFile(join(opencodeData, "opencode.db"));
  if (!marker) return { status: "migration_required" };
  const authPath = join(opencodeData, "auth.json");
  if (!(await regularCurrentUserFile(authPath))) return { status: "auth_missing" };
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath, "utf8"));
    if (!isUnknownRecord(parsed)) return { status: "auth_invalid" };
    const providers = new Set<string>();
    for (const [provider, credential] of Object.entries(parsed)) {
      if (provider.length === 0 || provider.trim() !== provider || !isOpenCodeCredentialEntry(credential)) {
        return { status: "auth_invalid" };
      }
      providers.add(provider);
    }
    return { status: "ok", providers };
  } catch {
    return { status: "auth_invalid" };
  }
}

async function regularCurrentUserFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && (typeof process.getuid !== "function" || info.uid === process.getuid());
  } catch {
    return false;
  }
}

function isOpenCodeCredentialEntry(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false;
  if (value.type === "oauth") {
    return typeof value.refresh === "string"
      && typeof value.access === "string"
      && (value.refresh.trim().length > 0 || value.access.trim().length > 0)
      && typeof value.expires === "number"
      && Number.isSafeInteger(value.expires)
      && value.expires >= 0
      && (value.accountId === undefined || typeof value.accountId === "string")
      && (value.enterpriseUrl === undefined || typeof value.enterpriseUrl === "string");
  }
  if (value.type === "api") {
    return typeof value.key === "string"
      && value.key.trim().length > 0
      && (value.metadata === undefined
        || (isUnknownRecord(value.metadata) && Object.values(value.metadata).every((entry) => typeof entry === "string")));
  }
  if (value.type === "wellknown") {
    return typeof value.key === "string" && value.key.trim().length > 0
      && typeof value.token === "string" && value.token.trim().length > 0;
  }
  return false;
}

async function checkOpenCodeVersion(
  env: Record<string, string | undefined>,
  cwd: string,
  run: SdkAuthStatusExecFile,
): Promise<boolean> {
  const versionEnv: Record<string, string | undefined> = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) versionEnv[key] = value;
  }
  try {
    const { stdout } = await run("opencode", ["--version"], {
      cwd,
      env: versionEnv,
      timeout: SDK_AUTH_STATUS_TIMEOUT_MS,
      maxBuffer: SDK_AUTH_STATUS_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(stdout.trim());
    if (match === null) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    return Number.isSafeInteger(major)
      && Number.isSafeInteger(minor)
      && Number.isSafeInteger(patch)
      && (major > 1 || (major === 1 && minor >= 15));
  } catch {
    return false;
  }
}

/** First env key whose value is present and non-blank, or undefined when none are set. */
function firstPresentEnvKey(env: Record<string, string | undefined>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return key;
    }
  }
  return undefined;
}

/**
 * Checks that every referenced model (primary, fallbacks, and the agent-host memory LLM)
 * has discoverable credentials, so a keyless or expired-OAuth provider is caught at
 * `validate` time instead of degrading crons/memory silently at runtime (the failure mode
 * that broke memory capture for ~10 days: the auth store's OAuth token had quietly expired,
 * and the E1 fresh-instance case where `claude:*` with no `ANTHROPIC_API_KEY` "validates"
 * clean but the first turn dies with an opaque "process exited with code 1").
 *
 * The check is read-only. Static validation never launches a process; live validation may
 * run bounded, local SDK login-status commands, which inspect durable external login state
 * without making a model turn or mutating the auth store.
 *
 * - Pi providers: inspect the auth store (`piAuthPath`) and the config's own
 *   `providers.local` custom providers. A custom/local provider follows its declared
 *   `apiKey` / `apiKeyEnv` contract instead of Pi OAuth; an OAuth provider absent from
 *   the store, or whose access token has expired, is flagged `waiting` with a re-auth hint.
 * - SDK-authenticated providers (`claude:*` / `codex:*`): inspect the RESOLVED ENV (process
 *   env + loaded `.env`) for the backend's accepted keys. During live validation only, a
 *   missing env credential falls back to `claude auth status --json` / `codex login status`.
 *   The commands use the same resolved environment (including PATH and HOME), are bounded,
 *   cached once per SDK, and never make a model turn. Static validation remains process-free.
 * - Direct OpenCode (`opencode:<provider>:<model>`): inspect exact provider IDs in the
 *   standard auth.json and require the native DB migration marker. Static validation launches
 *   no process. Live validation runs only a bounded `opencode --version` preflight; it never
 *   runs the mutation-capable auth middleware or makes a model turn.
 *
 * `waiting` (never `error`) keeps the verdict non-fatal, mirroring the Ollama/Phoenix
 * probes — the goal is visibility, not blocking start.
 */
async function credentialsSection(
  config: MonoAgentConfig,
  env: Record<string, string | undefined>,
  cwd: string,
  liveness: boolean,
  verifiedCredentialModelRefs: readonly string[] = [],
  sdkAuthStatusExecFile: SdkAuthStatusExecFile = defaultSdkAuthStatusExecFile,
  staticTriggerRefs: readonly { label: string; ref: RuntimeModelReference }[] = [],
): Promise<ValidationSection> {
  const refs: { label: string; ref: RuntimeModelReference }[] = [
    { label: "Primary", ref: config.runtime.model },
    ...configuredRuntimeRouteChecks(config).slice(1).map((route) => ({
      label: "Fallback",
      ref: route.model,
    })),
    ...staticTriggerRefs,
  ];
  if (config.memory?.llm !== undefined && config.memory.llm.provider !== "ollama") {
    try {
      refs.push({ label: "Memory LLM", ref: parseMonoRuntimeModelReference(config.memory.llm.model) });
    } catch {
      // A malformed memory model reference is surfaced by the memory/runtime shape checks.
    }
  }

  const authenticatedRefs = refs.filter((r) =>
    (r.ref.sdk === "pi" && typeof r.ref.provider === "string")
    || (r.ref.sdk === "opencode" && typeof r.ref.provider === "string")
    || isSdkAuthName(r.ref.sdk),
  );
  if (authenticatedRefs.length === 0) {
    return {
      id: "credentials",
      label: "Provider credentials",
      status: "disabled",
      details: ["No provider-authenticated models referenced."],
    };
  }

  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const verified = new Set(verifiedCredentialModelRefs);
  for (const { label, ref } of authenticatedRefs) {
    const refStr = referenceOf(ref);
    if (verified.has(refStr)) {
      details.push(`${label} ${refStr}: credentials verified by a successful live model check.`);
    }
  }
  const unverifiedRefs = authenticatedRefs.filter(({ ref }) => !verified.has(referenceOf(ref)));
  const piRefs = unverifiedRefs.filter((r) => r.ref.sdk === "pi" && typeof r.ref.provider === "string");
  const openCodeRefs = unverifiedRefs.filter((r) => r.ref.sdk === "opencode" && typeof r.ref.provider === "string");
  const sdkRefs = unverifiedRefs.filter(
    (r): r is { label: string; ref: RuntimeModelReference & { sdk: SdkAuthName } } => isSdkAuthName(r.ref.sdk),
  );

  if (piRefs.length > 0) {
    const piStatus = await appendPiCredentialDetails(config, piRefs, details, env);
    if (piStatus === "waiting") {
      status = "waiting";
    }
  }

  const openCodeInspection = openCodeRefs.length > 0
    ? inspectOpenCodeCredentialProviders(env)
    : undefined;
  const openCodeVersion = liveness && openCodeRefs.length > 0
    ? checkOpenCodeVersion(env, cwd, sdkAuthStatusExecFile)
    : undefined;

  const sdkAuthStatuses = new Map<SdkAuthName, Promise<boolean>>();
  const externalLoginStatus = (sdk: SdkAuthName): Promise<boolean> => {
    const cached = sdkAuthStatuses.get(sdk);
    if (cached !== undefined) {
      return cached;
    }
    const pending = checkSdkExternalLoginStatus(sdk, env, cwd, sdkAuthStatusExecFile);
    sdkAuthStatuses.set(sdk, pending);
    return pending;
  };

  // Start each unique local status check before awaiting details so two SDKs
  // cost one bounded timeout window rather than running serially.
  if (liveness) {
    for (const { ref } of sdkRefs) {
      const scheme = SDK_AUTH_SCHEMES[ref.sdk];
      if (scheme !== undefined && firstPresentEnvKey(env, scheme.envKeys) === undefined) {
        void externalLoginStatus(ref.sdk);
      }
    }
  }

  for (const { label, ref } of sdkRefs) {
    const refStr = referenceOf(ref);
    const scheme = SDK_AUTH_SCHEMES[ref.sdk];
    if (scheme === undefined) {
      continue;
    }
    const present = firstPresentEnvKey(env, scheme.envKeys);
    if (present !== undefined) {
      details.push(`${label} ${refStr}: SDK credential present in the resolved env (${present}); credential detected, live model verification is still pending.`);
      continue;
    }
    if (liveness && await externalLoginStatus(ref.sdk)) {
      details.push(
        `${label} ${refStr}: external sign-in detected by read-only \`${scheme.statusCommand}\`; ` +
          "credentials are not verified until a live model turn succeeds.",
      );
      continue;
    }
    status = "waiting";
    details.push(
      `[WARN] ${label} ${refStr}: no SDK credential in the resolved env (checked ${scheme.envKeys.join(", ")}). ` +
        (liveness
          ? `External login was not verified by \`${scheme.statusCommand}\`; `
          : `If you authenticated via ${scheme.loginDetail} this is fine and can't be verified during static validation; `) +
        `otherwise ${scheme.failureHint} — set ${scheme.envKeys[0]} or run \`${scheme.loginCommand}\`.`,
    );
  }


  if (openCodeRefs.length > 0) {
    const inspection = openCodeInspection === undefined ? undefined : await openCodeInspection;
    const supportedVersion = openCodeVersion === undefined ? false : await openCodeVersion;
    for (const { label, ref } of openCodeRefs) {
      const refStr = referenceOf(ref);
      const provider = ref.provider as string;
      const credentialPresent = inspection?.status === "ok" && inspection.providers.has(provider);
      if (credentialPresent && liveness && supportedVersion) {
        details.push(
          `${label} ${refStr}: provider \`${provider}\` credential present in the standard OpenCode auth store; stable OpenCode CLI >=1.15.0 detected without a model turn. Credential detected; live model verification is still pending.`,
        );
      } else {
        status = "waiting";
        const warning = inspection?.status === "migration_required"
          ? "the native OpenCode database migration marker is missing or invalid; run `opencode db migrate --pure` once"
          : inspection?.status === "inline_auth_unsupported"
            ? "OPENCODE_AUTH_CONTENT is unsupported for direct runs; persist credentials with `opencode auth login` and unset it"
            : inspection?.status === "auth_invalid"
              ? "the standard OpenCode auth.json is malformed or contains an unsupported credential entry"
              : credentialPresent && !liveness
                ? "credentials and migration marker are present, but the required stable OpenCode CLI >=1.15.0 is unverified during static validation"
                : credentialPresent && !supportedVersion
                  ? "credentials are present, but stable OpenCode CLI >=1.15.0 could not be verified"
              : inspection?.status === "ok"
                ? `no exact credential entry exists for provider \`${provider}\`; run \`opencode auth login\` for that provider`
                : "the standard OpenCode auth.json is missing; run `opencode auth login`";
        const safetyNote = liveness
          ? "No model turn or mutation-capable OpenCode command was run."
          : "No OpenCode process was launched.";
        details.push(`[WARN] ${label} ${refStr}: ${warning}. ${safetyNote}`);
      }
    }
  }

  return { id: "credentials", label: "Provider credentials", status, details };
}

/**
 * Appends one detail line per Pi provider reference and returns "waiting" if any
 * was flagged (missing/expired), else "ok". Recognizes custom providers only
 * through the config's `providers.local` set, matching the runtime boundary.
 */
async function appendPiCredentialDetails(
  config: MonoAgentConfig,
  piRefs: readonly { label: string; ref: RuntimeModelReference }[],
  details: string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ValidationStatus> {
  const authPath = config.providers?.piAuthPath;
  const authInspection = authPath === undefined ? undefined : await readPiAuthProviders(authPath);
  const authProviders = authInspection?.status === "ok" ? authInspection.providers : undefined;
  // A matching `providers.local` entry owns the runtime route, even when its ID
  // collides with a Pi built-in provider. Report the local entry's declared auth
  // contract instead of consulting the unrelated Pi auth store. A disabled entry
  // remains authoritative because the runtime rejects it before credential use.
  const localProviders = new Map(
    (config.providers?.local ?? []).map((provider) => [provider.id, provider] as const),
  );
  const now = Date.now();
  let status: ValidationStatus = "ok";
  if (authPath !== undefined) {
    details.push(`Pi auth store: ${authPath}`);
  }

  for (const { label, ref } of piRefs) {
    const provider = ref.provider as string;
    const refStr = referenceOf(ref);
    const loginCommand = piAuthRecoveryCommand(provider, authPath);
    const localProvider = localProviders.get(provider);
    if (localProvider !== undefined) {
      if (localProvider.enabled === false) {
        status = "waiting";
        details.push(
          `[WARN] ${label} ${refStr}: provider \`${provider}\` is configured in providers.local but disabled (\`enabled: false\`); the runtime will throw \`provider disabled: ${provider}\` on the first turn. Set \`enabled: true\` on that providers.local entry.`,
        );
      } else if (localProvider.apiKey !== undefined) {
        details.push(
          `${label} ${refStr}: provider \`${provider}\` configured via config providers.local (API key configured); credential detected, live model verification is still pending.`,
        );
      } else if (localProvider.apiKeyEnv !== undefined) {
        if (hasNonEmptyCredentialValue(env[localProvider.apiKeyEnv])) {
          details.push(
            `${label} ${refStr}: provider \`${provider}\` configured via config providers.local with ${localProvider.apiKeyEnv} present in the resolved environment; credential detected, live model verification is still pending.`,
          );
        } else {
          status = "waiting";
          details.push(
            `[WARN] ${label} ${refStr}: provider \`${provider}\` declares apiKeyEnv \`${localProvider.apiKeyEnv}\`, but the resolved environment has no non-empty value and no inline apiKey fallback. Set ${localProvider.apiKeyEnv} before starting.`,
          );
        }
      } else {
        details.push(
          `${label} ${refStr}: provider \`${provider}\` configured via config providers.local (keyless local provider; no API key declared).`,
        );
      }
      continue;
    }
    const apiKeyEnv = PI_API_KEY_ENV_BY_PROVIDER[provider];
    if (apiKeyEnv !== undefined && hasNonEmptyCredentialValue(env[apiKeyEnv])) {
      details.push(
        `${label} ${refStr}: Pi API-key credential for \`${provider}\` present in the resolved environment (${apiKeyEnv}); credential detected, live model verification is still pending.`,
      );
      continue;
    }
    if (authInspection?.status === "unsafe") {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: Pi auth store was not trusted because ${describePiAuthStoreUnsafeReason(authInspection.reason)}. ` +
          `Move the unsafe entry aside if needed, then run \`${loginCommand}\` to create or atomically harden a current-user 0600 store. ` +
          "A current-user, non-writable legacy store can be replaced during this explicit repair, but is intentionally never trusted for credential detection. " +
          "No credential values or file contents were displayed.",
      );
      continue;
    }
    const entry = authProviders?.[provider];
    if (entry === undefined) {
      status = "waiting";
      details.push(apiKeyEnv === undefined
        ? `[WARN] ${label} ${refStr}: no Pi credentials found for provider \`${provider}\` in the auth store. Authenticate it with \`${loginCommand}\`, or set providers.piAuthPath.`
        : `[WARN] ${label} ${refStr}: no Pi API key credentials found for provider \`${provider}\` in the auth store or resolved environment. Run \`${loginCommand}\`, or set ${apiKeyEnv}.`);
      continue;
    }
    const isOAuth = entry.type === "oauth";
    const isApiKey = entry.type === "api_key";
    if (isApiKey && !hasNonEmptyCredentialValue(entry.key)) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored API-key credential for \`${provider}\` has no usable key. Run \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    if (isOAuth && !hasNonEmptyCredentialValue(entry.access) && !hasNonEmptyCredentialValue(entry.refresh)) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored OAuth credential for \`${provider}\` has no usable access or refresh token. Re-authenticate with \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    if (!isOAuth && !isApiKey) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored credential for \`${provider}\` has an unsupported or missing type. Re-authenticate with \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    const expired = typeof entry.expires === "number" && entry.expires < now;
    const whenNote = typeof entry.expires === "number" ? ` ${new Date(entry.expires).toISOString()}` : "";
    if (isOAuth && expired) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: OAuth token for \`${provider}\` expired${whenNote} — the runtime may auto-refresh, but this credential is not ready until a request succeeds; if runs fail with "No API key for provider: ${provider}" re-authenticate with \`${loginCommand}\`.`,
      );
      continue;
    }
    details.push(
      isOAuth
        ? `${label} ${refStr}: OAuth credentials for \`${provider}\` present (token valid${whenNote}); credential detected, live model verification is still pending.`
        : `${label} ${refStr}: API key credentials for \`${provider}\` present; credential detected, live model verification is still pending.`,
    );
  }

  return status;
}

function describePiAuthStoreUnsafeReason(reason: PiAuthStoreUnsafeReason): string {
  switch (reason) {
    case "owner-check-unavailable": return "the current file owner could not be verified";
    case "symbolic-link": return "the configured entry is a symbolic link";
    case "not-regular-file": return "the configured entry is not a regular file";
    case "multiple-hard-links": return "the file has multiple hard links";
    case "oversized": return "the file exceeds the 1 MiB inspection limit";
    case "foreign-owner": return "the file is not owned by the current user";
    case "not-owner-only": return "its permissions are not owner-only";
    case "changed-during-read": return "its identity or metadata changed during inspection";
    case "malformed-json": return "it is not a valid JSON object";
    case "unreadable": return "it could not be opened and inspected safely";
  }
}

function hasNonEmptyCredentialValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 65_536 && !value.includes("\0");
}

async function contextSection(config: MonoAgentConfig, cwd: string): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  if (await pathExists(config.context.identityPath)) {
    details.push(`Identity: ${config.context.identityPath}`);
  } else {
    status = "error";
    details.push(`Identity file is missing: ${config.context.identityPath}`);
  }

  if (config.context.soulPath !== undefined && !(await pathExists(config.context.soulPath))) {
    status = "error";
    details.push(`Soul file is missing: ${config.context.soulPath}`);
  }

  if (config.context.skillsRoot !== undefined) {
    if (await pathExists(config.context.skillsRoot)) {
      details.push(`Skills root: ${config.context.skillsRoot}`);
      for (const skill of config.context.selectedSkills) {
        const skillPath = join(config.context.skillsRoot, skill, "SKILL.md");
        if (await pathExists(skillPath)) {
          details.push(`Skill \`${skill}\`: ${skillPath}`);
        } else {
          status = "error";
          details.push(`Skill \`${skill}\` is selected but ${skillPath} is missing.`);
        }
      }
    } else {
      status = "error";
      details.push(`Skills root is missing: ${config.context.skillsRoot}`);
    }
  } else if (config.context.selectedSkills.length > 0) {
    status = "error";
    details.push("Skills are selected but context.skillsRoot is not set.");
  }

  if (await managedProjectSkillsExist(cwd)) {
    const managed = await checkManagedProjectSkills(cwd);
    const drift = managed.statuses.filter((entry) => entry.status !== "ready");
    if (drift.length === 0) {
      details.push(`Managed project skills: current (${managed.manifestVersion ?? "unknown version"}).`);
    } else {
      if (status === "ok") status = "waiting";
      details.push(
        `Managed project skill drift: ${drift.map((entry) => `${entry.name}=${entry.status}`).join(", ")}. ` +
        "Run `mono-agent install-skill --project --check`; use --update only after reconciling modified copies.",
      );
    }
  }

  return { id: "context", label: "Context & skills", status, details };
}

const DEFAULT_CONSOLIDATION_CRON = "0 */2 * * *";

async function memorySection(
  config: MonoAgentConfig,
  cwd: string,
  liveness: boolean,
  allowFilesystemWrites: boolean,
): Promise<ValidationSection> {
  if (config.memory === undefined) {
    return { id: "memory", label: "Memory", status: "disabled", details: ["No memory configured."] };
  }
  // External backend (e.g. supermemory): mode/embeddings/llm are bujo-only and ignored, so report the
  // backend's own shape. We do not ping the instance here (config-shape check); the playbook covers
  // starting the server.
  if ((config.memory.backend ?? "bujo") === "supermemory") {
    const sm = config.memory.supermemory;
    if (sm === undefined) {
      return {
        id: "memory",
        label: "Memory",
        status: "error",
        details: ["[ERROR] backend 'supermemory' requires a memory.supermemory block."],
      };
    }
    try {
      const plugin = await loadSupermemoryPlugin({ cwd });
      const validation = plugin.validateSupermemoryConfig({
        baseUrl: sm.baseUrl,
        container: resolveSupermemoryContainer(config),
        ...(sm.apiKey === undefined ? {} : { apiKey: sm.apiKey }),
        ...(sm.timeoutMs === undefined ? {} : { timeoutMs: sm.timeoutMs }),
        ...(config.memory.maxBytes === undefined ? {} : { maxBytes: config.memory.maxBytes }),
      });
      if (!validation.valid) {
        return {
          id: "memory",
          label: "Memory",
          status: "error",
          details: validation.errors.map((detail) => `[ERROR] ${detail}`),
        };
      }
    } catch (error) {
      return {
        id: "memory",
        label: "Memory",
        status: "error",
        details: [`[ERROR] ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    return {
      id: "memory",
      label: "Memory",
      status: "ok",
      details: [
        `Backend: supermemory, writeMode: ${config.memory.writeMode}.`,
        `Endpoint: ${sm.baseUrl} (container "${resolveSupermemoryContainer(config)}").`,
        sm.apiKey === undefined
          ? "Auth: no API key configured (keyless — works only if the instance allows it)."
          : "Auth: API key configured.",
        "Start the Supermemory instance (e.g. `supermemory-server`) before sending turns; ingestion is async.",
      ],
    };
  }
  const details: string[] = [
    `Mode: ${config.memory.mode}, path: ${config.memory.path}, writeMode: ${config.memory.writeMode}.`,
  ];
  let status: ValidationStatus = "ok";
  if (config.memory.llm !== undefined) {
    details.push(`Chat LLM: ${memoryLlmLabel(config.memory.llm)}.`);
    if (config.memory.llm.provider === "agent-host") {
      try {
        const model = parseMonoRuntimeModelReference(config.memory.llm.model);
        const resolutionIssue = piModelResolutionIssue(config, model);
        if (resolutionIssue !== undefined) {
          status = "error";
          details.push(`Agent-host memory LLM ${referenceOf(model)}: ${resolutionIssue}.`);
        }
      } catch (error) {
        status = "error";
        details.push(
          `Agent-host memory LLM ${config.memory.llm.model}: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
  }

  if (config.memory.mode === "bujo") {
    // Report consolidation scheduler cadence.
    const consolidationEnabled = config.memory.consolidation?.enabled !== false;
    const consolidationCron = config.memory.consolidation?.cron ?? DEFAULT_CONSOLIDATION_CRON;
    if (consolidationEnabled) {
      details.push(`Consolidation: ${consolidationCron} (auto).`);
    } else {
      details.push("Consolidation: disabled.");
    }
  }

  const managedIdentity = await managedMemoryIdentityStatus(config.memory);
  if (managedIdentity !== undefined) {
    return {
      id: "memory",
      label: "Memory",
      status: status === "error" ? "error" : managedIdentity.status,
      details: [...details, ...managedIdentity.details],
    };
  }

  const nativeAvailability = await builtInMemoryNativeStatus(config.memory);
  if (nativeAvailability !== undefined) {
    return {
      id: "memory",
      label: "Memory",
      status: "error",
      details: [...details, nativeAvailability],
    };
  }

  if (config.memory.mode === "journal" || config.memory.mode === "bujo") {
    const warns = await memoryLivenessWarnings(config.memory, liveness, allowFilesystemWrites);
    if (warns.length > 0) {
      return {
        id: "memory",
        label: "Memory",
        status: status === "error" ? "error" : "waiting",
        details: [...details, ...warns],
      };
    }
  }

  if (config.memory.mode === "lite") {
    const liteWarns = await liteRootWritableWarning(config.memory.path, allowFilesystemWrites);
    if (liteWarns.length > 0) {
      return {
        id: "memory",
        label: "Memory",
        status: status === "error" ? "error" : "waiting",
        details: [...details, ...liteWarns],
      };
    }
  }

  return { id: "memory", label: "Memory", status, details };
}

async function managedMemoryIdentityStatus(
  memory: NonNullable<MonoAgentConfig["memory"]>,
): Promise<{ readonly status: "error"; readonly details: readonly string[] } | undefined> {
  if (await pathExists(join(memory.path, FIRST_RUN_MEMORY_INITIALIZING_MARKER))) {
    return {
      status: "error",
      details: [
        "[ERROR] First-run managed memory initialization is incomplete.",
        "Re-run `mono-agent init` in a clean target or remove only the failed first-run root after inspecting it.",
      ],
    };
  }
  const manifestPath = join(memory.path, ".index", "manifest.json");
  if (!(await pathExists(manifestPath))) {
    // Lite has no semantic index authority. Journal/BuJo readiness is strict:
    // a missing manifest is fatal even for a wholly new/unmanaged root, and the
    // provider must not be probed until rebuild establishes that authority.
    if (memory.mode === "lite") return undefined;
    return {
      status: "error",
      details: [
        "[ERROR] Managed memory generation metadata is missing for Journal/BuJo memory.",
        "Stop the agent with `mono-agent stop`, run `mono-agent memory rebuild`, then re-run `mono-agent validate` before restarting.",
      ],
    };
  }
  let manifest;
  try {
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    manifest = readManagedIndexManifest(memory.path);
  } catch {
    return {
      status: "error",
      details: ["[ERROR] Managed memory generation metadata is invalid or unavailable."],
    };
  }
  if (manifest === undefined) {
    return {
      status: "error",
      details: ["[ERROR] Managed memory generation metadata disappeared during validation."],
    };
  }

  const configuredModel = memory.embeddings === undefined
    ? undefined
    : `${memory.embeddings.provider}:${memory.embeddings.model}`;
  const configuredDimension = memory.embeddings === undefined ? undefined : memory.embeddings.dim ?? 768;
  const active = manifest.active;
  if (active.tier === memory.mode
    && active.embeddingModel === configuredModel
    && active.dimension === configuredDimension) {
    return undefined;
  }

  const identity = (tier: string, model: string | undefined, dimension: number | undefined): string =>
    `tier=${tier}, model=${model ?? "none"}, dim=${dimension ?? "none"}`;
  return {
    status: "error",
    details: [
      `[ERROR] Active managed generation does not match the configured memory identity: active ${identity(active.tier, active.embeddingModel, active.dimension)}; configured ${identity(memory.mode, configuredModel, configuredDimension)}.`,
      "Stop the agent with `mono-agent stop`, run `mono-agent memory rebuild`, then re-run `mono-agent validate` before restarting.",
    ],
  };
}

async function builtInMemoryNativeStatus(
  memory: NonNullable<MonoAgentConfig["memory"]>,
): Promise<string | undefined> {
  let database: { close(): void; indexMetadata(): unknown } | undefined;
  let managedGeneration = false;
  try {
    const { openMemoryDb } = await import("@mono-agent/memory/store");
    const manifestPath = join(memory.path, ".index", "manifest.json");
    if (await pathExists(manifestPath)) {
      managedGeneration = true;
      const { resolveActiveMemoryDbPath } = await import("@mono-agent/memory/bujo");
      database = openMemoryDb({ path: resolveActiveMemoryDbPath(memory.path), readOnly: true });
    } else {
      // Lite roots may not exist yet and validation must remain read-only. An
      // in-memory open exercises the exact native ABI + extension load without
      // scanning durable memory or creating the configured root.
      database = openMemoryDb({ path: ":memory:" });
    }
    // A single schema-row lookup proves the opened handle can actually read
    // SQLite state (constructor-only opens can accept a truncated file). This
    // remains constant-work and avoids the corpus/queue scans of strict audit.
    database.indexMetadata();
    database.close();
    database = undefined;
    return undefined;
  } catch (error) {
    if (isBuiltInMemoryNativeFailure(error)) {
      return "[ERROR] Built-in memory native module is unavailable for this Node runtime. Rebuild dependencies with the launch runtime, then re-run `mono-agent validate`.";
    }
    if (managedGeneration) {
      return "[ERROR] Built-in memory active generation is unavailable. Stop the agent with `mono-agent stop`, run `mono-agent memory rebuild`, then re-run `mono-agent validate` before restarting.";
    }
    return "[ERROR] Built-in memory database smoke check failed. Rebuild dependencies with the launch runtime; if the runtime is compatible, stop the agent and run `mono-agent memory rebuild`, then re-run `mono-agent validate`.";
  } finally {
    try { database?.close(); } catch { /* best-effort smoke cleanup */ }
  }
}

function isBuiltInMemoryNativeFailure(error: unknown): boolean {
  try {
    const message = error instanceof Error ? error.message : "";
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code ?? "")
      : "";
    return /(?:err_(?:dlopen|module_not_found)|module_not_found|better[-_ ]?sqlite|sqlite[-_ ]?vec|node_module_version|native module|dlopen|\.node\b)/iu
      .test(`${code} ${message}`);
  } catch {
    return false;
  }
}

async function liteRootWritableWarning(memoryPath: string, allowFilesystemWrites: boolean): Promise<string[]> {
  return await memoryRootWritableWarnings("lite", memoryPath, allowFilesystemWrites);
}

const BUJO_PROBE_TIMEOUT_MS = 3_000;

/** Probes Ollama /api/tags and returns a sorted list of model names, or throws. */
async function fetchOllamaModels(endpoint: string): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, BUJO_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { models?: { name?: unknown }[] };
    return (data.models ?? []).flatMap((m) => (typeof m.name === "string" ? [m.name] : []));
  } finally {
    clearTimeout(timer);
  }
}

async function memoryLivenessWarnings(
  memory: NonNullable<MonoAgentConfig["memory"]>,
  liveness: boolean,
  allowFilesystemWrites: boolean,
): Promise<string[]> {
  const warns: string[] = [];
  const mode = memory.mode;
  const embeddingsUsesOllama = (memory.embeddings?.provider ?? "ollama") === "ollama";
  const llmUsesOllama = memory.llm?.provider === "ollama";
  const ollamaModelsByEndpoint = new Map<string, string[] | undefined>();

  // 1. Memory root writable (every embedded tier) — local I/O, always checked.
  const rootWarns = await memoryRootWritableWarnings(mode, memory.path, allowFilesystemWrites);
  warns.push(...rootWarns);

  // Network-dependent probes below only ever produce `waiting`, so the start
  // preflight skips them (liveness=false) without changing the pass/fail verdict.
  if (!liveness) {
    return warns;
  }

  async function modelsForOllamaEndpoint(endpoint: string): Promise<string[] | undefined> {
    const normalizedEndpoint = endpoint.replace(/\/$/u, "");
    if (ollamaModelsByEndpoint.has(normalizedEndpoint)) {
      return ollamaModelsByEndpoint.get(normalizedEndpoint);
    }
    try {
      const models = await fetchOllamaModels(normalizedEndpoint);
      ollamaModelsByEndpoint.set(normalizedEndpoint, models);
      return models;
    } catch (err) {
      ollamaModelsByEndpoint.set(normalizedEndpoint, undefined);
      warns.push(
        `[WARN] Ollama not reachable at ${normalizedEndpoint}; ${mode} memory components configured for that endpoint will fail at runtime (${err instanceof Error ? err.message : String(err)}). Start Ollama or fix the endpoint.`,
      );
      return undefined;
    }
  }

  // 2. Ollama liveness — only probe components that actually use Ollama. OpenAI embeddings and
  // agent-host chat LLMs have no local model list to validate here.
  if (embeddingsUsesOllama) {
    const endpoint = memory.embeddings?.endpoint ?? "http://localhost:11434";
    const ollamaModels = await modelsForOllamaEndpoint(endpoint);
    if (ollamaModels !== undefined) {
      const embeddingsModel = memory.embeddings?.model ?? "nomic-embed-text:v1.5";
      if (!ollamaModels.includes(embeddingsModel)) {
        warns.push(`[WARN] Embeddings model ${embeddingsModel} not pulled — run \`ollama pull ${embeddingsModel}\`.`);
      }
    }
  }
  if (llmUsesOllama && memory.llm !== undefined) {
    const endpoint = memory.llm.endpoint ?? "http://localhost:11434";
    const ollamaModels = await modelsForOllamaEndpoint(endpoint);
    if (ollamaModels !== undefined) {
      const chatModel = memory.llm.model;
      if (!ollamaModels.includes(chatModel)) {
        warns.push(`[WARN] Chat LLM model ${chatModel} not pulled — run \`ollama pull ${chatModel}\`.`);
      }
    }
  }

  return warns;
}

async function memoryRootWritableWarnings(
  mode: string,
  memoryPath: string,
  allowFilesystemWrites: boolean,
): Promise<string[]> {
  if (allowFilesystemWrites) {
    try {
      await mkdir(memoryPath, { recursive: true });
      return [];
    } catch (err) {
      return [
        `[WARN] ${mode} memory root is not writable: ${memoryPath} (${err instanceof Error ? err.message : String(err)}). Fix filesystem permissions.`,
      ];
    }
  }

  try {
    const info = await stat(memoryPath);
    if (!info.isDirectory()) {
      return [`[WARN] ${mode} memory root is not a directory: ${memoryPath}. Fix filesystem permissions.`];
    }
    await access(memoryPath, constants.W_OK);
    return [];
  } catch (err) {
    const code = err !== null && typeof err === "object" && "code" in err ? String(err.code) : undefined;
    if (code === "ENOENT") {
      return [
        `[WARN] ${mode} memory root is missing: ${memoryPath}. Consumer validation is read-only and did not create it.`,
      ];
    }
    return [
      `[WARN] ${mode} memory root is not writable: ${memoryPath} (${err instanceof Error ? err.message : String(err)}). Fix filesystem permissions.`,
    ];
  }
}

function memoryLlmLabel(llm: NonNullable<MonoAgentConfig["memory"]>["llm"]): string {
  if (llm === undefined) {
    return "none";
  }
  return llm.provider === "ollama"
    ? `ollama:${llm.model}`
    : `agent-host:${llm.model}${llm.executionMode === undefined ? "" : ` (${llm.executionMode})`}`;
}

async function toolsSection(config: MonoAgentConfig, input: ValidateMonoAgentFolderOptions): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  const allowedTools = config.tools.allowedTools;
  const allowAll = isAllowAllTools(allowedTools);
  if (allowAll) {
    // Allow-all (`"*"`): render the policy plainly instead of echoing the raw sentinel
    // as `Allowed tools: *.`. The disallow list (if any) is folded in as the "except"
    // clause here, so the separate `Disallowed tools:` line below is skipped for
    // allow-all to avoid printing it twice. Status stays `ok`; the per-name unknown /
    // MemoryRecall checks do not apply when every tool is allowed.
    details.push(
      config.tools.disallowedTools.length > 0
        ? `All tools allowed (except: ${config.tools.disallowedTools.join(", ")}).`
        : "All tools allowed.",
    );
  } else if (allowedTools.length === 0) {
    // An agent with no tools can chat but can do nothing else — the user's core
    // "no-tools trap". `waiting` (never `error`) surfaces it without failing a
    // deliberately chat-only agent (`report.ok` only checks for `error`).
    status = "waiting";
    details.push(
      "No tools allowed — the agent can chat but cannot read files, run commands, or send proactive messages. " +
        "Add names to tools.allowedTools (e.g. Read, Glob, Grep), or re-run `mono-agent init` in an empty folder to pick tools interactively.",
    );
  } else {
    details.push(`Allowed tools: ${allowedTools.join(", ")}.`);
    let mcpNoteAdded = false;
    for (const name of allowedTools) {
      if (isMcpToolName(name)) {
        // MCP tool names are owned by their servers; we cannot verify them offline.
        if (!mcpNoteAdded) {
          details.push("MCP tool names are provided by their servers and cannot be validated offline.");
          mcpNoteAdded = true;
        }
        continue;
      }
      // Accept both the new `MemoryRecall` and the legacy `memory_recall` alias.
      if (canonicalToolName(name) === "MemoryRecall") {
        // MemoryRecall is auto-provisioned from memory.recallTool.enabled and is NOT
        // allowlist-gated. Listing it is harmless redundancy WHEN recall is on, but a
        // real misconfiguration when it is off (the user expects a recall they won't get).
        if (config.memory?.recallTool?.enabled === true) {
          details.push(
            `${name} in allowedTools has no effect — recall is auto-provisioned by memory.recallTool.enabled (already on). You can remove this entry.`,
          );
        } else {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but memory.recallTool.enabled is off — recall will not work. Enable memory.recallTool (or remove this entry).`,
          );
        }
        continue;
      }
      if (!isKnownToolName(name)) {
        status = "waiting";
        const suggestion = suggestToolName(name);
        details.push(
          `Unknown tool name "${name}"` +
            (suggestion !== undefined ? ` — did you mean ${suggestion}?` : "") +
            " (pi silently drops unknown names).",
        );
      }
    }
  }
  if (!allowAll && config.tools.disallowedTools.length > 0) {
    // Under allow-all the disallow list is already folded into the "except" clause above.
    details.push(`Disallowed tools: ${config.tools.disallowedTools.join(", ")}.`);
  }
  const directCodexModels = configuredRuntimeModels(config.runtime)
    .filter((model) => model.sdk === "codex")
    .map(referenceOf);
  const directOpenCodeModels = configuredRuntimeModels(config.runtime)
    .filter((model) => model.sdk === "opencode")
    .map(referenceOf);
  const claudeCliModels = [
    { model: config.runtime.model, executionMode: config.runtime.executionMode },
    ...configuredRuntimeFallbackModels(config.runtime).map((model) => ({
      model,
      executionMode: defaultExecutionModeForModel(model),
    })),
  ]
    .filter(({ model, executionMode }) => model.sdk === "claude" && executionMode === "cli")
    .map(({ model }) => referenceOf(model));
  const exactAllowAll = hasExactAllowAllToolPolicy(config.tools);
  const dedicatedNoToolsProbe = input.codexNoToolsProbe === true
    && allowedTools.length === 0
    && config.tools.disallowedTools.length === 0;
  if (
    directCodexModels.length > 0
    && !dedicatedNoToolsProbe
    && !exactAllowAll
  ) {
    status = "error";
    details.push(
      `Direct Codex model${directCodexModels.length === 1 ? "" : "s"} ${directCodexModels.join(", ")} cannot enforce ` +
        "tools.allowedTools/tools.disallowedTools. Use exact allow-all (allowedTools: [\"*\"] with no disallowedTools), " +
        "or select a runtime that supports restrictive tool policies.",
    );
  }
  if (directOpenCodeModels.length > 0 && !exactAllowAll) {
    status = "error";
    details.push(
      `Direct OpenCode model${directOpenCodeModels.length === 1 ? "" : "s"} ${directOpenCodeModels.join(", ")} cannot enforce ` +
        "tools.allowedTools/tools.disallowedTools. Use exact allow-all (allowedTools: [\"*\"] with no disallowedTools), " +
        "or use a Pi runtime (including pi:opencode-go:*).",
    );
  }
  if (claudeCliModels.length > 0 && allowedTools.length === 0) {
    status = "error";
    details.push(
      `Claude CLI model${claudeCliModels.length === 1 ? "" : "s"} ${claudeCliModels.join(", ")} cannot enforce an empty ` +
        "tools.allowedTools list because omitting --tools enables Claude Code's default tool set. Use Claude SDK for a chat-only agent, or configure a non-empty enforceable tool list.",
    );
  }
  let configuredMcpServerNames: string[] = [];
  let configuredMcpServers: Record<string, unknown> = {};
  if (config.tools.mcpConfigPath !== undefined) {
    if (await pathExists(config.tools.mcpConfigPath)) {
      details.push(`MCP config: ${config.tools.mcpConfigPath}`);
      try {
        const policy = await loadToolPolicyFromJsonFile(config.tools.mcpConfigPath);
        configuredMcpServers = policy.mcpServers ?? {};
        configuredMcpServerNames = Object.keys(configuredMcpServers);
      } catch {
        status = "error";
        details.push(`MCP config is malformed or unreadable: ${config.tools.mcpConfigPath}`);
      }
    } else {
      status = "error";
      details.push(`MCP config file is missing: ${config.tools.mcpConfigPath}`);
    }
  }
  for (const serverName of config.tools.mcpRequestContextServers ?? []) {
    const spec = configuredMcpServers[serverName];
    if (spec === undefined) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers names unknown MCP server "${serverName}"; declare it in tools.mcpConfigPath.`,
      );
      continue;
    }
    if (!isStdioMcpSpec(spec)) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers entry "${serverName}" must reference a stdio MCP server (command/type:stdio), not HTTP/SSE.`,
      );
    }
  }
  const adapterSendTools = await resolveAdapterSendToolsSettings(input, {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
    suppressInteractionTools: directOpenCodeModels.length > 0,
  });
  if (adapterSendTools === undefined) {
    details.push("No adapter-derived send tools enabled.");
  } else {
    details.push(`Adapter send tools: ${adapterSendToolNames(adapterSendTools).join(", ")}.`);
  }
  const blockedAdapterEndpoints = await adapterSendToolNetworkPolicyWarnings(
    config,
    input,
    adapterSendTools,
    directOpenCodeModels.length > 0,
  );
  if (blockedAdapterEndpoints.length > 0) {
    if (status !== "error") {
      status = "waiting";
    }
    details.push(...blockedAdapterEndpoints);
  }
  const effectiveMcpSources = effectiveMcpRuntimeSources(
    config,
    configuredMcpServerNames,
    adapterSendTools === undefined ? [] : adapterSendToolNames(adapterSendTools),
  );
  if (directOpenCodeModels.length > 0 && effectiveMcpSources.length > 0) {
    status = "error";
    details.push(
      `Direct OpenCode model${directOpenCodeModels.length === 1 ? "" : "s"} ${directOpenCodeModels.join(", ")} cannot safely consume ` +
        `MCP runtime options from ${effectiveMcpSources.join("; ")}. Disable those MCP sources or use a Pi runtime (including pi:opencode-go:*).`,
    );
  }

  return { id: "tools", label: "Tools & MCP", status, details };
}

function isStdioMcpSpec(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;
  return spec.type === "stdio"
    || (typeof spec.command === "string" && spec.type !== "http" && spec.type !== "sse");
}

interface AdapterEndpointRequirement {
  readonly label: string;
  readonly tools: readonly string[];
  readonly url: string;
}

/**
 * Adapter-send tools run in a stdio MCP child governed by the native SRT
 * policy. Channel readiness alone therefore is not enough: the child also
 * needs the remote adapter API (or the app-owned interaction bridge) admitted
 * by sandbox.network.
 */
async function adapterSendToolNetworkPolicyWarnings(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
  settings: Awaited<ReturnType<typeof resolveAdapterSendToolsSettings>>,
  suppressInteractionTools: boolean,
): Promise<readonly string[]> {
  if (config.sandbox === undefined || config.sandbox.mode !== "native") {
    return [];
  }

  const toolNames = settings === undefined ? [] : adapterSendToolNames(settings);
  const requirements: AdapterEndpointRequirement[] = [];
  if (settings?.slack !== undefined) {
    requirements.push({
      label: "Slack adapter-send API",
      tools: ["SlackSendMessage"],
      url: "https://slack.com/api",
    });
  }
  if (settings?.telegram !== undefined) {
    requirements.push({
      label: "Telegram adapter-send API",
      tools: toolNames.filter((name) => name.startsWith("Telegram")),
      url: settings.telegram.apiRoot ?? "https://api.telegram.org",
    });
  }

  const askUserAllowed = !suppressInteractionTools && isAdapterSendToolAllowed("AskUser", {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
  });
  const bridgeTools = [
    ...(askUserAllowed ? ["AskUser"] : []),
    ...(toolNames.includes("TelegramAskButtons") ? ["TelegramAskButtons"] : []),
  ];
  if (bridgeTools.length > 0) {
    const configuredBridgeUrl = input.env.MONO_AGENT_INTERACTION_BRIDGE_URL?.trim();
    const interaction = await loadInteractionSettings(input);
    const bridgeUrl = configuredBridgeUrl === undefined || configuredBridgeUrl.length === 0
      ? formatInteractionBridgeUrl(interaction.host, interaction.port)
      : configuredBridgeUrl;
    requirements.push({ label: "AskUser interaction bridge", tools: bridgeTools, url: bridgeUrl });
  }

  return requirements.flatMap((requirement) => {
    if (adapterSendChildNetworkAllowsUrl(config, requirement.url)) {
      return [];
    }
    const host = endpointHost(requirement.url);
    const allowlistHost = host === "::1" ? "localhost" : host;
    return [
      `Native sandbox network policy blocks ${requirement.label} host "${host}", required by ${requirement.tools.join(", ")}. ` +
        `Set sandbox.network.mode to "allowlist" and add "${allowlistHost}" to sandbox.network.allowlist, ` +
        `or disable ${requirement.tools.join(", ")}.`,
    ];
  });
}

function adapterSendChildNetworkAllowsUrl(config: MonoAgentConfig, url: string): boolean {
  if (networkPolicyAllowsUrl(config.sandbox, url)) return true;
  if (config.sandbox?.mode !== "native" || config.sandbox.network.mode !== "allowlist") return false;
  const host = endpointHost(url);
  return isLoopbackEndpointHost(host) && config.sandbox.network.allowlist.some(isLoopbackEndpointHost);
}

function isLoopbackEndpointHost(host: string): boolean {
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.split(".")[0] === "127");
}

function endpointHost(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return url;
  }
}

function effectiveMcpRuntimeSources(
  config: MonoAgentConfig,
  configuredMcpServerNames: readonly string[],
  adapterToolNames: readonly string[],
): string[] {
  const sources: string[] = [];
  if (configuredMcpServerNames.length > 0) {
    sources.push(`tools.mcpConfigPath (${configuredMcpServerNames.join(", ")})`);
  }
  if (config.memory?.recallTool?.enabled === true) {
    sources.push("memory.recallTool");
  }
  if (
    config.memory?.backend === "supermemory"
    && config.memory.supermemory?.exposeMcpServer === true
    && config.memory.supermemory.apiKey !== undefined
  ) {
    sources.push("memory.supermemory.exposeMcpServer");
  }
  if (adapterToolNames.length > 0) {
    sources.push(`adapter send tools (${adapterToolNames.join(", ")})`);
  }
  return sources;
}

async function sandboxSection(config: MonoAgentConfig, engine?: SandboxEngine): Promise<ValidationSection> {
  const runtimeModels = configuredRuntimeModels(config.runtime);
  const directCodexRefs = runtimeModels
    .filter((model) => model.sdk === "codex")
    .map((model) => model.reference ?? `codex:${model.model}`);
  const claudeRefs = runtimeModels
    .filter((model) => model.sdk === "claude")
    .map((model) => model.reference ?? `claude:${model.model}`);
  const directOpenCodeRefs = runtimeModels
    .filter((model) => model.sdk === "opencode")
    .map((model) => model.reference ?? `opencode:${model.provider ?? "unknown"}:${model.model}`);
  const routeSafety = config.runtime.routeSafety ?? "uniform";
  if (routeSafety === "per-route-native") {
    const monoSandboxActive = config.sandbox !== undefined && config.sandbox.mode !== "off";
    const piRoutes = runtimeModels.filter((model) => model.sdk === "pi");
    const details = runtimeModels.map((model, index) => routeNativeSafetyDetail(model, index, config));
    let status: ValidationStatus = !monoSandboxActive && piRoutes.length > 0 ? "disabled" : "ok";
    if (monoSandboxActive && piRoutes.length > 0) {
      const state = await resolveSandboxEffectiveState({
        policy: config.sandbox!,
        ...(engine === undefined ? {} : { engine }),
      });
      const warning = sandboxEffectiveStateWarning(state);
      details.push(
        `Pi route SRT policy: mode ${config.sandbox!.mode}, network ${config.sandbox!.network.mode}, fallback ${config.sandbox!.fallback}.`,
        describeSandboxEffectiveState(state),
        ...(warning === undefined ? [] : [warning]),
      );
      if (warning !== undefined || state.effective === "blocked") status = "waiting";
    } else if (piRoutes.length > 0) {
      details.push(
        "Pi route SRT policy: disabled; Bash and stdio MCP subprocesses run unsandboxed.",
      );
    } else if (monoSandboxActive) {
      details.push(
        "The configured mono-agent SRT policy has no Pi route to enforce it; provider-owned route contracts below apply instead.",
      );
      status = "waiting";
    }
    if (monoSandboxActive && runtimeModels.some((model) => model.sdk !== "pi")) {
      details.push(
        "[WARN] Per-route-native explicitly does not project mono-agent readableRoots, writableRoots, denyWrite, or network rules onto non-Pi routes; review each route contract before start.",
      );
      status = "waiting";
    }
    if (runtimeModels.some((model) => model.sdk === "codex") && config.runtime.permissionMode === "bypassPermissions") {
      status = "waiting";
    }
    return { id: "sandbox", label: "Sandbox", status, details };
  }
  const incompatibleDetails: string[] = [];
  if (config.sandbox !== undefined && config.sandbox.mode !== "off" && directCodexRefs.length > 0) {
    const codexPosture = directCodexSandboxPosture(config.runtime.permissionMode);
    incompatibleDetails.push(
      `Native mono-agent sandbox policy cannot govern direct Codex runtime${directCodexRefs.length === 1 ? "" : "s"}: ${directCodexRefs.join(", ")}.`,
      `${codexPosture.detail} Remove the mono-agent sandbox block or use Pi when exact srt roots, denyWrite, or network policy are required.`,
    );
  }
  if (config.sandbox !== undefined && config.sandbox.mode !== "off" && claudeRefs.length > 0) {
    incompatibleDetails.push(
      `Native mono-agent sandbox policy cannot govern Claude runtime${claudeRefs.length === 1 ? "" : "s"}: ${claudeRefs.join(", ")}.`,
      "Claude's provider-owned tool loop does not consume mono-agent sandboxPolicy. Set sandbox.mode to off, remove the sandbox block, or use a Pi runtime when mono-agent srt enforcement is required.",
    );
  }
  if (config.sandbox !== undefined && config.sandbox.mode !== "off" && directOpenCodeRefs.length > 0) {
    incompatibleDetails.push(
      `Native mono-agent sandbox policy cannot govern direct OpenCode runtime${directOpenCodeRefs.length === 1 ? "" : "s"}: ${directOpenCodeRefs.join(", ")}.`,
      "Direct OpenCode's provider-owned tool loop does not consume mono-agent sandboxPolicy. Set sandbox.mode to off, remove the sandbox block, or use a pi:opencode-go:* runtime when mono-agent srt enforcement is required.",
    );
  }
  if (incompatibleDetails.length > 0) {
    return {
      id: "sandbox",
      label: "Sandbox",
      status: "error",
      details: incompatibleDetails,
    };
  }
  if (directCodexRefs.length > 0 && (config.sandbox === undefined || config.sandbox.mode === "off")) {
    const posture = directCodexSandboxPosture(config.runtime.permissionMode);
    return {
      id: "sandbox",
      label: "Sandbox",
      status: posture.status,
      details: [
        posture.detail,
        config.sandbox === undefined
          ? "No mono-agent native srt policy is configured."
          : "The mono-agent native srt policy is explicitly off; the Codex-native posture still applies.",
      ],
    };
  }
  if (config.sandbox === undefined) {
    return { id: "sandbox", label: "Sandbox", status: "disabled", details: ["No sandbox policy configured."] };
  }
  const state = await resolveSandboxEffectiveState({
    policy: config.sandbox,
    ...(engine === undefined ? {} : { engine }),
  });
  const warning = sandboxEffectiveStateWarning(state);
  const details = [
    `Mode: ${config.sandbox.mode}, network: ${config.sandbox.network.mode}, fallback: ${config.sandbox.fallback}.`,
    describeSandboxEffectiveState(state),
    ...(warning === undefined ? [] : [warning]),
  ];
  const status: ValidationStatus = warning !== undefined
    ? "waiting"
    : state.effective === "off"
      ? "disabled"
      : state.effective === "blocked"
        ? "waiting"
      : "ok";
  return {
    id: "sandbox",
    label: "Sandbox",
    status,
    details,
  };
}

function routeNativeSafetyDetail(
  model: RuntimeModelReference,
  index: number,
  config: MonoAgentConfig,
): string {
  const label = index === 0 ? "Primary" : `Fallback ${index}`;
  const ref = referenceOf(model);
  if (model.sdk === "pi") {
    if (config.sandbox === undefined || config.sandbox.mode === "off") {
      return `${label} ${ref}: Pi-owned tools use mono-agent tool policy; SRT is disabled, so Bash and stdio MCP subprocesses run unsandboxed.`;
    }
    if (config.sandbox.fallback === "unsafe-host-process") {
      return `${label} ${ref}: Pi-owned tools use the configured mono-agent SRT policy; its explicit unsafe-host-process fallback can run subprocesses unsandboxed when SRT is unavailable.`;
    }
    return `${label} ${ref}: Pi-owned tools use the configured mono-agent SRT policy and fail closed when it is unavailable.`;
  }
  if (model.sdk === "claude") {
    return `${label} ${ref}: Claude provider-owned permissions apply; mono-agent SRT filesystem/network rules are not projected.`;
  }
  if (model.sdk === "codex") {
    return `${label} ${ref}: ${directCodexSandboxPosture(config.runtime.permissionMode).detail}`;
  }
  return `${label} ${ref}: OpenCode provider-owned execution with exact allow-all tool policy applies; mono-agent SRT rules are not projected.`;
}

function directCodexSandboxPosture(permissionMode: MonoAgentConfig["runtime"]["permissionMode"]): {
  readonly status: ValidationStatus;
  readonly detail: string;
} {
  if (permissionMode === "bypassPermissions") {
    return {
      status: "waiting",
      detail: "[WARN] Direct Codex bypassPermissions uses native danger-full-access with no filesystem or network sandbox; unattended approval prompts are still disabled.",
    };
  }
  if (permissionMode === "plan") {
    return {
      status: "ok",
      detail: "Direct Codex plan mode uses its native read-only sandbox with network disabled; unattended escalation requests are denied.",
    };
  }
  return {
    status: "ok",
    detail: "Direct Codex default/acceptEdits mode uses its native workspace-write sandbox with network disabled; unattended escalation requests are denied.",
  };
}


async function runsSection(input: MonoAgentAppConfigInput, config: MonoAgentConfig | undefined): Promise<ValidationSection> {
  const artifactDir = await resolveAppArtifactDir(input);
  const { totalRuns, runs, warnings } = await listRecordedRuns({ artifactDir, maxRuns: RUNS_HEALTH_MAX_RUNS, scope: "agent" });
  const display = buildRunsHealthDisplay({ artifactDir, totalRuns, runs, warnings });
  const retentionDetails = config === undefined
    ? []
    : [
        `Artifact retention: maxAgeDays=${config.artifacts.retention.maxAgeDays}, maxCount=${config.artifacts.retention.maxCount}, dryRun=${config.artifacts.retention.dryRun ? "true" : "false"}.`,
        `Memory artifact retention: maxAgeDays=${config.artifacts.memoryRetention.maxAgeDays}, maxCount=${config.artifacts.memoryRetention.maxCount}, dryRun=${config.artifacts.memoryRetention.dryRun ? "true" : "false"}.`,
      ];
  return { id: "runs", label: "Runs health", status: display.status, details: [...retentionDetails, ...display.details] };
}

const LOCAL_ARTIFACTS_NOTE = "JSONL artifacts remain local (the exporter is additive; export failures never affect them).";

/**
 * Reports observability exporter state and, uniquely among the validation
 * sections, performs a LIVE reachability probe of the Phoenix endpoint. An
 * invalid exporter shape is a hard `error` (fails the report) so bad config is
 * caught before startup, but an unreachable endpoint is only `waiting` — Phoenix
 * may start after the agent, mirroring the Ollama-unreachable precedent so
 * `validate` still passes. Probe failures are swallowed into a warning.
 */
async function exporterSection(input: MonoAgentAppConfigInput, liveness: boolean): Promise<ValidationSection> {
  let exporters;
  try {
    exporters = await resolveAppObservabilityExporters(input);
  } catch (error) {
    if (!isAppCoreConfigError(error)) {
      throw error;
    }
    return { id: "observability", label: "Observability exporter", status: "error", details: [error.message] };
  }

  if (exporters.length === 0) {
    return {
      id: "observability",
      label: "Observability exporter",
      status: "disabled",
      details: ["No observability exporter configured."],
    };
  }

  const exporter = exporters[0]!;
  const details: string[] = [`Exporter: ${exporter.type} -> ${exporter.endpoint}`];
  const appUrl = phoenixAppBaseUrl(exporter.endpoint);
  if (appUrl !== undefined) {
    details.push(`Phoenix app: ${appUrl}`);
  }
  if (exporter.includeSensitiveData) {
    details.push(describeSensitiveDataExportWarning(exporter.endpoint));
  }

  // The reachability probe only ever yields `waiting`, so the start preflight
  // skips it (liveness=false): the exporter shape is valid, and Phoenix may
  // legitimately come up after the agent.
  if (!liveness) {
    details.push(LOCAL_ARTIFACTS_NOTE);
    return { id: "observability", label: "Observability exporter", status: "ok", details };
  }

  const probeError = await probeExporterEndpoint(exporter.endpoint);
  if (probeError !== undefined) {
    details.push(
      `[WARN] Phoenix export not confirmed at ${exporter.endpoint} (${probeError}); exports will fail until it accepts OTLP protobuf. This is non-fatal.`,
    );
    details.push(LOCAL_ARTIFACTS_NOTE);
    return { id: "observability", label: "Observability exporter", status: "waiting", details };
  }

  details.push(LOCAL_ARTIFACTS_NOTE);
  return { id: "observability", label: "Observability exporter", status: "ok", details };
}

/**
 * Live export-compatibility probe: POSTs a tiny but VALID empty OTLP protobuf
 * `ExportTraceServiceRequest` (zero spans, so nothing is recorded) with
 * `content-type: application/x-protobuf` — exactly the wire format a real export
 * uses. Returns undefined when the endpoint accepts it (2xx), else an error
 * string. This catches what the old OPTIONS reachability probe missed: a server
 * that is listening but rejects the export (e.g. Phoenix returns 415 for the
 * wrong content type), so `validate` no longer reports `[ok]` for an endpoint
 * that every real export would 415. A throw (refused / DNS / timeout) means
 * nothing is listening. Kept non-fatal upstream (`waiting`, not `error`): Phoenix
 * may start after the agent.
 */
async function probeExporterEndpoint(endpoint: string): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, BUJO_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: serializeTraceSpans([]),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      return `HTTP ${response.status}`;
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
}

async function channelSection(
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

function referenceOf(model: RuntimeModelReference): string {
  return modelReferenceKey(model);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
