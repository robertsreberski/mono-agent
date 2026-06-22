import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  assertExecutionModeCompatible,
  defaultExecutionModeForModel,
  isRuntimeExecutionMode,
  parseMonoRuntimeModelReference,
  RuntimeAdapterError,
  validateLocalProviderDefinition,
} from "@mono-agent/runtime-adapter";
import type { LocalProviderDefinition, LocalProviderModelDefinition, RuntimeExecutionMode } from "@mono-agent/runtime-adapter";
import {
  SANDBOX_FALLBACKS,
  SANDBOX_MODES,
  SANDBOX_NETWORK_MODES,
  SandboxPolicyError,
  createSandboxPolicy,
} from "@mono-agent/sandbox";
import type { SandboxFallback, SandboxMode, SandboxNetworkMode } from "@mono-agent/sandbox";
import {
  normalizeOptionalString,
  readBoolean,
  readChoice,
  readCsv,
  readInteger,
  redactedSecret,
} from "@mono-agent/settings";
import type { ConfigErrorFactory } from "@mono-agent/settings";

import { EFFORT_LEVELS, PERMISSION_MODES } from "./enums.js";
import type { EffortLevel, MemoryEmbeddingsCircuitBreakerConfig, MemoryEmbeddingsConfig, MemoryEmbeddingsProvider, MemoryLlmConfig, MemoryLlmProvider, MemoryMode, MemoryRitualConfig, MemoryWriteMode, MonoAgentConfig, ObservabilityExporterConfig, PermissionMode, PiNativeProviderConfig, RedactedMonoAgentConfig, RedactedObservabilityConfig, SessionMode, SessionRollover } from "./types.js";

export type MonoAgentConfigErrorCode =
  | "missing_required_env"
  | "invalid_env"
  | "invalid_json"
  | "invalid_model_reference"
  | "incompatible_execution_mode";

