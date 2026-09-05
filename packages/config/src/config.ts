import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  isAutodiscoverableProviderId,
  isPiBuiltinProvider,
  localProviderDefinitionFor,
  MODEL_REFERENCE_ECHO_MAX_BYTES,
  MODEL_REFERENCE_REASON_MAX_BYTES,
  modelReferenceKey,
  parseMonoRuntimeModelReference,
  PI_TRANSPORTS,
  RuntimeAdapterError,
  sanitizeModelReferenceText,
  validateLocalProviderDefinition,
  validateProviderDefinition,
} from "@mono-agent/runtime-adapter";
import type { LocalProviderDefinition, LocalProviderModelDefinition, PiTransport, ProviderDefinition, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import {
  SANDBOX_FALLBACKS,
  SANDBOX_MODES,
  SANDBOX_NETWORK_MODES,
  SandboxPolicyError,
  createSandboxPolicy,
} from "@mono-agent/runtime-adapter";
import type { SandboxFallback, SandboxMode, SandboxNetworkMode } from "@mono-agent/runtime-adapter";
import {
  normalizeOptionalString,
  readBoolean,
  readChoice,
  readCsv,
  readInteger,
  redactedSecret,
} from "@mono-agent/agent-contracts";
import type { ConfigErrorFactory } from "@mono-agent/agent-contracts";

import {
  ALLOW_ALL_TOOLS,
  EFFORT_LEVELS,
  MEMORY_BACKENDS,
  MEMORY_EMBEDDINGS_PROVIDERS,
  MEMORY_LLM_PROVIDERS,
  MEMORY_MODES,
  MEMORY_WRITE_MODES,
  PERMISSION_MODES,
} from "./enums.js";
import type { EffortLevel, MemoryBackend, MemoryConsolidationConfig, MemoryEmbeddingsCircuitBreakerConfig, MemoryEmbeddingsConfig, MemoryEmbeddingsProvider, MemoryLlmConfig, MemoryLlmProvider, MemoryMode, MemorySupermemoryConfig, MemoryWriteMode, MonoAgentConfig, ObservabilityExporterConfig, PermissionMode, PiNativeProviderConfig, RedactedMonoAgentConfig, RedactedObservabilityConfig, ResolvedProviders, MonoAgentInlineSubagentsConfig, MonoAgentSubagentConfig, MonoAgentSubagentsConfig, RuntimeFallbackConfig, RuntimeRetryConfig, SessionMode, SessionRollover, SkillDisclosureMode, WebFetchRenderMode, WebSearchBackend } from "./types.js";

export type MonoAgentConfigErrorCode =
  | "missing_required_env"
  | "invalid_env"
  | "invalid_json"
  | "invalid_model_reference";

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
 * `@mono-agent/agent-contracts` coercers so their fail-closed throws keep config's
 * typed error shape (code + env/reason details) verbatim.
 */
const invalidEnv: ConfigErrorFactory = (message, details) =>
  new MonoAgentConfigError("invalid_env", message, details);

export interface LoadMonoAgentConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
}

/**
 * Retired settings stay explicit here so every loader entry point gives the
 * same repair instead of silently dropping a fallback chain or surfacing an
 * unactionable unknown-key error from a host-owned schema.
 *
 * `message` repairs the JSON key; `envMessage` repairs the environment variable.
 * They are separate on purpose: an operator whose `.env` still sets
 * `MONO_AGENT_FALLBACK_MODELS` has no `runtime.fallbackModels` key to rewrite, so
 * pointing at the JSON shape is not a repair they can carry out. Hand-migration is
 * only safe if the repair names the surface the operator is actually holding.
 */
export const RETIRED_CONFIG_FIELDS = [
  {
    path: "runtime.executionMode",
    env: "MONO_AGENT_EXECUTION_MODE",
    message: "`runtime.executionMode` was removed; mono-agent runs only the Pi runtime (SDK). Delete the key.",
    envMessage: "`MONO_AGENT_EXECUTION_MODE` was removed; mono-agent runs only the Pi runtime (SDK). Remove the variable from your environment and `.env`.",
  },
  {
    path: "runtime.routeSafety",
    env: "MONO_AGENT_ROUTE_SAFETY",
    message: "`runtime.routeSafety` was removed; every route is Pi-native, so `per-route-native` has no meaning. Delete the key.",
    envMessage: "`MONO_AGENT_ROUTE_SAFETY` was removed; every route is Pi-native, so `per-route-native` has no meaning. Remove the variable from your environment and `.env`.",
  },
  {
    path: "runtime.fallbackModels",
    env: "MONO_AGENT_FALLBACK_MODELS",
    message: "`runtime.fallbackModels` was replaced by `runtime.fallbacks: [{ \"model\": \"...\" }]`. Replace the key with that shape.",
    envMessage: "`MONO_AGENT_FALLBACK_MODELS` was replaced by `MONO_AGENT_FALLBACKS_JSON`, a JSON array of `{ \"model\": \"...\" }` objects. Remove the variable and re-express the chain there, or drop it into `runtime.fallbacks` in mono-agent.config.json.",
  },
  {
    path: "memory.llm.executionMode",
    env: "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE",
    message: "`memory.llm.executionMode` was removed for the same reason as `runtime.executionMode`: mono-agent runs only the Pi runtime (SDK). Delete the key.",
    envMessage: "`MONO_AGENT_MEMORY_LLM_EXECUTION_MODE` was removed for the same reason as `MONO_AGENT_EXECUTION_MODE`: mono-agent runs only the Pi runtime (SDK). Remove the variable from your environment and `.env`.",
  },
] as const;

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 1_800_000;
const DEFAULT_MEMORY_MAX_BYTES = 64_000;
const DEFAULT_EMBEDDINGS_MODELS: Record<MemoryEmbeddingsProvider, string> = {
  ollama: "nomic-embed-text:v1.5",
  lmstudio: "text-embedding-nomic-embed-text-v1.5",
  openai: "text-embedding-3-small",
};
/**
 * Keep model first: the layered loader uses this order when attributing an
 * incompatible memory.llm environment field.
 */
export const MEMORY_LLM_ENV_KEYS = [
  "MONO_AGENT_MEMORY_LLM_MODEL",
  "MONO_AGENT_MEMORY_LLM_PROVIDER",
  "MONO_AGENT_MEMORY_LLM_ENDPOINT",
  "MONO_AGENT_MEMORY_LLM_TRACE",
  "MONO_AGENT_MEMORY_LLM_TIMEOUT_MS",
] as const;
export const DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS = 365;
export const DEFAULT_ARTIFACT_RETENTION_MAX_COUNT = 50_000;
export const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS = 7;
export const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT = 5_000;
const DEFAULT_TRACE_HEARTBEAT_MS = 10_000;
const DEFAULT_TRACE_STALE_AFTER_MS = 30_000;
const OBSERVABILITY_EXPORTER_TYPES = ["phoenix"] as const;
const DEFAULT_PHOENIX_ENDPOINT = "http://127.0.0.1:6006/v1/traces";
const DEFAULT_PHOENIX_TIMEOUT_MS = 5_000;
const DEFAULT_PI_AUTH_PATH = resolve(homedir(), ".pi", "agent", "auth.json");
export const MAX_AGENT_NAME_LENGTH = 80;

