import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { serializeTraceSpans } from "@mono-agent/observability-otel";
import { describeMonoRuntimeSupport } from "@mono-agent/runtime-adapter";
import type { MonoAgentConfig } from "@mono-agent/config";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
  phoenixAppBaseUrl,
  resolveAppObservabilityExporters,
} from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import { adapterSendToolNames, resolveAdapterSendToolsSettings } from "./adapter-send-tools.js";
import { defaultChannelDrivers } from "./channels.js";
import type { ChannelDriver } from "./channels.js";

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
    sections.push(runtimeSection(coreConfig));
    sections.push(await contextSection(coreConfig));
    sections.push(await memorySection(coreConfig));
    sections.push(await toolsSection(coreConfig, options));
    sections.push(sandboxSection(coreConfig));
  }

  sections.push(await exporterSection(options));

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

async function memorySection(config: MonoAgentConfig): Promise<ValidationSection> {
  if (config.memory === undefined) {
    return { id: "memory", label: "Memory", status: "disabled", details: ["No memory configured."] };
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
    const warns = await memoryLivenessWarnings(config.memory);
    if (warns.length > 0) {
      return { id: "memory", label: "Memory", status: "waiting", details: [...details, ...warns] };
    }
  }

  if (config.memory.mode === "lite") {
    const liteWarns = await liteRootWritableWarning(config.memory.path);
    if (liteWarns.length > 0) {
      return { id: "memory", label: "Memory", status: "waiting", details: [...details, ...liteWarns] };
    }
  }

  return { id: "memory", label: "Memory", status: "ok", details };
}

async function liteRootWritableWarning(memoryPath: string): Promise<string[]> {
  try {
    await mkdir(memoryPath, { recursive: true });
    return [];
  } catch (err) {
    return [
      `[WARN] lite memory root is not writable: ${memoryPath} (${err instanceof Error ? err.message : String(err)}). Fix filesystem permissions.`,
    ];
  }
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
): Promise<string[]> {
  const warns: string[] = [];
  const mode = memory.mode;
  const embeddingsUsesOllama = (memory.embeddings?.provider ?? "ollama") === "ollama";
  const llmUsesOllama = memory.llm?.provider === "ollama";
  const ollamaModelsByEndpoint = new Map<string, string[] | undefined>();

  // 1. Memory root writable (every embedded tier)
  try {
    await mkdir(memory.path, { recursive: true });
  } catch (err) {
    warns.push(
      `[WARN] ${mode} memory root is not writable: ${memory.path} (${err instanceof Error ? err.message : String(err)}). Fix filesystem permissions.`,
    );
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

function sandboxSection(config: MonoAgentConfig): ValidationSection {
  if (config.sandbox === undefined) {
    return { id: "sandbox", label: "Sandbox", status: "disabled", details: ["No sandbox policy configured."] };
  }
  return {
    id: "sandbox",
    label: "Sandbox",
    status: "ok",
    details: [
      `Mode: ${config.sandbox.mode}, network: ${config.sandbox.network.mode}, fallback: ${config.sandbox.fallback}.`,
    ],
  };
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
async function exporterSection(input: MonoAgentAppConfigInput): Promise<ValidationSection> {
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
    details.push("includeSensitiveData=true (redacted payloads are exported).");
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
    return { id, label: driver.label, status: "ok", details: ["Configured; will start with the app."] };
  } catch (error) {
    if (driver.isConfigError(error)) {
      const reason = error instanceof Error ? error.message : String(error);
      return { id, label: driver.label, status: "waiting", details: [reason] };
    }
    throw error;
  }
}

function referenceOf(model: MonoAgentConfig["runtime"]["model"]): string {
  return model.reference ?? `${model.sdk}:${model.provider === undefined ? "" : `${model.provider}:`}${model.model}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
