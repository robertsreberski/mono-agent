import { inspectWebControl } from "./web-request-coordinator.js";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

// `BuiltinProvider`, not the root `KnownProvider`: since pi-ai 0.83.0 the
// latter also covers purely dynamic providers (e.g. "radius") that have no
// generated catalog entry, so it no longer keys `getBuiltinModels`. This guard
// is built from `getBuiltinProviders()`, which is exactly the catalog set.
import {
  type BuiltinProvider as PiBuiltinProvider,
  getBuiltinModels as getPiBuiltinModels,
  getBuiltinProviders as getPiBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { validateCronExpression } from "@mono-agent/cron-adapter";
import {
  classifyContinuationMcpServerTransport,
  isStdioMcpServerSpec,
  loadToolPolicyFromJsonFile,
} from "@mono-agent/agent-harness";
import {
  describeMonoRuntimeSupport,
  inspectCodexSubscriptionSearch,
  isValidMcpServerName,
  modelReferenceKey,
  networkPolicyAllowsUrl,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";
import {
  buildMonoAgentConfigView,
  EFFORT_LEVELS,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
  resolveSupermemoryContainer,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  describeSandboxEffectiveState,
  MODEL_REFERENCE_ECHO_MAX_BYTES,
  MODEL_REFERENCE_REASON_MAX_BYTES,
  resolveSandboxEffectiveState,
  RuntimeAdapterError,
  sandboxEffectiveStateWarning,
  sanitizeModelReferenceText,
} from "@mono-agent/runtime-adapter";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
} from "./app-config.js";
import { isRememberToolAllowed, isRememberToolPolicyName } from "./memory-remember.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import { adapterSendToolNames, isAdapterSendToolAllowed, resolveAdapterSendToolsSettings } from "./adapter-send-tools.js";
import { canonicalToolName, isAllowAllTools, isKnownToolName, isMcpToolName, suggestToolName } from "./modules/known-tools.js";
import { collectChannelConfigViews } from "./channel-config-view.js";
import { resolveChannelDrivers } from "./channels.js";
import type { ChannelDriver } from "./channels.js";
import { loadContinuationSettings } from "./continuation-config.js";
import { applyOriginContextGroupCommit } from "./continuation-origin-store.js";
import { readBoundedOwnerOnlyFile } from "./continuation-store-fs.js";
import { loadLegacyStore, mergeMigrationRecords } from "./continuation-store-records.js";
import {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
} from "./continuation-store.js";
import {
  applyRetention,
  isDurableGeneration,
  isOriginContextGroupCommit,
  isRecord,
  isRecordTransaction,
  isStoreFile,
  normalizeLegacyContinuationRecords,
  requiredDate,
  resolveRetention,
} from "./continuation-store-policy.js";
import {
  MAX_LEGACY_STORE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RECORD_BYTES,
  MAX_TRANSACTION_BYTES,
  type ContinuationRecordTransaction,
  type ContinuationRetentionOptions,
  type DurableContinuationRecord,
} from "./continuation-store-types.js";
import { CONTINUATION_STATES, continuationDigest, type ContinuationState } from "./continuations.js";
import { isProcessJobState, PROCESS_JOB_STATES } from "@mono-agent/agent-contracts";
import { loadProcessJobsSettings } from "./process-jobs-config.js";
import {
  attestProcessJobsRootRegistrySnapshot,
  failedProcessJobsRootRegistryProtection,
  loadProcessJobsRootRegistryProtection,
} from "./process-jobs-root-registry.js";
import {
  resolveProcessJobsProtectionPosture,
  type ProcessJobsProtectionPosture,
} from "./process-jobs-protection.js";
import {
  MAX_PROCESS_JOB_HEALTH_BYTES,
  PROCESS_JOB_HEALTH_FILE,
  PROCESS_JOB_QUARANTINE_DIRECTORY,
  PROCESS_JOB_RECORDS_DIRECTORY,
  PROCESS_JOB_SECRET_FILE,
} from "./process-jobs-store.js";
import { formatInteractionBridgeUrl, loadInteractionSettings } from "./interaction-bridge.js";
import { FIRST_RUN_MEMORY_INITIALIZING_MARKER } from "./first-run-managed-memory.js";
import {
  DEFAULT_MEMORY_EMBEDDING_ENDPOINTS,
  probeMemoryEmbeddingSelection,
} from "./memory-embedding-service.js";
import { piAuthRecoveryCommand } from "./provider-setup.js";
import { inspectPiAuthStore, type PiAuthStoreInspection, type PiAuthStoreUnsafeReason } from "./pi-auth-store-inspection.js";
import { checkManagedProjectSkills, managedProjectSkillsExist } from "./project-skills.js";
import { runtimeProvenanceDetail } from "./runtime-provenance.js";
import { resolveAdvertisedModelEffort } from "./model-effort-capabilities.js";
import { loadSupermemoryPlugin } from "./supermemory-plugin.js";
import {
  DEFAULT_LAUNCHD_LOG_POLICY,
  inspectLaunchdLogs,
  LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS,
  launchdLogPathsForConfig,
} from "./launchd-logs.js";
import type { LaunchdLogInspection, LaunchdLogStreamInspection } from "./launchd-logs.js";
import { readLaunchdLogMonitorStatus } from "./launchd-log-monitor-status.js";
import type { ManagedLaunchdLogMonitorStatus } from "./background-log-maintenance.js";
import { exporterSection, runsSection } from "./doctor-observability.js";
import { sessionToolHistorySection } from "./doctor-session-history.js";
import type { ValidationReport, ValidationSection, ValidationStatus } from "./doctor-types.js";

export type { ValidationReport, ValidationSection, ValidationStatus } from "./doctor-types.js";

const execFile = promisify(execFileCallback);

const CONTINUATION_V2_ROLLBACK_GUARD = "UPGRADED-TO-RECORDS-V3";
const CONTINUATION_V2_ROLLBACK_GUARD_CONTENT =
  "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n";

export interface DoctorStatusExecOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly encoding: "utf8";
}

export interface DoctorStatusExecResult {
  readonly stdout: string;
}

/** Injectable process seam for bounded, read-only local tool version checks. */
export type DoctorStatusExecFile = (
  file: string,
  args: readonly string[],
  options: DoctorStatusExecOptions,
) => Promise<DoctorStatusExecResult>;

const DOCTOR_STATUS_TIMEOUT_MS = 5_000;
const DOCTOR_STATUS_MAX_BUFFER_BYTES = 64 * 1024;

const defaultDoctorStatusExecFile: DoctorStatusExecFile = async (file, args, options) => {
  const { stdout } = await execFile(file, [...args], options);
  return { stdout };
};

export type CodexWebSearchProbe = (options: {
  readonly model: string;
}) => Promise<{ readonly ok: boolean; readonly reason: string; readonly model: string }>;

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
   * When false, skip live probes (Ollama and Supermemory reachability, the
   * Phoenix export probe, and local tool version checks) and validate
   * only structure/shape. Those probes can only ever downgrade a section to
   * `waiting`, never `error`, so skipping them leaves the pass/fail verdict
   * (`ok`) unchanged — the start preflight relies on this. Defaults to true.
   */
  readonly liveness?: boolean;
  /** Model refs whose credentials were proven by a successful live turn. */
  readonly verifiedCredentialModelRefs?: readonly string[];
  /** Injectable subprocess seam for deterministic local tool version checks. */
  readonly statusExecFile?: DoctorStatusExecFile;
  /** Injectable ChatGPT-subscription Codex search readiness probe. */
  readonly codexWebSearchProbe?: CodexWebSearchProbe;
  /** Managed workers resolve optional plugins only from their attested app closure. */
  readonly preferAppPluginInstall?: boolean;
  /**
   * Internal managed-worker fast path. The launch verifier has already bound
   * this informational detail to the exact private runtime marker, so doctor
   * must not repeat the full dependency-tree provenance traversal.
   */
  readonly verifiedRuntimeProvenanceDetail?: string;
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

  sections.push(await runtimeProvenanceSection(options.verifiedRuntimeProvenanceDetail));

  if (coreConfig !== undefined) {
    const staticTriggerCredentialRefs = await collectStaticTriggerCredentialRefs(drivers, options);
    const jsonResult = await readMonoAgentConfigJson(options.configPath);
    // Channel secrets (bot tokens, API keys) live outside the core view, so the
    // placement check spans both: core sections + every channel's config view.
    const configWarnings = [
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
      options.preferAppPluginInstall === true,
    ));
    sections.push(await toolsSection(coreConfig, options));
    sections.push(await sessionToolHistorySection({
      historyRoot: join(coreConfig.artifacts.dir, "..", "history"),
      requestScopedToolSupported: true,
    }));
    sections.push(await webToolsSection(coreConfig, options, liveness));
    sections.push(await continuationSection(coreConfig, options));
    sections.push(await processJobsSection(coreConfig, options));
    sections.push(await sandboxSection(coreConfig, options.sandboxEngine));
  }

  sections.push(await exporterSection(options, liveness));
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

/** Read-only launchd log inventory used by both `validate` and its `doctor` alias. */
export async function launchdLogsSection(configPath: string): Promise<ValidationSection> {
  let inspection: LaunchdLogInspection;
  let monitorStatus: ManagedLaunchdLogMonitorStatus | "unavailable" | undefined;
  try {
    const paths = await launchdLogPathsForConfig(configPath);
    inspection = await inspectLaunchdLogs(paths);
    const stdoutName = basename(paths.stdoutPath);
    const mainLabel = stdoutName.endsWith(".out.log")
      ? stdoutName.slice(0, -".out.log".length)
      : "";
    try {
      monitorStatus = await readLaunchdLogMonitorStatus(mainLabel, paths);
    } catch {
      monitorStatus = "unavailable";
    }
  } catch {
    return {
      id: "launchd-logs",
      label: "Launchd logs",
      status: "waiting",
      details: ["[WARN] Managed launchd log metadata could not be inspected safely."],
    };
  }

  return launchdLogsSectionFromInspection(inspection, monitorStatus);
}

/** Pure renderer kept separate so exact byte accounting is deterministic in tests. */
export function launchdLogsSectionFromInspection(
  inspection: LaunchdLogInspection,
  monitorStatus?: ManagedLaunchdLogMonitorStatus | "unavailable",
): ValidationSection {
  const policy = DEFAULT_LAUNCHD_LOG_POLICY;
  const details = [
    `Policy: ${policy.maxBytes} bytes per file, ${policy.rotationCount} retained generations, checked every ${LAUNCHD_LOG_MONITOR_INTERVAL_SECONDS} seconds.`,
    streamSizeDetail("stdout", inspection.stdout),
    streamSizeDetail("stderr", inspection.stderr),
    ...monitorStatusDetails(monitorStatus),
    ...inspection.issues.map((issue) => `[WARN] ${issue}.`),
    ...oversizedLogDetails("stdout", inspection.stdout, policy.maxBytes),
    ...oversizedLogDetails("stderr", inspection.stderr, policy.maxBytes),
  ];
  if (!inspection.present && inspection.issues.length === 0) {
    return {
      id: "launchd-logs",
      label: "Launchd logs",
      status: "disabled",
      details: [...details, "No managed launchd log files exist yet."],
    };
  }
  return {
    id: "launchd-logs",
    label: "Launchd logs",
    status: inspection.canMaintain && !inspection.needsMaintenance ? "ok" : "waiting",
    details,
  };
}

function monitorStatusDetails(
  status: ManagedLaunchdLogMonitorStatus | "unavailable" | undefined,
): string[] {
  if (status === "unavailable") {
    return ["Monitor: owner-private status is unavailable or unsafe."];
  }
  if (status === undefined) return ["Monitor: no observational snapshot has been recorded yet."];
  return [
    `Monitor last inspection: ${status.lastInspectionAt}.`,
    `Monitor wake count: ${status.wakeCount}.`,
    `Monitor last outcome: ${status.lastOutcome}.`,
    `Monitor cooldown deadline: ${status.cooldownDeadline}.`,
  ];
}