export function loadMonoAgentConfig(input: LoadMonoAgentConfigInput): MonoAgentConfig {
  assertNoRetiredConfigEnv(input.env);
  const cwd = normalizeCwd(input.cwd);
  const agentName = readAgentName(input.env.MONO_AGENT_NAME);
  const model = parseModel(readRequired(input.env, "MONO_AGENT_MODEL"));
  const fallbacks = readFallbacks(input.env);
  const retry = readRetryConfig(input.env);
  assertUniqueFallbackRoutes(model, fallbacks);
  const maxTurns = readMaxTurns(input.env.MONO_AGENT_MAX_TURNS);
  const compaction = readRuntimeCompactionConfig(input.env);
  const workspace = readPath(input.env.MONO_AGENT_WORKSPACE, cwd, cwd);
  const session = readSessionConfig(input.env);
  const identityPath = readPath(readRequired(input.env, "MONO_AGENT_IDENTITY_PATH"), cwd);
  const soulPath = readOptionalPath(input.env.MONO_AGENT_SOUL_PATH, cwd);
  const skillsRoot = readOptionalPath(input.env.MONO_AGENT_SKILLS_ROOT, cwd);
  const selectedSkills = readCsv(input.env.MONO_AGENT_SELECTED_SKILLS);
  // The skills loader rejects caps below 256 bytes; validate at the same floor.
  const skillMaxBytes = readOptionalInteger(input.env.MONO_AGENT_SKILL_MAX_BYTES, "MONO_AGENT_SKILL_MAX_BYTES", { min: 256, max: 1_000_000 });
  // Unset stays undefined so the harness default ("full" legacy) is preserved
  // byte-for-byte; only validate the choice when an operator opts in explicitly.
  const skillDisclosure = normalizeOptionalString(input.env.MONO_AGENT_SKILL_DISCLOSURE) === undefined
    ? undefined
    : readChoice<SkillDisclosureMode>(input.env.MONO_AGENT_SKILL_DISCLOSURE, "MONO_AGENT_SKILL_DISCLOSURE", ["index", "full"], "full", invalidEnv);
  const memory = readMemoryConfig(input.env, cwd);
  const mcpConfigPath = readOptionalPath(input.env.MONO_AGENT_MCP_CONFIG_PATH, cwd);
  const mcpRequestContextServers = readCsv(input.env.MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS);
  const continuationServers = readCsv(input.env.MONO_AGENT_CONTINUATION_SERVERS);
  const sandbox = readSandboxConfig(input.env, workspace);
  const artifactDir = readPath(input.env.MONO_AGENT_ARTIFACT_DIR, cwd, resolve(cwd, ".mono-agent", "artifacts"));
  const artifactRetention = readArtifactRetentionConfig(input.env);
  const memoryArtifactRetention = readMemoryArtifactRetentionConfig(input.env, artifactRetention);
  const traceability = readTraceabilityConfig(input.env, cwd, agentName);
  const observability = readObservabilityConfig(input.env);
  // Pi's auth path is routinely documented with a home-relative `~` prefix.
  // `path.resolve()` treats that prefix as a literal directory, so keep the
  // expansion explicit and limited to this user-owned credential path.
  const providerEnvelope = readConfiguredProviders(input.env);
  const providerEnv = layerProviderReservedValuesOntoEnv(providerEnvelope, input.env);
  const piAuthPath = readUserPath(providerEnv.MONO_AGENT_PI_AUTH_PATH, cwd, DEFAULT_PI_AUTH_PATH);
  const piNative = readPiNativeProviderConfig(providerEnv, cwd);
  const localProviders = providerEnvelope.entries
    .map((provider) => localProviderDefinitionFor(provider))
    .filter((provider): provider is LocalProviderDefinition => provider !== undefined);

  const effort = readEffort(input.env.MONO_AGENT_EFFORT);
  const permissionMode = readPermissionMode(input.env.MONO_AGENT_PERMISSION_MODE);
  const concurrency = readConcurrencyConfig(input.env);
  const subagents = readSubagentsConfig(input.env, cwd);
  const subagentRoutes = subagentProviderRoutes(subagents);
  const runtime: MonoAgentConfig["runtime"] = {
    model,
    ...(fallbacks.length === 0 ? {} : { fallbacks }),
    retry,
    ...(maxTurns === undefined ? {} : { maxTurns }),
    compaction,
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
    ...(skillDisclosure === undefined ? {} : { skillDisclosure }),
  };

  const mcpCallTimeoutMs = readOptionalTimeoutMs(input.env.MONO_AGENT_MCP_CALL_TIMEOUT_MS, "MONO_AGENT_MCP_CALL_TIMEOUT_MS");
  const mcpCallMaxTotalTimeoutMs = readOptionalTimeoutMs(
    input.env.MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS,
    "MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS",
  );
  const webSearchBackend = readChoice<WebSearchBackend>(
    input.env.MONO_AGENT_WEB_SEARCH_BACKEND,
    "MONO_AGENT_WEB_SEARCH_BACKEND",
    ["auto", "searxng", "codex", "keyless"],
    "auto",
    invalidEnv,
  );
  const webSearchEndpoint = readWebSearchEndpoint(input.env.MONO_AGENT_WEB_SEARCH_ENDPOINT);
  const webSearchCodexModel = readWebSearchCodexModel(input.env.MONO_AGENT_WEB_SEARCH_CODEX_MODEL);
  if (webSearchBackend === "searxng" && webSearchEndpoint === undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_WEB_SEARCH_ENDPOINT is required when MONO_AGENT_WEB_SEARCH_BACKEND=searxng.",
      { env: "MONO_AGENT_WEB_SEARCH_ENDPOINT" },
    );
  }
  const webFetchRender = readChoice<WebFetchRenderMode>(
    input.env.MONO_AGENT_WEB_FETCH_RENDER,
    "MONO_AGENT_WEB_FETCH_RENDER",
    ["never", "auto"],
    "never",
    invalidEnv,
  );
  const webBrowserCommand = readWebBrowserCommand(input.env.MONO_AGENT_WEB_BROWSER_COMMAND);
  const tools: MonoAgentConfig["tools"] = {
    // Omitted `tools.allowedTools` (env unset) → allow-all default; an explicit empty
    // list arrives as `MONO_AGENT_ALLOWED_TOOLS=""` (readCsv → []) meaning chat-only.
    allowedTools:
      input.env.MONO_AGENT_ALLOWED_TOOLS === undefined
        ? [ALLOW_ALL_TOOLS]
        : readCsv(input.env.MONO_AGENT_ALLOWED_TOOLS),
    disallowedTools: readCsv(input.env.MONO_AGENT_DISALLOWED_TOOLS),
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
    ...(mcpRequestContextServers.length === 0 ? {} : { mcpRequestContextServers }),
    ...(continuationServers.length === 0 ? {} : { continuationServers }),
    ...(mcpCallTimeoutMs === undefined ? {} : { mcpCallTimeoutMs }),
    ...(mcpCallMaxTotalTimeoutMs === undefined ? {} : { mcpCallMaxTotalTimeoutMs }),
    web: {
      coordination: readChoice(input.env.MONO_AGENT_WEB_COORDINATION, "MONO_AGENT_WEB_COORDINATION", ["process", "host"] as const, "process", invalidEnv),
      search: {
        backend: webSearchBackend,
        ...(webSearchEndpoint === undefined ? {} : { endpoint: webSearchEndpoint }),
        codex: { model: webSearchCodexModel },
      },
      fetch: {
        render: webFetchRender,
        browserCommand: webBrowserCommand,
      },
    },
  };

  const providers: NonNullable<MonoAgentConfig["providers"]> = {
    piAuthPath,
    ...(providerEnvelope.entries.length === 0 ? {} : { entries: providerEnvelope.entries }),
    ...(localProviders.length === 0 ? {} : { local: localProviders }),
    ...(piNative === undefined ? {} : { piNative }),
  };
  assertConfiguredProviderCoverage(model, fallbacks, resolveConfiguredProviders({ providers }), subagentRoutes);

  const config: MonoAgentConfig = {
    ...(agentName === undefined ? {} : { agent: { name: agentName } }),
    runtime,
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(subagents === undefined ? {} : { subagents }),
    context,
    tools,
    ...(sandbox === undefined ? {} : { sandbox }),
    artifacts: {
      dir: artifactDir,
      retention: artifactRetention,
      memoryRetention: memoryArtifactRetention,
    },
    traceability,
    ...(observability === undefined ? {} : { observability }),
    providers,
  };

  if (memory !== undefined) {
    return { ...config, memory };
  }
  return config;
}

/**
 * Normalize loaded/programmatic provider config into one deterministic view.
 * Loaded configs carry `entries`; the `local` fallback preserves compatibility
 * for embedders that still construct the pre-map shape by hand.
 */
export function resolveConfiguredProviders(
  config: Pick<MonoAgentConfig, "providers">,
): ResolvedProviders {
  const rawEntries = config.providers?.entries ?? config.providers?.local ?? [];
  const byId = new Map<string, ProviderDefinition>();
  for (const rawEntry of rawEntries) {
    const entry = validateProviderDefinition(rawEntry);
    if (byId.has(entry.id)) {
      throw new MonoAgentConfigError(
        "invalid_env",
        `Provider id "${entry.id}" is configured more than once. Remove the duplicate definition.`,
        { providerId: entry.id },
      );
    }
    byId.set(entry.id, entry);
  }
  const entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    piAuthPath: config.providers?.piAuthPath ?? DEFAULT_PI_AUTH_PATH,
    ...(config.providers?.piNative === undefined ? {} : { piNative: config.providers.piNative }),
  };
}

/** One authored model reference to validate, with the config path that owns it. */
export interface ProviderCoverageRoute {
  readonly model: RuntimeModelReference;
  /** Config path used verbatim in the failure message, e.g. `runtime.model`. */
  readonly path: string;
}

/**
 * Every authored `subagents.definitions[].model` is a real route: the harness
 * builds a runtime for it exactly like a fallback, so it must pass the same
 * provider gate. Left unchecked, a typo'd provider id loaded fine and only blew
 * up mid-turn, inside a subagent, where the failure is hardest to attribute.
 */
function subagentProviderRoutes(
  subagents: MonoAgentConfig["subagents"] | undefined,
): readonly ProviderCoverageRoute[] {
  return (subagents?.definitions ?? []).flatMap((definition, index) =>
    definition.model === undefined
      ? []
      : [{ model: definition.model, path: `subagents.definitions[${index}].model` }],
  );
}

/**
 * Fail early when a route names neither Pi's builtin catalog, an explicitly
 * configured provider, nor one of the two zero-config local discovery ids.
 * `additionalRoutes` carries model references authored outside
 * `runtime.model`/`runtime.fallbacks[]` (today: subagent profiles).
 */
