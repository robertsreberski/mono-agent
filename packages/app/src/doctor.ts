import { assertSupportedSessionsRoot } from "./sessions-root.js";
import { computerUseSection } from "./computer-use.js";
import { persistentSubagentsEnabled } from "./subagent-instances.js";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
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
} from "./app-config.js";
import { collectChannelConfigViews } from "./channel-config-view.js";
import { resolveChannelDrivers } from "./channels.js";
import { loadContinuationSettings } from "./continuation-config.js";
import { applyOriginContextGroupCommit } from "./continuation-origin-store.js";
import { readBoundedOwnerOnlyFile } from "./durable-state/private-files.js";
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
import { isProcessJobState, PROCESS_JOB_STATES, readSettingsJson } from "@mono-agent/contracts";
import {
  hasSubagentObligation,
  hasUnresolvedSubagentOwnership,
  isSubagentExecutionOwnership,
} from "./subagent-execution-ownership.js";
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
import { displayText } from "./doctor/format.js";

const CONTINUATION_V2_ROLLBACK_GUARD = "UPGRADED-TO-RECORDS-V3";
const CONTINUATION_V2_ROLLBACK_GUARD_CONTENT =
  "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n";

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
  const protectionDetail = [
    ...(posture === undefined ? [] : [`Private-state protection: ${posture.kind}${posture.retainedRoots ? " (roots retained)" : ""}.`]),
    persistentSubagentsEnabled(config) && settings.enabled && process.platform !== "win32"
      ? "Background subagents: configured for Pi-native, exact-conversation ProcessJobs routes; live availability also requires a healthy controller and remaining lineage."
      : "Background subagents unavailable: persistent Agent/AgentManage and supported, enabled ProcessJobs are required.",
  ];
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
    `Running slots: ${String(settings.maxConcurrent)} global, ${String(settings.maxActivePerConversation)} per conversation (nested descendants exempt); ${String(settings.maxQueued)} global waiting slots, including conversation-limited work.`,
    `Caps: runtime=${String(settings.maxRuntimeMs)}ms, queue-age=${String(settings.maxQueueAgeMs)}ms, output=${String(settings.maxOutputBytes)} bytes, chain-depth=${String(settings.maxChainDepth)}.`,
    `Runtime availability: Pi-native Exec/Bash and enabled persistent Agent/AgentManage; configured primary provider is ${displayText(config.runtime.model.provider)}.`,
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
  const childOwnership = { retained: 0, unresolved: 0, ownerUnavailable: 0 };
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
      if (raw.subagentOwnership !== undefined && !isSubagentExecutionOwnership(raw.subagentOwnership)) {
        throw new Error("record child ownership is invalid");
      }
      if (raw.subagentOwnership !== undefined && raw.kind !== "internal") {
        throw new Error("record child ownership kind is invalid");
      }
      if (raw.kind === "internal") {
        const ownership = isSubagentExecutionOwnership(raw.subagentOwnership) ? raw.subagentOwnership : undefined;
        const record = { kind: "internal" as const, childStillBusy: raw.childStillBusy === true, ...(ownership ? { subagentOwnership: ownership } : {}) };
        if (hasSubagentObligation(record)) childOwnership.retained++;
        if (hasUnresolvedSubagentOwnership(record)) {
          childOwnership.unresolved++;
          if (!ownership || ownership.owner.settlement === "unknown") childOwnership.ownerUnavailable++;
        }
      }
    } catch (error) {
      return { status: "error", details: [`Process-job record ${name} is unsafe or malformed: ${continuationReason(error)}`] };
    }
  }
  return {
    status: "ok",
    details: [
      `Local records: ${String(names.length)}.`,
      `States: ${PROCESS_JOB_STATES.map((state) => `${state}=${String(counts[state] ?? 0)}`).join(", ")}.`,
      `Persistent child ownership: retained=${String(childOwnership.retained)}, unresolved=${String(childOwnership.unresolved)}, owner-unavailable=${String(childOwnership.ownerUnavailable)}.`,
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
