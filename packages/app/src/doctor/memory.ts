import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { validateCronExpression } from "@mono-agent/trigger-cron";
import { effectiveEmbeddingIdentity } from "@mono-agent/memory/search";
import { parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import { FIRST_RUN_MEMORY_INITIALIZING_MARKER } from "../first-run-managed-memory.js";
import {
  DEFAULT_MEMORY_EMBEDDING_ENDPOINTS,
  probeMemoryEmbeddingSelection,
} from "../memory/memory-embedding-service.js";
import type { ValidationSection, ValidationStatus } from "../doctor-types.js";
import { piModelResolutionIssue } from "./runtime.js";
import { displayReferenceOf, displayText, displayReason, pathExists } from "./format.js";
import { LIVENESS_PROBE_TIMEOUT_MS } from "./probe-defaults.js";

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

export async function memorySection(
  config: MonoAgentConfig,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  liveness: boolean,
  allowFilesystemWrites: boolean,

): Promise<ValidationSection> {
  if (config.memory === undefined) {
    return {
      id: "memory",
      label: "Memory",
      status: "disabled",
      details: [
        "No memory configured.",
        "Chronological journal: disabled because no local memory backend is configured.",
      ],
    };
  }
  const details: string[] = [
    `Mode: ${config.memory.mode}, path: ${config.memory.path}, writeMode: ${config.memory.writeMode}.`,
    config.memory.recallTool?.enabled === false
      ? `Explicit memory read tools are disabled by memory.recallTool.enabled; the local ${config.memory.mode} tier supports chronology but MemoryJournal is not offered.`
      : `Chronological journal: supported by the local ${config.memory.mode} tier when tool policy allows MemoryJournal.`,
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

  if (config.memory.capture?.reconcileModel !== undefined) {
    try {
      const model = parseMonoRuntimeModelReference(config.memory.capture.reconcileModel);
      details.push(`Capture reconciliation model: ${displayReferenceOf(model)} (extraction and review use the chat LLM).`);
      const resolutionIssue = piModelResolutionIssue(config, model);
      if (resolutionIssue !== undefined) {
        status = "error";
        details.push(`Capture reconciliation model ${displayReferenceOf(model)}: ${resolutionIssue}.`);
      }
    } catch (error) {
      status = "error";
      details.push(`Capture reconciliation model ${displayText(config.memory.capture.reconcileModel)}: ${displayReason(error)}.`);
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

  const active = manifest.active;
  const configuredModel = memory.embeddings === undefined
    ? undefined
    : effectiveEmbeddingIdentity(memory.embeddings, active.embeddingModel);
  const configuredDimension = memory.embeddings === undefined ? undefined : memory.embeddings.dim ?? 768;
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
