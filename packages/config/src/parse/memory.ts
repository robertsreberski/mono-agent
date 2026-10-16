

import { parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";

import { normalizeOptionalString } from "@mono-agent/contracts";

import {
  MEMORY_BACKENDS,
  MEMORY_EMBEDDINGS_INSTRUCTIONS,
  MEMORY_EMBEDDINGS_PROVIDERS,
  MEMORY_LLM_PROVIDERS,
  MEMORY_MODES,
  MEMORY_WRITE_MODES,
} from "../enums.js";

import type {
  MemoryBackend,
  MemoryConsolidationConfig,
  MemoryEmbeddingsCircuitBreakerConfig,
  MemoryEmbeddingsConfig,
  MemoryEmbeddingsInstructions,
  MemoryEmbeddingsProvider,
  MemoryLlmConfig,
  MemoryLlmProvider,
  MemoryMode,
  MemoryWriteMode,
  MonoAgentConfig,
} from "../types.js";

import { MonoAgentConfigError } from "../errors.js";

import {
  assertJsonScalarFields,
  jsonBoolean,
  jsonChoice,
  jsonInteger,
  jsonOptionalBoolean,
  jsonOptionalInteger,
  jsonRecord,
  jsonString,
} from "./scalars.js";

import { modelReferenceEcho, modelReferenceReason } from "./model-reference.js";

import { readPath } from "./paths.js";

const DEFAULT_MEMORY_MAX_BYTES = 64_000;

const DEFAULT_EMBEDDINGS_MODELS: Record<MemoryEmbeddingsProvider, string> = {
  ollama: "nomic-embed-text:v1.5",
  lmstudio: "text-embedding-nomic-embed-text-v1.5",
  openai: "text-embedding-3-small",
};

/**
 * JSON paths that activate the `memory.llm` block. Keep model first: diagnostics
 * attribute an incompatible `memory.llm` block to the most informative field.
 */
const MEMORY_LLM_JSON_PATHS = [
  "memory.llm.model",
  "memory.llm.provider",
  "memory.llm.endpoint",
  "memory.llm.trace",
  "memory.llm.timeoutMs",
] as const;

/**
 * A JSON memory field counts as configured when it is present and non-blank,
 * mirroring how blank strings used to fall through to defaults.
 */
function hasMemoryJsonField(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined;
}

export function readMemoryConfig(value: unknown, cwd: string): MonoAgentConfig["memory"] | undefined {
  const memory = jsonRecord(value, "memory");
  if (memory === undefined) return undefined;
  // Validate raw JSON before defaults or the no-path exit can hide malformed
  // child blocks and scalar types. These were formerly checked by the layerer.
  assertJsonScalarFields(memory, "memory", { backend: "string", mode: "string", path: "string", maxBytes: "number", writeMode: "string" });
  const embeddingsJson = jsonRecord(memory.embeddings, "memory.embeddings");
  const llmJson = jsonRecord(memory.llm, "memory.llm");
  const captureJson = jsonRecord(memory.capture, "memory.capture");
  const recallToolJson = jsonRecord(memory.recallTool, "memory.recallTool");
  const recallJson = jsonRecord(memory.recall, "memory.recall");
  const profileJson = jsonRecord(memory.profile, "memory.profile");
  const rememberToolJson = jsonRecord(memory.rememberTool, "memory.rememberTool");
  const consolidationJson = jsonRecord(memory.consolidation, "memory.consolidation");
  if (embeddingsJson !== undefined) {
    assertJsonScalarFields(embeddingsJson, "memory.embeddings", {
      provider: "string", model: "string", endpoint: "string", apiKey: "string", apiKeyEnv: "string", dim: "number", timeoutMs: "number", instructions: "string",
    });
    const breaker = jsonRecord(embeddingsJson.circuitBreaker, "memory.embeddings.circuitBreaker");
    if (breaker !== undefined) assertJsonScalarFields(breaker, "memory.embeddings.circuitBreaker", { failureThreshold: "number", cooldownMs: "number" });
  }
  if (llmJson !== undefined) assertJsonScalarFields(llmJson, "memory.llm", { provider: "string", model: "string", endpoint: "string", trace: "boolean", timeoutMs: "number" });
  if (recallJson !== undefined) assertJsonScalarFields(recallJson, "memory.recall", { intentExpiry: "boolean", recency: "boolean" });
  if (profileJson !== undefined) assertJsonScalarFields(profileJson, "memory.profile", { enabled: "boolean" });
  if (recallToolJson !== undefined) assertJsonScalarFields(recallToolJson, "memory.recallTool", { enabled: "boolean" });
  if (rememberToolJson !== undefined) assertJsonScalarFields(rememberToolJson, "memory.rememberTool", { enabled: "boolean" });
  if (consolidationJson !== undefined) assertJsonScalarFields(consolidationJson, "memory.consolidation", { enabled: "boolean", cron: "string" });
  const backend = jsonChoice<MemoryBackend>(
    memory.backend,
    "memory.backend",
    MEMORY_BACKENDS,
    "bujo",
  );
  const rawPath = normalizeOptionalString(jsonString(memory.path, "memory.path"));

  // Every configured local memory setting requires a durable path.
  if (rawPath === undefined) {
    const orphaned = [
      "memory.mode",
      "memory.writeMode",
      "memory.capture",
      "memory.recall",
      "memory.profile",
      "memory.maxBytes",
      "memory.embeddings.provider",
      "memory.embeddings.model",
      "memory.embeddings.endpoint",
      "memory.embeddings.apiKey",
      "memory.embeddings.apiKeyEnv",
      "memory.rememberTool.enabled",
      "memory.embeddings.dim",
      "memory.embeddings.timeoutMs",
      "memory.embeddings.instructions",
      "memory.embeddings.circuitBreaker.failureThreshold",
      "memory.embeddings.circuitBreaker.cooldownMs",
      "memory.llm.provider",
      "memory.llm.model",
      "memory.llm.endpoint",
      "memory.llm.trace",
      "memory.llm.timeoutMs",
      "memory.recallTool.enabled",
      "memory.consolidation.enabled",
      "memory.consolidation.cron",
    ].find((path) => {
      const segments = path.split(".").slice(1);
      let current: unknown = memory;
      for (const segment of segments) {
        if (typeof current !== "object" || current === null || Array.isArray(current)) return false;
        current = (current as Record<string, unknown>)[segment];
      }
      return hasMemoryJsonField(current);
    });
    if (orphaned !== undefined) {
      throw new MonoAgentConfigError("invalid_json", `${orphaned} requires memory.path to be set.`, {
        path: "memory.path",
      });
    }
    return undefined;
  }
  const mode = jsonChoice<MemoryMode>(
    memory.mode,
    "memory.mode",
    MEMORY_MODES,
    "lite",
  );
  const writeMode = jsonChoice<MemoryWriteMode>(
    memory.writeMode,
    "memory.writeMode",
    MEMORY_WRITE_MODES,
    "disabled",
  );
  const intentExpiry = jsonBoolean(recallJson?.intentExpiry, "memory.recall.intentExpiry", false);
  const recency = jsonBoolean(recallJson?.recency, "memory.recall.recency", false);
  const profileEnabled = jsonBoolean(profileJson?.enabled, "memory.profile.enabled", false);
  if (recallJson !== undefined && Object.keys(recallJson).some((name) => !["intentExpiry", "recency"].includes(name))) {
    throw new MonoAgentConfigError("invalid_json", "memory_option_unknown", { path: "memory.recall" });
  }
  if (profileJson !== undefined && Object.keys(profileJson).some((name) => name !== "enabled")) {
    throw new MonoAgentConfigError("invalid_json", "memory_option_unknown", { path: "memory.profile" });
  }
  if (profileEnabled && mode !== "bujo") {
    throw new MonoAgentConfigError("invalid_json", "memory_option_requires_bujo", { path: "memory.profile.enabled" });
  }
  for (const [name, enabled] of [["intentExpiry", intentExpiry], ["recency", recency]] as const) {
    if (enabled && mode !== "bujo") throw new MonoAgentConfigError("invalid_json", "memory_option_requires_bujo", { path: `memory.recall.${name}` });
  }
  // Capture requires the local BuJo tier and its chat LLM.
  if (writeMode === "capture" && mode !== "bujo") {
    throw new MonoAgentConfigError(
      "invalid_json",
      `memory.writeMode "capture" requires memory.mode "bujo" (it needs a chat LLM).`,
      { path: "memory.writeMode" },
    );
  }
  if (captureJson !== undefined && (mode !== "bujo" || writeMode !== "capture")) {
    throw new MonoAgentConfigError("invalid_json",
      'memory.capture requires memory.mode "bujo" and memory.writeMode "capture".', { path: "memory.capture" });
  }
  let capture: NonNullable<NonNullable<MonoAgentConfig["memory"]>["capture"]> | undefined;
  if (captureJson !== undefined) {
    const rawFocus = captureJson.focus;
    if (rawFocus !== undefined && (typeof rawFocus !== "string" || rawFocus.trim().length === 0
      || rawFocus !== rawFocus.trim() || Buffer.byteLength(rawFocus, "utf8") > 2048
      || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(rawFocus.replaceAll("\n", ""))
      || /(?:^|\n)(?:END )?OPERATOR CAPTURE FOCUS\b/iu.test(rawFocus))) {
      throw new MonoAgentConfigError("invalid_json", "memory.capture.focus must be safe, trimmed text of at most 2048 UTF-8 bytes.",
        { path: "memory.capture.focus" });
    }
    const rawOnly = captureJson.only;
    if (rawOnly !== undefined && (!Array.isArray(rawOnly) || rawOnly.length > 3
      || rawOnly.some((kind: unknown) => kind !== "fact" && kind !== "preference" && kind !== "lesson")
      || new Set(rawOnly).size !== rawOnly.length)) {
      throw new MonoAgentConfigError("invalid_json", "memory.capture.only must be a unique subset of fact, preference, lesson.",
        { path: "memory.capture.only" });
    }
    const rawReconcileModel = captureJson.reconcileModel;
    if (rawReconcileModel !== undefined) {
      if (typeof rawReconcileModel !== "string" || rawReconcileModel.trim() !== rawReconcileModel || rawReconcileModel.length === 0) {
        throw new MonoAgentConfigError("invalid_json", "memory.capture.reconcileModel must be a nonblank, trimmed agent-host model reference.",
          { path: "memory.capture.reconcileModel" });
      }
      try {
        parseMonoRuntimeModelReference(rawReconcileModel);
      } catch (error) {
        const reason = modelReferenceReason(error);
        throw new MonoAgentConfigError("invalid_model_reference",
          `memory.capture.reconcileModel \`${modelReferenceEcho(rawReconcileModel)}\` is not a valid runtime model reference: ${reason}`,
          { path: "memory.capture.reconcileModel", reason });
      }
    }
    if (captureJson.cron !== undefined && typeof captureJson.cron !== "boolean") {
      throw new MonoAgentConfigError("invalid_json", "memory.capture.cron must be a boolean.",
        { path: "memory.capture.cron" });
    }
    if (captureJson.webhook !== undefined && typeof captureJson.webhook !== "boolean") {
      throw new MonoAgentConfigError("invalid_json", "memory.capture.webhook must be a boolean.",
        { path: "memory.capture.webhook" });
    }
    assertJsonScalarFields(captureJson, "memory.capture", { intentLifecycle: "boolean" });
    const intentLifecycle = jsonBoolean(captureJson.intentLifecycle, "memory.capture.intentLifecycle", false);
    capture = {
      ...(captureJson.intentLifecycle === undefined ? {} : { intentLifecycle }),
      ...(captureJson.cron === undefined ? {} : { cron: captureJson.cron }),
      ...(captureJson.webhook === undefined ? {} : { webhook: captureJson.webhook }),
      ...(rawFocus === undefined ? {} : { focus: rawFocus as string }),
      ...(rawOnly === undefined ? {} : { only: rawOnly as ("fact" | "preference" | "lesson")[] }),
      ...(rawReconcileModel === undefined ? {} : { reconcileModel: rawReconcileModel as string }),
    };
  }
  if ((mode === "lite" || mode === "journal") && hasMemoryLlmJson(llmJson)) {
    const message = mode === "lite"
      ? 'memory.mode "lite" is lexical-only and cannot configure memory.llm. Remove it or select journal/bujo.'
      : 'memory.mode "journal" is semantic-only and cannot configure a capture LLM or BuJo consolidation.';
    throw new MonoAgentConfigError("invalid_json", message, { path: "memory.llm" });
  }
  const embeddings = readMemoryEmbeddingsConfig(memory.embeddings);
  const llm = readMemoryLlmConfig(memory.llm, mode);
  const consolidation = readMemoryConsolidationConfig(memory.consolidation);

  // Built-in tiers are capability contracts, not best-effort hints.  Keeping
  // the matrix strict prevents a configured Journal/BuJo agent from silently
  // running as a cheaper tier when a prerequisite was omitted.
  if (mode === "lite") {
    const incompatible = embeddings !== undefined
      ? "memory.embeddings"
      : llm !== undefined
        ? "memory.llm"
        : consolidation !== undefined
          ? "memory.consolidation"
          : undefined;
    if (incompatible !== undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `memory.mode "lite" is lexical-only and cannot configure ${incompatible}. Remove it or select journal/bujo.`,
        { path: "memory.mode" },
      );
    }
  } else if (mode === "journal") {
    if (embeddings === undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        'memory.mode "journal" requires an explicit memory.embeddings block.',
        { path: "memory.embeddings" },
      );
    }
    if (llm !== undefined || consolidation !== undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        'memory.mode "journal" is semantic-only and cannot configure a capture LLM or BuJo consolidation.',
        { path: "memory.mode" },
      );
    }
  } else {
    if (embeddings === undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        'memory.mode "bujo" requires an explicit memory.embeddings block.',
        { path: "memory.embeddings" },
      );
    }
    if (llm === undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        'memory.mode "bujo" requires an explicit memory.llm block.',
        { path: "memory.llm" },
      );
    }
  }

  // Every configured local tier has targeted read-only recall: lite uses FTS,
  // and journal/bujo add semantic ranking.
  // The same switch also gates policy-allowed chronological browsing on local
  // tiers that affirm that separate capability. Explicit false is the shared
  // explicit-read opt-out; it does not disable automatic context recall.
  const recallToolEnabled = jsonBoolean(
    recallToolJson?.enabled,
    "memory.recallTool.enabled",
    true,
  );

  const rememberToolEnabled = jsonBoolean(
    rememberToolJson?.enabled,
    "memory.rememberTool.enabled",
    true,
  );

  return {
    backend,
    mode,
    path: readPath(rawPath, cwd),
    maxBytes: jsonInteger(memory.maxBytes, "memory.maxBytes", DEFAULT_MEMORY_MAX_BYTES, { min: 1, max: 1_000_000 }),
    writeMode,
    ...(capture === undefined ? {} : { capture }),
    ...(embeddings === undefined ? {} : { embeddings }),
    ...(llm === undefined ? {} : { llm }),
    recallTool: { enabled: recallToolEnabled },
    ...(recallJson === undefined ? {} : { recall: { ...(recallJson.intentExpiry === undefined ? {} : { intentExpiry }), ...(recallJson.recency === undefined ? {} : { recency }) } }),
    ...(profileJson === undefined ? {} : { profile: { enabled: profileEnabled } }),
    rememberTool: { enabled: rememberToolEnabled },
    ...(consolidation === undefined ? {} : { consolidation }),
  };
}

