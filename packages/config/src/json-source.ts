import {
  readSettingsJson,
  SettingsJsonError,
  writeSettingsJson,
} from "@mono-agent/settings";
import type { SettingsJson, SettingsJsonValue } from "@mono-agent/settings";

import { MonoAgentConfigError } from "./config.js";
import type { MemoryMode, MemoryScope, MemoryWriteMode } from "./types.js";

export type MonoAgentLocalProviderModelJson = {
  readonly name?: string;
  readonly alias?: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly capabilities?: { readonly [key: string]: SettingsJsonValue };
  readonly pricing?: { readonly [key: string]: SettingsJsonValue };
};

export type MonoAgentLocalProviderJson = {
  readonly id?: string;
  readonly type?: string;
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  readonly trustPublicUrl?: boolean;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly models?: readonly MonoAgentLocalProviderModelJson[];
};

export type MonoAgentProvidersJson = {
  readonly local?: readonly MonoAgentLocalProviderJson[];
};

/**
 * Serializable shape of MonoAgentConfig persisted as `mono-agent.config.json`.
 *
 * All fields are optional so a partially-configured file is acceptable. Env
 * variables can still satisfy missing fields when the layered loader runs.
 *
 * Paths inside this file are relative to the file's containing directory (or
 * the loader's `cwd`); they are resolved by the loader, not at write time.
 */
export interface MonoAgentConfigJson extends SettingsJson {
  readonly runtime?: {
    readonly model?: string;
    readonly executionMode?: string;
    readonly effort?: string;
    readonly maxTurns?: number;
    readonly workspace?: string;
  };
  readonly context?: {
    readonly identityPath?: string;
    readonly soulPath?: string;
    readonly skillsRoot?: string;
    readonly selectedSkills?: readonly string[];
  };
  readonly memory?: {
    readonly mode?: MemoryMode;
    readonly path?: string;
    readonly maxBytes?: number;
    readonly scope?: MemoryScope;
    readonly writeMode?: MemoryWriteMode;
  };
  readonly tools?: {
    readonly allowedTools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly mcpConfigPath?: string;
  };
  readonly artifacts?: {
    readonly dir?: string;
  };
  readonly traceability?: {
    readonly registryDir?: string;
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly heartbeatMs?: number;
    readonly staleAfterMs?: number;
  };
  readonly providers?: MonoAgentProvidersJson;
}

export interface ReadMonoAgentConfigJsonResult {
  readonly json: MonoAgentConfigJson;
  /** sha-256 of the parsed content (or empty string when the file is missing). */
  readonly version: string;
  /** Absolute path actually read. */
  readonly path: string;
  /** True when the file did not exist on disk. */
  readonly missing: boolean;
}

/**
 * Read a JSON config file. Missing file returns an empty config rather than
 * throwing; that lets hosts ship a blank config and fall back to env defaults.
 */
export async function readMonoAgentConfigJson(path: string): Promise<ReadMonoAgentConfigJsonResult> {
  try {
    const result = await readSettingsJson(path);
    return {
      ...result,
      json: result.json as MonoAgentConfigJson,
    };
  } catch (error) {
    throw toConfigError(error, path);
  }
}

/**
 * Atomically write a JSON config file. Writes to `<path>.tmp` first, fsyncs,
 * then renames over the target. The temp file is unlinked on failure so we
 * never leave a half-written `.tmp` behind on the next run.
 */
export async function writeMonoAgentConfigJson(input: {
  readonly path: string;
  readonly patch: MonoAgentConfigJson;
}): Promise<{ readonly version: string }> {
  try {
    return await writeSettingsJson({
      path: input.path,
      patch: input.patch,
    });
  } catch (error) {
    throw toConfigError(error, input.path);
  }
}

function toConfigError(error: unknown, path: string): MonoAgentConfigError {
  if (error instanceof SettingsJsonError) {
    return new MonoAgentConfigError("invalid_env", error.message, {
      path,
      reason: error.message,
    });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new MonoAgentConfigError("invalid_env", reason, { path, reason });
}
