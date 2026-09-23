import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  isAutodiscoverableProviderId,
  isPrivateBaseUrl,
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
  renamedToolMessage,
  renamedToolName,
} from "./enums.js";
import type { MonoAgentConfigJson } from "./json-source.js";
import type { EffortLevel, MemoryBackend, MemoryConsolidationConfig, MemoryEmbeddingsCircuitBreakerConfig, MemoryEmbeddingsConfig, MemoryEmbeddingsProvider, MemoryLlmConfig, MemoryLlmProvider, MemoryMode, MemoryWriteMode, MonoAgentConfig, PiNativeProviderConfig, RedactedMonoAgentConfig, ResolvedProviders, MonoAgentInlineSubagentsConfig, MonoAgentSubagentConfig, MonoAgentSubagentModelChoice, MonoAgentSubagentsConfig, RuntimeFallbackConfig, RuntimeRetryConfig, SessionMode, SessionRollover, SkillDisclosureMode, WebFetchRenderMode, WebSearchBackend } from "./types.js";

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
 * Error factory bound to the `invalid_json` code, handed to the shared
 * `@mono-agent/agent-contracts` coercers so their fail-closed throws keep config's
 * typed error shape. The coercers report the field name under `details.env`;
 * every name handed to them is a JSON path (never an environment variable), so
 * it is re-attributed to `details.path` here -- the single translation point
 * between the string coercers and JSON-path diagnostics.
 */
const invalidJson: ConfigErrorFactory = (message, details) => {
  const { env, ...rest } = details ?? {};
  return new MonoAgentConfigError("invalid_json", message, {
    ...rest,
    ...(typeof env === "string" ? { path: env } : {}),
  });
};

export interface ResolveJsonMonoAgentConfigInput {
  /**
   * Parsed `mono-agent.config.json` content. The core loader reads nothing else:
   * no process environment variable influences the resolved config.
   */
  readonly json: MonoAgentConfigJson;
  readonly cwd: string;
}

/**
 * Retired settings stay explicit here so every loader entry point gives the
 * same repair instead of silently dropping a fallback chain or surfacing an
 * unactionable unknown-key error from a host-owned schema.
 *
 * `message` repairs the JSON key the operator actually edits. Stale
 * `MONO_AGENT_*` environment variables are silently ignored and never reported
 * here: there is no surface left that reads them.
 */
export interface RetiredConfigField {
  readonly path: string;
  readonly message: string;
  /** Return true only when the legacy JSON value represented active behavior. */
  readonly jsonValueIsActive?: (value: unknown) => boolean;
}

function retiredObservabilityJsonIsActive(value: unknown): boolean {
  if (!isRecord(value) || Array.isArray(value)) return true;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (keys.length !== 1 || keys[0] !== "exporters") return true;
  return !Array.isArray(value.exporters) || value.exporters.length !== 0;
}

function retiredSupermemorySelectorIsActive(value: unknown): boolean {
  return typeof value === "string" && normalizeOptionalString(value) === "supermemory";
}

function retiredSupermemoryBlockIsActive(value: unknown): boolean {
  return !isRecord(value) || Array.isArray(value) || Object.keys(value).length !== 0;
}

const RETIRED_SUPERMEMORY_SELECTOR_JSON_MESSAGE =
  "`memory.backend` no longer accepts `supermemory`: first-party Supermemory support was removed. Remove the selector before upgrading. mono-agent does not select a replacement or migrate remote data; remote data remains untouched.";
const RETIRED_SUPERMEMORY_BLOCK_JSON_MESSAGE =
  "`memory.supermemory` was removed with first-party Supermemory support. Remove the block before upgrading. mono-agent does not select a replacement or migrate remote data; remote data remains untouched.";

export const RETIRED_CONFIG_FIELDS: readonly RetiredConfigField[] = [
  {
    path: "runtime.permissionMode",
    message: "`runtime.permissionMode` was removed because the Pi runtime never enforced it. Delete the key; configure `sandbox` for enforced tool isolation.",
  },
  {
    path: "tools.web.search.hound.endpoint",
    message: "`tools.web.search.hound.endpoint` was removed: local search is built in. Delete the endpoint setting; no external service is contacted.",
  },
  {
    path: "tools.web.fetch.hound.endpoint",
    message: "`tools.web.fetch.hound.endpoint` was removed: local fetch is built in. Delete the endpoint setting; no external service is contacted.",
  },
  {
    path: "runtime.executionMode",
    message: "`runtime.executionMode` was removed; mono-agent runs only the Pi runtime (SDK). Delete the key.",
  },
  {
    path: "runtime.routeSafety",
    message: "`runtime.routeSafety` was removed; every route is Pi-native, so `per-route-native` has no meaning. Delete the key.",
  },
  {
    path: "runtime.fallbackModels",
    message: "`runtime.fallbackModels` was replaced by `runtime.fallbacks: [{ \"model\": \"...\" }]`. Replace the key with that shape.",
  },
  {
    path: "memory.backend",
    message: RETIRED_SUPERMEMORY_SELECTOR_JSON_MESSAGE,
    jsonValueIsActive: retiredSupermemorySelectorIsActive,
  },
  {
    path: "memory.supermemory",
    message: RETIRED_SUPERMEMORY_BLOCK_JSON_MESSAGE,
    jsonValueIsActive: retiredSupermemoryBlockIsActive,
  },
  {
    path: "memory.llm.executionMode",
    message: "`memory.llm.executionMode` was removed for the same reason as `runtime.executionMode`: mono-agent runs only the Pi runtime (SDK). Delete the key.",
  },
  {
    path: "observability",
    message: "`observability.exporters` was removed with first-party Phoenix/OTLP export. Remove the active exporter block before upgrading. Local run artifacts are unchanged and mono-agent does not select a replacement. If a final export is required, perform it before upgrading with the known-good version you already operate.",
    jsonValueIsActive: retiredObservabilityJsonIsActive,
  },
] as const;

/**
 * Reject active retired fields on any config-shaped object, including direct
 * JavaScript callers that bypass the JSON/environment loaders. Diagnostics name
 * only stable field paths and migration guidance; retired values are never
 * included because they may contain credentials or private service locations.
 */
export function assertNoRetiredMonoAgentConfig(config: object): void {
  const retired = RETIRED_CONFIG_FIELDS.filter((field) => {
    const found = ownConfigPathValue(config, field.path);
    if (!found.present) return false;
    return field.jsonValueIsActive?.(found.value) ?? true;
  });
  if (retired.length === 0) return;
  throw new MonoAgentConfigError("invalid_json", retired.map((field) => field.message).join(" "), {
    path: retired[0]!.path,
    paths: retired.map((field) => field.path),
  });
}

function ownConfigPathValue(config: object, path: string): { readonly present: boolean; readonly value?: unknown } {
  let current: unknown = config;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || Array.isArray(current)) return { present: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { present: false };
    current = current[segment];
  }
  return { present: true, value: current };
}

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 1_800_000;
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
export const MEMORY_LLM_JSON_PATHS = [
  "memory.llm.model",
  "memory.llm.provider",
  "memory.llm.endpoint",
  "memory.llm.trace",
  "memory.llm.timeoutMs",
] as const;
export const DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS = 365;
export const DEFAULT_ARTIFACT_RETENTION_MAX_COUNT = 50_000;
export const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS = 7;
export const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT = 5_000;
const DEFAULT_TRACE_HEARTBEAT_MS = 10_000;
const DEFAULT_TRACE_STALE_AFTER_MS = 30_000;
const DEFAULT_PI_AUTH_PATH = resolve(homedir(), ".pi", "agent", "auth.json");
export const MAX_AGENT_NAME_LENGTH = 80;

/**
 * JSON scalar coercion for direct `mono-agent.config.json` parsing.
 *
 * The shared `@mono-agent/agent-contracts` coercers operate on strings, so a
 * JSON scalar is rendered to its string form before validation. Numbers and
 * booleans stringify exactly the way the previous JSON-to-string projection
 * rendered them, which keeps every range, enum and choice diagnostic identical
 * apart from naming the JSON path instead of a variable nobody set. Objects and
 * arrays are never scalars: they fail closed with the path the operator edits.
 */