export interface MonoAgentConfigErrorDetails {
  readonly code?: MonoAgentConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class MonoAgentConfigError extends Error {
  readonly code: MonoAgentConfigErrorCode;
  readonly details: MonoAgentConfigErrorDetails;

  constructor(code: MonoAgentConfigErrorCode, message: string, details: MonoAgentConfigErrorDetails = {}) {
    super(message);
    this.name = "MonoAgentConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

/**
 * Error factory bound to the `invalid_env` code, handed to the shared
 * `@mono-agent/settings` coercers so their fail-closed throws keep config's
 * typed error shape (code + env/reason details) verbatim.
 */
const invalidEnv: ConfigErrorFactory = (message, details) =>
  new MonoAgentConfigError("invalid_env", message, details);

export interface LoadMonoAgentConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
}

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 1_800_000;
const DEFAULT_MEMORY_MAX_BYTES = 64_000;
const DEFAULT_EMBEDDINGS_MODELS: Record<MemoryEmbeddingsProvider, string> = {
  ollama: "nomic-embed-text",
  openai: "text-embedding-3-small",
};
const DEFAULT_TRACE_HEARTBEAT_MS = 10_000;
const DEFAULT_TRACE_STALE_AFTER_MS = 30_000;
const OBSERVABILITY_EXPORTER_TYPES = ["phoenix"] as const;
const DEFAULT_PHOENIX_ENDPOINT = "http://127.0.0.1:6006/v1/traces";
const DEFAULT_PHOENIX_TIMEOUT_MS = 5_000;
const DEFAULT_PI_AUTH_PATH = resolve(homedir(), ".pi", "agent", "auth.json");

export function loadMonoAgentConfig(input: LoadMonoAgentConfigInput): MonoAgentConfig {
  const cwd = normalizeCwd(input.cwd);
  const model = parseModel(readRequired(input.env, "MONO_AGENT_MODEL"));
  const fallbackModels = readFallbackModels(input.env);
  const executionMode = parseExecutionMode(input.env.MONO_AGENT_EXECUTION_MODE, model);
  const maxTurns = readMaxTurns(input.env.MONO_AGENT_MAX_TURNS);
  const workspace = readPath(input.env.MONO_AGENT_WORKSPACE, cwd, cwd);
  const session = readSessionConfig(input.env);
  const identityPath = readPath(readRequired(input.env, "MONO_AGENT_IDENTITY_PATH"), cwd);
  const soulPath = readOptionalPath(input.env.MONO_AGENT_SOUL_PATH, cwd);
  const skillsRoot = readOptionalPath(input.env.MONO_AGENT_SKILLS_ROOT, cwd);
  const selectedSkills = readCsv(input.env.MONO_AGENT_SELECTED_SKILLS);
  // The skills loader rejects caps below 256 bytes; validate at the same floor.
  const skillMaxBytes = readOptionalInteger(input.env.MONO_AGENT_SKILL_MAX_BYTES, "MONO_AGENT_SKILL_MAX_BYTES", { min: 256, max: 1_000_000 });
  const memory = readMemoryConfig(input.env, cwd);
  const mcpConfigPath = readOptionalPath(input.env.MONO_AGENT_MCP_CONFIG_PATH, cwd);
  const sandbox = readSandboxConfig(input.env, workspace);
  const artifactDir = readPath(input.env.MONO_AGENT_ARTIFACT_DIR, cwd, resolve(cwd, ".mono-agent", "artifacts"));
  const traceability = readTraceabilityConfig(input.env, cwd);
  const observability = readObservabilityConfig(input.env);
  const piAuthPath = readPath(input.env.MONO_AGENT_PI_AUTH_PATH, cwd, DEFAULT_PI_AUTH_PATH);
  const localProviders = readLocalProviders(input.env);
  const piNative = readPiNativeProviderConfig(input.env, cwd);

  assertModeCompatibility(model, executionMode);

  const effort = readEffort(input.env.MONO_AGENT_EFFORT);
  const permissionMode = readPermissionMode(input.env.MONO_AGENT_PERMISSION_MODE);
  const concurrency = readConcurrencyConfig(input.env);
  const runtime: MonoAgentConfig["runtime"] = {
    model,
    ...(fallbackModels.length === 0 ? {} : { fallbackModels }),
    executionMode,
    ...(maxTurns === undefined ? {} : { maxTurns }),
    workspace,
    session,
    ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };

  const context: MonoAgentConfig["context"] = {
    identityPath,
    selectedSkills,
    ...(soulPath === undefined ? {} : { soulPath }),
    ...(skillsRoot === undefined ? {} : { skillsRoot }),
    ...(skillMaxBytes === undefined ? {} : { skillMaxBytes }),
  };

  const tools: MonoAgentConfig["tools"] = {
    allowedTools: readCsv(input.env.MONO_AGENT_ALLOWED_TOOLS),
    disallowedTools: readCsv(input.env.MONO_AGENT_DISALLOWED_TOOLS),
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
  };

  const config: MonoAgentConfig = {
    runtime,
    ...(concurrency === undefined ? {} : { concurrency }),
    context,
    tools,
    ...(sandbox === undefined ? {} : { sandbox }),
    artifacts: {
      dir: artifactDir,
    },
    traceability,
    ...(observability === undefined ? {} : { observability }),
    providers: {
      piAuthPath,
      ...(localProviders.length === 0 ? {} : { local: localProviders }),
      ...(piNative === undefined ? {} : { piNative }),
    },
  };

  if (memory !== undefined) {
    return { ...config, memory };
  }
  return config;
}

export function redactMonoAgentConfig(config: MonoAgentConfig): RedactedMonoAgentConfig {
  const redacted: RedactedMonoAgentConfig = {
    runtime: { ...config.runtime },
    ...(config.concurrency === undefined ? {} : { concurrency: { ...config.concurrency } }),
    context: { ...config.context, selectedSkills: [...config.context.selectedSkills] },
    tools: {
      ...config.tools,
      allowedTools: [...config.tools.allowedTools],
      disallowedTools: [...config.tools.disallowedTools],
    },
    ...(config.sandbox === undefined ? {} : { sandbox: { ...config.sandbox } }),
    artifacts: { ...config.artifacts },
    traceability: { ...config.traceability },
    ...(config.observability === undefined ? {} : { observability: redactObservabilityConfig(config.observability) }),
  };
  if (config.memory !== undefined) {
    const { embeddings, ...memory } = config.memory;
    if (embeddings === undefined) {
      return withRedactedProviders({ ...redacted, memory }, config);
    }
    const { apiKey, ...safeEmbeddings } = embeddings;
    return withRedactedProviders({
      ...redacted,
      memory: {
        ...memory,
        embeddings: {
          ...safeEmbeddings,
          ...(apiKey === undefined ? {} : { apiKey: redactedSecret(apiKey) }),
        },
      },
    }, config);
  }
  return withRedactedProviders(redacted, config);
}

function parseModel(raw: string): MonoAgentConfig["runtime"]["model"] {
  try {
    return parseMonoRuntimeModelReference(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MonoAgentConfigError("invalid_model_reference", "MONO_AGENT_MODEL is not a valid runtime model reference.", {
      env: "MONO_AGENT_MODEL",
      reason,
    });
  }
}

function readFallbackModels(env: Record<string, string | undefined>): readonly MonoAgentConfig["runtime"]["model"][] {
  return readCsv(env.MONO_AGENT_FALLBACK_MODELS).map((raw) => {
    try {
      return parseMonoRuntimeModelReference(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MonoAgentConfigError(
        "invalid_model_reference",
        `MONO_AGENT_FALLBACK_MODELS entry \`${raw}\` is not a valid runtime model reference.`,
        { env: "MONO_AGENT_FALLBACK_MODELS", reason },
      );
    }
  });
}

function readMaxTurns(raw: string | undefined): number | undefined {
  const maxTurns = readInteger(raw, "MONO_AGENT_MAX_TURNS", 0, invalidEnv, { min: 0, max: 100 });
  return maxTurns === 0 ? undefined : maxTurns;
}

function parseExecutionMode(raw: string | undefined, model: MonoAgentConfig["runtime"]["model"]): RuntimeExecutionMode {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return defaultExecutionModeForModel(model);
  }
  if (!isRuntimeExecutionMode(normalized)) {
    throw new MonoAgentConfigError("invalid_env", "MONO_AGENT_EXECUTION_MODE must be sdk or cli.", {
      env: "MONO_AGENT_EXECUTION_MODE",
    });
  }
  return normalized;
}

function assertModeCompatibility(model: MonoAgentConfig["runtime"]["model"], executionMode: RuntimeExecutionMode): void {
  try {
    assertExecutionModeCompatible(model, executionMode);
  } catch (error) {
    if (error instanceof RuntimeAdapterError && error.code === "incompatible_execution_mode") {
      throw new MonoAgentConfigError("incompatible_execution_mode", "Runtime model and execution mode are incompatible.", {
        env: "MONO_AGENT_EXECUTION_MODE",
        reason: error.message,
      });
    }
    throw error;
  }
}

function readSandboxConfig(env: Record<string, string | undefined>, workspace: string): MonoAgentConfig["sandbox"] | undefined {
  if (!hasSandboxEnv(env)) {
    return undefined;
  }

  const mode = readChoice<SandboxMode>(env.MONO_AGENT_SANDBOX_MODE, "MONO_AGENT_SANDBOX_MODE", SANDBOX_MODES, "native", invalidEnv);
  const networkMode = readChoice<SandboxNetworkMode>(env.MONO_AGENT_SANDBOX_NETWORK, "MONO_AGENT_SANDBOX_NETWORK", SANDBOX_NETWORK_MODES, "none", invalidEnv);
  const fallback = readChoice<SandboxFallback>(env.MONO_AGENT_SANDBOX_FALLBACK, "MONO_AGENT_SANDBOX_FALLBACK", SANDBOX_FALLBACKS, "fail-closed", invalidEnv);
  // Filesystem scope entries are resolved by the sandbox against `root` (the
  // workspace), so relative entries here mean "relative to the workspace".
  const readableRoots = readCsv(env.MONO_AGENT_SANDBOX_READABLE_ROOTS);
  const writableRoots = readCsv(env.MONO_AGENT_SANDBOX_WRITABLE_ROOTS);
  const denyWrite = readCsv(env.MONO_AGENT_SANDBOX_DENY_WRITE);
  try {
    return createSandboxPolicy({
      mode,
      root: workspace,
      ...(readableRoots.length === 0 ? {} : { readableRoots }),
      ...(writableRoots.length === 0 ? {} : { writableRoots }),
      ...(denyWrite.length === 0 ? {} : { denyWrite }),
      network: {
        mode: networkMode,
        allowlist: readCsv(env.MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST),
      },
      fallback,
      unsafeAllowHostProcess: readBoolean(
        env.MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS,
        "MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS",
        false,
        invalidEnv,
      ),
    });
  } catch (error) {
    if (error instanceof SandboxPolicyError) {
      throw new MonoAgentConfigError("invalid_env", `Sandbox policy env is invalid: ${error.message}`, {
        env: sandboxPolicyErrorEnv(error),
        reason: error.message,
      });
    }
    throw error;
  }
}

function sandboxPolicyErrorEnv(error: SandboxPolicyError): string {
  const field = typeof error.details.field === "string" ? error.details.field : undefined;
  if (field === "unsafeAllowHostProcess") {
    return "MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS";
  }
  if (field === "readableRoots" || field?.startsWith("readableRoots[")) {
    return "MONO_AGENT_SANDBOX_READABLE_ROOTS";
  }
  if (field === "writableRoots" || field?.startsWith("writableRoots[")) {
    return "MONO_AGENT_SANDBOX_WRITABLE_ROOTS";
  }
  if (field === "denyWrite" || field?.startsWith("denyWrite[")) {
    return "MONO_AGENT_SANDBOX_DENY_WRITE";
  }
  if (field === "network.allowlist" || field?.startsWith("network.allowlist[")) {
    return "MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST";
  }
  if (field === "network.mode") {
    return "MONO_AGENT_SANDBOX_NETWORK";
  }
  if (field === "fallback") {
    return "MONO_AGENT_SANDBOX_FALLBACK";
  }
  if (field === "root") {
    return "MONO_AGENT_WORKSPACE";
  }
  return "MONO_AGENT_SANDBOX_MODE";
}

function hasSandboxEnv(env: Record<string, string | undefined>): boolean {
  return [
    env.MONO_AGENT_SANDBOX_MODE,
    env.MONO_AGENT_SANDBOX_NETWORK,
    env.MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST,
    env.MONO_AGENT_SANDBOX_READABLE_ROOTS,
    env.MONO_AGENT_SANDBOX_WRITABLE_ROOTS,
    env.MONO_AGENT_SANDBOX_DENY_WRITE,
    env.MONO_AGENT_SANDBOX_FALLBACK,
    env.MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS,
  ].some((value) => normalizeOptionalString(value) !== undefined);
}

function readSessionConfig(env: Record<string, string | undefined>): MonoAgentConfig["runtime"]["session"] {
  const mode = readChoice<SessionMode>(env.MONO_AGENT_SESSION_MODE, "MONO_AGENT_SESSION_MODE", [
    "continuous",
    "per-message",
  ], "continuous", invalidEnv);
  const idleTimeoutMs = readInteger(
    env.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS,
    "MONO_AGENT_SESSION_IDLE_TIMEOUT_MS",
    DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    invalidEnv,
    { min: 1_000, max: 86_400_000 },
  );
  const rollover = readChoice<SessionRollover>(env.MONO_AGENT_SESSION_ROLLOVER, "MONO_AGENT_SESSION_ROLLOVER", [
    "none",
    "daily",
  ], "none", invalidEnv);
  const rolloverTimezone = typeof env.MONO_AGENT_SESSION_ROLLOVER_TIMEZONE === "string"
    && env.MONO_AGENT_SESSION_ROLLOVER_TIMEZONE.trim()
    ? env.MONO_AGENT_SESSION_ROLLOVER_TIMEZONE.trim()
    : undefined;
  return {
    mode,
    idleTimeoutMs,
    rollover,
    ...(rolloverTimezone === undefined ? {} : { rolloverTimezone }),
  };
}

function readMemoryConfig(env: Record<string, string | undefined>, cwd: string): MonoAgentConfig["memory"] | undefined {
  const rawPath = normalizeOptionalString(env.MONO_AGENT_MEMORY_PATH);
  if (rawPath === undefined) {
    // Any memory env var set without a path is a misconfiguration — fail closed rather than
    // silently ignoring it. Covers every behavior-configuring var (not just embeddings). The
    // retired _GRAPH_PATH/_SCOPE/_TOOLS_ENABLED keys are deliberately omitted: the loader tolerates
    // them for backward-compat with pre-v2 configs.
    const orphaned = [
      "MONO_AGENT_MEMORY_MODE",
      "MONO_AGENT_MEMORY_WRITE_MODE",
      "MONO_AGENT_MEMORY_MAX_BYTES",
      "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER",
      "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL",
      "MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT",
      "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
      "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV",
      "MONO_AGENT_MEMORY_EMBEDDINGS_DIM",
      "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS",
      "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
      "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS",
      "MONO_AGENT_MEMORY_LLM_PROVIDER",
      "MONO_AGENT_MEMORY_LLM_MODEL",
      "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
      "MONO_AGENT_MEMORY_LLM_ENDPOINT",
      "MONO_AGENT_MEMORY_LLM_TIMEOUT_MS",
      "MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED",
      "MONO_AGENT_MEMORY_REFLECTION_ENABLED",
      "MONO_AGENT_MEMORY_REFLECTION_CRON",
      "MONO_AGENT_MEMORY_MIGRATION_ENABLED",
      "MONO_AGENT_MEMORY_MIGRATION_CRON",
    ].find((name) => normalizeOptionalString(env[name]) !== undefined);
    if (orphaned !== undefined) {
      throw new MonoAgentConfigError("invalid_env", `${orphaned} requires MONO_AGENT_MEMORY_PATH (or memory.path) to be set.`, {
        env: orphaned,
      });
    }
    return undefined;
  }

  const mode = readChoice<MemoryMode>(env.MONO_AGENT_MEMORY_MODE, "MONO_AGENT_MEMORY_MODE", [
    "lite",
    "journal",
    "bujo",
  ], "lite", invalidEnv);
  const writeMode = readChoice<MemoryWriteMode>(env.MONO_AGENT_MEMORY_WRITE_MODE, "MONO_AGENT_MEMORY_WRITE_MODE", [
    "disabled",
    "append-host-summary",
    "capture",
  ], "disabled", invalidEnv);
  if (writeMode === "capture" && mode !== "bujo") {
    throw new MonoAgentConfigError(
      "invalid_env",
      `MONO_AGENT_MEMORY_WRITE_MODE "capture" requires MONO_AGENT_MEMORY_MODE "bujo" (it needs a chat LLM).`,
      { env: "MONO_AGENT_MEMORY_WRITE_MODE" },
    );
  }
  const embeddings = readMemoryEmbeddingsConfig(env);
  const llm = readMemoryLlmConfig(env);
  const dim = readOptionalInteger(env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM, "MONO_AGENT_MEMORY_EMBEDDINGS_DIM", { min: 1, max: 16_384 });
  const reflection = readMemoryRitualConfig(env, "REFLECTION");
  const migration = readMemoryRitualConfig(env, "MIGRATION");

  const embeddingsWithDim =
    embeddings === undefined
      ? undefined
      : dim === undefined
        ? embeddings
        : { ...embeddings, dim };

  // Read-only memory_recall tool. Recall needs only embeddings + FTS (no chat LLM),
  // so it defaults on whenever the resolved tier can rank semantically — mode !== "lite"
  // AND embeddings are configured — and off for lite. An explicit env/JSON value always wins.
  const recallToolDefault = mode !== "lite" && embeddingsWithDim !== undefined;
  const recallToolEnabled = readBoolean(
    env.MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED,
    "MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED",
    recallToolDefault,
    invalidEnv,
  );

  return {
    mode,
    path: readPath(rawPath, cwd),
    maxBytes: readInteger(env.MONO_AGENT_MEMORY_MAX_BYTES, "MONO_AGENT_MEMORY_MAX_BYTES", DEFAULT_MEMORY_MAX_BYTES, invalidEnv, { min: 1, max: 1_000_000 }),
    writeMode,
    ...(embeddingsWithDim === undefined ? {} : { embeddings: embeddingsWithDim }),
    ...(llm === undefined ? {} : { llm }),
    recallTool: { enabled: recallToolEnabled },
    ...(reflection === undefined ? {} : { reflection }),
    ...(migration === undefined ? {} : { migration }),
  };
}

function readMemoryEmbeddingsConfig(env: Record<string, string | undefined>): MemoryEmbeddingsConfig | undefined {
  const hasEmbeddingsEnv = [
    env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS,
  ].some((value) => normalizeOptionalString(value) !== undefined);
  if (!hasEmbeddingsEnv) {
    return undefined;
  }

  const provider = readChoice<MemoryEmbeddingsProvider>(
    env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER,
    "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER",
    ["ollama", "openai"],
    "ollama",
    invalidEnv,
  );
  const model = normalizeOptionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL) ?? DEFAULT_EMBEDDINGS_MODELS[provider];
  const endpoint = normalizeOptionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT);
  const apiKeyEnv = normalizeOptionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV);
  const apiKey = (apiKeyEnv === undefined ? undefined : normalizeOptionalString(env[apiKeyEnv]))
    ?? normalizeOptionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY);
  if (provider === "openai" && apiKey === undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "openai memory embeddings require MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY (or apiKeyEnv pointing at a set variable).",
      { env: "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY" },
    );
  }
  const timeoutMs = readOptionalInteger(
    env.MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS,
    "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS",
    { min: 1, max: 600_000 },
  );
  const circuitBreaker = readMemoryEmbeddingsCircuitBreakerConfig(env);
  return {
    provider,
    model,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(circuitBreaker === undefined ? {} : { circuitBreaker }),
  };
}