function streamSizeDetail(label: string, stream: LaunchdLogStreamInspection): string {
  if (!stream.byteAccountingComplete) {
    return `${label}: byte inventory unavailable because one or more paths could not be inspected safely.`;
  }
  return `${label}: active=${stream.activeBytes} bytes, retained=${stream.retainedBytes} bytes, total=${stream.totalBytes} bytes.`;
}

function oversizedLogDetails(
  label: string,
  stream: LaunchdLogStreamInspection,
  maxBytes: number,
): string[] {
  if (!stream.byteAccountingComplete) return [];
  return stream.files.flatMap((file) => file.bytes <= maxBytes
    ? []
    : [`[WARN] ${label}${file.generation === 0 ? "" : `.${file.generation}`} is ${file.bytes} bytes; maintenance limit is ${maxBytes} bytes.`]);
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

async function runtimeProvenanceSection(verifiedDetail?: string): Promise<ValidationSection> {
  return {
    id: "runtime-provenance",
    label: "Runtime provenance",
    status: "ok",
    details: [verifiedDetail ?? await runtimeProvenanceDetail()],
  };
}

function runtimeSection(config: MonoAgentConfig): ValidationSection {
  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const routes = configuredRuntimeRouteChecks(config);
  for (const route of routes) {
    try {
      const support = describeMonoRuntimeSupport(route.model);
      const resolutionIssue = piModelResolutionIssue(config, route.model);
      const effortWarning = runtimeRouteEffortWarning(config, route);
      if (resolutionIssue === undefined) {
        details.push(
          `${route.label} ${displayReferenceOf(route.model)} runs on ${support.backend.label} ` +
          `(effort: ${route.effort ?? "provider default"}).`,
        );
      } else {
        status = "error";
        details.push(`${route.label} ${displayReferenceOf(route.model)}: ${resolutionIssue}.`);
      }
      if (effortWarning !== undefined) {
        if (status !== "error") status = "waiting";
        details.push(effortWarning);
      }
    } catch (error) {
      status = "error";
      details.push(`${route.label} ${displayReferenceOf(route.model)}: ${displayReason(error)}.`);
    }
  }

  return { id: "runtime", label: "Runtime", status, details };
}

interface ConfiguredRuntimeRouteCheck {
  readonly label: string;
  readonly configPath: string;
  readonly model: RuntimeModelReference;
  readonly effort?: string;
}

function configuredRuntimeRouteChecks(config: MonoAgentConfig): readonly ConfiguredRuntimeRouteCheck[] {
  const primary: ConfiguredRuntimeRouteCheck = {
    label: "Primary model",
    configPath: "runtime.effort",
    model: config.runtime.model,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
  };
  return [
    primary,
    ...(config.runtime.fallbacks ?? []).map((fallback, index) => ({
      label: "Fallback model",
      configPath: `runtime.fallbacks[${index}].effort`,
      model: fallback.model,
      ...(fallback.effort === undefined ? {} : { effort: fallback.effort }),
    })),
  ];
}

function runtimeRouteEffortWarning(
  config: MonoAgentConfig,
  route: ConfiguredRuntimeRouteCheck,
): string | undefined {
  if (route.effort === undefined) return undefined;
  // Always go through the shared resolver. Deriving the ladder from
  // `thinkingLevelMap`'s KEYS treated an override table as the complete
  // supported set: claude-fable-5 maps only {off, xhigh, max}, which yielded
  // [none, xhigh, max] and made a perfectly valid `effort: medium` warn and
  // recommend xhigh. The resolver reports [minimal, low, medium, high, xhigh,
  // max] for that model, and it is the same one the catalog and pickers use --
  // doctor disagreeing with what the selector offers is its own bug.
  const resolved = resolveAdvertisedModelEffort(route.model, {
    ...(config.providers?.local === undefined ? {} : { localProviders: config.providers.local }),
  });
  // A NON-REASONING route has no advertised ladder at all, so the level-list
  // check below returns clean and `effort: high` was reported ready. Keep this
  // ahead of that check: a local model can declare `reasoning_mode: "none"`
  // WITH `reasoning_levels`, and "this route does not reason" is the accurate
  // diagnosis there, not "pick another level".
  if (resolved.reasoning === false && route.effort !== "none") {
    return `[WARN] ${route.configPath}=${route.effort} is unsupported because known model metadata marks ${displayReferenceOf(route.model)} as non-reasoning; use none, or omit it for the provider default. The runtime remains permissive and will forward the configured value.`;
  }
  const advertised = resolved.effortLevels
    ?.filter((level) => (EFFORT_LEVELS as readonly string[]).includes(level));
  if (advertised === undefined || advertised.length === 0 || advertised.includes(route.effort)) return undefined;
  const configuredIndex = EFFORT_LEVELS.indexOf(route.effort as (typeof EFFORT_LEVELS)[number]);
  const nearest = advertised.reduce((best, candidate) => {
    const candidateIndex = EFFORT_LEVELS.indexOf(candidate as (typeof EFFORT_LEVELS)[number]);
    const bestIndex = EFFORT_LEVELS.indexOf(best as (typeof EFFORT_LEVELS)[number]);
    return Math.abs(candidateIndex - configuredIndex) < Math.abs(bestIndex - configuredIndex) ? candidate : best;
  });
  return `[WARN] ${route.configPath}=${route.effort} is outside ${displayReferenceOf(route.model)}'s advertised effort levels (${advertised.join(", ")}); nearest advertised level: ${nearest}. The runtime remains permissive and will forward the configured value.`;
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
  const localProvider = config.providers?.local?.find((provider) => provider.id === model.provider);
  if (localProvider !== undefined) {
    if (localProvider.enabled === false) {
      return `provider \`${displayText(model.provider)}\` is disabled in providers.local`;
    }
    const localModel = localProvider.models?.find(
      (candidate) => candidate.name === model.model || candidate.alias === model.model,
    );
    if (localModel?.enabled === false) {
      return `model \`${displayText(model.model)}\` is disabled in providers.local for provider \`${displayText(model.provider)}\``;
    }
    return undefined;
  }

  if (
    isPiBuiltinProvider(model.provider)
    && getPiBuiltinModels(model.provider).some((candidate) => candidate.id === model.model)
  ) {
    return undefined;
  }

  // This is doctor's own validate-time diagnostic, not the runtime failure
  // string. The one that must stay byte-identical for `NON_RETRYABLE_PROVIDER_RE`
  // is built in agent-runtime's `ai/providers/pi-models.js`; nothing matches
  // against this text. So the reference is bounded here, which matters now that
  // the parser imposes no length ceiling and a legitimately long id reaches this
  // line whole.
  const reference = displayText(`${model.provider}:${model.model}`);
  return (
    `pi model not found: ${reference}; no matching providers.local entry exists and Pi's built-in catalog has no exact model. ` +
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
 * Checks that every referenced model (primary, fallbacks, and the agent-host memory LLM)
 * has discoverable credentials, so a keyless or expired-OAuth provider is caught at
 * `validate` time instead of degrading crons/memory silently at runtime (the failure mode
 * that broke memory capture for ~10 days when an auth-store OAuth token quietly expired.
 *
 * The read-only check inspects the auth store (`piAuthPath`) and the config's own
 *   `providers.local` custom providers. A custom/local provider follows its declared
 *   `apiKey` / `apiKeyEnv` contract instead of Pi OAuth; an OAuth provider absent from
 *   the store, or whose access token has expired, is flagged `waiting` with a re-auth hint.
 *
 * `waiting` (never `error`) keeps the verdict non-fatal, mirroring the Ollama/Phoenix
 * probes — the goal is visibility, not blocking start.
 */
async function credentialsSection(
  config: MonoAgentConfig,
  env: Record<string, string | undefined>,
  verifiedCredentialModelRefs: readonly string[] = [],
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
  if (config.memory?.llm?.provider === "agent-host") {
    try {
      refs.push({ label: "Memory LLM", ref: parseMonoRuntimeModelReference(config.memory.llm.model) });
    } catch {
      // A malformed memory model reference is surfaced by the memory/runtime shape checks.
    }
  }

  const authenticatedRefs = refs;
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
    // The set holds whole canonical references, so the LOOKUP key stays whole;
    // only the printed form is bounded.
    if (verified.has(referenceOf(ref))) {
      details.push(`${label} ${displayReferenceOf(ref)}: credentials verified by a successful live model check.`);
    }
  }
  const unverifiedRefs = authenticatedRefs.filter(({ ref }) => !verified.has(referenceOf(ref)));
  if (unverifiedRefs.length > 0) {
    const piStatus = await appendPiCredentialDetails(config, unverifiedRefs, details, env);
    if (piStatus === "waiting") {
      status = "waiting";
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
    // Display-only from here down: `provider` is still the lookup key into the
    // auth store and providers.local, `providerLabel` and `refStr` are what the
    // detail lines quote back at the operator.
    const providerLabel = displayText(provider);
    const refStr = displayReferenceOf(ref);
    const loginCommand = piAuthRecoveryCommand(providerLabel, authPath);
    const localProvider = localProviders.get(provider);
    if (localProvider !== undefined) {
      if (localProvider.enabled === false) {
        status = "waiting";
        details.push(
          `[WARN] ${label} ${refStr}: provider \`${providerLabel}\` is configured in providers.local but disabled (\`enabled: false\`); the runtime will throw \`provider disabled: ${providerLabel}\` on the first turn. Set \`enabled: true\` on that providers.local entry.`,
        );
      } else if (localProvider.apiKey !== undefined) {
        details.push(
          `${label} ${refStr}: provider \`${providerLabel}\` configured via config providers.local (API key configured); credential detected, live model verification is still pending.`,
        );
      } else if (localProvider.apiKeyEnv !== undefined) {
        if (hasNonEmptyCredentialValue(env[localProvider.apiKeyEnv])) {
          details.push(
            `${label} ${refStr}: provider \`${providerLabel}\` configured via config providers.local with ${localProvider.apiKeyEnv} present in the resolved environment; credential detected, live model verification is still pending.`,
          );
        } else {
          status = "waiting";
          details.push(
            `[WARN] ${label} ${refStr}: provider \`${providerLabel}\` declares apiKeyEnv \`${localProvider.apiKeyEnv}\`, but the resolved environment has no non-empty value and no inline apiKey fallback. Set ${localProvider.apiKeyEnv} before starting.`,
          );
        }
      } else {
        details.push(
          `${label} ${refStr}: provider \`${providerLabel}\` configured via config providers.local (keyless local provider; no API key declared).`,
        );
      }
      continue;
    }
    const apiKeyEnv = PI_API_KEY_ENV_BY_PROVIDER[provider];
    if (apiKeyEnv !== undefined && hasNonEmptyCredentialValue(env[apiKeyEnv])) {
      details.push(
        `${label} ${refStr}: Pi API-key credential for \`${providerLabel}\` present in the resolved environment (${apiKeyEnv}); credential detected, live model verification is still pending.`,
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
        ? `[WARN] ${label} ${refStr}: no Pi credentials found for provider \`${providerLabel}\` in the auth store. Authenticate it with \`${loginCommand}\`, or set providers.piAuthPath.`
        : `[WARN] ${label} ${refStr}: no Pi API key credentials found for provider \`${providerLabel}\` in the auth store or resolved environment. Run \`${loginCommand}\`, or set ${apiKeyEnv}.`);
      continue;
    }
    const isOAuth = entry.type === "oauth";
    const isApiKey = entry.type === "api_key";
    if (isApiKey && !hasNonEmptyCredentialValue(entry.key)) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored API-key credential for \`${providerLabel}\` has no usable key. Run \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    if (isOAuth && !hasNonEmptyCredentialValue(entry.access) && !hasNonEmptyCredentialValue(entry.refresh)) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored OAuth credential for \`${providerLabel}\` has no usable access or refresh token. Re-authenticate with \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    if (!isOAuth && !isApiKey) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored credential for \`${providerLabel}\` has an unsupported or missing type. Re-authenticate with \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    const expired = typeof entry.expires === "number" && entry.expires < now;
    const whenNote = typeof entry.expires === "number" ? ` ${new Date(entry.expires).toISOString()}` : "";
    if (isOAuth && expired) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: OAuth token for \`${providerLabel}\` expired${whenNote} — the runtime may auto-refresh, but this credential is not ready until a request succeeds; if runs fail with "No API key for provider: ${providerLabel}" re-authenticate with \`${loginCommand}\`.`,
      );
      continue;
    }
    details.push(
      isOAuth
        ? `${label} ${refStr}: OAuth credentials for \`${providerLabel}\` present (token valid${whenNote}); credential detected, live model verification is still pending.`
        : `${label} ${refStr}: API key credentials for \`${providerLabel}\` present; credential detected, live model verification is still pending.`,
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

function memoryConsolidationCronIssue(expression: string): string | undefined {
  const result = validateCronExpression(expression, { timezone: "UTC" });
  if (result.ok) {
    return undefined;
  }
  if (result.code === "required") {
    return "memory.consolidation.cron is required when consolidation is enabled.";
  }
  if (result.code === "field_count") {
    return `memory.consolidation.cron must use exactly five fields; received ${result.fieldCount}.`;
  }
  return `memory.consolidation.cron is invalid: ${result.reason}`;
}

async function memorySection(
  config: MonoAgentConfig,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  liveness: boolean,
  allowFilesystemWrites: boolean,
  preferAppPluginInstall: boolean,
): Promise<ValidationSection> {
  if (config.memory === undefined) {
    return { id: "memory", label: "Memory", status: "disabled", details: ["No memory configured."] };
  }
  // External backend (e.g. supermemory): mode/embeddings/llm are bujo-only and
  // ignored, so validate the plugin-owned shape before any soft liveness probe.
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
      const plugin = await loadSupermemoryPlugin({ cwd, preferAppInstall: preferAppPluginInstall });
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
    const details = [
      `Backend: supermemory, writeMode: ${config.memory.writeMode}.`,
      `Endpoint: ${sm.baseUrl} (container "${resolveSupermemoryContainer(config)}").`,
      sm.apiKey === undefined
        ? "Auth: no API key configured (keyless — works only if the instance allows it)."
        : "Auth: API key configured.",
    ];
    if (!liveness) {
      details.push("Supermemory liveness probe skipped; ingestion is async.");
      return { id: "memory", label: "Memory", status: "ok", details };
    }

    const probe = await probeSupermemoryEndpoint(sm.baseUrl);
    if (!probe.reachable) {
      details.push(
        `[WARN] Supermemory is not reachable at ${sm.baseUrl} (${probe.reason}). ` +
        "Start Supermemory or fix memory.supermemory.baseUrl, then re-run `mono-agent validate`; " +
        "capture and recall will degrade until it is reachable.",
      );
      return { id: "memory", label: "Memory", status: "waiting", details };
    }

    details.push(
      `Supermemory transport reachable at ${sm.baseUrl} (HTTP ${probe.status}); ingestion is async.`,
    );
    return { id: "memory", label: "Memory", status: "ok", details };
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
          details.push(`Agent-host memory LLM ${displayReferenceOf(model)}: ${resolutionIssue}.`);
        }
      } catch (error) {
        status = "error";
        details.push(
          `Agent-host memory LLM ${displayText(config.memory.llm.model)}: ${displayReason(error)}.`,
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
    const cronIssue = memoryConsolidationCronIssue(consolidationCron);
    if (cronIssue !== undefined) {
      status = "error";
      details.push(`[ERROR] ${cronIssue}`);
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
    const warns = await memoryLivenessWarnings(config.memory, env, liveness, allowFilesystemWrites);
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

const LIVENESS_PROBE_TIMEOUT_MS = 3_000;

type SupermemoryProbeResult =
  | { readonly reachable: true; readonly status: number }
  | { readonly reachable: false; readonly reason: string };

/**
 * Read-only transport probe for a configured Supermemory service root. Neither
 * the hosted nor self-hosted base URL has a documented health response, so any
 * HTTP status proves reachability; only transport failure or timeout degrades
 * validation. Manual redirects and omitted auth keep the probe on the exact
 * configured endpoint without sending memory data or credentials.
 */
async function probeSupermemoryEndpoint(endpoint: string): Promise<SupermemoryProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, LIVENESS_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "HEAD",
      redirect: "manual",
      signal: ctrl.signal,
    });
    return { reachable: true, status: response.status };
  } catch (error) {
    return {
      reachable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes Ollama /api/tags and returns a sorted list of model names, or throws. */
async function fetchOllamaModels(endpoint: string): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, LIVENESS_PROBE_TIMEOUT_MS);
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
  env: Readonly<Record<string, string | undefined>>,
  liveness: boolean,
  allowFilesystemWrites: boolean,
): Promise<string[]> {
  const warns: string[] = [];
  const mode = memory.mode;
  const llmUsesOllama = memory.llm?.provider === "ollama";
  const ollamaModelsByEndpoint = new Map<string, string[] | undefined>();

  // 1. Memory root writable (every embedded tier) — local I/O, always checked.
  const rootWarns = await memoryRootWritableWarnings(mode, memory.path, allowFilesystemWrites);
  warns.push(...rootWarns);

  const embeddings = memory.embeddings;
  let embeddingApiKey = embeddings?.apiKey;
  if (embeddings?.apiKeyEnv !== undefined) {
    embeddingApiKey = env[embeddings.apiKeyEnv]?.trim();
    if (embeddingApiKey === undefined || embeddingApiKey.length === 0) {
      warns.push(
        `[WARN] Embeddings apiKeyEnv ${embeddings.apiKeyEnv} is declared, but the resolved environment has no ` +
        `non-empty value. Set ${embeddings.apiKeyEnv} before starting managed memory; no keyless probe was attempted.`,
      );
      embeddingApiKey = undefined;
    }
  }

  // Network-dependent probes below only ever produce `waiting`, so the start
  // preflight skips them (liveness=false) without changing the pass/fail verdict.
  if (!liveness) {
    return warns;
  }

  if (
    embeddings !== undefined
    && (embeddings.provider === "ollama" || embeddings.provider === "lmstudio")
    && (embeddings.apiKeyEnv === undefined || embeddingApiKey !== undefined)
  ) {
    warns.push(...await localEmbeddingLivenessWarnings(embeddings, embeddingApiKey));
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

  // 2. Chat-LLM Ollama liveness remains independent from the selected
  // embeddings service. OpenAI embeddings and agent-host chat LLMs have no
  // local typed model catalog to validate here.
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

async function localEmbeddingLivenessWarnings(
  embeddings: NonNullable<NonNullable<MonoAgentConfig["memory"]>["embeddings"]>,
  apiKey: string | undefined,
): Promise<string[]> {
  if (embeddings.provider !== "ollama" && embeddings.provider !== "lmstudio") return [];
  const provider = embeddings.provider;
  const label = provider === "ollama" ? "Ollama" : "LM Studio";
  const endpoint = (embeddings.endpoint ?? DEFAULT_MEMORY_EMBEDDING_ENDPOINTS[provider]).replace(/\/+$/u, "");
  // Runtime readiness is authoritative on the exact configured model. Typed
  // catalogs help the wizard offer choices, but an unavailable/incomplete
  // catalog must not make its explicit manual fallback permanently unready.
  try {
    await probeMemoryEmbeddingSelection({
      provider,
      endpoint,
      model: embeddings.model,
      expectedDimension: embeddings.dim ?? 768,
      timeoutMs: LIVENESS_PROBE_TIMEOUT_MS,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    return [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/HTTP 401/u.test(reason)) {
      return [
        `[WARN] ${label} authentication failed at ${endpoint} (HTTP 401). ` +
        "Set the configured embeddings apiKeyEnv to a valid bearer token and retry.",
      ];
    }
    if (/could not connect|timed out/iu.test(reason)) {
      return [
        `[WARN] ${label} not reachable at ${endpoint}; embeddings will fail at runtime (${reason}). ` +
        `Start ${label} or fix the endpoint.`,
      ];
    }
    if (provider === "ollama" && /HTTP 404/u.test(reason)) {
      return [
        `[WARN] Ollama embedding model ${displayText(embeddings.model)} could not be proved at ${endpoint} (${reason}); ` +
        `run \`ollama pull ${displayText(embeddings.model)}\` and verify its embedding capability.`,
      ];
    }
    return [
      `[WARN] ${label} embedding readiness failed for ${displayText(embeddings.model)} at ${endpoint} (${reason}). ` +
      "Verify the selected model, authentication, and configured dimension.",
    ];
  }
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
    ? `ollama:${displayText(llm.model)}`
    : `agent-host:${displayText(llm.model)}`;
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
      if (isRememberToolPolicyName(name)) {
        // Reconcile with the runtime's own resolution, which honours the
        // `mcp__mono-agent-memory-write__*` spellings and deny-wins. This check
        // must precede the generic MCP branch below.
        if (!isRememberToolAllowed(config.tools)) {
          status = "waiting";
          details.push(
            `${name} is listed but tool policy still resolves to denied (deny wins, including the mcp__mono-agent-memory-write__* spellings) - the tool will not be offered.`,
          );
          continue;
        }
        // Unlike MemoryRecall, Remember IS allowlist-gated, so listing it is
        // correct and required under a restrictive policy. It still needs a
        // configured memory block with the write surface left enabled.
        if (config.memory === undefined) {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but no memory block is configured - durable writes will not work. Configure memory (or remove this entry).`,
          );
        } else if (config.memory.rememberTool?.enabled === false) {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but memory.rememberTool.enabled is off - durable writes will not work. Enable memory.rememberTool (or remove this entry).`,
          );
        } else if (config.memory.backend === "supermemory") {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but the supermemory backend exposes no durable write surface - the tool will not be offered.`,
          );
        }
        continue;
      }
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
    if (!isValidMcpServerName(serverName)) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers entry "${serverName}" is not a runtime-valid MCP server name (letters, digits, underscores, and hyphens only).`,
      );
      continue;
    }
    const spec = configuredMcpServers[serverName];
    if (spec === undefined) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers names unknown MCP server "${serverName}"; declare it in tools.mcpConfigPath.`,
      );
      continue;
    }
    if (!isStdioMcpServerSpec(spec)) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers entry "${serverName}" must reference a stdio MCP server (command/type:stdio), not HTTP/SSE.`,
      );
    }
  }
  for (const serverName of config.tools.continuationServers ?? []) {
    if (!isValidMcpServerName(serverName)) {
      status = "error";
      details.push(
        `tools.continuationServers entry "${serverName}" is not a runtime-valid MCP server name (letters, digits, underscores, and hyphens only).`,
      );
      continue;
    }
    const spec = configuredMcpServers[serverName];
    if (spec === undefined) {
      status = "error";
      details.push(
        `tools.continuationServers names unknown MCP server "${serverName}"; declare it in tools.mcpConfigPath.`,
      );
      continue;
    }
    if (classifyContinuationMcpServerTransport(spec) === "unsupported") {
      status = "error";
      details.push(
        `tools.continuationServers entry "${serverName}" must reference a stdio or loopback HTTP MCP server; remote HTTP and SSE are not supported.`,
      );
    }
  }
  const adapterSendTools = await resolveAdapterSendToolsSettings(input, {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
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
  );
  if (blockedAdapterEndpoints.length > 0) {
    if (status !== "error") {
      status = "waiting";
    }
    details.push(...blockedAdapterEndpoints);
  }
  // Subagents: the Agent tool is registered only when BOTH the capability is
  // enabled and the tool is allowed, so surface either half being missing.
  const subagents = config.subagents;
  const agentAllowed = allowAll || allowedTools.includes("Agent");
  if (subagents?.enabled === true) {
    const count = subagents.definitions?.length ?? 0;
    const inline = subagents.inline?.enabled === false
      ? "; call-time authoring off"
      : `; call-time authoring on${subagents.inline?.allowedTools === undefined ? "" : ` (capped at ${subagents.inline.allowedTools.join(", ")})`}`;
    details.push(`Subagents: enabled, ${count} profile${count === 1 ? "" : "s"}${count === 0 ? " (general-purpose only)" : ""}${inline}.`);
    // Whether children inherit the parent's skill index and the ReadSkill tool.
    // Worth stating either way: a subagent that has neither must rediscover by
    // trial and error whatever the parent could have looked up, and that shows
    // up as wasted turns rather than as an error anyone would report.
    if (config.context?.skillsRoot === undefined) {
      details.push("Subagents get no skill index (no context.skillsRoot is configured).");
    } else if ((config.context.skillDisclosure ?? "full") !== "index") {
      details.push(
        "Subagents get no skill index because context.skillDisclosure is \"full\"; set it to \"index\" so subagents inherit the index and the ReadSkill tool.",
      );
    } else {
      details.push("Subagents inherit the parent's skill index and the ReadSkill tool.");
    }
    for (const tool of subagents.inline?.allowedTools ?? []) {
      if (!isKnownToolName(tool) && !isMcpToolName(tool)) {
        status = "error";
        details.push(`subagents.inline.allowedTools lists unknown tool "${tool}".`);
      }
    }
    if (!agentAllowed) {
      status = status === "error" ? status : "waiting";
      details.push(
        "Subagents are enabled but Agent is not in tools.allowedTools, so the tool is never registered. Add \"Agent\" to tools.allowedTools.",
      );
    }
    for (const definition of subagents.definitions ?? []) {
      if (definition.promptPath !== undefined && !(await pathExists(definition.promptPath))) {
        status = "error";
        details.push(`Subagent "${definition.name}" promptPath does not exist: ${definition.promptPath}`);
      }
      for (const tool of definition.allowedTools ?? []) {
        if (!isKnownToolName(tool) && !isMcpToolName(tool)) {
          status = "error";
          details.push(`Subagent "${definition.name}" allows unknown tool "${tool}".`);
        }
      }
      for (const server of definition.mcpServers ?? []) {
        if (configuredMcpServerNames.length > 0 && !configuredMcpServerNames.includes(server)) {
          status = "error";
          details.push(`Subagent "${definition.name}" references MCP server "${server}", which is not in tools.mcpConfigPath.`);
        }
      }
    }
  } else if (agentAllowed && !allowAll) {
    // Naming `Agent` in an enumerated allowlist is an explicit request for it, so
    // half-configuration is a real mistake and blocks readiness.
    status = status === "error" ? status : "waiting";
    details.push(
      "Agent is allowed but subagents.enabled is not true, so the tool is never registered. Set subagents.enabled to true or drop Agent from tools.allowedTools.",
    );
  } else if (allowAll) {
    // Under `["*"]` nobody asked for `Agent` specifically — the wildcard merely
    // includes it — so this is NOT a misconfiguration and must not affect status,
    // or every default wildcard agent would report "waiting".
    //
    // It still gets a line, because the wildcard was previously the one posture
    // with no signal in either direction: an operator could ask the agent to
    // delegate, watch it silently not do so, and find nothing here saying why.
    details.push(
      "Subagents: off (subagents.enabled is not true), so the Agent tool is not registered and the agent cannot delegate.",
    );
  }

  return { id: "tools", label: "Tools & MCP", status, details };
}

const MIN_AGENT_BROWSER_VERSION = [0, 33, 1] as const;

async function webToolsSection(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
  liveness: boolean,
): Promise<ValidationSection> {
  const web = config.tools.web;
  const search = web?.search ?? {
    backend: "auto" as const,
    codex: { model: "gpt-5.6-luna" },
  };
  const fetchConfig = web?.fetch ?? { render: "never" as const, browserCommand: "agent-browser" };
  const details = [`WebSearch backend: ${search.backend}.`, `Web coordination: ${web?.coordination ?? "process"}.`];
  let status: ValidationStatus = "ok";
  if (web?.coordination === "host") {
    try {
      const shared = await inspectWebControl();
      details.push(shared.exists ? "Host web control state is valid." : "Host web control state will be initialized on first request.");
    } catch {
      status = "waiting";
      details.push("Host web control state is unavailable; web requests will fail closed. Inspect with mono-agent web-control status.");
    }
  }

  if (search.endpoint === undefined) {
    details.push(search.backend === "keyless"
      ? "SearXNG is not configured; keyless search is enabled."
      : search.backend === "codex"
        ? "SearXNG is not configured; strict Codex subscription search is enabled."
        : search.backend === "searxng"
          ? "SearXNG is not configured."
          : "SearXNG is not configured; auto mode starts with Codex subscription search, then keyless search.");
  } else {
    details.push(`SearXNG endpoint: ${search.endpoint}.`);
    if (!liveness) {
      details.push("SearXNG liveness was not probed.");
    } else {
      const probe = await probeSearxngEndpoint(search.endpoint);
      if (probe.ok) {
        details.push("SearXNG JSON search probe succeeded.");
      } else {
        status = "waiting";
        details.push(
          `[WARN] SearXNG JSON search probe failed (${probe.reason}). ` +
          (search.backend === "auto"
            ? "Start the local companion or fix tools.web.search.endpoint; auto mode can still fall back to Codex subscription search, then keyless search."
            : "Start the local companion or fix tools.web.search.endpoint; strict SearXNG mode has no fallback."),
        );
      }
    }
  }

  if (search.backend === "auto") {
    const codexModel = search.codex?.model ?? "gpt-5.6-luna";
    details.push(
      `Codex subscription fallback model: ${codexModel}; readiness is checked lazily when auto mode reaches that fallback.`,
    );
  } else if (search.backend === "codex") {
    const codexModel = search.codex?.model ?? "gpt-5.6-luna";
    details.push(`Codex subscription search model: ${codexModel}.`);
    if (!liveness) {
      details.push("Codex subscription search readiness was not probed.");
    } else {
      const probe = await (input.codexWebSearchProbe ?? inspectCodexSubscriptionSearch)({ model: codexModel });
      if (probe.ok) {
        details.push("Codex ChatGPT subscription, web-search capability, and configured model are ready.");
      } else {
        status = "waiting";
        details.push(
          `[WARN] Codex subscription search is not ready (${probe.reason}). `
          + "Strict Codex mode has no fallback.",
        );
      }
    }
  }

  details.push(`WebFetch browser rendering: ${fetchConfig.render}.`);
  if (fetchConfig.render === "never") {
    details.push("Static Defuddle/Readability extraction is active; agent-browser is not required.");
  } else if (!liveness) {
    details.push(`agent-browser liveness was not probed (${fetchConfig.browserCommand}).`);
  } else {
    const version = await readAgentBrowserVersion(fetchConfig.browserCommand, input);
    if (version === null || compareVersion(version, MIN_AGENT_BROWSER_VERSION) < 0) {
      status = "waiting";
      const found = version === null ? "missing or unreadable" : `v${version.join(".")}`;
      details.push(
        `[WARN] agent-browser is ${found}; WebFetch auto rendering requires >=${MIN_AGENT_BROWSER_VERSION.join(".")}.`,
      );
    } else {
      details.push(`agent-browser v${version.join(".")} is ready.`);
    }
  }

  return { id: "web-tools", label: "Web search & fetch", status, details };
}

async function probeSearxngEndpoint(endpoint: string): Promise<{ readonly ok: boolean; readonly reason: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, LIVENESS_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/u, "")}/search`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ q: "mono-agent doctor", format: "json", categories: "general" }),
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = await response.json() as {
      readonly results?: unknown;
      readonly unresponsive_engines?: unknown;
    };
    if (!Array.isArray(body.results)) {
      return { ok: false, reason: "response did not contain a results array" };
    }
    // An instance whose engines are all captcha'd or suspended answers 200 with
    // an empty result list, which the array check alone reported as healthy. The
    // empty array is not the signal on its own — this probe's query can
    // legitimately match very little — so only flag it alongside failed engines.
    const unresponsive = Array.isArray(body.unresponsive_engines) ? body.unresponsive_engines : [];
    if (body.results.length === 0 && unresponsive.length > 0) {
      const detail = unresponsive
        .map((entry) => (Array.isArray(entry) ? `${String(entry[0])}: ${String(entry[1])}` : String(entry)))
        .join("; ");
      return { ok: false, reason: `no results, and ${unresponsive.length === 1 ? "1 engine" : `${unresponsive.length} engines`} unresponsive — ${detail}` };
    }
    return { ok: true, reason: "" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function readAgentBrowserVersion(
  command: string,
  input: ValidateMonoAgentFolderOptions,
): Promise<readonly [number, number, number] | null> {
  const run = input.statusExecFile ?? defaultDoctorStatusExecFile;
  try {
    const { stdout } = await run(command, ["--version"], {
      cwd: input.cwd,
      env: Object.fromEntries(
        ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TMPDIR", "TMP", "TEMP"]
          .flatMap((key) => typeof input.env[key] === "string" ? [[key, input.env[key]]] : []),
      ),
      timeout: DOCTOR_STATUS_TIMEOUT_MS,
      maxBuffer: DOCTOR_STATUS_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(stdout.trim());
    if (match === null) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch {
    return null;
  }
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return 0;
}

async function continuationSection(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
): Promise<ValidationSection> {
  let settings;
  try {
    settings = await loadContinuationSettings({
      cwd: input.cwd,
      configPath: input.configPath,
      env: input.env,
    });
  } catch (error) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "error",
      details: [`Continuation configuration is invalid: ${continuationReason(error)}`],
    };
  }

  const continuationServers = config.tools.continuationServers ?? [];
  if (!settings.configured && continuationServers.length === 0) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "disabled",
      details: ["No continuation-capable MCP servers or detached continuation routes are configured."],
    };
  }
  if (!settings.enabled) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "error",
      details: ["Continuation service is disabled while continuation functionality is configured."],
    };
  }

  const details = [
    `Loopback service: http://${formatContinuationHost(settings.host)}:${String(settings.port)}.`,
    `Owner-only state: ${settings.stateDir}.`,
    continuationServers.length === 0
      ? "Run-scoped continuation MCP servers: none."
      : `Run-scoped continuation MCP servers: ${continuationServers.join(", ")}.`,
  ];
  const routeNames = Object.entries(settings.namedRoutes).map(([name, route]) => `${name} (${route.mode})`);
  details.push(routeNames.length === 0 ? "Named detached routes: none." : `Named detached routes: ${routeNames.join(", ")}.`);
  const detachedNames = Object.keys(settings.detachedServices);
  details.push(detachedNames.length === 0 ? "Detached services: none." : `Detached services: ${detachedNames.join(", ")}.`);

  const state = await inspectContinuationState(settings.stateDir, settings.retention);
  details.push(...state.details);
  return {
    id: "continuations",
    label: "Durable continuations",
    status: state.status,
    details,
  };
}

async function processJobsSection(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
): Promise<ValidationSection> {
  let settings;
  try {
    settings = await loadProcessJobsSettings({ cwd: input.cwd, configPath: input.configPath, env: input.env });
  } catch (error) {
    return {
      id: "process-jobs",
      label: "Background process jobs",
      status: "error",
      details: [`Process-job configuration is invalid: ${continuationReason(error)}`],
    };
  }
  // Resolve the posture on EVERY path, not just the unsafe opt-in. It decides
  // whether retained roots are in force, and there was previously no way to see
  // it from outside the process at all — which is what let mono-agent#664 run
  // for a day without the operator being able to name the state they were in.
  let unsafeWarning: string | undefined;
  let posture: ProcessJobsProtectionPosture | undefined;
  try {
    let registry = await loadProcessJobsRootRegistryProtection(input.cwd, config.runtime.workspace);
    if (registry.kind !== "failed") {
      try {
        registry = await attestProcessJobsRootRegistrySnapshot(registry, config.runtime.workspace);
      } catch {
        registry = failedProcessJobsRootRegistryProtection(registry.agentRoot);
      }
    }
    posture = resolveProcessJobsProtectionPosture({ settings, registry, coreConfig: config });
    if (settings.unsafeAllowUnprotectedState) {
      if (posture.kind === "unavailable") {
        return {
          id: "process-jobs",
          label: "Background process jobs",
          status: "error",
          details: ["Process-job private-state protection is unavailable."],
        };
      }
      unsafeWarning = posture.warning;
    }
  } catch (error) {
    // Only the unsafe opt-in has rejectable combinations; on the safe path this
    // line is diagnostics and must never turn a healthy config into an error.
    if (settings.unsafeAllowUnprotectedState) {
      return {
        id: "process-jobs",
        label: "Background process jobs",
        status: "error",
        details: [`Process-job configuration is invalid: ${continuationReason(error)}`],
      };
    }
    posture = undefined;
  }
  const protectionDetail = posture === undefined
    ? []
    : [`Private-state protection: ${posture.kind}${posture.retainedRoots ? " (roots retained)" : ""}.`];
  if (!settings.enabled) {
    return {
      id: "process-jobs",
      label: "Background process jobs",
      status: unsafeWarning === undefined ? "disabled" : "ok",
      details: [
        "Background Exec/Bash jobs are opt-in (processJobs.enabled=false).",
        ...protectionDetail,
        ...(unsafeWarning === undefined ? [] : [unsafeWarning]),
        ...(process.platform === "win32" ? ["Windows is unsupported; detached POSIX process-group ownership is required."] : []),
      ],
    };
  }
  if (process.platform === "win32") {
    return {
      id: "process-jobs",
      label: "Background process jobs",
      status: "error",
      details: ["Process jobs are enabled but Windows is unsupported; detached POSIX process-group ownership is required."],
    };
  }

  const details = [
    ...(unsafeWarning === undefined ? [] : [unsafeWarning]),
    ...protectionDetail,
    `Owner-only local state: ${settings.stateDir}.`,
    `Concurrency: ${String(settings.maxConcurrent)} global, ${String(settings.maxActivePerConversation)} per conversation, ${String(settings.maxQueued)} queued.`,
    `Caps: runtime=${String(settings.maxRuntimeMs)}ms, queue-age=${String(settings.maxQueueAgeMs)}ms, output=${String(settings.maxOutputBytes)} bytes, chain-depth=${String(settings.maxChainDepth)}.`,
    `Runtime availability: Pi-native Exec/Bash only; configured primary provider is ${displayText(config.runtime.model.provider)}.`,
  ];
  const inspection = await inspectProcessJobState(input.cwd, settings.stateDir);
  return {
    id: "process-jobs",
    label: "Background process jobs",
    status: inspection.status,
    details: [...details, ...inspection.details],
  };
}

async function inspectProcessJobState(cwd: string, stateDir: string): Promise<{
  readonly status: "ok" | "error";
  readonly details: readonly string[];
}> {
  const confinementError = await inspectProcessJobConfinement(cwd, stateDir);
  if (confinementError !== undefined) {
    return { status: "error", details: [confinementError] };
  }
  let root;
  try {
    root = await lstat(stateDir);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { status: "ok", details: ["State has not been initialized; the app will create it owner-only on first start."] }
      : { status: "error", details: [`Process-job state cannot be inspected: ${continuationReason(error)}`] };
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return { status: "error", details: ["Process-job state root must be a real directory, not a symlink."] };
  }
  const rootSecurity = processJobOwnershipError(root, "state directory", 0o700);
  if (rootSecurity !== undefined) return { status: "error", details: [rootSecurity] };

  const healthInspection = await inspectProcessJobHealth(stateDir);
  if (healthInspection !== undefined) return healthInspection;

  const quarantineInspection = await inspectProcessJobQuarantine(stateDir);
  if (quarantineInspection !== undefined) return quarantineInspection;

  const secretPath = join(stateDir, PROCESS_JOB_SECRET_FILE);
  try {
    const secret = await lstat(secretPath);
    if (!secret.isFile() || secret.isSymbolicLink() || Number(secret.nlink) !== 1 || Number(secret.size) > 256) {
      return { status: "error", details: ["Process-job operator secret must be one regular file."] };
    }
    const secretSecurity = processJobOwnershipError(secret, "operator secret", 0o600);
    if (secretSecurity !== undefined) return { status: "error", details: [secretSecurity] };
  } catch (error) {
    if (continuationFsCode(error) !== "ENOENT") {
      return { status: "error", details: [`Process-job operator secret cannot be inspected: ${continuationReason(error)}`] };
    }
  }

  const recordsPath = join(stateDir, PROCESS_JOB_RECORDS_DIRECTORY);
  let names: string[];
  try {
    const records = await lstat(recordsPath);
    if (!records.isDirectory() || records.isSymbolicLink()) {
      return { status: "error", details: ["Process-job records path must be a real directory."] };
    }
    const recordsSecurity = processJobOwnershipError(records, "records directory", 0o700);
    if (recordsSecurity !== undefined) return { status: "error", details: [recordsSecurity] };
    names = (await readdir(recordsPath)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { status: "ok", details: ["No local process-job records have been written yet."] }
      : { status: "error", details: [`Process-job records cannot be inspected: ${continuationReason(error)}`] };
  }
  if (names.length > 10_000) return { status: "error", details: ["Process-job record count exceeds the compiled inspection bound of 10000."] };
  const counts = Object.fromEntries(PROCESS_JOB_STATES.map((state) => [state, 0])) as Record<string, number>;
  for (const name of names) {
    const path = join(recordsPath, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) throw new Error("record is not one regular file");
      const security = processJobOwnershipError(info, `record ${name}`, 0o600);
      if (security !== undefined) throw new Error(security);
      if (Number(info.size) > 128 * 1024) throw new Error("record exceeds 131072 bytes");
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isDoctorObject(raw) || !isProcessJobState(raw.state) || raw.jobId !== name.slice(0, -5)) {
        throw new Error("record identity or state is invalid");
      }
      counts[raw.state] = (counts[raw.state] ?? 0) + 1;
    } catch (error) {
      return { status: "error", details: [`Process-job record ${name} is unsafe or malformed: ${continuationReason(error)}`] };
    }
  }
  return {
    status: "ok",
    details: [
      `Local records: ${String(names.length)}.`,
      `States: ${PROCESS_JOB_STATES.map((state) => `${state}=${String(counts[state] ?? 0)}`).join(", ")}.`,
    ],
  };
}

async function inspectProcessJobHealth(stateDir: string): Promise<{
  readonly status: "error";
  readonly details: readonly string[];
} | undefined> {
  const path = join(stateDir, PROCESS_JOB_HEALTH_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) {
      throw new Error("runtime health marker is not one regular file");
    }
    const security = processJobOwnershipError(info, "runtime health marker", 0o600);
    if (security !== undefined) throw new Error(security);
    if (Number(info.size) > MAX_PROCESS_JOB_HEALTH_BYTES) {
      throw new Error(`runtime health marker exceeds ${String(MAX_PROCESS_JOB_HEALTH_BYTES)} bytes`);
    }
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isDoctorObject(value)
      || Object.keys(value).sort().join(",") !== "detectedAt,operation,schemaVersion,state"
      || value.schemaVersion !== 1
      || value.state !== "degraded"
      || typeof value.operation !== "string"
      || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(value.operation)
      || typeof value.detectedAt !== "string"
      || !Number.isFinite(Date.parse(value.detectedAt))) {
      throw new Error("runtime health marker is malformed");
    }
    return {
      status: "error",
      details: [
        `Process-job storage degraded during ${value.operation} at ${value.detectedAt}; new admission is closed until a clean restart recovery.`,
      ],
    };
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? undefined
      : {
          status: "error",
          details: [`Process-job runtime health cannot be inspected: ${continuationReason(error)}`],
        };
  }
}