function jsonString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new MonoAgentConfigError("invalid_json", `${path} must be a string.`, { path });
}

function requireJsonString(value: unknown, path: string): string {
  const normalized = normalizeOptionalString(jsonString(value, path));
  if (normalized === undefined) {
    throw new MonoAgentConfigError("invalid_json", `${path} is required.`, { path });
  }
  return normalized;
}

function jsonInteger(
  value: unknown,
  path: string,
  fallback: number,
  bounds?: { readonly min: number; readonly max: number },
): number {
  return readInteger(jsonString(value, path), path, fallback, invalidJson, bounds);
}

function jsonOptionalInteger(
  value: unknown,
  path: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  if (value === undefined) return undefined;
  return readInteger(jsonString(value, path), path, bounds.min, invalidJson, bounds);
}

function jsonOptionalNumber(
  value: unknown,
  path: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `${path} must be a number between ${bounds.min} and ${bounds.max}.`,
        { path, reason: "out_of_range" },
      );
    }
    return value;
  }
  const normalized = normalizeOptionalString(jsonString(value, path));
  if (normalized === undefined) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${path} must be a number between ${bounds.min} and ${bounds.max}.`,
      { path, reason: "out_of_range" },
    );
  }
  return parsed;
}

function jsonBoolean(value: unknown, path: string, fallback: boolean): boolean {
  return readBoolean(jsonString(value, path), path, fallback, invalidJson);
}

function jsonOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  return readBoolean(jsonString(value, path), path, false, invalidJson);
}

function jsonChoice<T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
  fallback: T,
): T {
  return readChoice(jsonString(value, path), path, choices, fallback, invalidJson);
}

/**
 * Read a JSON string array. Arrays are kept element-wise so values containing
 * commas survive intact; a lone comma-separated string is still split for
 * tolerance. Anything else fails closed with the JSON path.
 */
function jsonStringArray(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return readCsv(value);
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== "string") {
        throw new MonoAgentConfigError("invalid_json", `${path} must be an array of strings.`, { path });
      }
      return entry;
    }).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  throw new MonoAgentConfigError("invalid_json", `${path} must be an array of strings.`, { path });
}

/**
 * Narrow an optional JSON block to a record. Missing stays missing; anything
 * present but not an object fails closed with the block path.
 */
function jsonRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new MonoAgentConfigError("invalid_json", `${path} must be an object.`, { path });
}

/**
 * Tolerant container access for the pure parent blocks (`runtime`, `context`,
 * `tools`, ...). A malformed parent behaves as absent so the required-field
 * and default logic below still produces the authoritative diagnostic.
 */
function jsonContainer(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function resolveJsonMonoAgentConfig(input: ResolveJsonMonoAgentConfigInput): MonoAgentConfig {
  assertNoRetiredMonoAgentConfig(input.json);
  const cwd = normalizeCwd(input.cwd);
  const json = input.json;
  const runtimeJson = jsonContainer(json.runtime);
  const contextJson = jsonContainer(json.context);
  const toolsJson = jsonContainer(json.tools);
  const webJson = jsonContainer(toolsJson?.web);
  const agentName = readAgentName(jsonString(jsonContainer(json.agent)?.name, "agent.name"));
  const model = parseModel(requireJsonString(runtimeJson?.model, "runtime.model"), "runtime.model");
  const fallbacks = readFallbacks(runtimeJson?.fallbacks);
  const retry = readRetryConfig(runtimeJson);
  assertUniqueFallbackRoutes(model, fallbacks);
  const maxTurns = readMaxTurns(runtimeJson?.maxTurns);
  const compaction = readRuntimeCompactionConfig(runtimeJson?.compaction);
  const workspace = readPath(jsonString(runtimeJson?.workspace, "runtime.workspace"), cwd, cwd);
  const session = readSessionConfig(runtimeJson?.session);
  const identityPath = readPath(requireJsonString(contextJson?.identityPath, "context.identityPath"), cwd);
  const soulPath = readOptionalPath(jsonString(contextJson?.soulPath, "context.soulPath"), cwd);
  const skillsRoot = readOptionalPath(jsonString(contextJson?.skillsRoot, "context.skillsRoot"), cwd);
  const selectedSkills = jsonStringArray(contextJson?.selectedSkills, "context.selectedSkills");
  // The skills loader rejects caps below 256 bytes; validate at the same floor.
  const skillMaxBytes = jsonOptionalInteger(contextJson?.skillMaxBytes, "context.skillMaxBytes", { min: 256, max: 1_000_000 });
  // Unset stays undefined so the harness default ("full" legacy) is preserved
  // byte-for-byte; only validate the choice when an operator opts in explicitly.
  const skillDisclosure = contextJson?.skillDisclosure === undefined
    ? undefined
    : jsonChoice<SkillDisclosureMode>(contextJson.skillDisclosure, "context.skillDisclosure", ["index", "full"], "full");
  const memory = readMemoryConfig(json.memory, cwd);
  const mcpConfigPath = readOptionalPath(jsonString(toolsJson?.mcpConfigPath, "tools.mcpConfigPath"), cwd);
  const mcpRequestContextServers = jsonStringArray(toolsJson?.mcpRequestContextServers, "tools.mcpRequestContextServers");
  const continuationServers = jsonStringArray(toolsJson?.continuationServers, "tools.continuationServers");
  const sandbox = readSandboxConfig(json.sandbox, workspace);
  const artifactsJson = jsonContainer(json.artifacts);
  const artifactDir = readPath(jsonString(artifactsJson?.dir, "artifacts.dir"), cwd, resolve(cwd, ".mono-agent", "artifacts"));
  const artifactRetention = readArtifactRetentionConfig(artifactsJson?.retention);
  const memoryArtifactRetention = readMemoryArtifactRetentionConfig(artifactsJson?.memoryRetention, artifactRetention);
  const traceability = readTraceabilityConfig(json.traceability, cwd, agentName);
  // Pi's auth path is routinely documented with a home-relative `~` prefix.
  // `path.resolve()` treats that prefix as a literal directory, so keep the
  // expansion explicit and limited to this user-owned credential path.
  const providerEnvelope = readConfiguredProviders(json.providers);
  const piAuthPath = readUserPath(providerEnvelope.piAuthPath, cwd, DEFAULT_PI_AUTH_PATH);
  const piNative = readPiNativeProviderConfig(providerEnvelope.piNative, cwd);
  const localProviders = providerEnvelope.entries
    .map((provider) => localProviderDefinitionFor(provider))
    .filter((provider): provider is LocalProviderDefinition => provider !== undefined);

  const effort = readEffort(jsonString(runtimeJson?.effort, "runtime.effort"));
  const concurrency = readConcurrencyConfig(json.concurrency);
  const subagents = readSubagentsConfig(json.subagents, cwd);
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
  };

  const context: MonoAgentConfig["context"] = {
    identityPath,
    selectedSkills,
    ...(soulPath === undefined ? {} : { soulPath }),
    ...(skillsRoot === undefined ? {} : { skillsRoot }),
    ...(skillMaxBytes === undefined ? {} : { skillMaxBytes }),
    ...(skillDisclosure === undefined ? {} : { skillDisclosure }),
  };

  const mcpCallTimeoutMs = readOptionalTimeoutMs(jsonString(toolsJson?.mcpCallTimeoutMs, "tools.mcpCallTimeoutMs"), "tools.mcpCallTimeoutMs");
  const mcpCallMaxTotalTimeoutMs = readOptionalTimeoutMs(
    jsonString(toolsJson?.mcpCallMaxTotalTimeoutMs, "tools.mcpCallMaxTotalTimeoutMs"),
    "tools.mcpCallMaxTotalTimeoutMs",
  );
  const searchJson = jsonContainer(webJson?.search);
  const fetchJson = jsonContainer(webJson?.fetch);
  const webSearchBackend = readWebProviderSelection<WebSearchBackend>(
    searchJson?.backend, "tools.web.search.backend",
    ["searxng", "ollama", "codex", "keyless", "duckduckgo", "startpage", "parallel", "local"],
    ["parallel", "ollama"], searchAutoRepair(searchJson),
    { hound: "`tools.web.search.backend` value `hound` was renamed to `local`; use `local` instead." },
  );
  const legacyWebSearchEndpoint = readWebSearchEndpoint(
    jsonString(searchJson?.endpoint, "tools.web.search.endpoint"),
    "tools.web.search.endpoint",
  );
  const canonicalWebSearchEndpoint = readWebSearchEndpoint(
    jsonString(jsonContainer(searchJson?.searxng)?.endpoint, "tools.web.search.searxng.endpoint"),
    "tools.web.search.searxng.endpoint",
  );
  if (
    legacyWebSearchEndpoint !== undefined
    && canonicalWebSearchEndpoint !== undefined
    && legacyWebSearchEndpoint !== canonicalWebSearchEndpoint
  ) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.endpoint and tools.web.search.searxng.endpoint disagree; keep only the canonical SearXNG setting.",
      { path: "tools.web.search.searxng.endpoint" },
    );
  }
  const webSearchEndpoint = canonicalWebSearchEndpoint ?? legacyWebSearchEndpoint;
  const webSearchOllama = readOllamaWebSearchConfig(searchJson?.ollama, webSearchBackend);
  const webSearchCodexModel = readWebSearchCodexModel(jsonString(jsonContainer(searchJson?.codex)?.model, "tools.web.search.codex.model"));
  const webSearchMaxRequestsPerRun = jsonInteger(
    searchJson?.maxRequestsPerRun,
    "tools.web.search.maxRequestsPerRun",
    4,
    { min: 1, max: 20 },
  );
  if (selectedWebProvider(webSearchBackend, "searxng") && webSearchEndpoint === undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.searxng.endpoint (or legacy tools.web.search.endpoint) is required when tools.web.search.backend selects searxng.",
      { path: "tools.web.search.searxng.endpoint" },
    );
  }
  const webSearchParallel = readParallelWebConfig(searchJson?.parallel, "tools.web.search.parallel.apiKeyEnv");
  const webFetchParallel = readParallelWebConfig(fetchJson?.parallel, "tools.web.fetch.parallel.apiKeyEnv");
  const webFetchProvider = readWebProviderSelection<"local" | "parallel">(
    fetchJson?.provider, "tools.web.fetch.provider", ["local", "parallel"], "local", undefined,
    { hound: "`tools.web.fetch.provider` value `hound` was renamed to `local`, which is not equivalent: `local` uses the standard fetch retry policy, performs no robots preflight, and honors the configured render mode instead of forcing document-only/render-never. Update the selection to `local` only if that posture is acceptable." },
  );
  const webFetchRender = jsonChoice<WebFetchRenderMode>(
    jsonContainer(webJson?.fetch)?.render,
    "tools.web.fetch.render",
    ["never", "auto"],
    "never",
  );
  if (webFetchRender === "auto" && !selectedWebProvider(webFetchProvider, "local")) {
    throw new MonoAgentConfigError("invalid_json", 'tools.web.fetch.render "auto" requires the local fetch provider.', { path: "tools.web.fetch.provider" });
  }
  const webBrowserCommand = readWebBrowserCommand(jsonString(fetchJson?.browserCommand, "tools.web.fetch.browserCommand"));
  const filesystemJson = jsonContainer(toolsJson?.filesystem);
  const fileToolReadableRoots = readFileToolRoots(
    filesystemJson?.readableRoots,
    "tools.filesystem.readableRoots",
  )
    .map((path) => readPath(path, cwd));
  const fileToolWritableRoots = readFileToolRoots(
    filesystemJson?.writableRoots,
    "tools.filesystem.writableRoots",
  )
    .map((path) => readPath(path, cwd));
  const tools: MonoAgentConfig["tools"] = {
    // Omitted `tools.allowedTools` → allow-all default; an explicit empty
    // list ([]) means chat-only.
    allowedTools:
      toolsJson?.allowedTools === undefined
        ? [ALLOW_ALL_TOOLS]
        : jsonStringArray(toolsJson.allowedTools, "tools.allowedTools"),
    disallowedTools: jsonStringArray(toolsJson?.disallowedTools, "tools.disallowedTools"),
    ...(fileToolReadableRoots.length === 0 && fileToolWritableRoots.length === 0
      ? {}
      : {
          filesystem: {
            readableRoots: fileToolReadableRoots,
            writableRoots: fileToolWritableRoots,
          },
        }),
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
    ...(mcpRequestContextServers.length === 0 ? {} : { mcpRequestContextServers }),
    ...(continuationServers.length === 0 ? {} : { continuationServers }),
    ...(mcpCallTimeoutMs === undefined ? {} : { mcpCallTimeoutMs }),
    ...(mcpCallMaxTotalTimeoutMs === undefined ? {} : { mcpCallMaxTotalTimeoutMs }),
    web: {
      coordination: jsonChoice(webJson?.coordination, "tools.web.coordination", ["process", "host"] as const, "process"),
      search: {
        backend: webSearchBackend,
        ...(webSearchParallel === undefined ? {} : { parallel: webSearchParallel }),
        maxRequestsPerRun: webSearchMaxRequestsPerRun,
        ...(webSearchEndpoint === undefined ? {} : { searxng: { endpoint: webSearchEndpoint } }),
        ...(webSearchOllama === undefined ? {} : { ollama: webSearchOllama }),
        codex: { model: webSearchCodexModel },
      },
      fetch: {
        provider: webFetchProvider,
        ...(webFetchParallel === undefined ? {} : { parallel: webFetchParallel }),
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
        "invalid_json",
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
  return [...(subagents?.models ?? []).map((choice, index) => ({
    model: choice.model, path: `subagents.models[${index}].model`,
  })), ...(subagents?.definitions ?? []).flatMap((definition, index) =>
    definition.model === undefined
      ? []
      : [{ model: definition.model, path: `subagents.definitions[${index}].model` }],
  )];
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

export function redactMonoAgentConfig(config: MonoAgentConfig): RedactedMonoAgentConfig {
  assertNoRetiredMonoAgentConfig(config);
  const { web: configuredWeb, ...toolsWithoutWeb } = config.tools;
  const configuredSearch = configuredWeb?.search;
  const {
    ollama: configuredOllamaSearch,
    codex: configuredCodexSearch,
    ...searchWithoutSecrets
  } = configuredSearch ?? { backend: ["parallel", "ollama"] as const, maxRequestsPerRun: 4 };
  const redacted: RedactedMonoAgentConfig = {
    ...(config.agent === undefined ? {} : { agent: { ...config.agent } }),
    runtime: { ...config.runtime },
    ...(config.concurrency === undefined ? {} : { concurrency: { ...config.concurrency } }),
    context: { ...config.context, selectedSkills: [...config.context.selectedSkills] },
    tools: {
      ...toolsWithoutWeb,
      allowedTools: [...config.tools.allowedTools],
      disallowedTools: [...config.tools.disallowedTools],
      ...(config.tools.filesystem === undefined ? {} : {
        filesystem: {
          readableRoots: [...config.tools.filesystem.readableRoots],
          writableRoots: [...config.tools.filesystem.writableRoots],
        },
      }),
      ...(configuredWeb === undefined ? {} : {
        web: {
          coordination: configuredWeb.coordination ?? "process",
          search: {
            ...searchWithoutSecrets,
            ...(configuredOllamaSearch === undefined
              ? {}
              : { ollama: redactApiKeyBlock(configuredOllamaSearch) }),
            ...(configuredCodexSearch === undefined
              ? {}
              : { codex: { ...configuredCodexSearch } }),
          },
          fetch: { ...configuredWeb.fetch },
        },
      }),
    },
    ...(config.sandbox === undefined ? {} : { sandbox: { ...config.sandbox } }),
    artifacts: { ...config.artifacts },
    traceability: { ...config.traceability },
  };
  if (config.memory !== undefined) {
    // The only tolerated direct legacy shape is an inert empty tombstone. It is
    // compatibility input, not resolved output, so never carry it into views.
    const { embeddings, supermemory: _retiredSupermemory, ...memory } = config.memory as
      NonNullable<MonoAgentConfig["memory"]> & { readonly supermemory?: unknown };
    return withRedactedProviders({
      ...redacted,
      memory: {
        ...memory,
        ...(embeddings === undefined ? {} : { embeddings: redactApiKeyBlock(embeddings) }),
      },
    }, config);
  }
  return withRedactedProviders(redacted, config);
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

function parseModel(raw: string, path: string): MonoAgentConfig["runtime"]["model"] {
  try {
    return parseMonoRuntimeModelReference(raw);
  } catch (error) {
    const reason = modelReferenceReason(error);
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `${path} \`${modelReferenceEcho(raw)}\` is not a valid runtime model reference: ${reason}`,
      { path, reason },
    );
  }
}

