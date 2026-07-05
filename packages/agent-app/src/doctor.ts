import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { listRecordedRuns } from "@mono-agent/observability";
import { serializeTraceSpans } from "@mono-agent/observability/otel";
import { describeMonoRuntimeSupport, modelReferenceKey, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";
import {
  buildMonoAgentConfigView,
  findJsonSecretConfigWarnings,
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
import { adapterSendToolNames, resolveAdapterSendToolsSettings } from "./adapter-send-tools.js";
import { collectChannelConfigViews } from "./channel-config-view.js";
import { defaultChannelDrivers } from "./channels.js";
import type { ChannelDriver } from "./channels.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";

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
   * When false, skip the live network probes (Ollama reachability and the
   * Phoenix export probe) and validate only structure/shape. Those probes can
   * only ever downgrade a section to `waiting`, never `error`, so skipping them
   * leaves the pass/fail verdict (`ok`) unchanged while removing up to two
   * 3s timeouts — the start preflight relies on this. Defaults to true.
   */
  readonly liveness?: boolean;
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
  const drivers = options.drivers ?? defaultChannelDrivers();
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
    const jsonResult = await readMonoAgentConfigJson(options.configPath);
    // Channel secrets (bot tokens, API keys) live outside the core view, so the
    // placement check spans both: core sections + every channel's config view.
    const secretWarnings = findJsonSecretConfigWarnings([
      ...buildMonoAgentConfigView({
        redacted: redactMonoAgentConfig(coreConfig),
        json: jsonResult.json,
        env: options.env,
      }),
      ...(await collectChannelConfigViews(drivers, options)),
    ]);
    if (secretWarnings.length > 0) {
      sections.push({ id: "secret-placement", label: "Secret placement", status: "waiting", details: secretWarnings });
    }
    sections.push(runtimeSection(coreConfig));
    sections.push(await credentialsSection(coreConfig));
    sections.push(await contextSection(coreConfig));
    sections.push(await memorySection(coreConfig, liveness, allowFilesystemWrites));
    sections.push(await toolsSection(coreConfig, options));
    sections.push(await sandboxSection(coreConfig, options.sandboxEngine));
  }

  sections.push(await exporterSection(options, liveness));
  sections.push(await runsSection(options, coreConfig));

  for (const driver of drivers) {
    sections.push(await channelSection(driver, options));
  }

  return {
    sections,
    ok: sections.every((section) => section.status !== "error"),
  };
}

function runtimeSection(config: MonoAgentConfig): ValidationSection {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  const primary = describeMonoRuntimeSupport(config.runtime.model, config.runtime.executionMode);
  if (primary.compatible) {
    details.push(`Primary model ${referenceOf(config.runtime.model)} runs on ${primary.backend?.label ?? "unknown backend"} (${config.runtime.executionMode}).`);
  } else {
    status = "error";
    details.push(`Primary model ${referenceOf(config.runtime.model)}: ${primary.incompatibilityReason ?? "unsupported"}.`);
  }

  for (const fallback of config.runtime.fallbackModels ?? []) {
    const support = describeMonoRuntimeSupport(fallback);
    if (support.compatible) {
      details.push(`Fallback model ${referenceOf(fallback)} runs on ${support.backend?.label ?? "unknown backend"}.`);
    } else {
      status = "error";
      details.push(`Fallback model ${referenceOf(fallback)}: ${support.incompatibilityReason ?? "unsupported"}.`);
    }
  }

  return { id: "runtime", label: "Runtime", status, details };
}

interface PiAuthEntry {
  readonly type?: string;
  readonly expires?: number;
  readonly refresh?: string;
}

/** Parses the Pi OAuth auth store (provider -> credentials) at `path`, best-effort. */
async function readPiAuthProviders(path: string): Promise<Record<string, PiAuthEntry> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, PiAuthEntry>;
    }
  } catch {
    // Missing/invalid auth file is reported per-provider below, not thrown here.
  }
  return undefined;
}

