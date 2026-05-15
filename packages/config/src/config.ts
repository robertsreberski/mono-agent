import { resolve } from "node:path";

import {
  assertExecutionModeCompatible,
  defaultExecutionModeForModel,
  isRuntimeExecutionMode,
  parseMonoRuntimeModelReference,
  RuntimeAdapterError,
} from "@worklab-ai/runtime-adapter";
import type { RuntimeExecutionMode } from "@worklab-ai/runtime-adapter";

import type { MemoryScope, MemoryWriteMode, MonoAgentConfig, RedactedMonoAgentConfig } from "./types.js";

export type MonoAgentConfigErrorCode =
  | "missing_required_env"
  | "invalid_env"
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

export interface LoadMonoAgentConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
}

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MEMORY_MAX_BYTES = 64_000;

export function loadMonoAgentConfig(input: LoadMonoAgentConfigInput): MonoAgentConfig {
  const cwd = normalizeCwd(input.cwd);
  const botToken = readRequired(input.env, "MONO_AGENT_TELEGRAM_BOT_TOKEN");
  const allowedChatIds = readRequiredCsv(input.env, "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS");
  const model = parseModel(readRequired(input.env, "MONO_AGENT_MODEL"));
  const executionMode = parseExecutionMode(input.env.MONO_AGENT_EXECUTION_MODE, model);
  const maxTurns = readInteger(input.env, "MONO_AGENT_MAX_TURNS", DEFAULT_MAX_TURNS, { min: 1, max: 100 });
  const workspace = readPath(input.env.MONO_AGENT_WORKSPACE, cwd, cwd);
  const identityPath = readPath(readRequired(input.env, "MONO_AGENT_IDENTITY_PATH"), cwd);
  const soulPath = readOptionalPath(input.env.MONO_AGENT_SOUL_PATH, cwd);
  const skillsRoot = readOptionalPath(input.env.MONO_AGENT_SKILLS_ROOT, cwd);
  const selectedSkills = readCsv(input.env.MONO_AGENT_SELECTED_SKILLS);
  const memory = readMemoryConfig(input.env, cwd);
  const mcpConfigPath = readOptionalPath(input.env.MONO_AGENT_MCP_CONFIG_PATH, cwd);
  const artifactDir = readPath(input.env.MONO_AGENT_ARTIFACT_DIR, cwd, resolve(cwd, ".mono-agent", "artifacts"));

  assertModeCompatibility(model, executionMode);

  const effort = normalizeOptionalString(input.env.MONO_AGENT_EFFORT);
  const runtime: MonoAgentConfig["runtime"] = {
    model,
    executionMode,
    maxTurns,
    workspace,
    ...(effort === undefined ? {} : { effort }),
  };

  const context: MonoAgentConfig["context"] = {
    identityPath,
    selectedSkills,
    ...(soulPath === undefined ? {} : { soulPath }),
    ...(skillsRoot === undefined ? {} : { skillsRoot }),
  };

  const tools: MonoAgentConfig["tools"] = {
    allowedTools: readCsv(input.env.MONO_AGENT_ALLOWED_TOOLS),
    disallowedTools: readCsv(input.env.MONO_AGENT_DISALLOWED_TOOLS),
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
  };

  const config: MonoAgentConfig = {
    telegram: {
      botToken,
      allowedChatIds,
    },
    runtime,
    context,
    tools,
    artifacts: {
      dir: artifactDir,
    },
  };

  if (memory !== undefined) {
    return { ...config, memory };
  }
  return config;
}

export function redactMonoAgentConfig(config: MonoAgentConfig): RedactedMonoAgentConfig {
  const redacted: RedactedMonoAgentConfig = {
    telegram: {
      botToken: { present: config.telegram.botToken.length > 0, redacted: true },
      allowedChatIds: { count: config.telegram.allowedChatIds.length },
    },
    runtime: { ...config.runtime },
    context: { ...config.context, selectedSkills: [...config.context.selectedSkills] },
    tools: {
      ...config.tools,
      allowedTools: [...config.tools.allowedTools],
      disallowedTools: [...config.tools.disallowedTools],
    },
    artifacts: { ...config.artifacts },
  };
  if (config.memory !== undefined) {
    return { ...redacted, memory: { ...config.memory } };
  }
  return redacted;
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

function readMemoryConfig(env: Record<string, string | undefined>, cwd: string): MonoAgentConfig["memory"] | undefined {
  const rawPath = normalizeOptionalString(env.MONO_AGENT_MEMORY_PATH);
  if (rawPath === undefined) {
    return undefined;
  }

  const writeMode = readChoice<MemoryWriteMode>(env.MONO_AGENT_MEMORY_WRITE_MODE, "MONO_AGENT_MEMORY_WRITE_MODE", [
    "disabled",
    "append-host-summary",
  ], "disabled");
  const scope = readChoice<MemoryScope>(env.MONO_AGENT_MEMORY_SCOPE, "MONO_AGENT_MEMORY_SCOPE", [
    "single-file",
    "per-conversation",
  ], "single-file");

  return {
    path: readPath(rawPath, cwd),
    maxBytes: readInteger(env, "MONO_AGENT_MEMORY_MAX_BYTES", DEFAULT_MEMORY_MAX_BYTES, { min: 1, max: 1_000_000 }),
    scope,
    writeMode,
  };
}

function readRequired(env: Record<string, string | undefined>, name: string): string {
  const value = normalizeOptionalString(env[name]);
  if (value === undefined) {
    throw new MonoAgentConfigError("missing_required_env", `${name} is required.`, { env: name });
  }
  return value;
}

function readRequiredCsv(env: Record<string, string | undefined>, name: string): readonly string[] {
  const values = readCsv(readRequired(env, name));
  if (values.length === 0) {
    throw new MonoAgentConfigError("missing_required_env", `${name} must contain at least one value.`, { env: name });
  }
  return values;
}

function readCsv(raw: string | undefined): readonly string[] {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return [];
  }
  return normalized
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
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

function readInteger(
  env: Record<string, string | undefined>,
  name: string,
  defaultValue: number,
  bounds: { readonly min: number; readonly max: number },
): number {
  const raw = normalizeOptionalString(env[name]);
  if (raw === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new MonoAgentConfigError("invalid_env", `${name} must be an integer.`, { env: name });
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new MonoAgentConfigError("invalid_env", `${name} must be between ${bounds.min} and ${bounds.max}.`, { env: name });
  }
  return value;
}

function readChoice<T extends string>(raw: string | undefined, name: string, choices: readonly T[], defaultValue: T): T {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if ((choices as readonly string[]).includes(normalized)) {
    return normalized as T;
  }
  throw new MonoAgentConfigError("invalid_env", `${name} must be one of: ${choices.join(", ")}.`, { env: name });
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeCwd(value: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    throw new MonoAgentConfigError("invalid_env", "cwd must be a non-empty path.");
  }
  return resolve(normalized);
}