function readMemoryEmbeddingsCircuitBreakerConfig(
  env: Record<string, string | undefined>,
): MemoryEmbeddingsCircuitBreakerConfig | undefined {
  const failureThreshold = readOptionalInteger(
    env.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
    { min: 1, max: 100 },
  );
  const cooldownMs = readOptionalInteger(
    env.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS,
    "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS",
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

function readMemoryLlmConfig(env: Record<string, string | undefined>): MemoryLlmConfig | undefined {
  const rawModel = normalizeOptionalString(env.MONO_AGENT_MEMORY_LLM_MODEL);
  if (rawModel === undefined) {
    return undefined;
  }
  const provider = readChoice<MemoryLlmProvider>(
    env.MONO_AGENT_MEMORY_LLM_PROVIDER,
    "MONO_AGENT_MEMORY_LLM_PROVIDER",
    ["ollama", "agent-host"],
    "ollama",
    invalidEnv,
  );
  const endpoint = normalizeOptionalString(env.MONO_AGENT_MEMORY_LLM_ENDPOINT);
  if (provider === "agent-host") {
    if (endpoint !== undefined) {
      throw new MonoAgentConfigError(
        "invalid_env",
        "MONO_AGENT_MEMORY_LLM_ENDPOINT is only valid when MONO_AGENT_MEMORY_LLM_PROVIDER is ollama.",
        { env: "MONO_AGENT_MEMORY_LLM_ENDPOINT" },
      );
    }
    let model: MonoAgentConfig["runtime"]["model"];
    try {
      model = parseMonoRuntimeModelReference(rawModel);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MonoAgentConfigError(
        "invalid_model_reference",
        "MONO_AGENT_MEMORY_LLM_MODEL is not a valid runtime model reference for agent-host memory LLM.",
        { env: "MONO_AGENT_MEMORY_LLM_MODEL", reason },
      );
    }
    const executionMode = readMemoryLlmExecutionMode(env.MONO_AGENT_MEMORY_LLM_EXECUTION_MODE, model);
    const trace =
      normalizeOptionalString(env.MONO_AGENT_MEMORY_LLM_TRACE) === undefined
        ? undefined
        : readBoolean(env.MONO_AGENT_MEMORY_LLM_TRACE, "MONO_AGENT_MEMORY_LLM_TRACE", true, invalidEnv);
    const timeoutMs = readOptionalInteger(env.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS, "MONO_AGENT_MEMORY_LLM_TIMEOUT_MS", {
      min: 1_000,
      max: 600_000,
    });
    return {
      provider,
      model: rawModel,
      executionMode,
      ...(trace === undefined ? {} : { trace }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (normalizeOptionalString(env.MONO_AGENT_MEMORY_LLM_EXECUTION_MODE) !== undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE is only valid when MONO_AGENT_MEMORY_LLM_PROVIDER is agent-host.",
      { env: "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE" },
    );
  }
  if (normalizeOptionalString(env.MONO_AGENT_MEMORY_LLM_TRACE) !== undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_MEMORY_LLM_TRACE is only valid when MONO_AGENT_MEMORY_LLM_PROVIDER is agent-host.",
      { env: "MONO_AGENT_MEMORY_LLM_TRACE" },
    );
  }
  if (normalizeOptionalString(env.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS) !== undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_MEMORY_LLM_TIMEOUT_MS is only valid when MONO_AGENT_MEMORY_LLM_PROVIDER is agent-host.",
      { env: "MONO_AGENT_MEMORY_LLM_TIMEOUT_MS" },
    );
  }
  return {
    provider,
    model: rawModel,
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

function readMemoryLlmExecutionMode(
  raw: string | undefined,
  model: MonoAgentConfig["runtime"]["model"],
): RuntimeExecutionMode {
  const normalized = normalizeOptionalString(raw);
  let executionMode: RuntimeExecutionMode;
  if (normalized === undefined) {
    executionMode = defaultExecutionModeForModel(model);
  } else {
    if (!isRuntimeExecutionMode(normalized)) {
      throw new MonoAgentConfigError("invalid_env", "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE must be sdk or cli.", {
        env: "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
      });
    }
    executionMode = normalized;
  }
  try {
    assertExecutionModeCompatible(model, executionMode);
  } catch (error) {
    if (error instanceof RuntimeAdapterError && error.code === "incompatible_execution_mode") {
      throw new MonoAgentConfigError(
        "incompatible_execution_mode",
        "memory.llm agent-host model and execution mode are incompatible.",
        {
          env: normalized === undefined ? "MONO_AGENT_MEMORY_LLM_MODEL" : "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
          reason: error.message,
        },
      );
    }
    throw error;
  }
  if (executionMode !== "sdk") {
    throw new MonoAgentConfigError(
      "incompatible_execution_mode",
      "memory.llm provider agent-host currently supports SDK execution mode only; CLI-backed memory LLMs are rejected because they cannot yet enforce no external actions.",
      {
        env: normalized === undefined ? "MONO_AGENT_MEMORY_LLM_MODEL" : "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
      },
    );
  }
  return executionMode;
}

/**
 * Reads an optional ritual config block (reflection or migration) from env.
 * Returns undefined when neither `_ENABLED` nor `_CRON` is present — the
 * object is only added to memory config when the user explicitly configures it.
 *
 * @param suffix - uppercase discriminator: "REFLECTION" or "MIGRATION"
 */
function readMemoryRitualConfig(
  env: Record<string, string | undefined>,
  suffix: "REFLECTION" | "MIGRATION",
): MemoryRitualConfig | undefined {
  const enabledKey = `MONO_AGENT_MEMORY_${suffix}_ENABLED`;
  const cronKey = `MONO_AGENT_MEMORY_${suffix}_CRON`;
  const hasEnabled = normalizeOptionalString(env[enabledKey]) !== undefined;
  const hasCron = normalizeOptionalString(env[cronKey]) !== undefined;
  if (!hasEnabled && !hasCron) {
    return undefined;
  }
  const enabled = hasEnabled
    ? readBoolean(env[enabledKey], enabledKey, true, invalidEnv)
    : undefined;
  const cron = normalizeOptionalString(env[cronKey]);
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(cron === undefined ? {} : { cron }),
  };
}

function readTraceabilityConfig(env: Record<string, string | undefined>, cwd: string): MonoAgentConfig["traceability"] {
  const registryDir = readPath(
    env.MONO_AGENT_TRACE_REGISTRY_DIR,
    cwd,
    resolve(homedir(), ".mono-agent", "trace-sources"),
  );
  const sourceId = normalizeOptionalString(env.MONO_AGENT_TRACE_SOURCE_ID);
  const sourceLabel = normalizeOptionalString(env.MONO_AGENT_TRACE_SOURCE_LABEL);
  const heartbeatMs = readInteger(env.MONO_AGENT_TRACE_HEARTBEAT_MS, "MONO_AGENT_TRACE_HEARTBEAT_MS", DEFAULT_TRACE_HEARTBEAT_MS, invalidEnv, {
    min: 250,
    max: 86_400_000,
  });
  const staleAfterMs = readInteger(env.MONO_AGENT_TRACE_STALE_AFTER_MS, "MONO_AGENT_TRACE_STALE_AFTER_MS", DEFAULT_TRACE_STALE_AFTER_MS, invalidEnv, {
    min: 1_000,
    max: 604_800_000,
  });
  return {
    registryDir,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    heartbeatMs,
    staleAfterMs,
  };
}

/**
 * Read the optional observability exporter block from
 * `MONO_AGENT_OBSERVABILITY_EXPORTERS` (a JSON array). Modeled on
 * {@link readLocalProvidersJson}: env-first, shape-only validation, no network.
 * Endpoint reachability is intentionally NOT probed here — that is `validate`'s
 * job (spec section 9). Returns undefined when the var is absent so the
 * conditional-spread idiom keeps `observability` off the config when unused.
 */
function readObservabilityConfig(
  env: Record<string, string | undefined>,
): MonoAgentConfig["observability"] | undefined {
  const raw = normalizeOptionalString(env.MONO_AGENT_OBSERVABILITY_EXPORTERS);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MonoAgentConfigError("invalid_json", "MONO_AGENT_OBSERVABILITY_EXPORTERS must contain valid JSON.", {
      env: "MONO_AGENT_OBSERVABILITY_EXPORTERS",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    throw new MonoAgentConfigError("invalid_env", "MONO_AGENT_OBSERVABILITY_EXPORTERS must be a JSON array.", {
      env: "MONO_AGENT_OBSERVABILITY_EXPORTERS",
    });
  }
  // Only the first exporter is wired (runtime/status/validate read exporters[0]).
  // Reject >1 loudly rather than silently dropping the rest.
  if (parsed.length > 1) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_OBSERVABILITY_EXPORTERS supports a single exporter; configure exactly one.",
      { env: "MONO_AGENT_OBSERVABILITY_EXPORTERS" },
    );
  }
  const exporters = parsed.map((value, index) =>
    normalizeExporterFromUnknown(value, `MONO_AGENT_OBSERVABILITY_EXPORTERS[${index}]`),
  );
  return { exporters };
}

function normalizeExporterFromUnknown(value: unknown, source: string): ObservabilityExporterConfig {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source} must be an object.`, { env: source });
  }
  // A present-but-non-string `type` is an invalid type and must fail clearly,
  // not silently collapse to undefined (and thus the phoenix default).
  if (value.type !== undefined && typeof value.type !== "string") {
    throw new MonoAgentConfigError("invalid_env", `${source}.type must be a string.`, { env: source });
  }
  const type = readChoice<(typeof OBSERVABILITY_EXPORTER_TYPES)[number]>(
    typeof value.type === "string" ? value.type : undefined,
    source,
    OBSERVABILITY_EXPORTER_TYPES,
    OBSERVABILITY_EXPORTER_TYPES[0],
    invalidEnv,
  );
  const endpointRaw = readObjectString(value, "endpoint", source, false);
  const endpoint = endpointRaw === undefined ? DEFAULT_PHOENIX_ENDPOINT : validateEndpoint(endpointRaw, source);
  const headers = readStringRecord(value.headers, "headers", source);
  const includeSensitiveData = readObjectBoolean(value, "includeSensitiveData", false, source);
  const timeoutMs = readObjectInteger(value, "timeoutMs", source, { min: 1, max: 60_000 });
  const projectName = readObjectString(value, "projectName", source, false);
  return {
    type,
    endpoint,
    ...(headers === undefined ? {} : { headers }),
    includeSensitiveData,
    timeoutMs: timeoutMs ?? DEFAULT_PHOENIX_TIMEOUT_MS,
    ...(projectName === undefined ? {} : { projectName }),
  };
}

/**
 * Shape-validate an endpoint string via `new URL` — never performs a request.
 * Also rejects credential/secret-bearing URL components (userinfo, query,
 * fragment): the raw endpoint is printed and persisted in plaintext via
 * start/status/doctor and trace-source metadata, so a `user:pass@`, `?api_key=`
 * or `#token` would leak. Secrets belong in `headers`, which are redacted.
 */
function validateEndpoint(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MonoAgentConfigError("invalid_env", `${source}.endpoint must be a valid URL.`, { env: source });
  }
  assertEndpointHasNoSecrets(url, source);
  return value;
}

/**
 * Reject URL components that can smuggle credentials into a plaintext-displayed
 * endpoint. Shared shape so the core config and the app resolver agree.
 */
function assertEndpointHasNoSecrets(url: URL, source: string): void {
  if (url.username !== "" || url.password !== "") {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${source}.endpoint must not embed credentials (user:pass@); put secrets in headers instead.`,
      { env: source },
    );
  }
  if (url.search !== "") {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${source}.endpoint must not contain a query string; put tokens in headers instead.`,
      { env: source },
    );
  }
  if (url.hash !== "") {
    throw new MonoAgentConfigError("invalid_env", `${source}.endpoint must not contain a URL fragment.`, {
      env: source,
    });
  }
}