export function assertConfiguredProviderCoverage(
  model: RuntimeModelReference,
  fallbacks: readonly RuntimeFallbackConfig[] | undefined,
  providers: ResolvedProviders,
  additionalRoutes: readonly ProviderCoverageRoute[] = [],
): void {
  const routes: readonly ProviderCoverageRoute[] = [
    { model, path: "runtime.model" },
    ...(fallbacks ?? []).map((fallback, index) => ({
      model: fallback.model,
      path: `runtime.fallbacks[${index}].model`,
    })),
    ...additionalRoutes,
  ];
  for (const route of routes) {
    const providerId = route.model.provider;
    const configured = providers.byId.get(providerId);
    // `enabled: false` is deliberately NOT a load error: for a local provider it
    // is a diagnosable state that `doctor` reports as waiting, and turning that
    // into a crash would break a working contract. What it must do is stop the
    // provider being advertised as selectable, which the catalog now enforces.
    if (isPiBuiltinProvider(providerId) || isAutodiscoverableProviderId(providerId)) {
      continue;
    }
    // A provider Pi does not know needs an endpoint to be reachable. Accepting a
    // bare `{}` here produced a config that validated, advertised an empty
    // catalog, and only failed at turn time with `pi model not found` -- and the
    // old repair text recommended exactly that bare entry.
    if (configured?.baseUrl !== undefined && configured.baseUrl.length > 0) {
      continue;
    }
    const repair = configured === undefined
      ? `add \"providers\": { \"${providerId}\": { \"type\": \"openai_compat\", \"baseUrl\": \"https://...\" } } to mono-agent.config.json`
      : `give providers.${providerId} a \"baseUrl\" (and \"type\"), because Pi has no built-in catalog for it`;
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `Provider "${providerId}" used by ${route.path} is not available; ${repair}.`,
      { providerId, path: route.path, reason: repair },
    );
  }
}

/**
 * Reject a retired field only when it still carries a value. Every reader in
 * this loader treats an empty env var as unset (`normalizeOptionalString`,
 * `readCsv`) and the layered loader drops empty env values before layering, so
 * `MONO_AGENT_FALLBACK_MODELS=` never configured anything even before the field
 * was retired -- it loaded as "no fallbacks". Rejecting it would turn an inert
 * leftover line in a deployed `.env` into a startup crash with no stale setting
 * behind it. A non-empty value is still a real, silently-dropped setting and
 * still fails closed.
 */
function assertNoRetiredConfigEnv(env: Record<string, string | undefined>): void {
  const retired = RETIRED_CONFIG_FIELDS.filter(
    (field) => normalizeOptionalString(env[field.env]) !== undefined,
  );
  if (retired.length === 0) return;
  // Report all of them, not just the first: a hand-migration is a single edit pass, and
  // one-at-a-time discovery turns a four-variable `.env` into four stop/edit/re-run cycles.
  // `env`/`path` stay the first entry so existing single-key consumers are unchanged.
  throw new MonoAgentConfigError("invalid_env", retired.map((field) => field.envMessage).join(" "), {
    env: retired[0]!.env,
    path: retired[0]!.path,
    envs: retired.map((field) => field.env),
    paths: retired.map((field) => field.path),
  });
}

export function redactMonoAgentConfig(config: MonoAgentConfig): RedactedMonoAgentConfig {
  const redacted: RedactedMonoAgentConfig = {
    ...(config.agent === undefined ? {} : { agent: { ...config.agent } }),
    runtime: { ...config.runtime },
    ...(config.concurrency === undefined ? {} : { concurrency: { ...config.concurrency } }),
    context: { ...config.context, selectedSkills: [...config.context.selectedSkills] },
    tools: {
      ...config.tools,
      allowedTools: [...config.tools.allowedTools],
      disallowedTools: [...config.tools.disallowedTools],
      ...(config.tools.web === undefined ? {} : {
        web: {
          coordination: config.tools.web.coordination ?? "process",
          search: {
            ...config.tools.web.search,
            ...(config.tools.web.search.codex === undefined
              ? {}
              : { codex: { ...config.tools.web.search.codex } }),
          },
          fetch: { ...config.tools.web.fetch },
        },
      }),
    },
    ...(config.sandbox === undefined ? {} : { sandbox: { ...config.sandbox } }),
    artifacts: { ...config.artifacts },
    traceability: { ...config.traceability },
    ...(config.observability === undefined ? {} : { observability: redactObservabilityConfig(config.observability) }),
  };
  if (config.memory !== undefined) {
    const { embeddings, supermemory, ...memory } = config.memory;
    return withRedactedProviders({
      ...redacted,
      memory: {
        ...memory,
        ...(embeddings === undefined ? {} : { embeddings: redactApiKeyBlock(embeddings) }),
        ...(supermemory === undefined ? {} : { supermemory: redactApiKeyBlock(supermemory) }),
      },
    }, config);
  }
  return withRedactedProviders(redacted, config);
}

/**
 * Resolve the Supermemory container/namespace tag for an agent: an explicit
 * `memory.supermemory.container` wins, else the trace identity, else a shared default. SINGLE source
 * of truth — both the store (write path) and the recall tool (read path) must agree on this, or
 * recall would search a different namespace than captures were written to.
 */
export function resolveSupermemoryContainer(config: MonoAgentConfig): string {
  return (
    config.memory?.supermemory?.container ??
    config.traceability.sourceId ??
    config.traceability.sourceLabel ??
    "mono-agent"
  );
}

/** Replace an `apiKey` literal with a redacted secret marker, leaving the rest of the block intact. */
function redactApiKeyBlock<T extends { readonly apiKey?: string }>(
  block: T,
): Omit<T, "apiKey"> & { readonly apiKey?: ReturnType<typeof redactedSecret> } {
  const { apiKey, ...rest } = block;
  return {
    ...rest,
    ...(apiKey === undefined ? {} : { apiKey: redactedSecret(apiKey) }),
  };
}

/**
 * The concrete repair for a rejected model reference (`codex:x` -> `openai-codex:x`, a tier
 * alias, the `<provider>:<model>` grammar) is built by the kernel parser and nested by the
 * runtime adapter in `details.reason`. Config used to keep only the adapter's generic outer
 * sentence, which is the one string every operator surface prints — so the repair the code
 * already knew was thrown away before anyone saw it. Unwrap one layer so the message carries
 * the innermost, actionable text.
 */
function modelReferenceReason(error: unknown): string {
  const reason = error instanceof RuntimeAdapterError && typeof error.details.reason === "string"
    ? error.details.reason
    : error instanceof Error
      ? error.message
      : String(error);
  // The adapter already bounds its own reason; re-bounding is a no-op there and is what
  // covers the branches above it, where the text is an arbitrary thrown value.
  return sanitizeModelReferenceText(reason, MODEL_REFERENCE_REASON_MAX_BYTES);
}

/**
 * Bound and neutralize the operator's own value before quoting it back at them. Naming the
 * rejected value is the half of the message that tells an operator *which* field to open, so
 * it stays -- but it is untrusted, unbounded text on its way into durable operator-shared
 * output, and it is treated as such.
 */
function modelReferenceEcho(raw: string): string {
  return sanitizeModelReferenceText(raw, MODEL_REFERENCE_ECHO_MAX_BYTES);
}

function parseModel(raw: string): MonoAgentConfig["runtime"]["model"] {
  try {
    return parseMonoRuntimeModelReference(raw);
  } catch (error) {
    const reason = modelReferenceReason(error);
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `MONO_AGENT_MODEL \`${modelReferenceEcho(raw)}\` is not a valid runtime model reference: ${reason}`,
      { env: "MONO_AGENT_MODEL", reason },
    );
  }
}

