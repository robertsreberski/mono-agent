import { assertNoRetiredMonoAgentConfigJson, readMonoAgentConfigJson } from "./json-source.js";
import type {
  MonoAgentConfigJson,
  MonoAgentMemoryConsolidationJson,
  MonoAgentMemoryEmbeddingsJson,
  MonoAgentMemoryLlmJson,
  MonoAgentProvidersJson,
} from "./json-source.js";
import { loadMonoAgentConfig, MEMORY_LLM_ENV_KEYS, MonoAgentConfigError } from "./config.js";
import type { MonoAgentConfig } from "./types.js";

export interface LoadMonoAgentConfigWithSourcesInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /**
   * Optional path to a JSON config file. Missing or empty file is OK.
   * When set, values from JSON fill in fields that are not present in env;
   * env always wins for fields present in both layers.
   */
  readonly jsonPath?: string;
}

/**
 * Layered loader: JSON file provides defaults, env vars override.
 *
 * Precedence (highest first):
 *   1. process env
 *   2. mono-agent.config.json
 *   3. built-in defaults from loadMonoAgentConfig (sessions, retry policy, etc.)
 *
 * Returns the same `MonoAgentConfig` shape as `loadMonoAgentConfig` so
 * existing call sites only need to swap the loader.
 */
export async function loadMonoAgentConfigWithSources(
  input: LoadMonoAgentConfigWithSourcesInput,
): Promise<MonoAgentConfig> {
  const jsonLayer = input.jsonPath === undefined
    ? {}
    : (await readMonoAgentConfigJson(input.jsonPath)).json;
  // Validate raw JSON before flattening it into the string-only env surface.
  // String(...) coercion is intentional for valid numeric/boolean settings,
  // but must never make arrays or other malformed nested values look valid.
  validateJsonMemoryBlocks(jsonLayer, input.env);
  const layeredEnv = layerJsonOntoEnv(jsonLayer, input.env);
  try {
    return loadMonoAgentConfig({ env: layeredEnv, cwd: input.cwd });
  } catch (error) {
    // Two disjoint source sets, so the order is immaterial; both translate a diagnostic
    // about the flattened env surface back to the file the operator actually edits.
    throw remapJsonRuntimeError(remapJsonMemoryError(error, jsonLayer, input.env), jsonLayer, input.env);
  }
}

/**
 * Every JSON setting is validated through the flattened env surface, so a rejected
 * `runtime.model` reported `MONO_AGENT_MODEL` -- a variable the operator never set and cannot
 * find. `memory.*` already translated back; the runtime, fallback and subagent sources did
 * not, which made the repair unactionable for exactly the fields a 0.21.0 migration touches.
 *
 * The reader per source is what makes this sound: `layerJsonOntoEnv` lets env win, so a
 * diagnostic is only JSON's to claim when the variable is unset *and* the JSON layer supplied
 * the value.
 */
const JSON_RUNTIME_SOURCES: readonly {
  readonly env: string;
  readonly path: string;
  readonly read: (json: MonoAgentConfigJson) => unknown;
}[] = [
  { env: "MONO_AGENT_MODEL", path: "runtime.model", read: (json) => json.runtime?.model },
  { env: "MONO_AGENT_FALLBACKS_JSON", path: "runtime.fallbacks", read: (json) => json.runtime?.fallbacks },
  { env: "MONO_AGENT_SUBAGENTS_JSON", path: "subagents", read: (json) => json.subagents },
];

/** Preserve the operator's real source surface when a layered runtime setting fails. */
function remapJsonRuntimeError(
  error: unknown,
  json: MonoAgentConfigJson,
  env: Record<string, string | undefined>,
): unknown {
  if (!(error instanceof MonoAgentConfigError)) return error;
  const source = error.details.env;
  if (typeof source !== "string") return error;
  const mapping = JSON_RUNTIME_SOURCES.find((candidate) => candidate.env === source);
  if (mapping === undefined) return error;
  if (hasValue(env[source]) || mapping.read(json) === undefined) return error;
  return remapConfigErrorToJson(error, source, mapping.path);
}

/** Preserve the operator's real source surface when layered memory validation fails. */
function remapJsonMemoryError(
  error: unknown,
  json: MonoAgentConfigJson,
  env: Record<string, string | undefined>,
): unknown {
  if (!(error instanceof MonoAgentConfigError) || json.memory === undefined) return error;

  const source = error.details.env;
  const scalarPath = jsonMemoryPathForSource(source, json.memory, env);
  if (scalarPath !== undefined && source !== undefined) {
    return remapConfigErrorToJson(error, source, scalarPath);
  }
  if (error.code !== "invalid_env") return error;
  if (
    source === "MONO_AGENT_MEMORY_BACKEND"
    && !hasValue(env.MONO_AGENT_MEMORY_BACKEND)
    && json.memory.backend !== undefined
  ) {
    return remapConfigErrorToJson(error, source, "memory.backend");
  }
  if (hasValue(env.MONO_AGENT_MEMORY_MODE)) return error;

  if (error.details.env === "MONO_AGENT_MEMORY_MODE") {
    const mode = normalizeJsonEnum(json.memory.mode) ?? "lite";
    const jsonPath = incompatibleJsonMemoryPath(mode, json.memory);
    if (jsonPath !== undefined) {
      const message = `memory.mode "${mode}" cannot configure ${jsonPath}.`;
      return new MonoAgentConfigError("invalid_json", message, { path: jsonPath, reason: message });
    }
    const implicatedEnv = envCapabilityActivator(mode, env);
    if (implicatedEnv !== undefined) {
      const message = `${implicatedEnv} is incompatible with memory.mode "${mode}" from mono-agent.config.json.`;
      return new MonoAgentConfigError("invalid_env", message, { env: implicatedEnv, reason: message });
    }
  }

  let path: string | undefined;
  if (source === "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL") path = "memory.embeddings";
  else if (source === "MONO_AGENT_MEMORY_LLM_MODEL") path = "memory.llm";
  else if (source === "MONO_AGENT_MEMORY_MODE") path = "memory.mode";
  if (path === undefined) return error;

  const mode = normalizeJsonEnum(json.memory.mode) ?? "lite";
  const message = source === "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL"
    ? `memory.mode "${mode}" requires an explicit memory.embeddings block.`
    : source === "MONO_AGENT_MEMORY_LLM_MODEL"
      ? `memory.mode "${mode}" requires an explicit memory.llm block.`
      : attributeMessageToJsonPath(error, "MONO_AGENT_MEMORY_MODE", "memory.mode");
  return new MonoAgentConfigError("invalid_json", message, { path, reason: message });
}