async function inspectProcessJobQuarantine(stateDir: string): Promise<{
  readonly status: "error";
  readonly details: readonly string[];
} | undefined> {
  const quarantinePath = join(stateDir, PROCESS_JOB_QUARANTINE_DIRECTORY);
  let names: string[];
  try {
    const directory = await lstat(quarantinePath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return { status: "error", details: ["Process-job quarantine path must be a real directory."] };
    }
    const security = processJobOwnershipError(directory, "quarantine directory", 0o700);
    if (security !== undefined) return { status: "error", details: [security] };
    names = await readdir(quarantinePath);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? undefined
      : { status: "error", details: [`Process-job quarantine cannot be inspected: ${continuationReason(error)}`] };
  }
  if (names.length > 10_000) {
    return { status: "error", details: ["Process-job quarantined transaction count exceeds 10000."] };
  }
  for (const name of names) {
    const path = join(quarantinePath, name);
    try {
      if (!/^transaction-\d{4}-\d{2}-\d{2}T[0-9.-]+Z-[0-9a-f-]{36}\.json$/iu.test(name)) {
        throw new Error("quarantine filename is invalid");
      }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1) {
        throw new Error("quarantined transaction is not one regular file");
      }
      const security = processJobOwnershipError(info, `quarantined transaction ${name}`, 0o600);
      if (security !== undefined) throw new Error(security);
      if (Number(info.size) > 256 * 1024) throw new Error("quarantined transaction exceeds 262144 bytes");
    } catch (error) {
      return {
        status: "error",
        details: [`Process-job quarantined transaction ${name} is unsafe: ${continuationReason(error)}`],
      };
    }
  }
  return names.length === 0
    ? undefined
    : {
        status: "error",
        details: [
          `Quarantined unreplayable process-job transactions: ${String(names.length)}.`,
          "The agent can continue without the affected transaction, but operator review is required.",
        ],
      };
}