function readFallbacks(value: unknown): readonly RuntimeFallbackConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", "runtime.fallbacks must be an array.", {
      path: "runtime.fallbacks",
    });
  }
  const parsed = value;
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.fallbacks entry ${index + 1} must be an object with a model.`,
        { path: "runtime.fallbacks", index },
      );
    }
    const record = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) => key !== "model" && key !== "effort" && key !== "attempts",
    );
    if (unknownKeys.length > 0) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.fallbacks entry ${index + 1} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.sort().join(", ")}. Only model, effort, and attempts are supported.`,
        { path: "runtime.fallbacks", index, unknownKeys: unknownKeys.sort() },
      );
    }
    if (typeof record.model !== "string" || record.model.trim().length === 0) {
      throw new MonoAgentConfigError(
        "invalid_model_reference",
        `runtime.fallbacks entry ${index + 1} must contain a non-empty model reference.`,
        { path: "runtime.fallbacks", index },
      );
    }
    const model = parseFallbackModel(record.model, index);
    const attempts = readFallbackAttempts(record.attempts, index);
    if (record.effort === undefined) {
      return attempts === undefined ? { model } : { model, attempts };
    }
    if (typeof record.effort !== "string") {
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.fallbacks entry ${index + 1} effort must be one of: ${EFFORT_LEVELS.join(", ")}.`,
        { path: "runtime.fallbacks", index },
      );
    }
    const normalizedEffort = normalizeOptionalString(record.effort);
    if (normalizedEffort === undefined) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.fallbacks entry ${index + 1} effort must be one of: ${EFFORT_LEVELS.join(", ")}.`,
        { path: "runtime.fallbacks", index },
      );
    }
    const effort = readChoice<EffortLevel>(
      normalizedEffort,
      `runtime.fallbacks[${index}].effort`,
      EFFORT_LEVELS,
      "medium",
      invalidJson,
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
      "invalid_json",
      `runtime.fallbacks entry ${index + 1} attempts must be an integer between 1 and 10.`,
      { path: "runtime.fallbacks", index },
    );
  }
  return value;
}

const SUBAGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/u;

function readSubagentsConfig(
  value: unknown,
  cwd: string,
): MonoAgentSubagentsConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = jsonRecord(value, "subagents");
  if (parsed === undefined) {
    return undefined;
  }
  const record = parsed;
  const definitions = readSubagentDefinitions(record.definitions, cwd);
  const models = readSubagentModels(record.models, definitions);
  return {
    ...(record.enabled === undefined ? {} : { enabled: readSubagentBoolean(record.enabled, "enabled") }),
    ...(record.maxConcurrent === undefined ? {} : { maxConcurrent: readSubagentInteger(record.maxConcurrent, "maxConcurrent", 1, 10) }),
    ...(record.maxPerTurn === undefined ? {} : { maxPerTurn: readSubagentInteger(record.maxPerTurn, "maxPerTurn", 1, 200) }),
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: readSubagentInteger(record.timeoutMs, "timeoutMs", 1_000, 3_600_000) }),
    ...(record.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: readSubagentInteger(record.commandTimeoutMs, "commandTimeoutMs", 1, Number.MAX_SAFE_INTEGER) }),
    ...(record.maxTurns === undefined ? {} : { maxTurns: readSubagentInteger(record.maxTurns, "maxTurns", 1, 400) }),
    ...(definitions === undefined ? {} : { definitions }),
    ...(models === undefined ? {} : { models }),
    ...(record.inline === undefined ? {} : { inline: readInlineSubagentsConfig(record.inline) }),
    ...(record.instances === undefined ? {} : { instances: readSubagentInstancesConfig(record.instances, cwd) }),
  };
}

function readSubagentInstancesConfig(value: unknown, cwd: string): NonNullable<MonoAgentSubagentsConfig["instances"]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSubagents("instances must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["enabled", "root", "maxPerConversation", "idleTtlMs", "maxTurns"].includes(key)) {
      throw invalidSubagents(`instances contains unknown field "${key}".`);
    }
  }
  if (record.root !== undefined && (typeof record.root !== "string" || !record.root.trim())) {
    throw invalidSubagents("instances.root must be a non-empty path.");
  }
  return {
    ...(record.enabled === undefined ? {} : { enabled: readSubagentBoolean(record.enabled, "instances.enabled") }),
    ...(record.root === undefined ? {} : { root: readPath(String(record.root), cwd) }),
    ...(record.maxPerConversation === undefined ? {} : { maxPerConversation: readSubagentInteger(record.maxPerConversation, "instances.maxPerConversation", 1, 32) }),
    ...(record.idleTtlMs === undefined ? {} : { idleTtlMs: readSubagentInteger(record.idleTtlMs, "instances.idleTtlMs", 60_000, 604_800_000) }),
    ...(record.maxTurns === undefined ? {} : { maxTurns: readSubagentInteger(record.maxTurns, "instances.maxTurns", 1, 500) }),
  };
}