/** Read an optional object of string->non-empty-string (e.g. HTTP headers). */
function readStringRecord(
  value: unknown,
  key: string,
  source: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source}.${key} must be an object.`, { env: source });
  }
  const out: Record<string, string> = {};
  for (const [headerKey, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string" || headerValue.length === 0) {
      throw new MonoAgentConfigError(
        "invalid_env",
        `${source}.${key}.${headerKey} must be a non-empty string.`,
        { env: source },
      );
    }
    out[headerKey] = headerValue;
  }
  return out;
}

/** Read an optional integer field from a parsed object, bounded and integer-checked. */
function readObjectInteger(
  object: Record<string, unknown>,
  key: string,
  source: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${source}.${key} must be an integer between ${bounds.min} and ${bounds.max}.`,
      { env: source },
    );
  }
  return value;
}

function redactObservabilityConfig(
  observability: NonNullable<MonoAgentConfig["observability"]>,
): RedactedObservabilityConfig {
  return {
    exporters: observability.exporters.map((exporter) => {
      const { headers, ...rest } = exporter;
      if (headers === undefined) {
        return rest;
      }
      const redactedHeaders: Record<string, "[redacted]"> = {};
      for (const headerKey of Object.keys(headers)) {
        redactedHeaders[headerKey] = "[redacted]";
      }
      return { ...rest, headers: redactedHeaders };
    }),
  };
}