function processJobOwnershipError(
  info: Awaited<ReturnType<typeof lstat>>,
  label: string,
  expectedMode: number,
): string | undefined {
  if (typeof process.getuid === "function" && Number(info.uid) !== process.getuid()) {
    return `Process-job ${label} is not owned by the current user.`;
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== expectedMode) {
    return `Process-job ${label} permissions must be ${expectedMode.toString(8)}.`;
  }
  return undefined;
}

async function inspectProcessJobConfinement(cwd: string, stateDir: string): Promise<string | undefined> {
  const lexicalRoot = resolve(cwd);
  const root = await realpath(lexicalRoot).catch(() => lexicalRoot);
  const rel = relative(root, resolve(stateDir));
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`)) {
    return "Process-job state must be a child directory inside the canonical agent root.";
  }
  let current = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return `Process-job state component must be a real directory, not a symlink: ${current}.`;
      }
    } catch (error) {
      if (continuationFsCode(error) === "ENOENT") return undefined;
      return `Process-job state confinement cannot be inspected: ${continuationReason(error)}`;
    }
  }
  return undefined;
}

async function inspectContinuationState(
  stateDir: string,
  retention: ContinuationRetentionOptions,
): Promise<{
  readonly status: "ok" | "waiting" | "error";
  readonly details: readonly string[];
}> {
  const details: string[] = [];
  const retentionPolicy = resolveRetention(retention);
  let directory;
  try {
    directory = await lstat(stateDir);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return {
        status: "ok",
        details: ["State has not been initialized; the app will create it with owner-only permissions on first start."],
      };
    }
    return { status: "error", details: [`Continuation state cannot be inspected: ${continuationReason(error)}`] };
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    return { status: "error", details: ["Continuation state path must be a real directory, not a file or symlink."] };
  }
  const directorySecurityError = continuationOwnershipError(directory, "state directory", 0o700);
  if (directorySecurityError !== undefined) {
    return { status: "error", details: [directorySecurityError] };
  }

  const secretError = await inspectContinuationSecret(join(stateDir, "continuation-secret"));
  if (secretError !== undefined) {
    return { status: "error", details: [secretError] };
  }

  const manifestPath = join(stateDir, "continuation-store-v3.json");
  let manifestInfo;
  try {
    manifestInfo = await lstat(manifestPath);
  } catch (error) {
    if (continuationFsCode(error) !== "ENOENT") {
      return { status: "error", details: [`Continuation store manifest cannot be inspected: ${continuationReason(error)}`] };
    }
  }
  if (manifestInfo !== undefined) {
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      return { status: "error", details: ["Continuation store manifest must be a regular file, not a symlink."] };
    }
    const manifestSecurityError = continuationOwnershipError(manifestInfo, "store manifest", 0o600);
    if (manifestSecurityError !== undefined) return { status: "error", details: [manifestSecurityError] };
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readBoundedOwnerOnlyFile(
        manifestPath,
        MAX_MANIFEST_BYTES,
        "Continuation v3 manifest",
      )) as unknown;
    } catch (error) {
      return { status: "error", details: [`Continuation store manifest contains invalid JSON: ${continuationReason(error)}`] };
    }
    if (!isContinuationStoreManifest(
      manifest,
      CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
      "per-record-v3",
    )) {
      return { status: "error", details: ["Continuation store manifest has an unsupported or malformed schema."] };
    }
    const recordsDirectoryPath = join(stateDir, "records-v3");
    const recordsDirectoryError = await inspectContinuationRecordsDirectory(recordsDirectoryPath);
    if (recordsDirectoryError !== undefined) return { status: "error", details: [recordsDirectoryError] };
    let recordsDirectoryHasEntries: boolean;
    try {
      recordsDirectoryHasEntries = (await readdir(recordsDirectoryPath))
        .some((entry) => !(entry.startsWith(".") && entry.endsWith(".tmp")));
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation record directory cannot be inspected: ${continuationReason(error)}`],
      };
    }
    const transaction = await inspectContinuationTransaction(
      join(stateDir, "continuation-transaction-v3.json"),
      CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
    );
    if (!transaction.valid) return { status: "error", details: [transaction.detail] };
    const legacyRecordsDirectoryPath = join(stateDir, "records-v2");
    let legacyRecordsDirectoryExists = false;
    try {
      const legacyRecordsDirectoryInfo = await lstat(legacyRecordsDirectoryPath);
      legacyRecordsDirectoryExists = true;
      if (!legacyRecordsDirectoryInfo.isDirectory() || legacyRecordsDirectoryInfo.isSymbolicLink()) {
        return { status: "error", details: ["Legacy continuation record directory must be a real directory."] };
      }
      const legacyRecordsDirectoryError = await inspectContinuationRecordsDirectory(
        legacyRecordsDirectoryPath,
        { allowV2RollbackGuard: true },
      );
      if (legacyRecordsDirectoryError !== undefined) {
        return { status: "error", details: [legacyRecordsDirectoryError] };
      }
    } catch (error) {
      if (continuationFsCode(error) !== "ENOENT") {
        return {
          status: "error",
          details: [`Legacy continuation record directory cannot be inspected: ${continuationReason(error)}`],
        };
      }
    }
    let legacyStateExists = legacyRecordsDirectoryExists;
    const legacyV1Path = join(stateDir, "continuations-v1.json");
    const legacyV1 = await inspectContinuationEvidenceFile(legacyV1Path, "v1 store");
    if (!legacyV1.valid) return { status: "error", details: [legacyV1.detail] };
    legacyStateExists ||= legacyV1.exists;
    const legacyV2Manifest = await inspectContinuationEvidenceFile(
      join(stateDir, "continuation-store-v2.json"),
      "v2 manifest",
    );
    if (!legacyV2Manifest.valid) return { status: "error", details: [legacyV2Manifest.detail] };
    legacyStateExists ||= legacyV2Manifest.exists;
    const legacyTransaction = await inspectContinuationTransaction(
      join(stateDir, "continuation-transaction-v2.json"),
      2,
    );
    if (!legacyTransaction.valid) return { status: "error", details: [legacyTransaction.detail] };
    legacyStateExists ||= legacyTransaction.pending;
    const manifestRollbackGuardRequired = manifest.rollbackGuardRequired ?? true;
    const legacyMigrationPending = legacyStateExists && !manifestRollbackGuardRequired;
    let recoverableRecords: Map<string, DurableContinuationRecord>;
    try {
      recoverableRecords = await loadContinuationRecordsForRecoveryInspection(recordsDirectoryPath);
      if (transaction.transaction !== undefined) {
        applyContinuationTransactionForInspection(recoverableRecords, transaction.transaction);
      }
      normalizeLegacyContinuationRecords(recoverableRecords);
      if (legacyMigrationPending) {
        const legacy = legacyRecordsDirectoryExists
          ? await loadContinuationRecordsForRecoveryInspection(legacyRecordsDirectoryPath)
          : new Map<string, DurableContinuationRecord>();
        if (legacyTransaction.transaction !== undefined) {
          applyContinuationTransactionForInspection(legacy, legacyTransaction.transaction);
        }
        if (legacyV1.exists) {
          mergeMigrationRecords(legacy, await loadLegacyStore(legacyV1Path), "recoverable v1 and v2");
        }
        mergeMigrationRecords(recoverableRecords, legacy, "recoverable v2 and v3");
      }
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation recoverable records are malformed or conflicting: ${continuationReason(error)}`],
      };
    }
    const originGroups = await inspectContinuationEvidenceDirectory(
      join(stateDir, "origin-context-groups-v1"),
      "origin-context activation directory",
      async () => recoverableRecords,
    );
    if (!originGroups.valid) return { status: "error", details: [originGroups.detail] };
    try {
      applyRetention(recoverableRecords, retentionPolicy, new Date());
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation retention projection cannot be recovered safely: ${continuationReason(error)}`],
      };
    }
    const rollbackGuardRequired = manifestRollbackGuardRequired
      || recordsDirectoryHasEntries
      || transaction.pending
      || originGroups.hasEntries;
    const rollbackGuard = await inspectContinuationRollbackGuard(
      join(legacyRecordsDirectoryPath, CONTINUATION_V2_ROLLBACK_GUARD),
      rollbackGuardRequired,
      legacyMigrationPending
        ? "Legacy continuation state is awaiting v3 migration; the current runtime will fence it before v3 materialization."
        : "The empty v3 store has no v2 rollback guard; the current runtime will install one before its first v3 record becomes durable.",
    );
    if (!rollbackGuard.valid) return { status: "error", details: [rollbackGuard.detail] };
    const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
    if (!owner.valid) return { status: "error", details: [owner.detail] };
    details.push(
      `Store v3: ${String(manifest.stats.records)} retained; ${String(manifest.stats.active)} active; ${String(manifest.stats.unresolvedDelivery)} delivery unknown; ${String(manifest.stats.deadLettered)} dead-lettered; ${String(manifest.stats.historyDegraded)} history-degraded deliveries; ${String(manifest.stats.terminalTombstones)} terminal tombstones; ${String(manifest.stats.compacted)} compacted; ${String(manifest.stats.capturedText)} captured answers.`,
      `Retention: at most ${String(manifest.stats.limits.terminalMaxRecords)} terminal tombstones with a maximum age of ${String(manifest.stats.limits.terminalMaxAgeMs)} ms and ${String(manifest.stats.limits.capturedTextMaxRecords)} captured answers with a maximum age of ${String(manifest.stats.limits.capturedTextMaxAgeMs)} ms.`,
      transaction.detail,
      rollbackGuard.detail,
      originGroups.detail,
      ...(legacyMigrationPending ? ["Legacy continuation state is awaiting idempotent v3 migration."] : []),
      owner.detail,
    );
    return {
      status: transaction.pending
        || originGroups.hasEntries
        || legacyMigrationPending
        || manifest.stats.unresolvedDelivery > 0
        || manifest.stats.deadLettered > 0
        || manifest.stats.historyDegraded > 0
        ? "waiting"
        : "ok",
      details,
    };
  }

  // Without a v3 manifest, derive one complete read-only recovery projection
  // before choosing a status. A crash may leave a WAL, already-applied records
  // after WAL removal, legacy inputs, or an activation marker in any
  // combination; reporting one item as waiting must not mask another item that
  // runtime recovery would reject.
  const unmanifestedV3Transaction = await inspectContinuationTransaction(
    join(stateDir, "continuation-transaction-v3.json"),
    CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  );
  if (!unmanifestedV3Transaction.valid) {
    return { status: "error", details: [unmanifestedV3Transaction.detail] };
  }
  const unmanifestedV2Transaction = await inspectContinuationTransaction(
    join(stateDir, "continuation-transaction-v2.json"),
    2,
  );
  if (!unmanifestedV2Transaction.valid) {
    return { status: "error", details: [unmanifestedV2Transaction.detail] };
  }

  const legacyManifestPath = join(stateDir, "continuation-store-v2.json");
  let legacyManifestInfo;
  try {
    legacyManifestInfo = await lstat(legacyManifestPath);
  } catch (error) {
    if (continuationFsCode(error) !== "ENOENT") {
      return { status: "error", details: [`Legacy continuation store manifest cannot be inspected: ${continuationReason(error)}`] };
    }
  }
  let legacyManifestExists = false;
  let legacyManifestDetails: readonly string[] | undefined;
  if (legacyManifestInfo !== undefined) {
    legacyManifestExists = true;
    if (!legacyManifestInfo.isFile() || legacyManifestInfo.isSymbolicLink()) {
      return { status: "error", details: ["Legacy continuation store manifest must be a regular file, not a symlink."] };
    }
    const manifestSecurityError = continuationOwnershipError(legacyManifestInfo, "legacy store manifest", 0o600);
    if (manifestSecurityError !== undefined) return { status: "error", details: [manifestSecurityError] };
    let legacyManifest: unknown;
    try {
      legacyManifest = JSON.parse(await readBoundedOwnerOnlyFile(
        legacyManifestPath,
        MAX_MANIFEST_BYTES,
        "Continuation v2 manifest",
      )) as unknown;
    } catch (error) {
      return { status: "error", details: [`Legacy continuation store manifest contains invalid JSON: ${continuationReason(error)}`] };
    }
    if (!isContinuationStoreManifest(legacyManifest, 2, "per-record-v2")) {
      return { status: "error", details: ["Legacy continuation store manifest has an unsupported or malformed schema."] };
    }
    legacyManifestDetails = [
      `Legacy store v2 awaiting v3 migration: ${String(legacyManifest.stats.records)} retained; ${String(legacyManifest.stats.active)} active; ${String(legacyManifest.stats.unresolvedDelivery)} delivery unknown; ${String(legacyManifest.stats.deadLettered)} dead-lettered; ${String(legacyManifest.stats.historyDegraded)} history-degraded deliveries; ${String(legacyManifest.stats.terminalTombstones)} terminal tombstones; ${String(legacyManifest.stats.compacted)} compacted; ${String(legacyManifest.stats.capturedText)} captured answers.`,
      `Retention: at most ${String(legacyManifest.stats.limits.terminalMaxRecords)} terminal tombstones with a maximum age of ${String(legacyManifest.stats.limits.terminalMaxAgeMs)} ms and ${String(legacyManifest.stats.limits.capturedTextMaxRecords)} captured answers with a maximum age of ${String(legacyManifest.stats.limits.capturedTextMaxAgeMs)} ms.`,
    ];
  }

  const legacyV1Path = join(stateDir, "continuations-v1.json");
  const legacyV1 = await inspectContinuationEvidenceFile(legacyV1Path, "v1 store");
  if (!legacyV1.valid) return { status: "error", details: [legacyV1.detail] };
  let v3Directory: Awaited<ReturnType<typeof loadOptionalContinuationRecordsForRecoveryInspection>>;
  let v2Directory: Awaited<ReturnType<typeof loadOptionalContinuationRecordsForRecoveryInspection>>;
  let projectedRecords: Map<string, DurableContinuationRecord>;
  let hasCommittedV3Records = false;
  try {
    v3Directory = await loadOptionalContinuationRecordsForRecoveryInspection(join(stateDir, "records-v3"));
    hasCommittedV3Records = v3Directory.records.size > 0;
    v2Directory = await loadOptionalContinuationRecordsForRecoveryInspection(join(stateDir, "records-v2"), {
      allowV2RollbackGuard: true,
    });
    const legacyRecords = v2Directory.records;
    if (unmanifestedV2Transaction.transaction !== undefined) {
      applyContinuationTransactionForInspection(legacyRecords, unmanifestedV2Transaction.transaction);
    }
    if (legacyV1.exists) {
      mergeMigrationRecords(legacyRecords, await loadLegacyStore(legacyV1Path), "recoverable v1 and v2");
    }
    projectedRecords = v3Directory.records;
    if (unmanifestedV3Transaction.transaction !== undefined) {
      applyContinuationTransactionForInspection(projectedRecords, unmanifestedV3Transaction.transaction);
    }
    normalizeLegacyContinuationRecords(projectedRecords);
    mergeMigrationRecords(projectedRecords, legacyRecords, "recoverable v2 and v3");
  } catch (error) {
    return {
      status: "error",
      details: [`Continuation recovery evidence is malformed or conflicting: ${continuationReason(error)}`],
    };
  }
  const originGroups = await inspectContinuationEvidenceDirectory(
    join(stateDir, "origin-context-groups-v1"),
    "origin-context activation directory",
    async () => projectedRecords,
  );
  if (!originGroups.valid) return { status: "error", details: [originGroups.detail] };
  try {
    applyRetention(projectedRecords, retentionPolicy, new Date());
  } catch (error) {
    return {
      status: "error",
      details: [`Continuation retention projection cannot be recovered safely: ${continuationReason(error)}`],
    };
  }
  const rollbackGuard = await inspectContinuationRollbackGuard(
    join(stateDir, "records-v2", CONTINUATION_V2_ROLLBACK_GUARD),
    false,
    "The v2 rollback guard is not installed; the current runtime will install it during v3 migration before publishing v3 state.",
  );
  if (!rollbackGuard.valid) return { status: "error", details: [rollbackGuard.detail] };
  const recoverableEvidenceExists = legacyManifestExists
    || v2Directory.exists
    || hasCommittedV3Records
    || unmanifestedV2Transaction.pending
    || unmanifestedV3Transaction.pending
    || originGroups.hasEntries;
  if (recoverableEvidenceExists) {
    const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
    if (!owner.valid) return { status: "error", details: [owner.detail] };
    details.push(
      ...(legacyManifestDetails ?? ["Continuation records are awaiting completion of the v3 manifest."]),
      ...(unmanifestedV2Transaction.pending ? [unmanifestedV2Transaction.detail] : []),
      ...(unmanifestedV3Transaction.pending ? [unmanifestedV3Transaction.detail] : []),
      rollbackGuard.detail,
      originGroups.detail,
      owner.detail,
    );
    return { status: "waiting", details };
  }

  const storePath = join(stateDir, "continuations-v1.json");
  let storeInfo;
  try {
    storeInfo = await lstat(storePath);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      details.push("No continuation ledger has been written yet.");
      const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
      details.push(owner.detail);
      return { status: owner.valid ? "ok" : "error", details };
    }
    return { status: "error", details: [`Continuation ledger cannot be inspected: ${continuationReason(error)}`] };
  }
  if (!storeInfo.isFile() || storeInfo.isSymbolicLink()) {
    return { status: "error", details: ["Continuation ledger must be a regular file, not a symlink."] };
  }
  const storeSecurityError = continuationOwnershipError(storeInfo, "ledger", 0o600);
  if (storeSecurityError !== undefined) {
    return { status: "error", details: [storeSecurityError] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedOwnerOnlyFile(
      storePath,
      MAX_LEGACY_STORE_BYTES,
      "Continuation legacy store",
    )) as unknown;
  } catch (error) {
    return { status: "error", details: [`Continuation ledger contains invalid JSON: ${continuationReason(error)}`] };
  }
  if (!isContinuationLedger(parsed)) {
    return { status: "error", details: ["Continuation ledger has an unsupported or malformed schema."] };
  }

  const counts = Object.fromEntries(CONTINUATION_STATES.map((state) => [state, 0])) as Record<ContinuationState, number>;
  for (const record of Object.values(parsed.records)) {
    if (!isDoctorObject(record) || typeof record.state !== "string" || !CONTINUATION_STATES.includes(record.state as ContinuationState)) {
      return { status: "error", details: ["Continuation ledger contains a record with an invalid lifecycle state."] };
    }
    counts[record.state as ContinuationState] += 1;
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const pending = counts.claimed + counts.result_received + counts.synthesizing + counts.ready_to_deliver + counts.delivery_retry;
  details.push(
    `Legacy ledger awaiting v3 migration: ${String(total)} total; ${String(pending)} pending; ${String(counts.delivery_unknown)} delivery unknown; ${String(counts.dead_lettered)} dead-lettered.`,
  );
  const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
  details.push(owner.detail);
  return {
    status: !owner.valid
      ? "error"
      : counts.delivery_unknown > 0 || counts.dead_lettered > 0
        ? "waiting"
        : "ok",
    details,
  };
}

