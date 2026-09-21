import { resolve } from "node:path";

import { readMonoAgentConfigJson } from "./json-source.js";
import { resolveJsonMonoAgentConfig } from "./config.js";
import type { MonoAgentConfig } from "./types.js";

export interface LoadMonoAgentConfigInput {
  readonly cwd: string;
  /** Optional path to a JSON config file. Missing or empty file is OK. */
  readonly jsonPath?: string;
  /** Disable deprecation prose for callers that produce structured diagnostics. */
  readonly warnOnDeprecatedConfig?: boolean;
}

const warnedDeprecatedConfigPaths = new Set<string>();

/**
 * Load core configuration from `mono-agent.config.json` and built-in defaults.
 *
 * Precedence is JSON, then built-in defaults. `MONO_AGENT_*` variables are
 * never consulted: any stale core variable left in the environment is silently
 * ignored, so the JSON file is the only configuration input. Credential values
 * stay out of the file itself -- JSON stores `apiKeyEnv`-style names and the
 * runtime resolves them against the effective environment at call time.
 */
export async function loadMonoAgentConfig(
  input: LoadMonoAgentConfigInput,
): Promise<MonoAgentConfig> {
  const jsonLayer = input.jsonPath === undefined
    ? {}
    : (await readMonoAgentConfigJson(input.jsonPath)).json;
  const configPath = input.jsonPath === undefined ? undefined : resolve(input.jsonPath);
  if (configPath !== undefined && input.warnOnDeprecatedConfig !== false
    && Object.hasOwn(jsonLayer, "monitors") && !warnedDeprecatedConfigPaths.has(configPath)) {
    warnedDeprecatedConfigPaths.add(configPath);
    console.warn("[mono-agent] Ignoring deprecated monitors config: monitors were removed. Use background process jobs for finite work.");
  }
  return resolveJsonMonoAgentConfig({ json: jsonLayer, cwd: input.cwd });
}