function readMemoryEmbeddingsConfig(value: unknown): MemoryEmbeddingsConfig | undefined {
  const embeddings = jsonRecord(value, "memory.embeddings");
  if (embeddings === undefined) {
    return undefined;
  }
  if (Object.keys(embeddings).length === 0) {
    const path = "memory.embeddings";
    const message = `${path} must contain at least one setting; provider, model, and dim default after the block is activated.`;
    throw new MonoAgentConfigError("invalid_json", message, { path, reason: message });
  }

  const provider = jsonChoice<MemoryEmbeddingsProvider>(
    embeddings.provider,
    "memory.embeddings.provider",
    MEMORY_EMBEDDINGS_PROVIDERS,
    "ollama",
  );
  const model = normalizeOptionalString(jsonString(embeddings.model, "memory.embeddings.model")) ?? DEFAULT_EMBEDDINGS_MODELS[provider];
  const endpoint = normalizeOptionalString(jsonString(embeddings.endpoint, "memory.embeddings.endpoint"));
  const apiKeyEnv = normalizeOptionalString(jsonString(embeddings.apiKeyEnv, "memory.embeddings.apiKeyEnv"));
  // A declared name is authoritative and stays unresolved at load: the runtime
  // resolves it against the effective environment when the provider is used,
  // so readiness can explain a missing value. Only an inline literal lands in
  // `apiKey` here.
  const apiKey = normalizeOptionalString(jsonString(embeddings.apiKey, "memory.embeddings.apiKey"));
  if (provider === "openai" && apiKey === undefined && apiKeyEnv === undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "openai memory embeddings require memory.embeddings.apiKey or memory.embeddings.apiKeyEnv.",
      { path: "memory.embeddings.apiKey" },
    );
  }
  const dim = jsonOptionalInteger(embeddings.dim, "memory.embeddings.dim", { min: 1, max: 16_384 });
  const timeoutMs = jsonOptionalInteger(
    embeddings.timeoutMs,
    "memory.embeddings.timeoutMs",
    { min: 1, max: 600_000 },
  );
  const instructions = embeddings.instructions === undefined
    ? undefined
    : jsonChoice<MemoryEmbeddingsInstructions>(
      embeddings.instructions,
      "memory.embeddings.instructions",
      MEMORY_EMBEDDINGS_INSTRUCTIONS,
      "auto",
    );
  const circuitBreaker = readMemoryEmbeddingsCircuitBreakerConfig(embeddings.circuitBreaker);
  return {
    provider,
    model,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(dim === undefined ? {} : { dim }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(circuitBreaker === undefined ? {} : { circuitBreaker }),
  };
}