function readFallbacks(env: Record<string, string | undefined>): readonly RuntimeFallbackConfig[] {
  const raw = normalizeOptionalString(env.MONO_AGENT_FALLBACKS_JSON);
  if (raw === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MonoAgentConfigError("invalid_json", "MONO_AGENT_FALLBACKS_JSON must be a JSON array.", {
      env: "MONO_AGENT_FALLBACKS_JSON",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    throw new MonoAgentConfigError("invalid_env", "MONO_AGENT_FALLBACKS_JSON must be a JSON array.", {
      env: "MONO_AGENT_FALLBACKS_JSON",
    });
  }
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MonoAgentConfigError(
        "invalid_env",
        `MONO_AGENT_FALLBACKS_JSON entry ${index + 1} must be an object with a model.`,
        { env: "MONO_AGENT_FALLBACKS_JSON", index },
      );
    }
    const record = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) => key !== "model" && key !== "effort" && key !== "attempts",
    );
    if (unknownKeys.length > 0) {
      throw new MonoAgentConfigError(
        "invalid_env",
        `MONO_AGENT_FALLBACKS_JSON entry ${index + 1} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.sort().join(", ")}. Only model, effort, and attempts are supported.`,
        { env: "MONO_AGENT_FALLBACKS_JSON", index, unknownKeys: unknownKeys.sort() },
      );
    }
    if (typeof record.model !== "string" || record.model.trim().length === 0) {
      throw new MonoAgentConfigError(
        "invalid_model_reference",
        `MONO_AGENT_FALLBACKS_JSON entry ${index + 1} must contain a non-empty model reference.`,
        { env: "MONO_AGENT_FALLBACKS_JSON", index },
      );
    }
    const model = parseFallbackModel(record.model, "MONO_AGENT_FALLBACKS_JSON", index);
    const attempts = readFallbackAttempts(record.attempts, index);
    if (record.effort === undefined) {
      return attempts === undefined ? { model } : { model, attempts };
    }
    if (typeof record.effort !== "string") {
      throw new MonoAgentConfigError(
        "invalid_env",
        `MONO_AGENT_FALLBACKS_JSON entry ${index + 1} effort must be one of: ${EFFORT_LEVELS.join(", ")}.`,
        { env: "MONO_AGENT_FALLBACKS_JSON", index },
      );
    }
    const normalizedEffort = normalizeOptionalString(record.effort);
    if (normalizedEffort === undefined) {
      throw new MonoAgentConfigError(
        "invalid_env",
        `MONO_AGENT_FALLBACKS_JSON entry ${index + 1} effort must be one of: ${EFFORT_LEVELS.join(", ")}.`,
        { env: "MONO_AGENT_FALLBACKS_JSON", index },
      );
    }
    const effort = readChoice<EffortLevel>(
      normalizedEffort,
      `MONO_AGENT_FALLBACKS_JSON[${index}].effort`,
      EFFORT_LEVELS,
      "medium",
      invalidEnv,
    );
    return attempts === undefined ? { model, effort } : { model, effort, attempts };
  });
}

function readFallbackAttempts(value: unknown, index: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `MONO_AGENT_FALLBACKS_JSON entry ${index + 1} attempts must be an integer between 1 and 10.`,
      { env: "MONO_AGENT_FALLBACKS_JSON", index },
    );
  }
  return value;
}

const SUBAGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/u;

function readSubagentsConfig(
  env: Record<string, string | undefined>,
  cwd: string,
): MonoAgentSubagentsConfig | undefined {
  const raw = normalizeOptionalString(env.MONO_AGENT_SUBAGENTS_JSON);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MonoAgentConfigError("invalid_json", "MONO_AGENT_SUBAGENTS_JSON must be a JSON object.", {
      env: "MONO_AGENT_SUBAGENTS_JSON",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MonoAgentConfigError("invalid_env", "MONO_AGENT_SUBAGENTS_JSON must be a JSON object.", {
      env: "MONO_AGENT_SUBAGENTS_JSON",
    });
  }
  const record = parsed as Record<string, unknown>;
  const definitions = readSubagentDefinitions(record.definitions, cwd);
  return {
    ...(record.enabled === undefined ? {} : { enabled: readSubagentBoolean(record.enabled, "enabled") }),
    ...(record.maxConcurrent === undefined ? {} : { maxConcurrent: readSubagentInteger(record.maxConcurrent, "maxConcurrent", 1, 10) }),
    ...(record.maxPerTurn === undefined ? {} : { maxPerTurn: readSubagentInteger(record.maxPerTurn, "maxPerTurn", 1, 200) }),
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: readSubagentInteger(record.timeoutMs, "timeoutMs", 1_000, 3_600_000) }),
    ...(record.maxTurns === undefined ? {} : { maxTurns: readSubagentInteger(record.maxTurns, "maxTurns", 1, 200) }),
    ...(definitions === undefined ? {} : { definitions }),
    ...(record.inline === undefined ? {} : { inline: readInlineSubagentsConfig(record.inline) }),
  };
}

function readInlineSubagentsConfig(value: unknown): MonoAgentInlineSubagentsConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSubagents("inline must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowedTools = readSubagentTools(record.allowedTools, "inline", "allowedTools");
  // Same reasoning as a declared profile: the ceiling is what stops an authored
  // subagent reaching past its author, so it must be enumerated, and `Agent`
  // stays out of it because subagents never spawn subagents.
  if (allowedTools?.includes(ALLOW_ALL_TOOLS)) {
    throw invalidSubagents(`inline allowedTools cannot use the ${ALLOW_ALL_TOOLS} wildcard; list the tools it needs.`);
  }
  if (allowedTools?.includes("Agent")) {
    throw invalidSubagents("inline allowedTools cannot allow Agent; subagents never spawn subagents.");
  }
  return {
    ...(record.enabled === undefined ? {} : { enabled: readSubagentBoolean(record.enabled, "inline.enabled") }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
  };
}

function readSubagentDefinitions(
  value: unknown,
  cwd: string,
): readonly MonoAgentSubagentConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidSubagents("definitions must be an array.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidSubagents(`definition ${index + 1} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!SUBAGENT_NAME_RE.test(name)) {
      throw invalidSubagents(`definition ${index + 1} name must be lowercase kebab-case (got ${JSON.stringify(record.name)}).`);
    }
    if (seen.has(name)) {
      throw invalidSubagents(`duplicate definition name "${name}".`);
    }
    seen.add(name);
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (description.length === 0) {
      throw invalidSubagents(`definition "${name}" needs a non-empty description; the model picks profiles by it.`);
    }
    const hasPrompt = typeof record.prompt === "string" && record.prompt.trim().length > 0;
    const hasPromptPath = typeof record.promptPath === "string" && record.promptPath.trim().length > 0;
    if (hasPrompt === hasPromptPath) {
      throw invalidSubagents(`definition "${name}" needs exactly one of prompt or promptPath.`);
    }
    const subject = `definition "${name}"`;
    const allowedTools = readSubagentTools(record.allowedTools, subject, "allowedTools");
    const disallowedTools = readSubagentTools(record.disallowedTools, subject, "disallowedTools");
    const mcpServers = readSubagentTools(record.mcpServers, subject, "mcpServers");
    // `"*"` would hand a subagent every built-in including shell and writes.
    // Widening a helper's reach must be an explicit, enumerated decision.
    if (allowedTools?.includes(ALLOW_ALL_TOOLS)) {
      throw invalidSubagents(`definition "${name}" cannot use the ${ALLOW_ALL_TOOLS} wildcard; list the tools it needs.`);
    }
    if (allowedTools?.includes("Agent")) {
      throw invalidSubagents(`definition "${name}" cannot allow Agent; subagents never spawn subagents.`);
    }
    return {
      name,
      description,
      ...(hasPrompt ? { prompt: String(record.prompt).trim() } : {}),
      ...(hasPromptPath ? { promptPath: readPath(String(record.promptPath), cwd) } : {}),
      ...(record.model === undefined ? {} : { model: parseSubagentModel(record.model, name) }),
      ...(record.effort === undefined ? {} : {
        effort: readChoice<EffortLevel>(String(record.effort), `subagents.definitions[${index}].effort`, EFFORT_LEVELS, "medium", invalidEnv),
      }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(mcpServers === undefined ? {} : { mcpServers }),
      ...(record.maxTurns === undefined ? {} : { maxTurns: readSubagentInteger(record.maxTurns, `definition "${name}" maxTurns`, 1, 200) }),
      ...(record.timeoutMs === undefined ? {} : { timeoutMs: readSubagentInteger(record.timeoutMs, `definition "${name}" timeoutMs`, 1_000, 3_600_000) }),
    } satisfies MonoAgentSubagentConfig;
  });
}

function parseSubagentModel(value: unknown, name: string): MonoAgentConfig["runtime"]["model"] {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidSubagents(`definition "${name}" model must be a model reference string.`);
  }
  try {
    return parseMonoRuntimeModelReference(value);
  } catch (error) {
    const reason = modelReferenceReason(error);
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `MONO_AGENT_SUBAGENTS_JSON definition "${name}" model \`${modelReferenceEcho(value)}\` is not a valid runtime model reference: ${reason}`,
      { env: "MONO_AGENT_SUBAGENTS_JSON", reason },
    );
  }
}

/** `subject` is the already-formatted owner of the field, e.g. `definition "researcher"`. */
function readSubagentTools(value: unknown, subject: string, field: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw invalidSubagents(`${subject} ${field} must be an array of non-empty strings.`);
  }
  return value.map((entry) => String(entry).trim());
}

function readSubagentBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidSubagents(`${field} must be a boolean.`);
  }
  return value;
}

function readSubagentInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalidSubagents(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function invalidSubagents(detail: string): MonoAgentConfigError {
  return new MonoAgentConfigError("invalid_env", `MONO_AGENT_SUBAGENTS_JSON ${detail}`, {
    env: "MONO_AGENT_SUBAGENTS_JSON",
  });
}

function readRetryConfig(env: Record<string, string | undefined>): RuntimeRetryConfig {
  return {
    primaryAttempts: readRetryInteger(env.MONO_AGENT_RETRY_PRIMARY_ATTEMPTS, "MONO_AGENT_RETRY_PRIMARY_ATTEMPTS", 2, 1, 10),
    backoffMs: readRetryInteger(env.MONO_AGENT_RETRY_BACKOFF_MS, "MONO_AGENT_RETRY_BACKOFF_MS", 1_000, 0, 60_000),
    maxBackoffMs: readRetryInteger(env.MONO_AGENT_RETRY_MAX_BACKOFF_MS, "MONO_AGENT_RETRY_MAX_BACKOFF_MS", 15_000, 0, 300_000),
  };
}

function readRetryInteger(
  raw: string | undefined,
  env: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return fallback;
  }
  const value = Number(normalized);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${env} must be an integer between ${min} and ${max}.`,
      { env },
    );
  }
  return value;
}

function parseFallbackModel(raw: string, env: string, index: number): MonoAgentConfig["runtime"]["model"] {
  try {
    return parseMonoRuntimeModelReference(raw.trim());
  } catch (error) {
    const reason = modelReferenceReason(error);
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `${env} entry ${index + 1} model \`${modelReferenceEcho(raw)}\` is not a valid runtime model reference: ${reason}`,
      { env, index, reason },
    );
  }
}

function assertUniqueFallbackRoutes(
  primary: MonoAgentConfig["runtime"]["model"],
  canonical: readonly RuntimeFallbackConfig[],
): void {
  const seen = new Map<string, string>([[modelReferenceKey(primary), "runtime.model"]]);
  const routes = canonical.map((entry, index) => ({ model: entry.model, path: `runtime.fallbacks[${index}]` }));
  for (const route of routes) {
    const key = modelReferenceKey(route.model);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new MonoAgentConfigError(
        "invalid_env",
        `Duplicate runtime route \`${key}\` at ${route.path}; it is already selected at ${first}.`,
        { route: key, path: route.path, duplicateOf: first },
      );
    }
    seen.set(key, route.path);
  }
}

function readAgentName(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const name = raw.trim();
  const length = Array.from(name).length;
  if (length === 0 || length > MAX_AGENT_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `MONO_AGENT_NAME must be a single-line name between 1 and ${MAX_AGENT_NAME_LENGTH} characters.`,
      { env: "MONO_AGENT_NAME", maxLength: MAX_AGENT_NAME_LENGTH },
    );
  }
  return name;
}

/** Optional per-MCP-call timeout override; unset defers to the runtime defaults (120s inactivity / 45 min total). */
function readOptionalTimeoutMs(raw: string | undefined, name: string): number | undefined {
  if (normalizeOptionalString(raw) === undefined) {
    return undefined;
  }
  return readInteger(raw, name, 0, invalidEnv, { min: 1000, max: 86_400_000 });
}

function readWebSearchEndpoint(raw: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) return undefined;
  try {
    const endpoint = new URL(normalized);
    const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (
      endpoint.protocol !== "http:"
      || !["localhost", "127.0.0.1", "::1"].includes(host)
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
    ) {
      throw new Error("not loopback HTTP");
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
    return endpoint.href.replace(/\/+$/u, "");
  } catch {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_WEB_SEARCH_ENDPOINT must be an unauthenticated loopback HTTP URL.",
      { env: "MONO_AGENT_WEB_SEARCH_ENDPOINT" },
    );
  }
}

function readWebSearchCodexModel(raw: string | undefined): string {
  const value = normalizeOptionalString(raw) ?? "gpt-5.6-luna";
  if (value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_WEB_SEARCH_CODEX_MODEL must be a non-empty model id of at most 160 characters without control characters.",
      { env: "MONO_AGENT_WEB_SEARCH_CODEX_MODEL" },
    );
  }
  return value;
}

function readWebBrowserCommand(raw: string | undefined): string {
  const value = normalizeOptionalString(raw) ?? "agent-browser";
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_WEB_BROWSER_COMMAND must be one executable name or path without control characters.",
      { env: "MONO_AGENT_WEB_BROWSER_COMMAND" },
    );
  }
  return value;
}

function readMaxTurns(raw: string | undefined): number | undefined {
  const maxTurns = readInteger(raw, "MONO_AGENT_MAX_TURNS", 0, invalidEnv, { min: 0, max: 100 });
  return maxTurns === 0 ? undefined : maxTurns;
}

