import { readMonoAgentConfigJson } from "./json-source.js";
import type { MonoAgentConfigJson } from "./json-source.js";
import { loadMonoAgentConfig } from "./config.js";
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
 *   3. built-in defaults from loadMonoAgentConfig (executionMode, maxTurns, etc.)
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
  const layeredEnv = layerJsonOntoEnv(jsonLayer, input.env);
  return loadMonoAgentConfig({ env: layeredEnv, cwd: input.cwd });
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
  const fromJson: Record<string, string | undefined> = {};
  if (json.runtime?.model !== undefined) {
    fromJson.MONO_AGENT_MODEL = json.runtime.model;
  }
  if (json.runtime?.fallbackModels !== undefined) {
    fromJson.MONO_AGENT_FALLBACK_MODELS = csv(json.runtime.fallbackModels);
  }
  if (json.runtime?.executionMode !== undefined) {
    fromJson.MONO_AGENT_EXECUTION_MODE = json.runtime.executionMode;
  }
  if (json.runtime?.effort !== undefined) {
    fromJson.MONO_AGENT_EFFORT = json.runtime.effort;
  }
  if (json.runtime?.permissionMode !== undefined) {
    fromJson.MONO_AGENT_PERMISSION_MODE = json.runtime.permissionMode;
  }
  if (json.runtime?.reasoningSummary !== undefined) {
    fromJson.MONO_AGENT_REASONING_SUMMARY = json.runtime.reasoningSummary;
  }
  if (json.runtime?.maxTurns !== undefined) {
    fromJson.MONO_AGENT_MAX_TURNS = String(json.runtime.maxTurns);
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
  if (json.memory?.mode !== undefined) {
    fromJson.MONO_AGENT_MEMORY_MODE = json.memory.mode;
  }
  if (json.memory?.path !== undefined) {
    fromJson.MONO_AGENT_MEMORY_PATH = json.memory.path;
  }
  if (json.memory?.maxBytes !== undefined) {
    fromJson.MONO_AGENT_MEMORY_MAX_BYTES = String(json.memory.maxBytes);
  }
  if (json.memory?.scope !== undefined) {
    fromJson.MONO_AGENT_MEMORY_SCOPE = json.memory.scope;
  }
  if (json.memory?.writeMode !== undefined) {
    fromJson.MONO_AGENT_MEMORY_WRITE_MODE = json.memory.writeMode;
  }
  if (json.memory?.tools?.enabled !== undefined) {
    fromJson.MONO_AGENT_MEMORY_TOOLS_ENABLED = String(json.memory.tools.enabled);
  }
  if (json.memory?.tools?.allowJournalAppend !== undefined) {
    fromJson.MONO_AGENT_MEMORY_TOOLS_ALLOW_JOURNAL_APPEND = String(json.memory.tools.allowJournalAppend);
  }
  if (json.memory?.graphPath !== undefined) {
    fromJson.MONO_AGENT_MEMORY_GRAPH_PATH = json.memory.graphPath;
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
  if (json.tools?.allowedTools !== undefined) {
    fromJson.MONO_AGENT_ALLOWED_TOOLS = csv(json.tools.allowedTools);
  }
  if (json.tools?.disallowedTools !== undefined) {
    fromJson.MONO_AGENT_DISALLOWED_TOOLS = csv(json.tools.disallowedTools);
  }
  if (json.tools?.mcpConfigPath !== undefined) {
    fromJson.MONO_AGENT_MCP_CONFIG_PATH = json.tools.mcpConfigPath;
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
  if (json.providers?.piAuthPath !== undefined) {
    fromJson.MONO_AGENT_PI_AUTH_PATH = json.providers.piAuthPath;
  }
  if (json.providers?.local !== undefined && !hasLocalProviderEnv(env)) {
    fromJson.MONO_AGENT_LOCAL_PROVIDERS_JSON = JSON.stringify(json.providers.local);
  }

  // env wins: spread env last
  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim().length > 0) {
      layered[key] = value;
    }
  }
  return layered;
}

function csv(values: readonly string[]): string {
  return values.join(",");
}

function hasLocalProviderEnv(env: Record<string, string | undefined>): boolean {
  return [
    "MONO_AGENT_LOCAL_PROVIDERS_JSON",
    "MONO_AGENT_LOCAL_PROVIDER_ID",
    "MONO_AGENT_LOCAL_PROVIDER_TYPE",
    "MONO_AGENT_LOCAL_PROVIDER_BASE_URL",
    "MONO_AGENT_LOCAL_PROVIDER_ENABLED",
    "MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL",
    "MONO_AGENT_LOCAL_PROVIDER_API_KEY",
  ].some((name) => {
    const value = env[name];
    return value !== undefined && value.trim().length > 0;
  });
}