function readSubagentModels(
  value: unknown,
  definitions: readonly MonoAgentSubagentConfig[] | undefined,
): readonly MonoAgentSubagentModelChoice[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidSubagents("models must be an array.");
  const names = new Set<string>();
  const models = new Set<string>();
  const reserved = new Set(["general-purpose", ...(definitions ?? []).map((definition) => definition.name)]);
  return value.map((entry, index) => {
    const subject = `models[${index}]`;
    if (typeof entry !== "string" && (entry === null || typeof entry !== "object" || Array.isArray(entry))) {
      throw invalidSubagents(`${subject} must be a model reference string or object.`);
    }
    const record = typeof entry === "string" ? { model: entry } : entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "name" && key !== "model") throw invalidSubagents(`${subject} contains unknown field "${key}".`);
    }
    if (typeof record.model !== "string" || record.model.trim().length === 0) {
      throw invalidSubagents(`${subject} model must be a model reference string.`);
    }
    let model: RuntimeModelReference;
    try {
      model = parseMonoRuntimeModelReference(record.model);
    } catch (error) {
      const reason = modelReferenceReason(error);
      throw new MonoAgentConfigError("invalid_model_reference",
        `subagents ${subject} model \`${modelReferenceEcho(record.model)}\` is not a valid runtime model reference: ${reason}`,
        { path: "subagents", reason });
    }
    if (record.name !== undefined && (typeof record.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(record.name))) {
      throw invalidSubagents(`${subject} name must be lowercase kebab-case, 1-40 characters, without a colon.`);
    }
    const key = modelReferenceKey(model);
    const name = record.name as string | undefined;
    const effectiveName = name ?? key;
    if (reserved.has(effectiveName)) throw invalidSubagents(`${subject} name "${effectiveName}" collides with a subagent name.`);
    if (models.has(key)) throw invalidSubagents(`${subject} duplicate model reference "${key}".`);
    if (names.has(effectiveName)) throw invalidSubagents(`${subject} duplicate model name "${effectiveName}".`);
    names.add(effectiveName);
    models.add(key);
    return { ...(name === undefined ? {} : { name }), model };
  });
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
  if (allowedTools?.some((tool) => tool === "Agent" || tool === "AgentManage")) {
    throw invalidSubagents("inline allowedTools cannot allow Agent or AgentManage; subagents never spawn subagents or continue other instances.");
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
    if (allowedTools?.some((tool) => tool === "Agent" || tool === "AgentManage")) {
      throw invalidSubagents(`definition "${name}" cannot allow Agent or AgentManage; subagents never spawn subagents or continue other instances.`);
    }
    return {
      name,
      description,
      ...(hasPrompt ? { prompt: String(record.prompt).trim() } : {}),
      ...(hasPromptPath ? { promptPath: readPath(String(record.promptPath), cwd) } : {}),
      ...(record.model === undefined ? {} : { model: parseSubagentModel(record.model, name) }),
      ...(record.effort === undefined ? {} : {
        effort: readChoice<EffortLevel>(String(record.effort), `subagents.definitions[${index}].effort`, EFFORT_LEVELS, "medium", invalidJson),
      }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(mcpServers === undefined ? {} : { mcpServers }),
      ...(record.maxTurns === undefined ? {} : { maxTurns: readSubagentInteger(record.maxTurns, `definition "${name}" maxTurns`, 1, 400) }),
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
      `subagents definition "${name}" model \`${modelReferenceEcho(value)}\` is not a valid runtime model reference: ${reason}`,
      { path: "subagents", reason },
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
  const tools = value.map((entry) => String(entry).trim());
  if (field !== "mcpServers") {
    // A renamed tool has no alias, so a stale entry would grant or deny
    // nothing. Name the migration instead of accepting it silently.
    const retired = tools.find((tool) => renamedToolName(tool) !== undefined);
    if (retired !== undefined) {
      throw invalidSubagents(renamedToolMessage(retired, `${subject} ${field}`));
    }
  }
  return tools;
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
  return new MonoAgentConfigError("invalid_json", `subagents ${detail}`, {
    path: "subagents",
  });
}

function readRetryConfig(runtime: Record<string, unknown> | undefined): RuntimeRetryConfig {
  const retry = jsonRecord(runtime?.retry, "runtime.retry") ?? {};
  return {
    primaryAttempts: readRetryInteger(retry.primaryAttempts, "runtime.retry.primaryAttempts", 2, 1, 10),
    backoffMs: readRetryInteger(retry.backoffMs, "runtime.retry.backoffMs", 1_000, 0, 60_000),
    maxBackoffMs: readRetryInteger(retry.maxBackoffMs, "runtime.retry.maxBackoffMs", 15_000, 0, 300_000),
  };
}

function readRetryInteger(
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const normalized = normalizeOptionalString(jsonString(value, path));
  if (normalized === undefined) {
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${path} must be an integer between ${min} and ${max}.`,
      { path },
    );
  }
  return parsed;
}

function parseFallbackModel(raw: string, index: number): MonoAgentConfig["runtime"]["model"] {
  const path = `runtime.fallbacks[${index}].model`;
  try {
    return parseMonoRuntimeModelReference(raw.trim());
  } catch (error) {
    const reason = modelReferenceReason(error);
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `${path} \`${modelReferenceEcho(raw)}\` is not a valid runtime model reference: ${reason}`,
      { path, index, reason },
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
        "invalid_json",
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
      "invalid_json",
      `agent.name must be a single-line name between 1 and ${MAX_AGENT_NAME_LENGTH} characters.`,
      { path: "agent.name", maxLength: MAX_AGENT_NAME_LENGTH },
    );
  }
  return name;
}

/** Optional per-MCP-call timeout override; unset defers to the runtime defaults (120s inactivity / 45 min total). */
function readOptionalTimeoutMs(raw: string | undefined, name: string): number | undefined {
  if (normalizeOptionalString(raw) === undefined) {
    return undefined;
  }
  return readInteger(raw, name, 0, invalidJson, { min: 1000, max: 86_400_000 });
}

function readWebSearchEndpoint(raw: string | undefined, source: string): string | undefined {
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
      "invalid_json",
      `${source} must be an unauthenticated loopback HTTP URL.`,
      { path: source },
    );
  }
}


const DEFAULT_OLLAMA_WEB_SEARCH_BASE_URL = "http://127.0.0.1:11434";
const OFFICIAL_OLLAMA_ORIGIN = "https://ollama.com";