function readRuntimeCompactionConfig(
  env: Record<string, string | undefined>,
): NonNullable<MonoAgentConfig["runtime"]["compaction"]> {
  const triggerRatio = readOptionalNumber(
    env.MONO_AGENT_COMPACTION_TRIGGER_RATIO,
    "MONO_AGENT_COMPACTION_TRIGGER_RATIO",
    { min: 0.2, max: 0.95 },
  );
  const keepRecentTokens = readOptionalInteger(
    env.MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS,
    "MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS",
    { min: 4_000, max: 200_000 },
  );
  const summaryMaxTokens = readOptionalInteger(
    env.MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS,
    "MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS",
    { min: 1_000, max: 64_000 },
  );
  const minSavingsTokens = readOptionalInteger(
    env.MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS,
    "MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS",
    { min: 0, max: 500_000 },
  );
  const contextWindowOverride = readOptionalInteger(
    env.MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE,
    "MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE",
    { min: 32_000, max: 10_000_000 },
  );
  return {
    enabled: readBoolean(
      env.MONO_AGENT_COMPACTION_ENABLED,
      "MONO_AGENT_COMPACTION_ENABLED",
      true,
      invalidEnv,
    ),
    ...(triggerRatio === undefined ? {} : { triggerRatio }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
    ...(summaryMaxTokens === undefined ? {} : { summaryMaxTokens }),
    ...(minSavingsTokens === undefined ? {} : { minSavingsTokens }),
    fixedOverheadEnabled: readBoolean(
      env.MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED,
      "MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED",
      true,
      invalidEnv,
    ),
    ...(contextWindowOverride === undefined ? {} : { contextWindowOverride }),
  };
}

function readArtifactRetentionConfig(env: Record<string, string | undefined>): MonoAgentConfig["artifacts"]["retention"] {
  return {
    maxAgeDays: readInteger(
      env.MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS,
      "MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS",
      DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS,
      invalidEnv,
      { min: 1, max: 3_650 },
    ),
    maxCount: readInteger(
      env.MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT,
      "MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT",
      DEFAULT_ARTIFACT_RETENTION_MAX_COUNT,
      invalidEnv,
      { min: 1, max: 1_000_000 },
    ),
    dryRun: readBoolean(
      env.MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN,
      "MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN",
      false,
      invalidEnv,
    ),
  };
}

function readMemoryArtifactRetentionConfig(
  env: Record<string, string | undefined>,
  agentRetention: MonoAgentConfig["artifacts"]["retention"],
): MonoAgentConfig["artifacts"]["memoryRetention"] {
  return {
    maxAgeDays: readInteger(
      env.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS,
      "MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS",
      DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS,
      invalidEnv,
      { min: 1, max: 3_650 },
    ),
    maxCount: readInteger(
      env.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT,
      "MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT",
      DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT,
      invalidEnv,
      { min: 1, max: 1_000_000 },
    ),
    dryRun: readBoolean(
      env.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN,
      "MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN",
      agentRetention.dryRun,
      invalidEnv,
    ),
  };
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
  // Unset stays undefined so hosts can keep their existing display policy;
  // explicit false is preserved for operators who want to suppress notices.
  const rolloverNotice = normalizeOptionalString(env.MONO_AGENT_SESSION_ROLLOVER_NOTICE) === undefined
    ? undefined
    : readBoolean(env.MONO_AGENT_SESSION_ROLLOVER_NOTICE, "MONO_AGENT_SESSION_ROLLOVER_NOTICE", false, invalidEnv);
  // Unset stays undefined so the harness default (false, no behavior change) is
  // preserved byte-for-byte; only parse the boolean when an operator opts in.
  const isolateProactive = normalizeOptionalString(env.MONO_AGENT_SESSION_ISOLATE_PROACTIVE) === undefined
    ? undefined
    : readBoolean(env.MONO_AGENT_SESSION_ISOLATE_PROACTIVE, "MONO_AGENT_SESSION_ISOLATE_PROACTIVE", false, invalidEnv);
  return {
    mode,
    idleTimeoutMs,
    rollover,
    ...(rolloverTimezone === undefined ? {} : { rolloverTimezone }),
    ...(rolloverNotice === undefined ? {} : { rolloverNotice }),
    ...(isolateProactive === undefined ? {} : { isolateProactive }),
  };
}

/**
 * Pre-v2 memory keys the loader still tolerates (never throws) but no longer
 * honors. Surfaced as a one-line deprecation warning instead of being silently
 * dropped, so a stale config doesn't look like it is taking effect.
 */
const RETIRED_MEMORY_ENV_KEYS = [
  "MONO_AGENT_MEMORY_GRAPH_PATH",
  "MONO_AGENT_MEMORY_SCOPE",
  "MONO_AGENT_MEMORY_TOOLS_ENABLED",
  "MONO_AGENT_MEMORY_REFLECTION_ENABLED",
  "MONO_AGENT_MEMORY_REFLECTION_CRON",
  "MONO_AGENT_MEMORY_MIGRATION_ENABLED",
  "MONO_AGENT_MEMORY_MIGRATION_CRON",
] as const;

function warnRetiredMemoryKeys(env: Record<string, string | undefined>): void {
  const retired = RETIRED_MEMORY_ENV_KEYS.filter(
    (name) => normalizeOptionalString(env[name]) !== undefined,
  );
  if (retired.length > 0) {
    console.warn(
      `[mono-agent] Ignoring retired memory env var(s): ${retired.join(", ")}. `
        + "These were removed in Memory v2 and have no effect.",
    );
  }
}

function readMemoryConfig(env: Record<string, string | undefined>, cwd: string): MonoAgentConfig["memory"] | undefined {
  warnRetiredMemoryKeys(env);
  const backend = readChoice<MemoryBackend>(
    env.MONO_AGENT_MEMORY_BACKEND,
    "MONO_AGENT_MEMORY_BACKEND",
    MEMORY_BACKENDS,
    "bujo",
    invalidEnv,
  );
  const supermemory = readMemorySupermemoryConfig(env);
  const rawPath = normalizeOptionalString(env.MONO_AGENT_MEMORY_PATH);

  // The bujo backend stores to a local path; an external backend (supermemory) keeps no local store
  // and therefore does NOT require a path. For bujo, any memory env set without a path is a
  // misconfiguration — fail closed rather than silently ignoring it. Backend selection and the
  // supermemory block are routing concerns (not path-gated) and are excluded from this check. The
  // retired memory keys stay tolerated (warned, not thrown) for stale configs.
  if (backend !== "supermemory" && rawPath === undefined) {
    const orphaned = [
      "MONO_AGENT_MEMORY_MODE",
      "MONO_AGENT_MEMORY_WRITE_MODE",
      "MONO_AGENT_MEMORY_MAX_BYTES",
      "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER",
      "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL",
      "MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT",
      "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
      "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV",
      "MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED",
      "MONO_AGENT_MEMORY_EMBEDDINGS_DIM",
      "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS",
      "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
      "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS",
      "MONO_AGENT_MEMORY_LLM_PROVIDER",
      "MONO_AGENT_MEMORY_LLM_MODEL",
      "MONO_AGENT_MEMORY_LLM_ENDPOINT",
      "MONO_AGENT_MEMORY_LLM_TRACE",
      "MONO_AGENT_MEMORY_LLM_TIMEOUT_MS",
      "MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED",
      "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED",
      "MONO_AGENT_MEMORY_CONSOLIDATION_CRON",
    ].find((name) => normalizeOptionalString(env[name]) !== undefined);
    if (orphaned !== undefined) {
      throw new MonoAgentConfigError("invalid_env", `${orphaned} requires MONO_AGENT_MEMORY_PATH (or memory.path) to be set.`, {
        env: orphaned,
      });
    }
    return undefined;
  }
  if (backend === "supermemory" && supermemory === undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `MONO_AGENT_MEMORY_BACKEND "supermemory" requires MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL (or memory.supermemory.baseUrl).`,
      { env: "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL" },
    );
  }

  const mode = readChoice<MemoryMode>(
    env.MONO_AGENT_MEMORY_MODE,
    "MONO_AGENT_MEMORY_MODE",
    MEMORY_MODES,
    "lite",
    invalidEnv,
  );
  const writeMode = readChoice<MemoryWriteMode>(
    env.MONO_AGENT_MEMORY_WRITE_MODE,
    "MONO_AGENT_MEMORY_WRITE_MODE",
    MEMORY_WRITE_MODES,
    "disabled",
    invalidEnv,
  );
  // "capture" needs server-side or LLM-driven extraction. The bujo backend gets it from a chat
  // LLM (so it requires mode "bujo"); external backends (e.g. supermemory) extract server-side,
  // so capture is valid for them regardless of mode.
  if (writeMode === "capture" && backend === "bujo" && mode !== "bujo") {
    throw new MonoAgentConfigError(
      "invalid_env",
      `MONO_AGENT_MEMORY_WRITE_MODE "capture" requires MONO_AGENT_MEMORY_MODE "bujo" (it needs a chat LLM) or an external MONO_AGENT_MEMORY_BACKEND that extracts server-side.`,
      { env: "MONO_AGENT_MEMORY_WRITE_MODE" },
    );
  }
  // embeddings / llm / dim / consolidation are BuJo-only and ignored by external backends. Skip parsing
  // them for supermemory so a stale BuJo env (e.g. an openai embeddings provider with no key) does
  // not throw and block switching an existing BuJo config over to Supermemory.
  const isBujo = backend === "bujo";
  if (isBujo && (mode === "lite" || mode === "journal") && hasMemoryLlmConfig(env)) {
    const message = mode === "lite"
      ? 'MONO_AGENT_MEMORY_MODE "lite" is lexical-only and cannot configure memory.llm. Remove it or select journal/bujo.'
      : 'MONO_AGENT_MEMORY_MODE "journal" is semantic-only and cannot configure a capture LLM or BuJo consolidation.';
    throw new MonoAgentConfigError("invalid_env", message, { env: "MONO_AGENT_MEMORY_MODE" });
  }
  const embeddings = isBujo ? readMemoryEmbeddingsConfig(env) : undefined;
  const llm = isBujo ? readMemoryLlmConfig(env) : undefined;
  const dim = isBujo
    ? readOptionalInteger(env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM, "MONO_AGENT_MEMORY_EMBEDDINGS_DIM", { min: 1, max: 16_384 })
    : undefined;
  const consolidation = isBujo ? readMemoryConsolidationConfig(env) : undefined;

  const embeddingsWithDim =
    embeddings === undefined
      ? undefined
      : dim === undefined
        ? embeddings
        : { ...embeddings, dim };

  // Built-in tiers are capability contracts, not best-effort hints.  Keeping
  // the matrix strict prevents a configured Journal/BuJo agent from silently
  // running as a cheaper tier when a prerequisite was omitted.
  if (isBujo) {
    if (mode === "lite") {
      const incompatible = embeddingsWithDim !== undefined
        ? "memory.embeddings"
        : dim !== undefined
          ? "memory.embeddings.dim"
          : llm !== undefined
            ? "memory.llm"
            : consolidation !== undefined
              ? "memory.consolidation"
              : undefined;
      if (incompatible !== undefined) {
        throw new MonoAgentConfigError(
          "invalid_env",
          `MONO_AGENT_MEMORY_MODE "lite" is lexical-only and cannot configure ${incompatible}. Remove it or select journal/bujo.`,
          { env: "MONO_AGENT_MEMORY_MODE" },
        );
      }
    } else if (mode === "journal") {
      if (embeddingsWithDim === undefined) {
        throw new MonoAgentConfigError(
          "invalid_env",
          'MONO_AGENT_MEMORY_MODE "journal" requires an explicit memory.embeddings block.',
          { env: "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL" },
        );
      }
      if (llm !== undefined || consolidation !== undefined) {
        throw new MonoAgentConfigError(
          "invalid_env",
          'MONO_AGENT_MEMORY_MODE "journal" is semantic-only and cannot configure a capture LLM or BuJo consolidation.',
          { env: "MONO_AGENT_MEMORY_MODE" },
        );
      }
    } else {
      if (embeddingsWithDim === undefined) {
        throw new MonoAgentConfigError(
          "invalid_env",
          'MONO_AGENT_MEMORY_MODE "bujo" requires an explicit memory.embeddings block.',
          { env: "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL" },
        );
      }
      if (llm === undefined) {
        throw new MonoAgentConfigError(
          "invalid_env",
          'MONO_AGENT_MEMORY_MODE "bujo" requires an explicit memory.llm block.',
          { env: "MONO_AGENT_MEMORY_LLM_MODEL" },
        );
      }
    }
  }

  // Every configured memory tier has a read-only recall surface: lite uses FTS,
  // journal/bujo add semantic ranking, and external backends provide search.
  // Explicit false remains the privacy/availability opt-out.
  const recallToolDefault = backend === "supermemory" ? supermemory !== undefined : true;
  const recallToolEnabled = readBoolean(
    env.MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED,
    "MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED",
    recallToolDefault,
    invalidEnv,
  );

  // The explicit write surface is bujo-backend only: an external backend
  // implements the shared MemoryStore contract but no deterministic remember
  // path, so it never advertises the capability and defaults off here.
  const rememberToolDefault = backend !== "supermemory";
  const rememberToolEnabled = readBoolean(
    env.MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED,
    "MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED",
    rememberToolDefault,
    invalidEnv,
  );

  return {
    backend,
    mode,
    // bujo always has a path here (else we returned above); the supermemory backend keeps no local
    // store, so a default placeholder satisfies the type without the operator having to set one.
    path: readPath(rawPath ?? "./.mono-agent/memory", cwd),
    maxBytes: readInteger(env.MONO_AGENT_MEMORY_MAX_BYTES, "MONO_AGENT_MEMORY_MAX_BYTES", DEFAULT_MEMORY_MAX_BYTES, invalidEnv, { min: 1, max: 1_000_000 }),
    writeMode,
    ...(supermemory === undefined ? {} : { supermemory }),
    ...(embeddingsWithDim === undefined ? {} : { embeddings: embeddingsWithDim }),
    ...(llm === undefined ? {} : { llm }),
    recallTool: { enabled: recallToolEnabled },
    rememberTool: { enabled: rememberToolEnabled },
    ...(consolidation === undefined ? {} : { consolidation }),
  };
}