function readLocalProviders(env: Record<string, string | undefined>): readonly LocalProviderDefinition[] {
  const registryJson = normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDERS_JSON);
  if (registryJson !== undefined) {
    return readLocalProvidersJson(registryJson, env);
  }

  const id = normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_ID);
  const type = normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_TYPE);
  const baseUrl = normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_BASE_URL);
  const hasOneProviderEnv = id !== undefined ||
    type !== undefined ||
    baseUrl !== undefined ||
    normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_ENABLED) !== undefined ||
    normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL) !== undefined ||
    normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_API_KEY) !== undefined;
  if (!hasOneProviderEnv) {
    return [];
  }

  const provider = normalizeLocalProviderFromUnknown({
    id: id ?? "ollama",
    type: type ?? "ollama",
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: readBoolean(env.MONO_AGENT_LOCAL_PROVIDER_ENABLED, "MONO_AGENT_LOCAL_PROVIDER_ENABLED", true, invalidEnv),
    trustPublicUrl: readBoolean(env.MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL, "MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL", false, invalidEnv),
    ...(normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_API_KEY) === undefined
      ? {}
      : { apiKey: normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_API_KEY) as string }),
  }, env, "MONO_AGENT_LOCAL_PROVIDER");

  return [provider];
}

