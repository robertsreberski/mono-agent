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
  if (json.telegram?.botToken !== undefined) {
    fromJson.MONO_AGENT_TELEGRAM_BOT_TOKEN = json.telegram.botToken;
  }
  if (json.telegram?.allowedChatIds !== undefined) {
    fromJson.MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS = csv(json.telegram.allowedChatIds);
  }
  if (json.runtime?.model !== undefined) {
    fromJson.MONO_AGENT_MODEL = json.runtime.model;
  }
  if (json.runtime?.executionMode !== undefined) {
    fromJson.MONO_AGENT_EXECUTION_MODE = json.runtime.executionMode;
  }
  if (json.runtime?.effort !== undefined) {
    fromJson.MONO_AGENT_EFFORT = json.runtime.effort;
  }
  if (json.runtime?.maxTurns !== undefined) {
    fromJson.MONO_AGENT_MAX_TURNS = String(json.runtime.maxTurns);
  }
  if (json.runtime?.workspace !== undefined) {
    fromJson.MONO_AGENT_WORKSPACE = json.runtime.workspace;
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
  if (json.tools?.allowedTools !== undefined) {
    fromJson.MONO_AGENT_ALLOWED_TOOLS = csv(json.tools.allowedTools);
  }
  if (json.tools?.disallowedTools !== undefined) {
    fromJson.MONO_AGENT_DISALLOWED_TOOLS = csv(json.tools.disallowedTools);
  }
  if (json.tools?.mcpConfigPath !== undefined) {
    fromJson.MONO_AGENT_MCP_CONFIG_PATH = json.tools.mcpConfigPath;
  }
  if (json.artifacts?.dir !== undefined) {
    fromJson.MONO_AGENT_ARTIFACT_DIR = json.artifacts.dir;
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