function readMemoryEmbeddingsConfig(env: Record<string, string | undefined>): MemoryEmbeddingsConfig | undefined {
  const hasEmbeddingsEnv = [
    env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV,
    env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM,
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
    MEMORY_EMBEDDINGS_PROVIDERS,
    "ollama",
    invalidEnv,
  );
  const model = normalizeOptionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL) ?? DEFAULT_EMBEDDINGS_MODELS[provider];
  const endpoint = normalizeOptionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT);
  const apiKeyEnv = normalizeOptionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV);
  // A declared name is authoritative. Ignoring an unresolved name in favor of
  // the generic literal could send a stale credential to a newly selected
  // provider; local providers preserve the unresolved reference so readiness
  // can explain it, while OpenAI still fails its mandatory-key validation.
  const apiKey = apiKeyEnv === undefined
    ? normalizeOptionalString(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY)
    : normalizeOptionalString(env[apiKeyEnv]);
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

function readMemorySupermemoryConfig(env: Record<string, string | undefined>): MemorySupermemoryConfig | undefined {
  const hasSupermemoryEnv = [
    env.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL,
    env.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY,
    env.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV,
    env.MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER,
    env.MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS,
    env.MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER,
  ].some((value) => normalizeOptionalString(value) !== undefined);
  if (!hasSupermemoryEnv) {
    return undefined;
  }
  const baseUrl = normalizeOptionalString(env.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL);
  if (baseUrl === undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL is required when any memory.supermemory.* value is set.",
      { env: "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL" },
    );
  }
  // Same secret pattern as embeddings: prefer reading the key from the named env var (so only the
  // NAME is persisted in resolved config), falling back to an inline literal.
  const apiKeyEnv = normalizeOptionalString(env.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV);
  const apiKey = (apiKeyEnv === undefined ? undefined : normalizeOptionalString(env[apiKeyEnv]))
    ?? normalizeOptionalString(env.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY);
  const container = normalizeOptionalString(env.MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER);
  const timeoutMs = readOptionalInteger(
    env.MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS,
    "MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS",
    { min: 1, max: 600_000 },
  );
  const exposeMcpServer = readBoolean(
    env.MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER,
    "MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER",
    false,
    invalidEnv,
  );
  return {
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(container === undefined ? {} : { container }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(exposeMcpServer ? { exposeMcpServer } : {}),
  };
}

function readMemoryLlmConfig(env: Record<string, string | undefined>): MemoryLlmConfig | undefined {
  if (!hasMemoryLlmConfig(env)) {
    return undefined;
  }
  const rawModel = normalizeOptionalString(env.MONO_AGENT_MEMORY_LLM_MODEL);
  if (rawModel === undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      "MONO_AGENT_MEMORY_LLM_MODEL is required when any memory.llm value is set.",
      { env: "MONO_AGENT_MEMORY_LLM_MODEL" },
    );
  }
  const provider = readChoice<MemoryLlmProvider>(
    env.MONO_AGENT_MEMORY_LLM_PROVIDER,
    "MONO_AGENT_MEMORY_LLM_PROVIDER",
    MEMORY_LLM_PROVIDERS,
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
    try {
      parseMonoRuntimeModelReference(rawModel);
    } catch (error) {
      const reason = modelReferenceReason(error);
      throw new MonoAgentConfigError(
        "invalid_model_reference",
        `MONO_AGENT_MEMORY_LLM_MODEL \`${modelReferenceEcho(rawModel)}\` is not a valid runtime model reference for agent-host memory LLM: ${reason}`,
        { env: "MONO_AGENT_MEMORY_LLM_MODEL", reason },
      );
    }
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
      ...(trace === undefined ? {} : { trace }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
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

function hasMemoryLlmConfig(env: Record<string, string | undefined>): boolean {
  return MEMORY_LLM_ENV_KEYS.some((name) => normalizeOptionalString(env[name]) !== undefined);
}

/**
 * Reads the optional consolidation config from env. Cron syntax is scheduler-validated,
 * not config-load validated, so operators get a runtime warning without blocking config load.
 */
function readMemoryConsolidationConfig(
  env: Record<string, string | undefined>,
): MemoryConsolidationConfig | undefined {
  const enabledKey = "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED";
  const cronKey = "MONO_AGENT_MEMORY_CONSOLIDATION_CRON";
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

function readTraceabilityConfig(
  env: Record<string, string | undefined>,
  cwd: string,
  agentName: string | undefined,
): MonoAgentConfig["traceability"] {
  const registryDir = readPath(
    env.MONO_AGENT_TRACE_REGISTRY_DIR,
    cwd,
    resolve(homedir(), ".mono-agent", "trace-sources"),
  );
  const sourceId = normalizeOptionalString(env.MONO_AGENT_TRACE_SOURCE_ID);
  // An explicit trace label remains authoritative. Otherwise the public agent
  // name becomes the display label without changing the stable source id.
  const sourceLabel = normalizeOptionalString(env.MONO_AGENT_TRACE_SOURCE_LABEL) ?? agentName;
  const heartbeatMs = readInteger(env.MONO_AGENT_TRACE_HEARTBEAT_MS, "MONO_AGENT_TRACE_HEARTBEAT_MS", DEFAULT_TRACE_HEARTBEAT_MS, invalidEnv, {
    min: 250,
    max: 86_400_000,
  });
  const staleAfterMs = readInteger(env.MONO_AGENT_TRACE_STALE_AFTER_MS, "MONO_AGENT_TRACE_STALE_AFTER_MS", DEFAULT_TRACE_STALE_AFTER_MS, invalidEnv, {
    min: 1_000,
    max: 604_800_000,
  });
  const globalDiscovery = readBoolean(env.MONO_AGENT_TRACE_GLOBAL_DISCOVERY, "MONO_AGENT_TRACE_GLOBAL_DISCOVERY", true, invalidEnv);
  return {
    registryDir,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    heartbeatMs,
    staleAfterMs,
    globalDiscovery,
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
  const contentPatternRedaction = readObjectBoolean(value, "contentPatternRedaction", false, source);
  const timeoutMs = readObjectInteger(value, "timeoutMs", source, { min: 1, max: 60_000 });
  const projectName = readObjectString(value, "projectName", source, false);
  return {
    type,
    endpoint,
    ...(headers === undefined ? {} : { headers }),
    includeSensitiveData,
    contentPatternRedaction,
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

interface ConfiguredProviderEnvelope {
  readonly entries: readonly ProviderDefinition[];
  readonly piAuthPath?: string;
  readonly piNative?: Readonly<Record<string, unknown>>;
}

const RESERVED_PROVIDER_KEYS = new Set(["local", "piAuthPath", "piNative"]);
const PROVIDER_ENTRY_KEYS = new Set([
  "apiKey",
  "apiKeyEnv",
  "baseUrl",
  "enabled",
  "maxAdvertisedModels",
  "models",
  "trustPublicUrl",
  "type",
]);

function readConfiguredProviders(env: Record<string, string | undefined>): ConfiguredProviderEnvelope {
  const providerJson = normalizeOptionalString(env.MONO_AGENT_PROVIDERS_JSON);
  let parsed: Record<string, unknown> = {};
  if (providerJson !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(providerJson);
    } catch (error) {
      throw new MonoAgentConfigError("invalid_json", "MONO_AGENT_PROVIDERS_JSON must contain valid JSON.", {
        env: "MONO_AGENT_PROVIDERS_JSON",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isRecord(value) || Array.isArray(value)) {
      throw new MonoAgentConfigError("invalid_env", "MONO_AGENT_PROVIDERS_JSON must be an object.", {
        env: "MONO_AGENT_PROVIDERS_JSON",
      });
    }
    parsed = value;
  }

  const entries = new Map<string, { readonly provider: ProviderDefinition; readonly path: string }>();
  for (const id of Object.keys(parsed).filter((key) => !RESERVED_PROVIDER_KEYS.has(key)).sort()) {
    addConfiguredProvider(entries, normalizeProviderFromUnknown(id, parsed[id], env, `providers.${id}`, false), `providers.${id}`);
  }

  const legacyFromEnv = readLegacyProviderEnv(env);
  const legacyFromMap = parsed.local;
  if (legacyFromEnv.length === 0 && legacyFromMap !== undefined) {
    if (!Array.isArray(legacyFromMap)) {
      throw new MonoAgentConfigError("invalid_env", "providers.local must be an array.", { env: "MONO_AGENT_PROVIDERS_JSON" });
    }
    legacyFromMap.forEach((provider, index) => {
      const path = `providers.local[${index}]`;
      const normalized = normalizeLegacyProviderFromUnknown(provider, env, path);
      addConfiguredProvider(entries, normalized, path);
    });
  }

  for (const legacy of legacyFromEnv) {
    addConfiguredProvider(entries, legacy.provider, legacy.path);
  }

  const piAuthPath = parsed.piAuthPath === undefined
    ? undefined
    : readObjectString(parsed, "piAuthPath", "providers", false);
  const piNative = parsed.piNative === undefined
    ? undefined
    : readProviderPiNative(parsed.piNative);
  return {
    entries: [...entries.values()].map(({ provider }) => provider).sort((a, b) => a.id.localeCompare(b.id)),
    ...(piAuthPath === undefined ? {} : { piAuthPath }),
    ...(piNative === undefined ? {} : { piNative }),
  };
}

function readLegacyProviderEnv(
  env: Record<string, string | undefined>,
): readonly { readonly provider: LocalProviderDefinition; readonly path: string }[] {
  const registryJson = normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDERS_JSON);
  if (registryJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(registryJson);
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
    return rawProviders.map((provider, index) => {
      const path = `MONO_AGENT_LOCAL_PROVIDERS_JSON[${index}]`;
      return { provider: normalizeLegacyProviderFromUnknown(provider, env, path), path };
    });
  }

  const id = normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_ID);
  const type = normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_TYPE);
  const baseUrl = normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_BASE_URL);
  const hasOneProviderEnv = id !== undefined
    || type !== undefined
    || baseUrl !== undefined
    || normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_ENABLED) !== undefined
    || normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL) !== undefined
    || normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_API_KEY) !== undefined;
  if (!hasOneProviderEnv) {
    return [];
  }
  const path = "MONO_AGENT_LOCAL_PROVIDER";
  return [{
    path,
    provider: normalizeLegacyProviderFromUnknown({
      id: id ?? "ollama",
      type: type ?? "ollama",
      ...(baseUrl === undefined ? {} : { baseUrl }),
      enabled: readBoolean(env.MONO_AGENT_LOCAL_PROVIDER_ENABLED, "MONO_AGENT_LOCAL_PROVIDER_ENABLED", true, invalidEnv),
      trustPublicUrl: readBoolean(env.MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL, "MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL", false, invalidEnv),
      ...(normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_API_KEY) === undefined
        ? {}
        : { apiKey: normalizeOptionalString(env.MONO_AGENT_LOCAL_PROVIDER_API_KEY) as string }),
    }, env, path),
  }];
}