async function inspectContinuationSecret(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? undefined
      : `Continuation secret cannot be inspected: ${continuationReason(error)}`;
  }
  if (!info.isFile() || info.isSymbolicLink()) return "Continuation secret must be a regular file, not a symlink.";
  const securityError = continuationOwnershipError(info, "secret", 0o600);
  if (securityError !== undefined) return securityError;
  try {
    const secret = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    if (secret.length !== 32) return "Continuation secret contents are invalid.";
  } catch (error) {
    return `Continuation secret cannot be read: ${continuationReason(error)}`;
  }
  return undefined;
}

async function inspectContinuationOwnerDatabase(path: string): Promise<{
  readonly valid: boolean;
  readonly detail: string;
}> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, detail: "The OS-backed continuation ownership database has not been initialized yet." }
      : { valid: false, detail: `Continuation ownership database cannot be inspected: ${continuationReason(error)}` };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { valid: false, detail: "Continuation ownership database is not a regular file." };
  }
  const securityError = continuationOwnershipError(info, "ownership database", 0o600);
  if (securityError !== undefined) return { valid: false, detail: securityError };
  return { valid: true, detail: "OS-backed exclusive ownership is released automatically on clean stop or process death." };
}

async function inspectContinuationRecordsDirectory(
  path: string,
  options: { readonly allowV2RollbackGuard?: boolean } = {},
): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? "Continuation record directory is missing."
      : `Continuation record directory cannot be inspected: ${continuationReason(error)}`;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return "Continuation record directory must be a real directory, not a file or symlink.";
  }
  const directorySecurityError = continuationOwnershipError(info, "record directory", 0o700);
  if (directorySecurityError !== undefined) return directorySecurityError;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (options.allowV2RollbackGuard && entry.name === CONTINUATION_V2_ROLLBACK_GUARD) continue;
      if (!entry.name.endsWith(".json") && !(entry.name.startsWith(".") && entry.name.endsWith(".tmp"))) {
        return `Continuation record directory contains an unexpected entry: ${entry.name}.`;
      }
      const recordInfo = await lstat(join(path, entry.name));
      if (!recordInfo.isFile() || recordInfo.isSymbolicLink()) {
        return `Continuation record entry is not a regular file: ${entry.name}.`;
      }
      const securityError = continuationOwnershipError(recordInfo, "record", 0o600);
      if (securityError !== undefined) return securityError;
      if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
        try {
          await readBoundedOwnerOnlyFile(
            join(path, entry.name),
            MAX_RECORD_BYTES,
            "Continuation temporary record",
          );
        } catch (error) {
          return `Continuation temporary record is unsafe: ${continuationReason(error)}`;
        }
      }
    }
  } catch (error) {
    return `Continuation record directory cannot be inspected: ${continuationReason(error)}`;
  }
  return undefined;
}