function readLocalProvidersJson(
  value: string,
  env: Record<string, string | undefined>,
): readonly LocalProviderDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new MonoAgentConfigError("invalid_json", "MONO_AGENT_LOCAL_PROVIDERS_JSON must contain valid JSON.", {
      env: "MONO_AGENT_LOCAL_PROVIDERS_JSON",
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const rawProviders = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.local)
      ? parsed.local
      : undefined;
  if (rawProviders === undefined) {
    throw new MonoAgentConfigError("invalid_env", "MONO_AGENT_LOCAL_PROVIDERS_JSON must be an array or an object with local array.", {
      env: "MONO_AGENT_LOCAL_PROVIDERS_JSON",
    });
  }

  return rawProviders.map((provider, index) => normalizeLocalProviderFromUnknown(
    provider,
    env,
    `MONO_AGENT_LOCAL_PROVIDERS_JSON[${index}]`,
  ));
}

function normalizeLocalProviderFromUnknown(
  value: unknown,
  env: Record<string, string | undefined>,
  source: string,
): LocalProviderDefinition {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source} must be an object.`, { env: source });
  }

  const id = readObjectString(value, "id", source, true) as string;
  const type = readObjectString(value, "type", source, true) as LocalProviderDefinition["type"];
  const baseUrl = readObjectString(value, "baseUrl", source, false);
  const apiKeyEnv = readObjectString(value, "apiKeyEnv", source, false);
  const apiKeyFromEnv = apiKeyEnv === undefined ? undefined : normalizeOptionalString(env[apiKeyEnv]);
  const inlineApiKey = readObjectString(value, "apiKey", source, false);
  const apiKey = apiKeyFromEnv ?? inlineApiKey;
  const models = readLocalProviderModels(value.models, source);
  const provider: LocalProviderDefinition = {
    id,
    type,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: readObjectBoolean(value, "enabled", true, source),
    trustPublicUrl: readObjectBoolean(value, "trustPublicUrl", false, source),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(models.length === 0 ? {} : { models }),
  };

  try {
    return validateLocalProviderDefinition(provider);
  } catch (error) {
    if (error instanceof RuntimeAdapterError) {
      throw new MonoAgentConfigError("invalid_env", error.message, {
        env: source,
        reason: error.message,
      });
    }
    throw error;
  }
}

function readLocalProviderModels(value: unknown, source: string): readonly LocalProviderModelDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source}.models must be an array.`, { env: source });
  }
  return value.map((model, index) => {
    const modelSource = `${source}.models[${index}]`;
    if (!isRecord(model) || Array.isArray(model)) {
      throw new MonoAgentConfigError("invalid_env", `${modelSource} must be an object.`, { env: modelSource });
    }
    const name = readObjectString(model, "name", modelSource, true) as string;
    const alias = readObjectString(model, "alias", modelSource, false);
    const displayName = readObjectString(model, "displayName", modelSource, false);
    return {
      name,
      ...(alias === undefined ? {} : { alias }),
      ...(displayName === undefined ? {} : { displayName }),
      enabled: readObjectBoolean(model, "enabled", true, modelSource),
      ...(model.capabilities === undefined ? {} : { capabilities: readPlainObject(model.capabilities, `${modelSource}.capabilities`) }),
      ...(model.pricing === undefined ? {} : { pricing: readPlainObject(model.pricing, `${modelSource}.pricing`) }),
    };
  });
}

