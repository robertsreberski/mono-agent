import {
  layerJsonOntoEnv,
  readBoolean,
  readInteger,
  readJsonSection,
  readSettingsJson,
  readString,
  normalizeOptionalString,
  redactedSecret,
} from "@mono-agent/settings";
import type { RedactedSecretValue, SettingsJson } from "@mono-agent/settings";

import {
  DEFAULT_BASE_PATH,
  DEFAULT_HOST,
  DEFAULT_MODEL_ID,
  DEFAULT_PORT,
} from "./constants.js";
import { OpenAIApiAdapterError } from "./errors.js";

export interface OpenAIApiAdapterConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly allowNonLoopback: boolean;
  readonly apiKey?: string;
  readonly modelId: string;
}

export interface RedactedOpenAIApiAdapterConfig extends Omit<OpenAIApiAdapterConfig, "apiKey"> {
  readonly apiKey: RedactedSecretValue;
}

export interface LoadOpenAIApiAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const DEFAULT_ENABLED = false;

const invalidConfig = (message: string, details?: Record<string, unknown>): OpenAIApiAdapterError =>
  new OpenAIApiAdapterError("invalid_config", message, details);

export async function loadOpenAIApiAdapterConfig(
  input: LoadOpenAIApiAdapterConfigInput,
): Promise<OpenAIApiAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerOpenAIApiJsonOntoEnv(json, input.env);
  const apiKey = normalizeOptionalString(env.MONO_AGENT_OPENAI_API_KEY);
  return {
    enabled: readBoolean(env.MONO_AGENT_OPENAI_API_ENABLED, "MONO_AGENT_OPENAI_API_ENABLED", DEFAULT_ENABLED, invalidConfig),
    host: readString(env.MONO_AGENT_OPENAI_API_HOST, DEFAULT_HOST),
    port: readInteger(env.MONO_AGENT_OPENAI_API_PORT, "MONO_AGENT_OPENAI_API_PORT", DEFAULT_PORT, invalidConfig, { min: 0, max: 65535 }),
    basePath: readBasePath(env.MONO_AGENT_OPENAI_API_BASE_PATH),
    allowNonLoopback: readBoolean(env.MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK, "MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK", false, invalidConfig),
    ...(apiKey === undefined ? {} : { apiKey }),
    modelId: readString(env.MONO_AGENT_OPENAI_API_MODEL_ID, DEFAULT_MODEL_ID),
  };
}

export function redactOpenAIApiAdapterConfig(
  config: OpenAIApiAdapterConfig,
): RedactedOpenAIApiAdapterConfig {
  return {
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    basePath: config.basePath,
    allowNonLoopback: config.allowNonLoopback,
    apiKey: redactedSecret(config.apiKey),
    modelId: config.modelId,
  };
}

function layerOpenAIApiJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readJsonSection(json, "openaiApi");
  return layerJsonOntoEnv(env, [
    { env: "MONO_AGENT_OPENAI_API_ENABLED", value: section.enabled, kind: "boolean" },
    { env: "MONO_AGENT_OPENAI_API_HOST", value: section.host },
    { env: "MONO_AGENT_OPENAI_API_PORT", value: section.port, kind: "integer" },
    { env: "MONO_AGENT_OPENAI_API_BASE_PATH", value: section.basePath },
    { env: "MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK", value: section.allowNonLoopback, kind: "boolean" },
    { env: "MONO_AGENT_OPENAI_API_KEY", value: section.apiKey },
    { env: "MONO_AGENT_OPENAI_API_MODEL_ID", value: section.modelId },
  ]);
}

function readBasePath(raw: string | undefined): string {
  const value = readString(raw, DEFAULT_BASE_PATH);
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw invalidConfig("MONO_AGENT_OPENAI_API_BASE_PATH must be an absolute path without query or hash.");
  }
  return value.length === 1 ? "/" : value.replace(/\/+$/u, "");
}