async function inspectContinuationEvidenceDirectory(
  path: string,
  label: string,
  loadRecoverableRecords: () => Promise<Map<string, DurableContinuationRecord>>,
): Promise<{
  readonly valid: boolean;
  readonly hasEntries: boolean;
  readonly hasTemporaryDebris: boolean;
  readonly detail: string;
}> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, hasEntries: false, hasTemporaryDebris: false, detail: `${label} has not been created.` }
      : {
          valid: false,
          hasEntries: false,
          hasTemporaryDebris: false,
          detail: `${label} cannot be inspected: ${continuationReason(error)}`,
        };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { valid: false, hasEntries: false, hasTemporaryDebris: false, detail: `${label} must be a real directory.` };
  }
  const securityError = continuationOwnershipError(info, label, 0o700);
  if (securityError !== undefined) {
    return { valid: false, hasEntries: false, hasTemporaryDebris: false, detail: securityError };
  }
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const temporaryEntries = entries.filter((entry) => entry.name.startsWith(".") && entry.name.endsWith(".tmp"));
    let projectedRecords: Map<string, DurableContinuationRecord> | undefined;
    const recordsForRecovery = async (): Promise<Map<string, DurableContinuationRecord>> => {
      if (projectedRecords !== undefined) return projectedRecords;
      projectedRecords = await loadRecoverableRecords();
      return projectedRecords;
    };
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      const temporary = entry.name.startsWith(".") && entry.name.endsWith(".tmp");
      if (temporary) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          return {
            valid: false,
            hasEntries: true,
            hasTemporaryDebris: true,
            detail: `${label} temporary entry must be a regular file: ${entry.name}.`,
          };
        }
        try {
          await readBoundedOwnerOnlyFile(
            entryPath,
            64 * 1024,
            "Continuation origin-context group temporary",
          );
        } catch (error) {
          return {
            valid: false,
            hasEntries: false,
            hasTemporaryDebris: true,
            detail: `${label} temporary entry is unsafe: ${continuationReason(error)}`,
          };
        }
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} contains an unexpected entry: ${entry.name}.`,
        };
      }
      const entryInfo = await lstat(entryPath);
      if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.nlink !== 1) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker must be a single-link regular file: ${entry.name}.`,
        };
      }
      const entrySecurityError = continuationOwnershipError(entryInfo, `${label} marker`, 0o600);
      if (entrySecurityError !== undefined) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: entrySecurityError,
        };
      }
      if (entryInfo.size > 64 * 1024) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker exceeds its safety limit: ${entry.name}.`,
        };
      }
      let markerBody: string;
      try {
        markerBody = await readBoundedOwnerOnlyFile(
          entryPath,
          64 * 1024,
          "Continuation origin-context group commit",
        );
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker is unsafe to read: ${continuationReason(error)}`,
        };
      }
      let marker: unknown;
      try {
        marker = JSON.parse(markerBody) as unknown;
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker contains invalid JSON: ${continuationReason(error)}`,
        };
      }
      if (!isOriginContextGroupCommit(marker) || `${marker.groupKey}.json` !== entry.name) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker has a malformed schema or filename: ${entry.name}.`,
        };
      }
      try {
        applyOriginContextGroupCommit(await recordsForRecovery(), marker);
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker does not match the recoverable durable records: ${continuationReason(error)}`,
        };
      }
    }
    const markerCount = entries.length - temporaryEntries.length;
    const hasEntries = markerCount > 0;
    const detail = markerCount > 0
      ? `${label} contains ${markerCount === 1 ? "a durable marker" : `${String(markerCount)} durable markers`} awaiting idempotent recovery${temporaryEntries.length > 0 ? ", plus incomplete temporary debris awaiting cleanup" : ""}.`
      : temporaryEntries.length > 0
        ? `${label} contains only incomplete temporary debris awaiting cleanup.`
        : `${label} is owner-only and empty.`;
    return {
      valid: true,
      hasEntries,
      hasTemporaryDebris: temporaryEntries.length > 0,
      detail,
    };
  } catch (error) {
    return {
      valid: false,
      hasEntries: false,
      hasTemporaryDebris: false,
      detail: `${label} cannot be inspected: ${continuationReason(error)}`,
    };
  }
}

async function loadContinuationRecordsForRecoveryInspection(
  path: string,
): Promise<Map<string, DurableContinuationRecord>> {
  const records = new Map<string, DurableContinuationRecord>();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (!entry.name.endsWith(".json")) continue;
    const entryPath = join(path, entry.name);
    let value: unknown;
    try {
      value = JSON.parse(await readBoundedOwnerOnlyFile(
        entryPath,
        MAX_RECORD_BYTES,
        "Continuation record",
      )) as unknown;
    } catch (error) {
      throw new Error(`Continuation record cannot be validated for activation recovery: ${entry.name}`, {
        cause: error,
      });
    }
    if (!isDoctorObject(value)
      || typeof value.continuationId !== "string"
      || !isRecord(value, value.continuationId)
      || `${continuationDigest(value.continuationId)}.json` !== entry.name
      || records.has(value.continuationId)) {
      throw new Error(`Continuation record has a malformed schema, duplicate id, or mismatched filename: ${entry.name}`);
    }
    records.set(value.continuationId, structuredClone(value) as DurableContinuationRecord);
  }
  return records;
}

async function loadOptionalContinuationRecordsForRecoveryInspection(
  path: string,
  options: { readonly allowV2RollbackGuard?: boolean } = {},
): Promise<{
  readonly exists: boolean;
  readonly records: Map<string, DurableContinuationRecord>;
}> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Continuation record directory must be a real directory, not a file or symlink.");
    }
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return { exists: false, records: new Map() };
    }
    throw error;
  }
  const inspectionError = await inspectContinuationRecordsDirectory(path, options);
  if (inspectionError !== undefined) throw new Error(inspectionError);
  return {
    exists: true,
    records: await loadContinuationRecordsForRecoveryInspection(path),
  };
}

function applyContinuationTransactionForInspection(
  records: Map<string, DurableContinuationRecord>,
  transaction: ContinuationRecordTransaction,
): void {
  for (const record of transaction.writes) {
    records.set(record.continuationId, structuredClone(record));
  }
  for (const id of transaction.deletes) records.delete(id);
}

async function inspectContinuationEvidenceFile(
  path: string,
  label: string,
): Promise<{ readonly valid: boolean; readonly exists: boolean; readonly detail: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, exists: false, detail: `Legacy continuation ${label} is absent.` }
      : {
        valid: false,
        exists: false,
        detail: `Legacy continuation ${label} cannot be inspected: ${continuationReason(error)}`,
      };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return {
      valid: false,
      exists: true,
      detail: `Legacy continuation ${label} must be a single-link regular file.`,
    };
  }
  const securityError = continuationOwnershipError(info, `legacy ${label}`, 0o600);
  return securityError === undefined
    ? { valid: true, exists: true, detail: `Legacy continuation ${label} is owner-only.` }
    : { valid: false, exists: true, detail: securityError };
}

async function inspectContinuationRollbackGuard(
  path: string,
  required: boolean,
  missingDetail = "The v2 rollback guard is not installed; the current runtime will install it during v3 migration.",
): Promise<{ readonly valid: boolean; readonly detail: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return required
        ? { valid: false, detail: "Continuation v2 rollback guard is missing from the v3 store." }
        : { valid: true, detail: missingDetail };
    }
    return { valid: false, detail: `Continuation v2 rollback guard cannot be inspected: ${continuationReason(error)}` };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return { valid: false, detail: "Continuation v2 rollback guard must be a single-link regular file, not a symlink." };
  }
  const securityError = continuationOwnershipError(info, "v2 rollback guard", 0o600);
  if (securityError !== undefined) return { valid: false, detail: securityError };
  if (info.size > 4 * 1024) {
    return { valid: false, detail: "Continuation v2 rollback guard exceeds its safety limit." };
  }
  let contents: string;
  try {
    contents = await readBoundedOwnerOnlyFile(path, 4 * 1024, "Continuation v2 rollback guard");
  } catch (error) {
    return { valid: false, detail: `Continuation v2 rollback guard cannot be read: ${continuationReason(error)}` };
  }
  if (contents !== CONTINUATION_V2_ROLLBACK_GUARD_CONTENT) {
    return { valid: false, detail: "Continuation v2 rollback guard contents are invalid." };
  }
  return {
    valid: true,
    detail: "The owner-only v2 rollback guard prevents older runtimes from opening stale continuation records.",
  };
}

async function inspectContinuationTransaction(
  path: string,
  expectedSchemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
): Promise<{
  readonly valid: boolean;
  readonly pending: boolean;
  readonly transaction?: ContinuationRecordTransaction;
  readonly detail: string;
}> {
  const versionLabel = `v${String(expectedSchemaVersion)}`;
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, pending: false, detail: `No interrupted durable ${versionLabel} transaction is awaiting recovery.` }
      : {
          valid: false,
          pending: false,
          detail: `Continuation ${versionLabel} transaction cannot be inspected: ${continuationReason(error)}`,
        };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction must be a single-link regular file, not a symlink.`,
    };
  }
  const securityError = continuationOwnershipError(info, `${versionLabel} transaction`, 0o600);
  if (securityError !== undefined) return { valid: false, pending: true, detail: securityError };
  let transaction: unknown;
  try {
    transaction = JSON.parse(await readBoundedOwnerOnlyFile(
      path,
      MAX_TRANSACTION_BYTES,
      `Continuation ${versionLabel} transaction`,
    )) as unknown;
  } catch (error) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction cannot be read as bounded JSON: ${continuationReason(error)}`,
    };
  }
  if (!isRecordTransaction(transaction, expectedSchemaVersion)) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction has an unsupported or malformed schema.`,
    };
  }
  const oversizedRecord = transaction.writes.find((record) =>
    Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8") > MAX_RECORD_BYTES);
  if (oversizedRecord !== undefined) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction contains a record over its ${String(MAX_RECORD_BYTES)} byte safety limit: ${oversizedRecord.continuationId}.`,
    };
  }
  return {
    valid: true,
    pending: true,
    transaction,
    detail: `An interrupted durable ${versionLabel} transaction is present and will be completed idempotently by the state owner.`,
  };
}

function continuationOwnershipError(
  info: Awaited<ReturnType<typeof lstat>>,
  label: string,
  expectedMode: number,
): string | undefined {
  if (typeof process.getuid === "function" && Number(info.uid) !== process.getuid()) {
    return `Continuation ${label} is not owned by the current user.`;
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== expectedMode) {
    return `Continuation ${label} permissions must be ${expectedMode.toString(8)}.`;
  }
  return undefined;
}

function isContinuationLedger(value: unknown): value is {
  readonly schemaVersion: number;
  readonly records: Record<string, unknown>;
} {
  return isStoreFile(value);
}

function isContinuationStoreManifest(
  value: unknown,
  schemaVersion: number,
  format: "per-record-v2" | "per-record-v3",
): value is {
  readonly schemaVersion: number;
  readonly generation: string;
  readonly updatedAt: string;
  readonly rollbackGuardRequired?: boolean;
  readonly stats: {
    readonly records: number;
    readonly active: number;
    readonly unresolvedDelivery: number;
    readonly deadLettered: number;
    readonly historyDegraded: number;
    readonly terminalTombstones: number;
    readonly compacted: number;
    readonly capturedText: number;
    readonly limits: {
      readonly terminalMaxRecords: number;
      readonly terminalMaxAgeMs: number;
      readonly capturedTextMaxRecords: number;
      readonly capturedTextMaxAgeMs: number;
    };
  };
} {
  if (!isDoctorObject(value)
    || value.schemaVersion !== schemaVersion
    || !isDurableGeneration(value.generation)
    || !requiredDate(value.updatedAt)
    || (value.rollbackGuardRequired !== undefined && typeof value.rollbackGuardRequired !== "boolean")
    || !isDoctorObject(value.stats)
    || value.stats.format !== format
    || !isDoctorObject(value.stats.limits)) return false;
  return [
    value.stats.records,
    value.stats.active,
    value.stats.unresolvedDelivery,
    value.stats.deadLettered,
    value.stats.historyDegraded,
    value.stats.terminalTombstones,
    value.stats.compacted,
    value.stats.capturedText,
    value.stats.limits.terminalMaxRecords,
    value.stats.limits.terminalMaxAgeMs,
    value.stats.limits.capturedTextMaxRecords,
    value.stats.limits.capturedTextMaxAgeMs,
  ].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0);
}

function isDoctorObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function continuationFsCode(error: unknown): string | undefined {
  return isDoctorObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function continuationReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatContinuationHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
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

  const askUserAllowed = isAdapterSendToolAllowed("AskUser", {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
  });
  const bridgeTools = [
    ...(askUserAllowed ? ["AskUser"] : []),
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

async function sandboxSection(config: MonoAgentConfig, engine?: SandboxEngine): Promise<ValidationSection> {
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

/**
 * Bounded, single-line rendering of operator-supplied text for a diagnostic.
 *
 * `referenceOf` is the canonical KEY -- it is compared against
 * `verifiedCredentialModelRefs`, which carries whole references -- so it must
 * stay unbounded. What gets PRINTED must not be. The parser deliberately has no
 * length ceiling any more (a reference cannot be truncated into validity, so a
 * ceiling there could only refuse a model that runs), which means acceptance
 * stopped being a length guarantee: a 500,000-byte reference parses today and
 * every one of these lines is echoed by `mono-agent validate`, the daemon log
 * and launchd's captured stdout. Escaping comes with the clamp, so a reference
 * carrying a newline also cannot forge a detail line that reads as doctor's own.
 */
function displayText(value: string): string {
  return sanitizeModelReferenceText(value, MODEL_REFERENCE_ECHO_MAX_BYTES);
}

/** Bounded display form of a model reference. Never use it as a map or set key. */
function displayReferenceOf(model: RuntimeModelReference): string {
  return displayText(referenceOf(model));
}

/**
 * Bounded display form of a thrown reason. A reason gets the larger budget because it is one
 * fixed repair sentence plus at most one echo of the value.
 *
 * Unwrap one layer first, as `modelReferenceReason` in @mono-agent/config and `reasonOf` in
 * trigger-overrides already do: the adapter's `message` wraps a 32-byte generic prefix around
 * a reason ALREADY at the full reason budget, so clamping the wrapped form spends the budget
 * on the prefix and pays for it out of the tail -- which is where the kernel parser puts the
 * concrete repair whenever it quotes the operator's value first.
 */
function displayReason(error: unknown): string {
  const reason = error instanceof RuntimeAdapterError && typeof error.details.reason === "string"
    ? error.details.reason
    : error instanceof Error
      ? error.message
      : String(error);
  return sanitizeModelReferenceText(reason, MODEL_REFERENCE_REASON_MAX_BYTES);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