type MemoryJson = NonNullable<MonoAgentConfigJson["memory"]>;
type MemoryJsonBackend = "bujo" | "supermemory";

const MEMORY_JSON_SOURCES = {
  MONO_AGENT_MEMORY_BACKEND: jsonMemorySource("memory.backend", (memory) => memory.backend),
  MONO_AGENT_MEMORY_PATH: jsonMemorySource("memory.path", (memory) => memory.path),
  MONO_AGENT_MEMORY_MAX_BYTES: jsonMemorySource("memory.maxBytes", (memory) => memory.maxBytes),
  MONO_AGENT_MEMORY_WRITE_MODE: jsonMemorySource("memory.writeMode", (memory) => memory.writeMode),
  MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED: jsonMemorySource(
    "memory.recallTool.enabled",
    (memory) => memory.recallTool?.enabled,
  ),
  MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED: jsonMemorySource(
    "memory.rememberTool.enabled",
    (memory) => memory.rememberTool?.enabled,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: jsonMemorySource(
    "memory.supermemory.baseUrl",
    (memory) => memory.supermemory?.baseUrl,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY: jsonMemorySource(
    "memory.supermemory.apiKey",
    (memory) => memory.supermemory?.apiKey,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV: jsonMemorySource(
    "memory.supermemory.apiKeyEnv",
    (memory) => memory.supermemory?.apiKeyEnv,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER: jsonMemorySource(
    "memory.supermemory.container",
    (memory) => memory.supermemory?.container,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS: jsonMemorySource(
    "memory.supermemory.timeoutMs",
    (memory) => memory.supermemory?.timeoutMs,
  ),
  MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER: jsonMemorySource(
    "memory.supermemory.exposeMcpServer",
    (memory) => memory.supermemory?.exposeMcpServer,
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: jsonMemorySource(
    "memory.embeddings.provider",
    (memory) => memory.embeddings?.provider,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: jsonMemorySource(
    "memory.embeddings.model",
    (memory) => memory.embeddings?.model,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT: jsonMemorySource(
    "memory.embeddings.endpoint",
    (memory) => memory.embeddings?.endpoint,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: jsonMemorySource(
    "memory.embeddings.apiKey",
    (memory) => memory.embeddings?.apiKey,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: jsonMemorySource(
    "memory.embeddings.apiKeyEnv",
    (memory) => memory.embeddings?.apiKeyEnv,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_DIM: jsonMemorySource(
    "memory.embeddings.dim",
    (memory) => memory.embeddings?.dim,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS: jsonMemorySource(
    "memory.embeddings.timeoutMs",
    (memory) => memory.embeddings?.timeoutMs,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: jsonMemorySource(
    "memory.embeddings.circuitBreaker.failureThreshold",
    (memory) => memory.embeddings?.circuitBreaker?.failureThreshold,
    "bujo",
  ),
  MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS: jsonMemorySource(
    "memory.embeddings.circuitBreaker.cooldownMs",
    (memory) => memory.embeddings?.circuitBreaker?.cooldownMs,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_PROVIDER: jsonMemorySource(
    "memory.llm.provider",
    (memory) => memory.llm?.provider,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_MODEL: jsonMemorySource(
    "memory.llm.model",
    (memory) => memory.llm?.model,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_ENDPOINT: jsonMemorySource(
    "memory.llm.endpoint",
    (memory) => memory.llm?.endpoint,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_TRACE: jsonMemorySource(
    "memory.llm.trace",
    (memory) => memory.llm?.trace,
    "bujo",
  ),
  MONO_AGENT_MEMORY_LLM_TIMEOUT_MS: jsonMemorySource(
    "memory.llm.timeoutMs",
    (memory) => memory.llm?.timeoutMs,
    "bujo",
  ),
  MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: jsonMemorySource(
    "memory.consolidation.enabled",
    (memory) => memory.consolidation?.enabled,
    "bujo",
  ),
  MONO_AGENT_MEMORY_CONSOLIDATION_CRON: jsonMemorySource(
    "memory.consolidation.cron",
    (memory) => memory.consolidation?.cron,
    "bujo",
  ),
} as const;

function jsonMemorySource(
  path: string,
  read: (memory: MemoryJson) => unknown,
  backend?: MemoryJsonBackend,
): { readonly path: string; readonly read: (memory: MemoryJson) => unknown; readonly backend?: MemoryJsonBackend } {
  return { path, read, ...(backend === undefined ? {} : { backend }) };
}

function jsonMemoryPathForSource(
  source: unknown,
  memory: MemoryJson,
  env: Record<string, string | undefined>,
): string | undefined {
  if (source === "MONO_AGENT_MEMORY_MODE") return undefined;
  if (
    source === "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL"
    && !hasValue(env.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL)
  ) {
    return jsonSupermemoryRequiresBaseUrl(memory, env)
      ? "memory.supermemory.baseUrl"
      : undefined;
  }
  if (
    source === "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY"
    && !hasValue(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY)
  ) {
    return jsonEmbeddingsCredentialPath(memory, env);
  }
  if (typeof source !== "string" || !Object.hasOwn(MEMORY_JSON_SOURCES, source)) return undefined;
  const envName = source as keyof typeof MEMORY_JSON_SOURCES;
  const mapping = MEMORY_JSON_SOURCES[envName];
  const effectiveBackend = env.MONO_AGENT_MEMORY_BACKEND?.trim()
    || normalizeJsonEnum(memory.backend)
    || "bujo";
  if (
    hasValue(env[envName])
    || (mapping.backend !== undefined && mapping.backend !== effectiveBackend)
    || mapping.read(memory) === undefined
  ) return undefined;
  return mapping.path;
}

function jsonSupermemoryRequiresBaseUrl(
  memory: MemoryJson,
  env: Record<string, string | undefined>,
): boolean {
  if (
    !hasValue(env.MONO_AGENT_MEMORY_BACKEND)
    && normalizeJsonEnum(memory.backend) === "supermemory"
  ) return true;
  const supermemory = memory.supermemory;
  if (supermemory === undefined) return false;
  const activatingStringLeaves = [
    ["apiKey", "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY"],
    ["apiKeyEnv", "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV"],
    ["container", "MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER"],
  ] as const;
  if (activatingStringLeaves.some(([field, envName]) => (
    hasJsonString(supermemory[field]) && !hasValue(env[envName])
  ))) return true;
  const activatingScalarLeaves = [
    ["timeoutMs", "MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS"],
    ["exposeMcpServer", "MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER"],
  ] as const;
  return activatingScalarLeaves.some(([field, envName]) => (
    supermemory[field] !== undefined && !hasValue(env[envName])
  ));
}

function jsonEmbeddingsCredentialPath(
  memory: MemoryJson,
  env: Record<string, string | undefined>,
): "memory.embeddings.apiKey" | "memory.embeddings.apiKeyEnv" | undefined {
  const embeddings = memory.embeddings;
  if (embeddings === undefined) return undefined;
  if (
    hasJsonString(embeddings.apiKeyEnv)
    && !hasValue(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV)
  ) return "memory.embeddings.apiKeyEnv";
  if (
    normalizeJsonEnum(embeddings.provider) === "openai"
    && !hasValue(env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER)
    && !hasValue(env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV)
    && !hasJsonString(embeddings.apiKey)
    && !hasJsonString(embeddings.apiKeyEnv)
  ) return "memory.embeddings.apiKey";
  return undefined;
}

/**
 * Re-attribute a diagnostic from the env variable it was raised against to the JSON path the
 * operator actually edits -- without rewriting anything the operator wrote.
 *
 * Two spans of a config diagnostic are operator text rather than config prose:
 *   - the value it quotes back, which config always renders inside BACKTICKS; and
 *   - the parser-derived `reason` it ends with, which is built FROM that value and carries
 *     the concrete repair the operator is meant to copy.
 * Everything outside those two spans is config's own fixed sentence, and that is the only
 * part re-attribution may touch.
 *
 * `error.message.replaceAll(source, path)` touched all three. A model reference is an
 * arbitrary operator string, so `"runtime": { "model": "codex:MONO_AGENT_MODEL" }` was quoted
 * back as `codex:runtime.model` and repaired to `openai-codex:runtime.model` -- a model that
 * does not exist. The same held for a fallback, a subagent and the agent-host memory LLM.
 *
 * The other operator-supplied fragments a config message interpolates cannot collide: a
 * subagent name is `^[a-z0-9][a-z0-9-]*$` and a memory mode is an enum, so neither can spell
 * an upper-case variable name.
 *
 * NOTE what this is and is not. Attribution here is still SURGERY ON A RENDERED STRING, and
 * every version of it rests on some claim about where operator text sits in that string. The
 * real fix is for the diagnostic to carry its source as a SLOT the loader re-renders, so
 * nothing is ever searched for or replaced; that means changing where the messages are built
 * (`packages/config/src/config.ts`), not where they are re-attributed, and it is filed as a
 * handoff rather than done here. What this layer owes in the meantime is that its failure mode
 * is a LOST attribution, never a CORRUPTED value -- see `replaceSourceBeforeOperatorText`.
 */
function attributeMessageToJsonPath(
  error: MonoAgentConfigError,
  source: string,
  path: string,
): string {
  const message = error.message;
  const reason = error.details.reason;
  // A `reason` equal to the whole message is a self-reference (the message IS the reason), not
  // a nested parser reason, so there is no operator-derived tail to protect.
  const frameLength = typeof reason === "string" && reason.length < message.length && message.endsWith(reason)
    ? message.length - reason.length
    : message.length;
  const attributed = replaceSourceBeforeOperatorText(message.slice(0, frameLength), source, path)
    + message.slice(frameLength);
  return attributed.includes(path) ? attributed : `${path}: ${attributed}`;
}

/**
 * Rewrite the source only in the span that runs from the start of the message to its FIRST
 * backtick. Config opens a backtick when, and only when, it begins quoting an operator value,
 * so that span is config's own prose by construction and everything from the backtick on is
 * either the value, the fixed connector after it, or a reason built from it.
 *
 * This replaces a parity rule -- "the odd segments of a backtick split are the operator's" --
 * that was true only while the operator's value contained no backtick of its own. It can, and
 * `codex:a\`MONO_AGENT_MODEL` came back as `codex:a\`runtime.model`: every segment after the
 * value's own backtick shifted parity, so the value's second half was rewritten as if it were
 * config's sentence. Counting backticks does not rescue the parity rule either -- a value with
 * two of them restores an even count and corrupts just the same -- which is why the rule is
 * replaced rather than guarded.
 *
 * The cost is deliberate and one-directional. Every message config renders with a quoted value
 * that also names a source names it BEFORE the quote opens -- `parseModel`, the subagent and
 * fallback entries, the agent-host memory LLM, all four pinned by the attribution cases below
 * -- so nothing in use loses its attribution. A future
 * message that named its source only AFTER its quoted value would keep the variable name in
 * the sentence and be prefixed with the JSON path by the caller above -- an attribution that
 * reads clumsily, rather than a value the operator is told to paste and cannot use.
 */
function replaceSourceBeforeOperatorText(frame: string, source: string, path: string): string {
  const quote = frame.indexOf("`");
  if (quote === -1) {
    return frame.replaceAll(source, path);
  }
  return frame.slice(0, quote).replaceAll(source, path) + frame.slice(quote);
}

function remapConfigErrorToJson(
  error: MonoAgentConfigError,
  source: string,
  path: string,
): MonoAgentConfigError {
  const message = attributeMessageToJsonPath(error, source, path);
  const { code: _code, env: _env, ...details } = error.details;
  return new MonoAgentConfigError("invalid_json", message, {
    ...details,
    path,
    reason: error.details.reason ?? message,
  });
}

function validateJsonMemoryBlocks(
  json: MonoAgentConfigJson,
  env: Record<string, string | undefined>,
): void {
  const memory: unknown = json.memory;
  if (memory !== undefined && !isJsonObject(memory)) {
    throwInvalidJsonValue("memory", "an object");
  }

  // Strict BuJo tier blocks do not belong to external memory backends. Resolve
  // backend precedence first (env wins directly here), then ignore stale
  // local blocks exactly as the runtime and published schema do. Unknown
  // backends are left to loadMonoAgentConfig so the authoritative invalid_env
  // diagnostic is not masked by a lower-precedence JSON detail.
  const effectiveBackendValue: unknown = hasValue(env.MONO_AGENT_MEMORY_BACKEND)
    ? env.MONO_AGENT_MEMORY_BACKEND
    : memory?.backend;
  if (effectiveBackendValue !== undefined && typeof effectiveBackendValue !== "string") {
    throwInvalidJsonValue("memory.backend", "a string");
  }
  const effectiveBackend = effectiveBackendValue?.trim() || "bujo";
  if (effectiveBackend !== "bujo" && effectiveBackend !== "supermemory") return;
  if (memory === undefined) return;

  validateJsonScalarFields(memory, "memory", env, [
    ["backend", "MONO_AGENT_MEMORY_BACKEND", "string"],
    ["mode", "MONO_AGENT_MEMORY_MODE", "string"],
    ["path", "MONO_AGENT_MEMORY_PATH", "string"],
    ["maxBytes", "MONO_AGENT_MEMORY_MAX_BYTES", "number"],
    ["writeMode", "MONO_AGENT_MEMORY_WRITE_MODE", "string"],
  ]);

  const recallTool = validateOptionalJsonObject(memory.recallTool, "memory.recallTool");
  if (recallTool !== undefined) {
    validateJsonScalarFields(recallTool, "memory.recallTool", env, [
      ["enabled", "MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED", "boolean"],
    ]);
  }

  const rememberTool = validateOptionalJsonObject(memory.rememberTool, "memory.rememberTool");
  if (rememberTool !== undefined) {
    validateJsonScalarFields(rememberTool, "memory.rememberTool", env, [
      ["enabled", "MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED", "boolean"],
    ]);
  }

  const supermemory = validateOptionalJsonObject(memory.supermemory, "memory.supermemory");
  if (supermemory !== undefined) {
    validateJsonScalarFields(supermemory, "memory.supermemory", env, [
      ["baseUrl", "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL", "string"],
      ["apiKey", "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY", "string"],
      ["apiKeyEnv", "MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV", "string"],
      ["container", "MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER", "string"],
      ["timeoutMs", "MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS", "number"],
      ["exposeMcpServer", "MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER", "boolean"],
    ]);
  }
  if (effectiveBackend === "supermemory") return;

  const embeddings = validateOptionalJsonObject(memory.embeddings, "memory.embeddings");
  if (embeddings !== undefined) {
    validateJsonScalarFields(embeddings, "memory.embeddings", env, [
      ["provider", "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER", "string"],
      ["model", "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL", "string"],
      ["endpoint", "MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT", "string"],
      ["apiKey", "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY", "string"],
      ["apiKeyEnv", "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV", "string"],
      ["dim", "MONO_AGENT_MEMORY_EMBEDDINGS_DIM", "number"],
      ["timeoutMs", "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS", "number"],
    ]);
    const circuitBreaker = validateOptionalJsonObject(
      embeddings.circuitBreaker,
      "memory.embeddings.circuitBreaker",
    );
    if (circuitBreaker !== undefined) {
      validateJsonScalarFields(circuitBreaker, "memory.embeddings.circuitBreaker", env, [
        [
          "failureThreshold",
          "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
          "number",
        ],
        ["cooldownMs", "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS", "number"],
      ]);
    }
  }
  if (embeddings !== undefined && Object.keys(embeddings).length === 0) {
    const path = "memory.embeddings";
    const message = `${path} must contain at least one setting; provider, model, and dim default after the block is activated.`;
    throw new MonoAgentConfigError("invalid_json", message, { path, reason: message });
  }

  const llm = validateOptionalJsonObject(memory.llm, "memory.llm");
  if (llm !== undefined) validateJsonMemoryLlmFields(llm, env);
  if (llm !== undefined && Object.keys(llm).length === 0) {
    const path = "memory.llm";
    const effectiveModeValue: unknown = hasValue(env.MONO_AGENT_MEMORY_MODE)
      ? env.MONO_AGENT_MEMORY_MODE
      : memory.mode;
    if (effectiveModeValue !== undefined && typeof effectiveModeValue !== "string") {
      throwInvalidJsonValue("memory.mode", "a string");
    }
    const mode = effectiveModeValue?.trim() || "lite";
    const message = mode === "bujo"
      ? `${path} must contain a model for memory.mode "bujo".`
      : `memory.mode "${mode}" cannot configure ${path}.`;
    throw new MonoAgentConfigError("invalid_json", message, { path, reason: message });
  }

  const consolidation = validateOptionalJsonObject(memory.consolidation, "memory.consolidation");
  if (consolidation !== undefined) {
    validateJsonScalarFields(consolidation, "memory.consolidation", env, [
      ["enabled", "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED", "boolean"],
      ["cron", "MONO_AGENT_MEMORY_CONSOLIDATION_CRON", "string"],
    ]);
  }
}

type JsonScalarKind = "string" | "number" | "boolean";
type JsonScalarFieldSpec = readonly [field: string, envName: string, kind: JsonScalarKind];

function validateJsonScalarFields(
  value: Record<string, unknown>,
  path: string,
  env: Record<string, string | undefined>,
  specs: readonly JsonScalarFieldSpec[],
): void {
  for (const [field, envName, kind] of specs) {
    if (hasValue(env[envName]) || value[field] === undefined) continue;
    if (typeof value[field] !== kind) {
      throwInvalidJsonValue(`${path}.${field}`, `a ${kind}`);
    }
  }
}

function validateOptionalJsonObject(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throwInvalidJsonValue(path, "an object");
  return value;
}

function validateJsonMemoryLlmFields(
  llm: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  const stringFields = [
    ["provider", "MONO_AGENT_MEMORY_LLM_PROVIDER"],
    ["model", "MONO_AGENT_MEMORY_LLM_MODEL"],
    ["endpoint", "MONO_AGENT_MEMORY_LLM_ENDPOINT"],
  ] as const;
  for (const [field, envName] of stringFields) {
    if (field === "endpoint" && shouldDropJsonMemoryLlmEndpoint(llm, env)) continue;
    if (hasValue(env[envName]) || llm[field] === undefined) continue;
    if (typeof llm[field] !== "string") throwInvalidJsonValue(`memory.llm.${field}`, "a string");
  }

  if (
    !hasValue(env.MONO_AGENT_MEMORY_LLM_TRACE)
    && llm.trace !== undefined
    && typeof llm.trace !== "boolean"
  ) {
    throwInvalidJsonValue("memory.llm.trace", "a boolean");
  }
  if (
    !hasValue(env.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS)
    && llm.timeoutMs !== undefined
    && typeof llm.timeoutMs !== "number"
  ) {
    throwInvalidJsonValue("memory.llm.timeoutMs", "a number");
  }
}

/** Match the established provider-switch cleanup before validating the stale JSON endpoint leaf. */
function shouldDropJsonMemoryLlmEndpoint(
  llm: { readonly provider?: unknown } | undefined,
  env: Record<string, string | undefined>,
): boolean {
  return env.MONO_AGENT_MEMORY_LLM_PROVIDER?.trim() === "agent-host"
    && normalizeJsonEnum(llm?.provider) !== "agent-host"
    && !hasValue(env.MONO_AGENT_MEMORY_LLM_ENDPOINT);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwInvalidJsonValue(path: string, expected: string): never {
  const message = `${path} must be ${expected}.`;
  throw new MonoAgentConfigError("invalid_json", message, { path, reason: message });
}

const MEMORY_EMBEDDINGS_ENV_KEYS = [
  "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER",
  "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL",
  "MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT",
  "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
  "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV",
  "MONO_AGENT_MEMORY_EMBEDDINGS_DIM",
  "MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS",
  "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
  "MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS",
] as const;
const MEMORY_CONSOLIDATION_ENV_KEYS = [
  "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED",
  "MONO_AGENT_MEMORY_CONSOLIDATION_CRON",
] as const;
function incompatibleJsonMemoryPath(
  mode: string,
  memory: NonNullable<MonoAgentConfigJson["memory"]>,
): string | undefined {
  const normalizedMode = normalizeJsonEnum(mode) ?? "lite";
  if (normalizedMode === "lite" && jsonEmbeddingsActive(memory.embeddings)) return "memory.embeddings";
  if (
    (normalizedMode === "lite" || normalizedMode === "journal")
    && jsonLlmActive(memory.llm)
  ) return "memory.llm";
  if (
    (normalizedMode === "lite" || normalizedMode === "journal")
    && jsonConsolidationActive(memory.consolidation)
  ) {
    return "memory.consolidation";
  }
  return undefined;
}

function envCapabilityActivator(
  mode: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const normalizedMode = normalizeJsonEnum(mode) ?? "lite";
  if (normalizedMode === "lite") {
    const embeddings = firstConfiguredEnv(env, MEMORY_EMBEDDINGS_ENV_KEYS);
    if (embeddings !== undefined) return embeddings;
  }
  if (normalizedMode === "lite" || normalizedMode === "journal") {
    const llm = firstConfiguredEnv(env, MEMORY_LLM_ENV_KEYS);
    if (llm !== undefined) return llm;
  }
  if (normalizedMode === "lite" || normalizedMode === "journal") {
    return firstConfiguredEnv(env, MEMORY_CONSOLIDATION_ENV_KEYS);
  }
  return undefined;
}

function jsonEmbeddingsActive(value: MonoAgentMemoryEmbeddingsJson | undefined): boolean {
  return value !== undefined && (
    hasJsonString(value.provider)
    || hasJsonString(value.model)
    || hasJsonString(value.endpoint)
    || hasJsonString(value.apiKey)
    || hasJsonString(value.apiKeyEnv)
    || value.dim !== undefined
    || value.timeoutMs !== undefined
    || value.circuitBreaker?.failureThreshold !== undefined
    || value.circuitBreaker?.cooldownMs !== undefined
  );
}

function jsonConsolidationActive(value: MonoAgentMemoryConsolidationJson | undefined): boolean {
  return value !== undefined && (value.enabled !== undefined || hasJsonString(value.cron));
}

function jsonLlmActive(value: MonoAgentMemoryLlmJson | undefined): boolean {
  return value !== undefined && (
    hasJsonString(value.provider)
    || hasJsonString(value.model)
    || hasJsonString(value.endpoint)
    || value.trace !== undefined
    || value.timeoutMs !== undefined
  );
}

function hasJsonString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Mirror normalizeOptionalString before comparing enum-like JSON values. */
function normalizeJsonEnum(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function firstConfiguredEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  return names.find((name) => hasValue(env[name]));
}

/**
 * Convert a JSON config object into a flat env-like record so we can hand it
 * to the existing env-based loader. Env values present in `env` take
 * precedence over JSON-derived values.
 */
export function layerJsonOntoEnv(
  json: MonoAgentConfigJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  assertNoRetiredMonoAgentConfigJson(json);
  validateJsonRuntimeCompaction(json);
  const fromJson: Record<string, string | undefined> = {};
  if (json.agent?.name !== undefined) {
    fromJson.MONO_AGENT_NAME = json.agent.name;
  }
  if (json.runtime?.model !== undefined) {
    fromJson.MONO_AGENT_MODEL = json.runtime.model;
  }
  if (!hasValue(env.MONO_AGENT_FALLBACKS_JSON) && json.runtime?.fallbacks !== undefined) {
    fromJson.MONO_AGENT_FALLBACKS_JSON = JSON.stringify(json.runtime.fallbacks);
  }
  if (json.runtime?.retry?.primaryAttempts !== undefined) {
    fromJson.MONO_AGENT_RETRY_PRIMARY_ATTEMPTS = String(json.runtime.retry.primaryAttempts);
  }
  if (json.runtime?.retry?.backoffMs !== undefined) {
    fromJson.MONO_AGENT_RETRY_BACKOFF_MS = String(json.runtime.retry.backoffMs);
  }
  if (json.runtime?.retry?.maxBackoffMs !== undefined) {
    fromJson.MONO_AGENT_RETRY_MAX_BACKOFF_MS = String(json.runtime.retry.maxBackoffMs);
  }
  if (json.subagents !== undefined && !hasValue(env.MONO_AGENT_SUBAGENTS_JSON)) {
    fromJson.MONO_AGENT_SUBAGENTS_JSON = JSON.stringify(json.subagents);
  }
  if (json.runtime?.effort !== undefined) {
    fromJson.MONO_AGENT_EFFORT = json.runtime.effort;
  }
  if (json.runtime?.permissionMode !== undefined) {
    fromJson.MONO_AGENT_PERMISSION_MODE = json.runtime.permissionMode;
  }
  if (json.runtime?.maxTurns !== undefined) {
    fromJson.MONO_AGENT_MAX_TURNS = String(json.runtime.maxTurns);
  }
  if (json.runtime?.compaction?.enabled !== undefined) {
    if (typeof json.runtime.compaction.enabled !== "boolean") {
      throw new MonoAgentConfigError("invalid_json", "runtime.compaction.enabled must be a boolean.", {
        path: "runtime.compaction.enabled",
      });
    }
    fromJson.MONO_AGENT_COMPACTION_ENABLED = String(json.runtime.compaction.enabled);
  }
  if (json.runtime?.compaction?.triggerRatio !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_TRIGGER_RATIO = String(json.runtime.compaction.triggerRatio);
  }
  if (json.runtime?.compaction?.keepRecentTokens !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS = String(json.runtime.compaction.keepRecentTokens);
  }
  if (json.runtime?.compaction?.summaryMaxTokens !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS = String(json.runtime.compaction.summaryMaxTokens);
  }
  if (json.runtime?.compaction?.minSavingsTokens !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS = String(json.runtime.compaction.minSavingsTokens);
  }
  if (json.runtime?.compaction?.fixedOverheadEnabled !== undefined) {
    if (typeof json.runtime.compaction.fixedOverheadEnabled !== "boolean") {
      throw new MonoAgentConfigError("invalid_json", "runtime.compaction.fixedOverheadEnabled must be a boolean.", {
        path: "runtime.compaction.fixedOverheadEnabled",
      });
    }
    fromJson.MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED = String(json.runtime.compaction.fixedOverheadEnabled);
  }
  if (json.runtime?.compaction?.contextWindowOverride !== undefined) {
    fromJson.MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE = String(json.runtime.compaction.contextWindowOverride);
  }
  if (json.runtime?.workspace !== undefined) {
    fromJson.MONO_AGENT_WORKSPACE = json.runtime.workspace;
  }
  if (json.runtime?.session?.mode !== undefined) {
    fromJson.MONO_AGENT_SESSION_MODE = json.runtime.session.mode;
  }
  if (json.runtime?.session?.idleTimeoutMs !== undefined) {
    fromJson.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS = String(json.runtime.session.idleTimeoutMs);
  }
  if (json.runtime?.session?.rollover !== undefined) {
    fromJson.MONO_AGENT_SESSION_ROLLOVER = json.runtime.session.rollover;
  }
  if (json.runtime?.session?.rolloverTimezone !== undefined) {
    fromJson.MONO_AGENT_SESSION_ROLLOVER_TIMEZONE = json.runtime.session.rolloverTimezone;
  }
  if (json.runtime?.session?.rolloverNotice !== undefined) {
    if (typeof json.runtime.session.rolloverNotice !== "boolean") {
      throw new MonoAgentConfigError("invalid_env", "runtime.session.rolloverNotice must be a boolean.", {
        path: "runtime.session.rolloverNotice",
      });
    }
    fromJson.MONO_AGENT_SESSION_ROLLOVER_NOTICE = String(json.runtime.session.rolloverNotice);
  }
  if (json.runtime?.session?.isolateProactive !== undefined) {
    fromJson.MONO_AGENT_SESSION_ISOLATE_PROACTIVE = String(json.runtime.session.isolateProactive);
  }
  if (json.concurrency?.maxConcurrentRuns !== undefined) {
    fromJson.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS = String(json.concurrency.maxConcurrentRuns);
  }
  if (json.concurrency?.maxPendingRuns !== undefined) {
    fromJson.MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS = String(json.concurrency.maxPendingRuns);
  }
  if (json.context?.identityPath !== undefined) {
    fromJson.MONO_AGENT_IDENTITY_PATH = json.context.identityPath;
  }
  if (json.context?.soulPath !== undefined) {
    fromJson.MONO_AGENT_SOUL_PATH = json.context.soulPath;
  }
  if (json.context?.skillsRoot !== undefined) {
    fromJson.MONO_AGENT_SKILLS_ROOT = json.context.skillsRoot;
  }
  if (json.context?.selectedSkills !== undefined) {
    fromJson.MONO_AGENT_SELECTED_SKILLS = csv(json.context.selectedSkills);
  }
  if (json.context?.skillMaxBytes !== undefined) {
    fromJson.MONO_AGENT_SKILL_MAX_BYTES = String(json.context.skillMaxBytes);
  }
  if (json.context?.skillDisclosure !== undefined) {
    fromJson.MONO_AGENT_SKILL_DISCLOSURE = json.context.skillDisclosure;
  }
  if (json.memory?.backend !== undefined) {
    fromJson.MONO_AGENT_MEMORY_BACKEND = json.memory.backend;
  }
  if (json.memory?.mode !== undefined) {
    fromJson.MONO_AGENT_MEMORY_MODE = json.memory.mode;
  }
  if (json.memory?.path !== undefined) {
    fromJson.MONO_AGENT_MEMORY_PATH = json.memory.path;
  }
  if (json.memory?.maxBytes !== undefined) {
    fromJson.MONO_AGENT_MEMORY_MAX_BYTES = String(json.memory.maxBytes);
  }
  if (json.memory?.writeMode !== undefined) {
    fromJson.MONO_AGENT_MEMORY_WRITE_MODE = json.memory.writeMode;
  }
  if (json.memory?.supermemory?.baseUrl !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL = json.memory.supermemory.baseUrl;
  }
  if (json.memory?.supermemory?.apiKey !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY = json.memory.supermemory.apiKey;
  }
  if (json.memory?.supermemory?.apiKeyEnv !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV = json.memory.supermemory.apiKeyEnv;
  }
  if (json.memory?.supermemory?.container !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER = json.memory.supermemory.container;
  }
  if (json.memory?.supermemory?.timeoutMs !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS = String(json.memory.supermemory.timeoutMs);
  }
  if (json.memory?.supermemory?.exposeMcpServer !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER = String(json.memory.supermemory.exposeMcpServer);
  }
  if (json.memory?.embeddings?.provider !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER = json.memory.embeddings.provider;
  }
  if (json.memory?.embeddings?.model !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL = json.memory.embeddings.model;
  }
  if (json.memory?.embeddings?.endpoint !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT = json.memory.embeddings.endpoint;
  }
  if (json.memory?.embeddings?.apiKey !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY = json.memory.embeddings.apiKey;
  }
  if (json.memory?.embeddings?.apiKeyEnv !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV = json.memory.embeddings.apiKeyEnv;
  }
  if (json.memory?.embeddings?.dim !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_DIM = String(json.memory.embeddings.dim);
  }
  if (json.memory?.embeddings?.timeoutMs !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS = String(json.memory.embeddings.timeoutMs);
  }
  if (json.memory?.embeddings?.circuitBreaker?.failureThreshold !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD = String(
      json.memory.embeddings.circuitBreaker.failureThreshold,
    );
  }
  if (json.memory?.embeddings?.circuitBreaker?.cooldownMs !== undefined) {
    fromJson.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS = String(
      json.memory.embeddings.circuitBreaker.cooldownMs,
    );
  }
  if (json.memory?.llm?.provider !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_PROVIDER = json.memory.llm.provider;
  }
  if (json.memory?.llm?.model !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_MODEL = json.memory.llm.model;
  }
  if (json.memory?.llm?.trace !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_TRACE = String(json.memory.llm.trace);
  }
  if (json.memory?.llm?.timeoutMs !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS = String(json.memory.llm.timeoutMs);
  }
  if (json.memory?.llm?.endpoint !== undefined) {
    fromJson.MONO_AGENT_MEMORY_LLM_ENDPOINT = json.memory.llm.endpoint;
  }
  if (json.memory?.rememberTool?.enabled !== undefined) {
    fromJson.MONO_AGENT_MEMORY_REMEMBER_TOOL_ENABLED = String(json.memory.rememberTool.enabled);
  }
  if (json.memory?.recallTool?.enabled !== undefined) {
    fromJson.MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED = String(json.memory.recallTool.enabled);
  }
  if (json.memory?.consolidation?.enabled !== undefined) {
    fromJson.MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED = String(json.memory.consolidation.enabled);
  }
  if (json.memory?.consolidation?.cron !== undefined) {
    fromJson.MONO_AGENT_MEMORY_CONSOLIDATION_CRON = json.memory.consolidation.cron;
  }
  if (json.tools?.allowedTools !== undefined) {
    fromJson.MONO_AGENT_ALLOWED_TOOLS = csv(json.tools.allowedTools);
  }
  if (json.tools?.disallowedTools !== undefined) {
    fromJson.MONO_AGENT_DISALLOWED_TOOLS = csv(json.tools.disallowedTools);
  }
  if (json.tools?.filesystem?.readableRoots !== undefined) {
    fromJson.MONO_AGENT_FILE_TOOL_READABLE_ROOTS = JSON.stringify(json.tools.filesystem.readableRoots);
  }
  if (json.tools?.filesystem?.writableRoots !== undefined) {
    fromJson.MONO_AGENT_FILE_TOOL_WRITABLE_ROOTS = JSON.stringify(json.tools.filesystem.writableRoots);
  }
  if (json.tools?.mcpConfigPath !== undefined) {
    fromJson.MONO_AGENT_MCP_CONFIG_PATH = json.tools.mcpConfigPath;
  }
  if (json.tools?.mcpRequestContextServers !== undefined) {
    fromJson.MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS = csv(json.tools.mcpRequestContextServers);
  }
  if (json.tools?.continuationServers !== undefined) {
    fromJson.MONO_AGENT_CONTINUATION_SERVERS = csv(json.tools.continuationServers);
  }
  if (json.tools?.mcpCallTimeoutMs !== undefined) {
    fromJson.MONO_AGENT_MCP_CALL_TIMEOUT_MS = String(json.tools.mcpCallTimeoutMs);
  }
  if (json.tools?.mcpCallMaxTotalTimeoutMs !== undefined) {
    fromJson.MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS = String(json.tools.mcpCallMaxTotalTimeoutMs);
  }
  if (json.tools?.web?.coordination !== undefined) {
    fromJson.MONO_AGENT_WEB_COORDINATION = json.tools.web.coordination;
  }
  if (json.tools?.web?.search?.backend !== undefined) {
    fromJson.MONO_AGENT_WEB_SEARCH_BACKEND = json.tools.web.search.backend;
  }
  if (json.tools?.web?.search?.endpoint !== undefined) {
    fromJson.MONO_AGENT_WEB_SEARCH_ENDPOINT = json.tools.web.search.endpoint;
  }
  if (json.tools?.web?.search?.codex?.model !== undefined) {
    fromJson.MONO_AGENT_WEB_SEARCH_CODEX_MODEL = json.tools.web.search.codex.model;
  }
  if (json.tools?.web?.fetch?.render !== undefined) {
    fromJson.MONO_AGENT_WEB_FETCH_RENDER = json.tools.web.fetch.render;
  }
  if (json.tools?.web?.fetch?.browserCommand !== undefined) {
    fromJson.MONO_AGENT_WEB_BROWSER_COMMAND = json.tools.web.fetch.browserCommand;
  }
  if (json.sandbox?.mode !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_MODE = json.sandbox.mode;
  }
  if (json.sandbox?.network?.mode !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_NETWORK = json.sandbox.network.mode;
  }
  if (json.sandbox?.network?.allowlist !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST = csv(json.sandbox.network.allowlist);
  }
  if (json.sandbox?.readableRoots !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_READABLE_ROOTS = csv(json.sandbox.readableRoots);
  }
  if (json.sandbox?.writableRoots !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_WRITABLE_ROOTS = csv(json.sandbox.writableRoots);
  }
  if (json.sandbox?.denyWrite !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_DENY_WRITE = csv(json.sandbox.denyWrite);
  }
  if (json.sandbox?.fallback !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_FALLBACK = json.sandbox.fallback;
  }
  if (json.sandbox?.unsafeAllowHostProcess !== undefined) {
    fromJson.MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS = String(json.sandbox.unsafeAllowHostProcess);
  }
  if (json.artifacts?.dir !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_DIR = json.artifacts.dir;
  }
  if (json.artifacts?.retention?.maxAgeDays !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS = String(json.artifacts.retention.maxAgeDays);
  }
  if (json.artifacts?.retention?.maxCount !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT = String(json.artifacts.retention.maxCount);
  }
  if (json.artifacts?.retention?.dryRun !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN = String(json.artifacts.retention.dryRun);
  }
  if (json.artifacts?.memoryRetention?.maxAgeDays !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS = String(json.artifacts.memoryRetention.maxAgeDays);
  }
  if (json.artifacts?.memoryRetention?.maxCount !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT = String(json.artifacts.memoryRetention.maxCount);
  }
  if (json.artifacts?.memoryRetention?.dryRun !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN = String(json.artifacts.memoryRetention.dryRun);
  }
  if (json.traceability?.registryDir !== undefined) {
    fromJson.MONO_AGENT_TRACE_REGISTRY_DIR = json.traceability.registryDir;
  }
  if (json.traceability?.sourceId !== undefined) {
    fromJson.MONO_AGENT_TRACE_SOURCE_ID = json.traceability.sourceId;
  }
  if (json.traceability?.sourceLabel !== undefined) {
    fromJson.MONO_AGENT_TRACE_SOURCE_LABEL = json.traceability.sourceLabel;
  }
  if (json.traceability?.heartbeatMs !== undefined) {
    fromJson.MONO_AGENT_TRACE_HEARTBEAT_MS = String(json.traceability.heartbeatMs);
  }
  if (json.traceability?.staleAfterMs !== undefined) {
    fromJson.MONO_AGENT_TRACE_STALE_AFTER_MS = String(json.traceability.staleAfterMs);
  }
  if (json.traceability?.globalDiscovery !== undefined) {
    fromJson.MONO_AGENT_TRACE_GLOBAL_DISCOVERY = String(json.traceability.globalDiscovery);
  }
  if (json.observability?.exporters !== undefined && !hasObservabilityEnv(env)) {
    fromJson.MONO_AGENT_OBSERVABILITY_EXPORTERS = JSON.stringify(json.observability.exporters);
  }
  // Provider ids are operator-defined map keys, so the hand-written scalar
  // projector cannot enumerate them. Preserve the whole providers object in
  // one JSON env value; discrete legacy/reserved env values still layer later.
  if (json.providers !== undefined && !hasValue(env.MONO_AGENT_PROVIDERS_JSON)) {
    fromJson.MONO_AGENT_PROVIDERS_JSON = JSON.stringify(withoutEnvOverriddenProviders(json.providers, env));
  }
  if (json.providers?.piAuthPath !== undefined) {
    fromJson.MONO_AGENT_PI_AUTH_PATH = json.providers.piAuthPath;
  }
  if (json.providers?.piNative?.piMaxRetries !== undefined) {
    fromJson.MONO_AGENT_PI_MAX_RETRIES = String(json.providers.piNative.piMaxRetries);
  }
  if (json.providers?.piNative?.transport !== undefined) {
    fromJson.MONO_AGENT_PI_TRANSPORT = String(json.providers.piNative.transport);
  }
  if (json.providers?.piNative?.maxRetryDelayMs !== undefined) {
    fromJson.MONO_AGENT_MAX_RETRY_DELAY_MS = String(json.providers.piNative.maxRetryDelayMs);
  }
  if (json.providers?.piNative?.piSessionsRoot !== undefined) {
    fromJson.MONO_AGENT_PI_SESSIONS_ROOT = json.providers.piNative.piSessionsRoot;
  }

  // env wins: spread env last
  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim().length > 0) {
      layered[key] = value;
    }
  }
  if (shouldDropJsonMemoryLlmEndpoint(json.memory?.llm, env)) {
    delete layered.MONO_AGENT_MEMORY_LLM_ENDPOINT;
  }
  return layered;
}

function validateJsonRuntimeCompaction(json: MonoAgentConfigJson): void {
  const compaction: unknown = json.runtime?.compaction;
  if (compaction === undefined) return;
  if (!isJsonObject(compaction)) {
    throw new MonoAgentConfigError("invalid_json", "runtime.compaction must be an object.", {
      path: "runtime.compaction",
    });
  }
  for (const field of ["enabled", "fixedOverheadEnabled"] as const) {
    const value = compaction[field];
    if (value !== undefined && typeof value !== "boolean") {
      throw new MonoAgentConfigError("invalid_json", `runtime.compaction.${field} must be a boolean.`, {
        path: `runtime.compaction.${field}`,
      });
    }
  }
  const numbers = [
    ["triggerRatio", 0.2, 0.95, false],
    ["keepRecentTokens", 4_000, 200_000, true],
    ["summaryMaxTokens", 1_000, 64_000, true],
    ["minSavingsTokens", 0, 500_000, true],
    ["contextWindowOverride", 32_000, 10_000_000, true],
  ] as const;
  for (const [field, min, max, integer] of numbers) {
    const value = compaction[field];
    if (
      value !== undefined
      && (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max)
    ) {
      const kind = integer ? "an integer" : "a number";
      throw new MonoAgentConfigError(
        "invalid_json",
        `runtime.compaction.${field} must be ${kind} between ${min} and ${max}.`,
        { path: `runtime.compaction.${field}` },
      );
    }
  }
}

function csv(values: readonly string[]): string {
  return values.join(",");
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** Reserved `providers` keys that configure Pi rather than name a provider. */
const RESERVED_PROVIDERS_JSON_KEYS = new Set(["local", "piAuthPath", "piNative"]);

/**
 * Provider ids claimed by the legacy local-provider env vars, which the config
 * reader loads *in addition to* the provider map. Best effort by design: an
 * unparseable `MONO_AGENT_LOCAL_PROVIDERS_JSON` yields no ids here so the
 * reader still raises its own precise `invalid_json` error.
 */
function legacyEnvProviderIds(env: Record<string, string | undefined>): ReadonlySet<string> {
  const ids = new Set<string>();
  const registryJson = env.MONO_AGENT_LOCAL_PROVIDERS_JSON;
  if (hasValue(registryJson)) {
    try {
      const parsed: unknown = JSON.parse(registryJson as string);
      const entries: unknown = Array.isArray(parsed)
        ? parsed
        : (parsed as { readonly local?: unknown } | null)?.local;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const id: unknown = (entry as { readonly id?: unknown } | null)?.id;
          if (typeof id === "string" && id.trim().length > 0) ids.add(id.trim());
        }
      }
    } catch {
      return ids;
    }
    return ids;
  }
  // The discrete single-provider form: any one of these vars activates it, and
  // an omitted id defaults to `ollama` exactly as the reader defaults it.
  const singleProviderVars = [
    env.MONO_AGENT_LOCAL_PROVIDER_ID,
    env.MONO_AGENT_LOCAL_PROVIDER_TYPE,
    env.MONO_AGENT_LOCAL_PROVIDER_BASE_URL,
    env.MONO_AGENT_LOCAL_PROVIDER_ENABLED,
    env.MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL,
    env.MONO_AGENT_LOCAL_PROVIDER_API_KEY,
  ];
  if (singleProviderVars.some((value) => hasValue(value))) {
    const id = env.MONO_AGENT_LOCAL_PROVIDER_ID;
    ids.add(hasValue(id) ? (id as string).trim() : "ollama");
  }
  return ids;
}

/**
 * Env wins over JSON everywhere else in this loader, so a provider id defined
 * by both the JSON `providers` map and a legacy local-provider env var must
 * resolve to the env definition. Both layers used to reach the reader intact,
 * where `addConfiguredProvider()` rejected the collision and the agent failed
 * to load instead of taking the override. Reserved keys and `providers.local[]`
 * are untouched: the reader already drops the JSON `local` array whenever the
 * legacy env form is present.
 */
function withoutEnvOverriddenProviders(
  providers: MonoAgentProvidersJson,
  env: Record<string, string | undefined>,
): MonoAgentProvidersJson {
  const overridden = legacyEnvProviderIds(env);
  if (overridden.size === 0) return providers;
  const kept = Object.entries(providers).filter(
    ([key]) => RESERVED_PROVIDERS_JSON_KEYS.has(key) || !overridden.has(key),
  );
  return kept.length === Object.keys(providers).length
    ? providers
    : (Object.fromEntries(kept) as MonoAgentProvidersJson);
}

function hasObservabilityEnv(env: Record<string, string | undefined>): boolean {
  const value = env.MONO_AGENT_OBSERVABILITY_EXPORTERS;
  return value !== undefined && value.trim().length > 0;
}