/** Provider ids configured via the sibling `models.json` (custom/local providers need no OAuth). */
async function readPiCustomProviders(authPath: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dirname(authPath), "models.json"), "utf8"));
    const providers = (parsed as { providers?: unknown } | null)?.providers;
    if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
      return new Set(Object.keys(providers as Record<string, unknown>));
    }
  } catch {
    // No models.json is fine; such providers simply won't be marked custom.
  }
  return new Set();
}

/**
 * Checks that every referenced model (primary, fallbacks, and the agent-host memory LLM)
 * has discoverable credentials, so a keyless or expired-OAuth provider is caught at
 * `validate` time instead of degrading crons/memory silently at runtime (the failure mode
 * that broke memory capture for ~10 days: the auth store's OAuth token had quietly expired).
 *
 * The check is intentionally STATIC and read-only — a validator must not mutate the auth
 * store or hit the network. For each Pi provider it inspects the auth store (`piAuthPath`)
 * and the sibling `models.json`: a custom/local provider needs no OAuth; an OAuth provider
 * absent from the store, or whose access token has expired, is flagged `waiting` with a
 * re-auth hint. SDK-authenticated models (claude/codex) are validated by their own SDK and
 * are noted but not key-checked here. `waiting` (never `error`) keeps the verdict non-fatal,
 * mirroring the Ollama/Phoenix probes — the goal is visibility, not blocking start.
 */
async function credentialsSection(config: MonoAgentConfig): Promise<ValidationSection> {
  const refs: { label: string; ref: RuntimeModelReference }[] = [
    { label: "Primary", ref: config.runtime.model },
    ...(config.runtime.fallbackModels ?? []).map((ref) => ({ label: "Fallback", ref })),
  ];
  if (config.memory?.llm !== undefined && config.memory.llm.provider !== "ollama") {
    try {
      refs.push({ label: "Memory LLM", ref: parseMonoRuntimeModelReference(config.memory.llm.model) });
    } catch {
      // A malformed memory model reference is surfaced by the memory/runtime shape checks.
    }
  }

  const piRefs = refs.filter((r) => r.ref.sdk === "pi" && typeof r.ref.provider === "string");
  if (piRefs.length === 0) {
    return {
      id: "credentials",
      label: "Provider credentials",
      status: "disabled",
      details: ["No Pi provider-key models referenced (SDK-authenticated models are checked by their SDK)."],
    };
  }

  const authPath = config.providers?.piAuthPath;
  const authProviders = authPath === undefined ? undefined : await readPiAuthProviders(authPath);
  const customProviders = authPath === undefined ? new Set<string>() : await readPiCustomProviders(authPath);
  const now = Date.now();
  const details: string[] = [];
  let status: ValidationStatus = "ok";
  if (authPath !== undefined) {
    details.push(`Pi auth store: ${authPath}`);
  }

  for (const { label, ref } of piRefs) {
    const provider = ref.provider as string;
    const refStr = referenceOf(ref);
    if (customProviders.has(provider)) {
      details.push(`${label} ${refStr}: provider \`${provider}\` configured via pi models.json.`);
      continue;
    }
    const entry = authProviders?.[provider];
    if (entry === undefined) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: no Pi credentials found for provider \`${provider}\` (absent from the auth store and models.json). Authenticate it (\`pi auth login ${provider}\`) or set providers.piAuthPath.`,
      );
      continue;
    }
    const isOAuth = entry.type === "oauth" || typeof entry.expires === "number";
    const expired = typeof entry.expires === "number" && entry.expires < now;
    const whenNote = typeof entry.expires === "number" ? ` ${new Date(entry.expires).toISOString()}` : "";
    if (isOAuth && expired) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: OAuth token for \`${provider}\` expired${whenNote} — the runtime auto-refreshes, but if runs fail with "No API key for provider: ${provider}" the refresh is dead; re-authenticate: \`pi auth login ${provider}\`.`,
      );
      continue;
    }
    details.push(
      isOAuth
        ? `${label} ${refStr}: OAuth credentials for \`${provider}\` present (token valid${whenNote}).`
        : `${label} ${refStr}: credentials for \`${provider}\` present.`,
    );
  }

  return { id: "credentials", label: "Provider credentials", status, details };
}