function readOllamaWebSearchConfig(
  value: unknown,
  backend: WebSearchBackend | readonly WebSearchBackend[],
): NonNullable<NonNullable<MonoAgentConfig["tools"]["web"]>["search"]["ollama"]> | undefined {
  const ollama = jsonRecord(value, "tools.web.search.ollama");
  if (ollama === undefined && !selectedWebProvider(backend, "ollama")) {
    return undefined;
  }
  const block = ollama ?? {};

  const source = "tools.web.search.ollama.baseUrl";
  const baseUrlRaw = normalizeOptionalString(jsonString(block.baseUrl, source));
  const apiKeyEnv = normalizeOptionalString(jsonString(block.apiKeyEnv, "tools.web.search.ollama.apiKeyEnv"));
  const trustRaw = jsonString(block.trustPublicUrl, "tools.web.search.ollama.trustPublicUrl");
  let parsed: URL;
  try {
    parsed = new URL(baseUrlRaw ?? DEFAULT_OLLAMA_WEB_SEARCH_BASE_URL);
  } catch {
    throw new MonoAgentConfigError("invalid_json", `${source} must be a valid HTTP(S) origin URL.`, { path: source });
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !["", "/"].includes(parsed.pathname)
  ) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${source} must be an HTTP(S) origin without credentials, path, query, or fragment.`,
      { path: source },
    );
  }
  const baseUrl = parsed.origin;
  const official = baseUrl === OFFICIAL_OLLAMA_ORIGIN;
  const trustPublicUrl = trustRaw === undefined
    ? false
    : readBoolean(trustRaw, "tools.web.search.ollama.trustPublicUrl", false, invalidJson);
  if (!official && !isPrivateBaseUrl(baseUrl)) {
    if (parsed.protocol !== "https:" || !trustPublicUrl) {
      throw new MonoAgentConfigError(
        "invalid_json",
        `${source} points to a public custom origin; use HTTPS and set tools.web.search.ollama.trustPublicUrl to true after reviewing it.`,
        { path: source },
      );
    }
  }
  if (!official && apiKeyEnv !== undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.ollama.apiKeyEnv is allowed only for the exact https://ollama.com origin.",
      { path: "tools.web.search.ollama.apiKeyEnv" },
    );
  }
  if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.ollama.apiKeyEnv must name an environment variable.",
      { path: "tools.web.search.ollama.apiKeyEnv" },
    );
  }
  if (official && apiKeyEnv === undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.ollama.apiKeyEnv is required for hosted Ollama Web Search.",
      { path: "tools.web.search.ollama.apiKeyEnv" },
    );
  }
  // The named credential stays unresolved at load: the web runtime reads it
  // from the effective environment when it calls the provider.
  return {
    baseUrl,
    trustPublicUrl,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
  };
}

function readWebSearchCodexModel(raw: string | undefined): string {
  const value = normalizeOptionalString(raw) ?? "gpt-5.6-luna";
  if (value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.codex.model must be a non-empty model id of at most 160 characters without control characters.",
      { path: "tools.web.search.codex.model" },
    );
  }
  return value;
}

function readWebBrowserCommand(raw: string | undefined): string {
  const value = normalizeOptionalString(raw) ?? "agent-browser";
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.fetch.browserCommand must be one executable name or path without control characters.",
      { path: "tools.web.fetch.browserCommand" },
    );
  }
  return value;
}

function readMaxTurns(value: unknown): number | undefined {
  const maxTurns = jsonInteger(value, "runtime.maxTurns", 0, { min: 0, max: 100 });
  return maxTurns === 0 ? undefined : maxTurns;
}

function readRuntimeCompactionConfig(
  value: unknown,
): NonNullable<MonoAgentConfig["runtime"]["compaction"]> {
  const compaction = jsonRecord(value, "runtime.compaction") ?? {};
  const triggerRatio = jsonOptionalNumber(
    compaction.triggerRatio,
    "runtime.compaction.triggerRatio",
    { min: 0.2, max: 0.95 },
  );
  const keepRecentTokens = jsonOptionalInteger(
    compaction.keepRecentTokens,
    "runtime.compaction.keepRecentTokens",
    { min: 4_000, max: 200_000 },
  );
  const summaryMaxTokens = jsonOptionalInteger(
    compaction.summaryMaxTokens,
    "runtime.compaction.summaryMaxTokens",
    { min: 1_000, max: 64_000 },
  );
  const minSavingsTokens = jsonOptionalInteger(
    compaction.minSavingsTokens,
    "runtime.compaction.minSavingsTokens",
    { min: 0, max: 500_000 },
  );
  const contextWindowOverride = jsonOptionalInteger(
    compaction.contextWindowOverride,
    "runtime.compaction.contextWindowOverride",
    { min: 32_000, max: 10_000_000 },
  );
  return {
    enabled: jsonBoolean(
      compaction.enabled,
      "runtime.compaction.enabled",
      true,
    ),
    ...(triggerRatio === undefined ? {} : { triggerRatio }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
    ...(summaryMaxTokens === undefined ? {} : { summaryMaxTokens }),
    ...(minSavingsTokens === undefined ? {} : { minSavingsTokens }),
    fixedOverheadEnabled: jsonBoolean(
      compaction.fixedOverheadEnabled,
      "runtime.compaction.fixedOverheadEnabled",
      true,
    ),
    ...(contextWindowOverride === undefined ? {} : { contextWindowOverride }),
  };
}

function readArtifactRetentionConfig(value: unknown): MonoAgentConfig["artifacts"]["retention"] {
  const retention = jsonRecord(value, "artifacts.retention") ?? {};
  return {
    maxAgeDays: jsonInteger(
      retention.maxAgeDays,
      "artifacts.retention.maxAgeDays",
      DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS,
      { min: 1, max: 3_650 },
    ),
    maxCount: jsonInteger(
      retention.maxCount,
      "artifacts.retention.maxCount",
      DEFAULT_ARTIFACT_RETENTION_MAX_COUNT,
      { min: 1, max: 1_000_000 },
    ),
    dryRun: jsonBoolean(
      retention.dryRun,
      "artifacts.retention.dryRun",
      false,
    ),
  };
}

function readMemoryArtifactRetentionConfig(
  value: unknown,
  agentRetention: MonoAgentConfig["artifacts"]["retention"],
): MonoAgentConfig["artifacts"]["memoryRetention"] {
  const retention = jsonRecord(value, "artifacts.memoryRetention") ?? {};
  return {
    maxAgeDays: jsonInteger(
      retention.maxAgeDays,
      "artifacts.memoryRetention.maxAgeDays",
      DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS,
      { min: 1, max: 3_650 },
    ),
    maxCount: jsonInteger(
      retention.maxCount,
      "artifacts.memoryRetention.maxCount",
      DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT,
      { min: 1, max: 1_000_000 },
    ),
    dryRun: jsonBoolean(
      retention.dryRun,
      "artifacts.memoryRetention.dryRun",
      agentRetention.dryRun,
    ),
  };
}

function readSandboxConfig(value: unknown, workspace: string): MonoAgentConfig["sandbox"] | undefined {
  const sandbox = jsonRecord(value, "sandbox");
  if (sandbox === undefined) {
    return undefined;
  }
  const network = jsonRecord(sandbox.network, "sandbox.network") ?? {};
  // An empty block configures nothing: it stays absent rather than materializing
  // a default-deny policy the operator never asked for.
  const configured = [
    sandbox.mode,
    network.mode,
    network.allowlist,
    sandbox.readableRoots,
    sandbox.writableRoots,
    sandbox.denyWrite,
    sandbox.fallback,
    sandbox.unsafeAllowHostProcess,
  ].some((field) => field !== undefined);
  if (!configured) {
    return undefined;
  }

  const mode = jsonChoice<SandboxMode>(sandbox.mode, "sandbox.mode", SANDBOX_MODES, "native");
  const networkMode = jsonChoice<SandboxNetworkMode>(network.mode, "sandbox.network.mode", SANDBOX_NETWORK_MODES, "none");
  const fallback = jsonChoice<SandboxFallback>(sandbox.fallback, "sandbox.fallback", SANDBOX_FALLBACKS, "fail-closed");
  // Filesystem scope entries are resolved by the sandbox against `root` (the
  // workspace), so relative entries here mean "relative to the workspace".
  const readableRoots = jsonStringArray(sandbox.readableRoots, "sandbox.readableRoots");
  const writableRoots = jsonStringArray(sandbox.writableRoots, "sandbox.writableRoots");
  const denyWrite = jsonStringArray(sandbox.denyWrite, "sandbox.denyWrite");
  try {
    return createSandboxPolicy({
      mode,
      root: workspace,
      ...(readableRoots.length === 0 ? {} : { readableRoots }),
      ...(writableRoots.length === 0 ? {} : { writableRoots }),
      ...(denyWrite.length === 0 ? {} : { denyWrite }),
      network: {
        mode: networkMode,
        allowlist: jsonStringArray(network.allowlist, "sandbox.network.allowlist"),
      },
      fallback,
      unsafeAllowHostProcess: jsonBoolean(
        sandbox.unsafeAllowHostProcess,
        "sandbox.unsafeAllowHostProcess",
        false,
      ),
    });
  } catch (error) {
    if (error instanceof SandboxPolicyError) {
      throw new MonoAgentConfigError("invalid_json", `Sandbox policy config is invalid: ${error.message}`, {
        path: sandboxPolicyErrorPath(error),
        reason: error.message,
      });
    }
    throw error;
  }
}

function sandboxPolicyErrorPath(error: SandboxPolicyError): string {
  const field = typeof error.details.field === "string" ? error.details.field : undefined;
  if (field === "unsafeAllowHostProcess") {
    return "sandbox.unsafeAllowHostProcess";
  }
  if (field === "readableRoots" || field?.startsWith("readableRoots[")) {
    return "sandbox.readableRoots";
  }
  if (field === "writableRoots" || field?.startsWith("writableRoots[")) {
    return "sandbox.writableRoots";
  }
  if (field === "denyWrite" || field?.startsWith("denyWrite[")) {
    return "sandbox.denyWrite";
  }
  if (field === "network.allowlist" || field?.startsWith("network.allowlist[")) {
    return "sandbox.network.allowlist";
  }
  if (field === "network.mode") {
    return "sandbox.network.mode";
  }
  if (field === "fallback") {
    return "sandbox.fallback";
  }
  if (field === "root") {
    return "runtime.workspace";
  }
  return "sandbox.mode";
}

function readSessionConfig(value: unknown): MonoAgentConfig["runtime"]["session"] {
  const session = jsonRecord(value, "runtime.session") ?? {};
  const mode = jsonChoice<SessionMode>(session.mode, "runtime.session.mode", [
    "continuous",
    "per-message",
  ], "continuous");
  const idleTimeoutMs = jsonInteger(
    session.idleTimeoutMs,
    "runtime.session.idleTimeoutMs",
    DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    { min: 1_000, max: 86_400_000 },
  );
  const rollover = jsonChoice<SessionRollover>(session.rollover, "runtime.session.rollover", [
    "none",
    "daily",
  ], "none");
  const rolloverTimezone = normalizeOptionalString(jsonString(session.rolloverTimezone, "runtime.session.rolloverTimezone"));
  // Unset stays undefined so hosts can keep their existing display policy;
  // explicit false is preserved for operators who want to suppress notices.
  const rolloverNotice = jsonOptionalBoolean(session.rolloverNotice, "runtime.session.rolloverNotice");
  // Unset stays undefined so the harness default (false, no behavior change) is
  // preserved byte-for-byte; only parse the boolean when an operator opts in.
  const isolateProactive = jsonOptionalBoolean(session.isolateProactive, "runtime.session.isolateProactive");
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
 * A JSON memory field counts as configured when it is present and non-blank,
 * mirroring how blank strings used to fall through to defaults.
 */
function hasMemoryJsonField(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined;
}

function readMemoryConfig(value: unknown, cwd: string): MonoAgentConfig["memory"] | undefined {
  const memory = jsonRecord(value, "memory");
  if (memory === undefined) {
    return undefined;
  }
  const backend = jsonChoice<MemoryBackend>(
    memory.backend,
    "memory.backend",
    MEMORY_BACKENDS,
    "bujo",
  );
  const rawPath = normalizeOptionalString(jsonString(memory.path, "memory.path"));
  const embeddingsJson = jsonContainer(memory.embeddings);
  const llmJson = jsonContainer(memory.llm);
  const recallToolJson = jsonContainer(memory.recallTool);
  const rememberToolJson = jsonContainer(memory.rememberTool);
  const consolidationJson = jsonContainer(memory.consolidation);

  // Every configured local memory setting requires a durable path.
  if (rawPath === undefined) {
    const orphaned = [
      "memory.mode",
      "memory.writeMode",
      "memory.maxBytes",
      "memory.embeddings.provider",
      "memory.embeddings.model",
      "memory.embeddings.endpoint",
      "memory.embeddings.apiKey",
      "memory.embeddings.apiKeyEnv",
      "memory.rememberTool.enabled",
      "memory.embeddings.dim",
      "memory.embeddings.timeoutMs",
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
  // Capture requires the local BuJo tier and its chat LLM.
  if (writeMode === "capture" && mode !== "bujo") {
    throw new MonoAgentConfigError(
      "invalid_json",
      `memory.writeMode "capture" requires memory.mode "bujo" (it needs a chat LLM).`,
      { path: "memory.writeMode" },
    );
  }
  if ((mode === "lite" || mode === "journal") && hasMemoryLlmJson(llmJson)) {
    const message = mode === "lite"
      ? 'memory.mode "lite" is lexical-only and cannot configure memory.llm. Remove it or select journal/bujo.'
      : 'memory.mode "journal" is semantic-only and cannot configure a capture LLM or BuJo consolidation.';
    throw new MonoAgentConfigError("invalid_json", message, { path: "memory.mode" });
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
    ...(embeddings === undefined ? {} : { embeddings }),
    ...(llm === undefined ? {} : { llm }),
    recallTool: { enabled: recallToolEnabled },
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
  const circuitBreaker = readMemoryEmbeddingsCircuitBreakerConfig(embeddings.circuitBreaker);
  return {
    provider,
    model,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(dim === undefined ? {} : { dim }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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

function readTraceabilityConfig(
  value: unknown,
  cwd: string,
  agentName: string | undefined,
): MonoAgentConfig["traceability"] {
  const traceability = jsonRecord(value, "traceability") ?? {};
  const registryDir = readPath(
    jsonString(traceability.registryDir, "traceability.registryDir"),
    cwd,
    resolve(homedir(), ".mono-agent", "trace-sources"),
  );
  const sourceId = normalizeOptionalString(jsonString(traceability.sourceId, "traceability.sourceId"));
  // An explicit trace label remains authoritative. Otherwise the public agent
  // name becomes the display label without changing the stable source id.
  const sourceLabel = normalizeOptionalString(jsonString(traceability.sourceLabel, "traceability.sourceLabel")) ?? agentName;
  const heartbeatMs = jsonInteger(traceability.heartbeatMs, "traceability.heartbeatMs", DEFAULT_TRACE_HEARTBEAT_MS, {
    min: 250,
    max: 86_400_000,
  });
  const staleAfterMs = jsonInteger(traceability.staleAfterMs, "traceability.staleAfterMs", DEFAULT_TRACE_STALE_AFTER_MS, {
    min: 1_000,
    max: 604_800_000,
  });
  const globalDiscovery = jsonBoolean(traceability.globalDiscovery, "traceability.globalDiscovery", true);
  return {
    registryDir,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    heartbeatMs,
    staleAfterMs,
    globalDiscovery,
  };
}

/** Read an optional integer field from a parsed object, bounded and integer-checked. */
function readObjectInteger(
  object: Record<string, unknown>,
  key: string,
  source: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${source}.${key} must be an integer between ${bounds.min} and ${bounds.max}.`,
      { path: `${source}.${key}` },
    );
  }
  return value;
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