function withRedactedProviders(
  redacted: RedactedMonoAgentConfig,
  config: MonoAgentConfig,
): RedactedMonoAgentConfig {
  if (config.providers === undefined) {
    return redacted;
  }
  return {
    ...redacted,
    providers: {
      ...(config.providers.piAuthPath === undefined ? {} : { piAuthPath: config.providers.piAuthPath }),
      // pi-native knobs carry no secrets — pass them through so redacted config
      // surfaces (e.g. the TUI config pane) still show them.
      ...(config.providers.piNative === undefined ? {} : { piNative: config.providers.piNative }),
      ...(config.providers.local === undefined
        ? {}
        : {
            local: config.providers.local.map((provider) => {
              const { apiKey, ...safeProvider } = provider;
              return {
                ...safeProvider,
                ...(apiKey === undefined ? {} : { apiKey: redactedSecret(apiKey) }),
              };
            }),
          }),
    },
  };
}

function readRequired(env: Record<string, string | undefined>, name: string): string {
  const value = normalizeOptionalString(env[name]);
  if (value === undefined) {
    throw new MonoAgentConfigError("missing_required_env", `${name} is required.`, { env: name });
  }
  return value;
}

function readEffort(raw: string | undefined): EffortLevel | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return undefined;
  }
  return readChoice<EffortLevel>(normalized, "MONO_AGENT_EFFORT", EFFORT_LEVELS, EFFORT_LEVELS[0], invalidEnv);
}