async function contextSection(config: MonoAgentConfig): Promise<ValidationSection> {
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

  return { id: "context", label: "Context & skills", status, details };
}

const DEFAULT_REFLECTION_CRON = "0 3 * * *";
const DEFAULT_MIGRATION_CRON = "0 4 1 * *";

async function memorySection(
  config: MonoAgentConfig,
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
  if (config.memory.llm !== undefined) {
    details.push(`Chat LLM: ${memoryLlmLabel(config.memory.llm)}.`);
  }

  if (config.memory.mode === "bujo") {
    // Report ritual scheduler cadence
    const reflectionEnabled = config.memory.reflection?.enabled !== false;
    const migrationEnabled = config.memory.migration?.enabled !== false;
    const reflectionCron = config.memory.reflection?.cron ?? DEFAULT_REFLECTION_CRON;
    const migrationCron = config.memory.migration?.cron ?? DEFAULT_MIGRATION_CRON;
    const hasLlm = config.memory.llm !== undefined;

    if (hasLlm) {
      const ritualParts: string[] = [];
      if (reflectionEnabled) {
        ritualParts.push(`reflection ${reflectionCron}`);
      } else {
        ritualParts.push("reflection disabled");
      }
      if (migrationEnabled) {
        ritualParts.push(`migration ${migrationCron}`);
      } else {
        ritualParts.push("migration disabled");
      }
      details.push(`Rituals: ${ritualParts.join(" / ")} (auto).`);
    } else {
      details.push("Rituals: manual (no chat model — reflect/migrate need an LLM).");
    }
  }

  if (config.memory.mode === "journal" || config.memory.mode === "bujo") {
    const warns = await memoryLivenessWarnings(config.memory, liveness, allowFilesystemWrites);
    if (warns.length > 0) {
      return { id: "memory", label: "Memory", status: "waiting", details: [...details, ...warns] };
    }
  }

  if (config.memory.mode === "lite") {
    const liteWarns = await liteRootWritableWarning(config.memory.path, allowFilesystemWrites);
    if (liteWarns.length > 0) {
      return { id: "memory", label: "Memory", status: "waiting", details: [...details, ...liteWarns] };
    }
  }

  return { id: "memory", label: "Memory", status: "ok", details };
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

async function toolsSection(config: MonoAgentConfig, input: MonoAgentAppConfigInput): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  details.push(
    config.tools.allowedTools.length === 0
      ? "No tools allowed (fail-closed default)."
      : `Allowed tools: ${config.tools.allowedTools.join(", ")}.`,
  );
  if (config.tools.disallowedTools.length > 0) {
    details.push(`Disallowed tools: ${config.tools.disallowedTools.join(", ")}.`);
  }
  if (config.tools.mcpConfigPath !== undefined) {
    if (await pathExists(config.tools.mcpConfigPath)) {
      details.push(`MCP config: ${config.tools.mcpConfigPath}`);
    } else {
      status = "error";
      details.push(`MCP config file is missing: ${config.tools.mcpConfigPath}`);
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

  return { id: "tools", label: "Tools & MCP", status, details };
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


async function runsSection(input: MonoAgentAppConfigInput, config: MonoAgentConfig | undefined): Promise<ValidationSection> {
  const artifactDir = await resolveAppArtifactDir(input);
  const { totalRuns, runs, warnings } = await listRecordedRuns({ artifactDir, maxRuns: RUNS_HEALTH_MAX_RUNS });
  const display = buildRunsHealthDisplay({ artifactDir, totalRuns, runs, warnings });
  const retentionDetails = config === undefined
    ? []
    : [
        `Artifact retention: maxAgeDays=${config.artifacts.retention.maxAgeDays}, maxCount=${config.artifacts.retention.maxCount}, dryRun=${config.artifacts.retention.dryRun ? "true" : "false"}.`,
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