function readConfiguredProviders(value: unknown): ConfiguredProviderEnvelope {
  const parsed = jsonRecord(value, "providers") ?? {};

  const entries = new Map<string, { readonly provider: ProviderDefinition; readonly path: string }>();
  for (const id of Object.keys(parsed).filter((key) => !RESERVED_PROVIDER_KEYS.has(key)).sort()) {
    addConfiguredProvider(entries, normalizeProviderFromUnknown(id, parsed[id], `providers.${id}`, false), `providers.${id}`);
  }

  // The `local` array is the legacy single-shape form of the same provider map.
  const legacyFromMap = parsed.local;
  if (legacyFromMap !== undefined) {
    if (!Array.isArray(legacyFromMap)) {
      throw new MonoAgentConfigError("invalid_json", "providers.local must be an array.", { path: "providers.local" });
    }
    legacyFromMap.forEach((provider, index) => {
      const path = `providers.local[${index}]`;
      const normalized = normalizeLegacyProviderFromUnknown(provider, path);
      addConfiguredProvider(entries, normalized, path);
    });
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

function normalizeLegacyProviderFromUnknown(
  value: unknown,
  source: string,
): LocalProviderDefinition {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", `${source} must be an object.`, { path: source });
  }
  const id = readObjectString(value, "id", source, true) as string;
  const provider = normalizeProviderFromUnknown(id, value, source, true);
  return provider as LocalProviderDefinition;
}

function normalizeProviderFromUnknown(
  id: string,
  value: unknown,
  source: string,
  requireType: boolean,
): ProviderDefinition {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", `${source} must be an object.`, { path: source });
  }
  const unknownKeys = Object.keys(value).filter((key) =>
    !(requireType && key === "id") && !PROVIDER_ENTRY_KEYS.has(key),
  ).sort();
  if (unknownKeys.length > 0) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `${source} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
      { path: source, unknownKeys },
    );
  }
  const type = readObjectString(value, "type", source, requireType) as ProviderDefinition["type"];
  const baseUrl = readObjectString(value, "baseUrl", source, false);
  const apiKeyEnv = readObjectString(value, "apiKeyEnv", source, false);
  // Credential names stay unresolved at load: the runtime resolves them against
  // the effective environment when the provider is used. Only an inline literal
  // lands in `apiKey` here, so secrets never flow through the loader.
  const apiKey = readObjectString(value, "apiKey", source, false);
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
      throw new MonoAgentConfigError("invalid_json", error.message, {
        path: source,
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
      "invalid_json",
      `Provider id "${provider.id}" is configured twice at ${existing.path} and ${path}. Remove one definition.`,
      { path, providerId: provider.id, paths: [existing.path, path] },
    );
  }
  entries.set(provider.id, { provider, path });
}

function readProviderPiNative(value: unknown): Readonly<Record<string, unknown>> {
  const source = "providers.piNative";
  const record = readPlainObject(value, source);
  if (record.promptCacheDiagnostics !== undefined && typeof record.promptCacheDiagnostics !== "boolean") {
    throw new MonoAgentConfigError("invalid_json", "providers.piNative.promptCacheDiagnostics must be a boolean.", {
      path: "providers.piNative.promptCacheDiagnostics",
    });
  }
  if (record.cacheRetention !== undefined && !["short", "long"].includes(record.cacheRetention as string)) {
    throw new MonoAgentConfigError("invalid_json", "providers.piNative.cacheRetention must be short or long.", {
      path: "providers.piNative.cacheRetention",
    });
  }
  const allowed = new Set(["transport", "cacheRetention", "promptCacheDiagnostics", "piMaxRetries", "maxRetryDelayMs", "piSessionsRoot"]);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key)).sort();
  if (unknownKeys.length > 0) {
    throw new MonoAgentConfigError("invalid_json", `${source} contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`, {
      path: source,
      unknownKeys,
    });
  }
  return record;
}

function readLocalProviderModels(value: unknown, source: string): readonly LocalProviderModelDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", `${source}.models must be an array.`, { path: source });
  }
  return value.map((model, index) => {
    const modelSource = `${source}.models[${index}]`;
    if (!isRecord(model) || Array.isArray(model)) {
      throw new MonoAgentConfigError("invalid_json", `${modelSource} must be an object.`, { path: modelSource });
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

function readEffort(raw: string | undefined): EffortLevel | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return undefined;
  }
  return readChoice<EffortLevel>(normalized, "runtime.effort", EFFORT_LEVELS, EFFORT_LEVELS[0], invalidJson);
}

function readConcurrencyConfig(value: unknown): MonoAgentConfig["concurrency"] | undefined {
  const concurrency = jsonRecord(value, "concurrency");
  if (concurrency === undefined) {
    return undefined;
  }
  const maxConcurrentRuns = jsonOptionalInteger(
    concurrency.maxConcurrentRuns,
    "concurrency.maxConcurrentRuns",
    { min: 1, max: 100_000 },
  );
  const maxPendingRuns = jsonOptionalInteger(
    concurrency.maxPendingRuns,
    "concurrency.maxPendingRuns",
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
  value: Readonly<Record<string, unknown>> | undefined,
  cwd: string,
): PiNativeProviderConfig {
  const piNative = value ?? {};
  const transport = normalizeOptionalString(jsonString(piNative.transport, "providers.piNative.transport")) === undefined
    ? undefined
    : readChoice<PiTransport>(
        jsonString(piNative.transport, "providers.piNative.transport"),
        "providers.piNative.transport",
        PI_TRANSPORTS,
        "auto",
        invalidJson,
      );
  const promptCacheDiagnostics = jsonOptionalBoolean(piNative.promptCacheDiagnostics, "providers.piNative.promptCacheDiagnostics");
  const cacheRetention = jsonChoice<"short" | "long">(
    piNative.cacheRetention, "providers.piNative.cacheRetention", ["short", "long"], "long",
  );
  const piMaxRetries = jsonOptionalInteger(piNative.piMaxRetries, "providers.piNative.piMaxRetries", { min: 0, max: 8 });
  const maxRetryDelayMs = jsonOptionalInteger(piNative.maxRetryDelayMs, "providers.piNative.maxRetryDelayMs", { min: 100, max: 3_600_000 });
  const piSessionsRoot = readOptionalPath(jsonString(piNative.piSessionsRoot, "providers.piNative.piSessionsRoot"), cwd);
  return {
    ...(transport === undefined ? {} : { transport }),
    ...(promptCacheDiagnostics === undefined ? {} : { promptCacheDiagnostics }),
    cacheRetention,
    ...(piMaxRetries === undefined ? {} : { piMaxRetries }),
    ...(maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs }),
    ...(piSessionsRoot === undefined ? {} : { piSessionsRoot }),
  };
}

function readPath(raw: string | undefined, cwd: string, defaultPath?: string): string {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    if (defaultPath !== undefined) {
      return defaultPath;
    }
    throw new MonoAgentConfigError("invalid_json", "Path value is required.");
  }
  return resolve(cwd, normalized);
}

// JSON arrays stay element-wise so roots containing commas retain their
// boundaries. A lone comma-separated string is still split for tolerance.
function readFileToolRoots(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") {
    const normalized = normalizeOptionalString(value);
    if (normalized === undefined) return [];
    if (normalized.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(normalized);
        if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
          return parsed;
        }
      } catch {
        // Report the same deterministic error as a parsed non-string array below.
      }
      throw new MonoAgentConfigError(
        "invalid_json",
        `${path} must be a comma-separated path list or an array of strings.`,
        { path, reason: "invalid_string_array" },
      );
    }
    return readCsv(value);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  throw new MonoAgentConfigError(
    "invalid_json",
    `${path} must be a comma-separated path list or an array of strings.`,
    { path, reason: "invalid_string_array" },
  );
}

function readUserPath(raw: string | undefined, cwd: string, defaultPath?: string): string {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    if (defaultPath !== undefined) {
      return defaultPath;
    }
    throw new MonoAgentConfigError("invalid_json", "Path value is required.");
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
      throw new MonoAgentConfigError("invalid_json", `${source}.${key} is required.`, { path: `${source}.${key}` });
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new MonoAgentConfigError("invalid_json", `${source}.${key} must be a non-empty trimmed string.`, { path: `${source}.${key}` });
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
  throw new MonoAgentConfigError("invalid_json", `${source}.${key} must be a boolean.`, { path: `${source}.${key}` });
}

function readPlainObject(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", `${source} must be an object.`, { path: source });
  }
  return { ...value };
}

function normalizeCwd(value: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    throw new MonoAgentConfigError("invalid_json", "cwd must be a non-empty path.");
  }
  return resolve(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function selectedWebProvider(selection: string | readonly string[], name: string): boolean {
  return typeof selection === "string" ? selection === name : selection.includes(name);
}

/**
 * The previous `auto` order for a search block, derived from the providers the
 * block actually configures. Used only to repair a stale `"auto"` selection.
 */
function searchAutoRepair(search: Record<string, unknown> | undefined): readonly string[] {
  return [
    ...(search?.ollama !== undefined ? ["ollama"] : []),
    ...(normalizeOptionalString(jsonString((search?.searxng as Record<string, unknown> | undefined)?.endpoint, "tools.web.search.searxng.endpoint")) !== undefined
      || normalizeOptionalString(jsonString(search?.endpoint, "tools.web.search.endpoint")) !== undefined
      ? ["searxng"]
      : []),
    "codex", "keyless",
  ];
}

function readWebProviderSelection<T extends string>(
  value: unknown, path: string, names: readonly T[], fallback: T | readonly T[],
  autoRepair?: readonly string[], renamed?: Record<string, string>,
): T | readonly T[] {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) {
    const retired = value.find((name) => typeof name === "string" && renamed && Object.hasOwn(renamed, name));
    if (typeof retired === "string") throw new MonoAgentConfigError("invalid_json", renamed![retired]!, { path });
    if (value.length === 0 || value.some((name) => typeof name !== "string" || !names.includes(name as T))) {
      throw new MonoAgentConfigError("invalid_json", `${path} must be one provider or a non-empty ordered chain of: ${names.join(", ")}.`, { path });
    }
    if (new Set(value).size !== value.length) {
      throw new MonoAgentConfigError("invalid_json", `${path} contains duplicate provider names.`, { path });
    }
    return value as T | readonly T[];
  }
  const raw = jsonString(value, path);
  const trimmed = normalizeOptionalString(raw);
  if (trimmed === undefined) return fallback;
  if (trimmed === "auto" && autoRepair !== undefined) {
    throw new MonoAgentConfigError("invalid_json", `tools.web.search.backend "auto" was removed; use ${JSON.stringify(autoRepair)} (the previous auto order for this configuration)`, { path });
  }
  let selection: unknown;
  try { selection = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.includes(",") ? trimmed.split(",").map((name) => name.trim()) : trimmed; }
  catch { selection = null; }
  const list = Array.isArray(selection) ? selection : [selection];
  if (renamed) {
    const retired = list.find((name) => typeof name === "string" && Object.hasOwn(renamed, name));
    if (typeof retired === "string") throw new MonoAgentConfigError("invalid_json", renamed[retired]!, { path });
  }
  if (!list.length || list.some((name) => typeof name !== "string" || !names.includes(name as T))) {
    throw new MonoAgentConfigError("invalid_json", `${path} must be one provider or a non-empty ordered chain of: ${names.join(", ")}.`, { path });
  }
  if (new Set(list).size !== list.length) {
    throw new MonoAgentConfigError("invalid_json", `${path} contains duplicate provider names.`, { path });
  }
  return selection as T | readonly T[];
}

function readParallelWebConfig(value: unknown, path: string): { readonly apiKeyEnv: string } | undefined {
  const raw = jsonContainer(value)?.apiKeyEnv;
  if (raw === undefined) return undefined;
  const name = normalizeOptionalString(jsonString(raw, path)) ?? "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new MonoAgentConfigError("invalid_json", `${path} must name an environment variable.`, { path });
  }
  // The named credential stays unresolved at load: the Parallel runtime reads
  // it from the effective environment at call time, so anonymous access is an
  // omitted field rather than a load error.
  return { apiKeyEnv: name };
}