function readPermissionMode(raw: string | undefined): PermissionMode | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return undefined;
  }
  return readChoice<PermissionMode>(normalized, "MONO_AGENT_PERMISSION_MODE", PERMISSION_MODES, PERMISSION_MODES[0], invalidEnv);
}

function readConcurrencyConfig(env: Record<string, string | undefined>): MonoAgentConfig["concurrency"] | undefined {
  const maxConcurrentRuns = readOptionalInteger(
    env.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS,
    "MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS",
    { min: 1, max: 100_000 },
  );
  const maxPendingRuns = readOptionalInteger(
    env.MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS,
    "MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS",
    { min: 1, max: 100_000 },
  );
  if (maxConcurrentRuns === undefined && maxPendingRuns === undefined) {
    return undefined;
  }
  return {
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
    ...(maxPendingRuns === undefined ? {} : { maxPendingRuns }),
  };
}

function readPiNativeProviderConfig(
  env: Record<string, string | undefined>,
  cwd: string,
): PiNativeProviderConfig | undefined {
  const hasAny = [
    env.MONO_AGENT_PI_MAX_RETRIES,
    env.MONO_AGENT_MAX_RETRY_DELAY_MS,
    env.MONO_AGENT_PI_SESSIONS_ROOT,
  ].some((value) => normalizeOptionalString(value) !== undefined);
  if (!hasAny) {
    return undefined;
  }
  const piMaxRetries = readOptionalInteger(env.MONO_AGENT_PI_MAX_RETRIES, "MONO_AGENT_PI_MAX_RETRIES", { min: 0, max: 8 });
  const maxRetryDelayMs = readOptionalInteger(env.MONO_AGENT_MAX_RETRY_DELAY_MS, "MONO_AGENT_MAX_RETRY_DELAY_MS", { min: 100, max: 3_600_000 });
  const piSessionsRoot = readOptionalPath(env.MONO_AGENT_PI_SESSIONS_ROOT, cwd);
  return {
    ...(piMaxRetries === undefined ? {} : { piMaxRetries }),
    ...(maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs }),
    ...(piSessionsRoot === undefined ? {} : { piSessionsRoot }),
  };
}

function readOptionalInteger(
  raw: string | undefined,
  name: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  if (normalizeOptionalString(raw) === undefined) {
    return undefined;
  }
  return readInteger(raw, name, bounds.min, invalidEnv, bounds);
}

function readPath(raw: string | undefined, cwd: string, defaultPath?: string): string {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    if (defaultPath !== undefined) {
      return defaultPath;
    }
    throw new MonoAgentConfigError("invalid_env", "Path value is required.");
  }
  return resolve(cwd, normalized);
}

function readOptionalPath(raw: string | undefined, cwd: string): string | undefined {
  const normalized = normalizeOptionalString(raw);
  return normalized === undefined ? undefined : resolve(cwd, normalized);
}

function readObjectString(
  object: Record<string, unknown>,
  key: string,
  source: string,
  required: boolean,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    if (required) {
      throw new MonoAgentConfigError("invalid_env", `${source}.${key} is required.`, { env: source });
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new MonoAgentConfigError("invalid_env", `${source}.${key} must be a non-empty trimmed string.`, { env: source });
  }
  return value;
}

function readObjectBoolean(
  object: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
  source: string,
): boolean {
  const value = object[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new MonoAgentConfigError("invalid_env", `${source}.${key} must be a boolean.`, { env: source });
}

function readPlainObject(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source} must be an object.`, { env: source });
  }
  return { ...value };
}

function normalizeCwd(value: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    throw new MonoAgentConfigError("invalid_env", "cwd must be a non-empty path.");
  }
  return resolve(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