function normalizeLegacyProviderFromUnknown(
  value: unknown,
  env: Record<string, string | undefined>,
  source: string,
): LocalProviderDefinition {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source} must be an object.`, { env: source });
  }
  const id = readObjectString(value, "id", source, true) as string;
  const provider = normalizeProviderFromUnknown(id, value, env, source, true);
  return provider as LocalProviderDefinition;
}

function normalizeProviderFromUnknown(
  id: string,
  value: unknown,
  env: Record<string, string | undefined>,
  source: string,
  requireType: boolean,
): ProviderDefinition {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source} must be an object.`, { env: source });
  }
  const unknownKeys = Object.keys(value).filter((key) =>
    !(requireType && key === "id") && !PROVIDER_ENTRY_KEYS.has(key),
  ).sort();
  if (unknownKeys.length > 0) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${source} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
      { env: source, unknownKeys },
    );
  }
  const type = readObjectString(value, "type", source, requireType) as ProviderDefinition["type"];
  const baseUrl = readObjectString(value, "baseUrl", source, false);
  const apiKeyEnv = readObjectString(value, "apiKeyEnv", source, false);
  const apiKeyFromEnv = apiKeyEnv === undefined ? undefined : normalizeOptionalString(env[apiKeyEnv]);
  const inlineApiKey = readObjectString(value, "apiKey", source, false);
  const apiKey = apiKeyFromEnv ?? inlineApiKey;
  const models = readLocalProviderModels(value.models, source);
  const maxAdvertisedModels = readObjectInteger(value, "maxAdvertisedModels", source, { min: 1, max: 200 });
  const provider: ProviderDefinition = {
    id,
    ...(type === undefined ? {} : { type }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: readObjectBoolean(value, "enabled", true, source),
    trustPublicUrl: readObjectBoolean(value, "trustPublicUrl", false, source),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(models.length === 0 ? {} : { models }),
    ...(maxAdvertisedModels === undefined ? {} : { maxAdvertisedModels }),
  };
  try {
    return requireType
      ? validateLocalProviderDefinition(provider as LocalProviderDefinition)
      : validateProviderDefinition(provider);
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

function addConfiguredProvider(
  entries: Map<string, { readonly provider: ProviderDefinition; readonly path: string }>,
  provider: ProviderDefinition,
  path: string,
): void {
  const existing = entries.get(provider.id);
  if (existing !== undefined) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `Provider id "${provider.id}" is configured twice at ${existing.path} and ${path}. Remove one definition.`,
      { env: path, providerId: provider.id, paths: [existing.path, path] },
    );
  }
  entries.set(provider.id, { provider, path });
}

function readProviderPiNative(value: unknown): Readonly<Record<string, unknown>> {
  const source = "providers.piNative";
  const record = readPlainObject(value, source);
  const allowed = new Set(["transport", "piMaxRetries", "maxRetryDelayMs", "piSessionsRoot"]);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key)).sort();
  if (unknownKeys.length > 0) {
    throw new MonoAgentConfigError("invalid_env", `${source} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`, {
      env: source,
      unknownKeys,
    });
  }
  return record;
}

function layerProviderReservedValuesOntoEnv(
  providers: ConfiguredProviderEnvelope,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const layered = { ...env };
  if (normalizeOptionalString(env.MONO_AGENT_PI_AUTH_PATH) === undefined && providers.piAuthPath !== undefined) {
    layered.MONO_AGENT_PI_AUTH_PATH = providers.piAuthPath;
  }
  const mappings = [
    ["transport", "MONO_AGENT_PI_TRANSPORT"],
    ["piMaxRetries", "MONO_AGENT_PI_MAX_RETRIES"],
    ["maxRetryDelayMs", "MONO_AGENT_MAX_RETRY_DELAY_MS"],
    ["piSessionsRoot", "MONO_AGENT_PI_SESSIONS_ROOT"],
  ] as const;
  for (const [property, envKey] of mappings) {
    const value = providers.piNative?.[property];
    if (normalizeOptionalString(env[envKey]) === undefined && value !== undefined) {
      layered[envKey] = String(value);
    }
  }
  return layered;
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
      ...(config.providers.entries === undefined
        ? {}
        : {
            entries: config.providers.entries.map((provider) => redactProviderDefinition(provider)),
          }),
      ...(config.providers.local === undefined
        ? {}
        : {
            local: config.providers.local.map((provider) => redactProviderDefinition(provider)),
          }),
    },
  };
}

function redactProviderDefinition<T extends ProviderDefinition>(provider: T): Omit<T, "apiKey"> & {
  readonly apiKey?: ReturnType<typeof redactedSecret>;
} {
  const { apiKey, ...safeProvider } = provider;
  return {
    ...safeProvider,
    ...(apiKey === undefined ? {} : { apiKey: redactedSecret(apiKey) }),
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
    env.MONO_AGENT_PI_TRANSPORT,
    env.MONO_AGENT_PI_MAX_RETRIES,
    env.MONO_AGENT_MAX_RETRY_DELAY_MS,
    env.MONO_AGENT_PI_SESSIONS_ROOT,
  ].some((value) => normalizeOptionalString(value) !== undefined);
  if (!hasAny) {
    return undefined;
  }
  const transport = normalizeOptionalString(env.MONO_AGENT_PI_TRANSPORT) === undefined
    ? undefined
    : readChoice<PiTransport>(
        env.MONO_AGENT_PI_TRANSPORT,
        "MONO_AGENT_PI_TRANSPORT",
        PI_TRANSPORTS,
        "auto",
        invalidEnv,
      );
  const piMaxRetries = readOptionalInteger(env.MONO_AGENT_PI_MAX_RETRIES, "MONO_AGENT_PI_MAX_RETRIES", { min: 0, max: 8 });
  const maxRetryDelayMs = readOptionalInteger(env.MONO_AGENT_MAX_RETRY_DELAY_MS, "MONO_AGENT_MAX_RETRY_DELAY_MS", { min: 100, max: 3_600_000 });
  const piSessionsRoot = readOptionalPath(env.MONO_AGENT_PI_SESSIONS_ROOT, cwd);
  return {
    ...(transport === undefined ? {} : { transport }),
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

function readOptionalNumber(
  raw: string | undefined,
  name: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return undefined;
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${name} must be a number between ${bounds.min} and ${bounds.max}.`,
      { env: name, reason: "out_of_range" },
    );
  }
  return value;
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

function readUserPath(raw: string | undefined, cwd: string, defaultPath?: string): string {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    if (defaultPath !== undefined) {
      return defaultPath;
    }
    throw new MonoAgentConfigError("invalid_env", "Path value is required.");
  }
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return resolve(homedir(), normalized.slice(2));
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