function readMemoryEmbeddingsCircuitBreakerConfig(
  value: unknown,
): MemoryEmbeddingsCircuitBreakerConfig | undefined {
  const circuitBreaker = jsonRecord(value, "memory.embeddings.circuitBreaker");
  if (circuitBreaker === undefined) {
    return undefined;
  }
  const failureThreshold = jsonOptionalInteger(
    circuitBreaker.failureThreshold,
    "memory.embeddings.circuitBreaker.failureThreshold",
    { min: 1, max: 100 },
  );
  const cooldownMs = jsonOptionalInteger(
    circuitBreaker.cooldownMs,
    "memory.embeddings.circuitBreaker.cooldownMs",
    { min: 1, max: 3_600_000 },
  );
  if (failureThreshold === undefined && cooldownMs === undefined) {
    return undefined;
  }
  return {
    ...(failureThreshold === undefined ? {} : { failureThreshold }),
    ...(cooldownMs === undefined ? {} : { cooldownMs }),
  };
}

function readMemoryLlmConfig(value: unknown, mode: MemoryMode): MemoryLlmConfig | undefined {
  const llm = jsonRecord(value, "memory.llm");
  if (llm === undefined) {
    return undefined;
  }
  if (Object.keys(llm).length === 0) {
    const path = "memory.llm";
    const message = mode === "bujo"
      ? `${path} must contain a model for memory.mode "bujo".`
      : `memory.mode "${mode}" cannot configure ${path}.`;
    throw new MonoAgentConfigError("invalid_json", message, { path, reason: message });
  }
  const rawModel = normalizeOptionalString(jsonString(llm.model, "memory.llm.model"));
  if (rawModel === undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "memory.llm.model is required when any memory.llm value is set.",
      { path: "memory.llm.model" },
    );
  }
  const provider = jsonChoice<MemoryLlmProvider>(
    llm.provider,
    "memory.llm.provider",
    MEMORY_LLM_PROVIDERS,
    "ollama",
  );
  const endpoint = normalizeOptionalString(jsonString(llm.endpoint, "memory.llm.endpoint"));
  if (provider === "agent-host") {
    if (endpoint !== undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        "memory.llm.endpoint is only valid when memory.llm.provider is ollama.",
        { path: "memory.llm.endpoint" },
      );
    }
    try {
      parseMonoRuntimeModelReference(rawModel);
    } catch (error) {
      const reason = modelReferenceReason(error);
      throw new MonoAgentConfigError(
        "invalid_model_reference",
        `memory.llm.model \`${modelReferenceEcho(rawModel)}\` is not a valid runtime model reference for agent-host memory LLM: ${reason}`,
        { path: "memory.llm.model", reason },
      );
    }
    const trace = jsonOptionalBoolean(llm.trace, "memory.llm.trace");
    const timeoutMs = jsonOptionalInteger(llm.timeoutMs, "memory.llm.timeoutMs", {
      min: 1_000,
      max: 600_000,
    });
    return {
      provider,
      model: rawModel,
      ...(trace === undefined ? {} : { trace }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (hasMemoryJsonField(llm.trace)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "memory.llm.trace is only valid when memory.llm.provider is agent-host.",
      { path: "memory.llm.trace" },
    );
  }
  if (hasMemoryJsonField(llm.timeoutMs)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "memory.llm.timeoutMs is only valid when memory.llm.provider is agent-host.",
      { path: "memory.llm.timeoutMs" },
    );
  }
  return {
    provider,
    model: rawModel,
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

function hasMemoryLlmJson(llm: Record<string, unknown> | undefined): boolean {
  if (llm === undefined) return false;
  return MEMORY_LLM_JSON_PATHS.some((path) => hasMemoryJsonField(llm[path.slice("memory.llm.".length)]));
}

/**
 * Reads the optional consolidation config from env. Cron syntax is scheduler-validated,
 * not config-load validated, so operators get a runtime warning without blocking config load.
 */
function readMemoryConsolidationConfig(
  value: unknown,
): MemoryConsolidationConfig | undefined {
  const consolidation = jsonRecord(value, "memory.consolidation");
  if (consolidation === undefined) {
    return undefined;
  }
  const hasEnabled = hasMemoryJsonField(consolidation.enabled);
  const hasCron = hasMemoryJsonField(consolidation.cron);
  if (!hasEnabled && !hasCron) {
    return undefined;
  }
  const enabled = hasEnabled
    ? jsonBoolean(consolidation.enabled, "memory.consolidation.enabled", true)
    : undefined;
  const cron = normalizeOptionalString(jsonString(consolidation.cron, "memory.consolidation.cron"));
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(cron === undefined ? {} : { cron }),
  };
}
