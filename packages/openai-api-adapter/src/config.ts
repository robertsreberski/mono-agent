import {
  defineFieldGroup,
  readSettingsJson,
} from "@worklab-ai/settings";
import type { FieldGroup, SettingsJson } from "@worklab-ai/settings";

import { OpenAIApiAdapterError } from "./server.js";

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
  readonly apiKey: { readonly present: boolean; readonly redacted: true };
}

export interface LoadOpenAIApiAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const DEFAULT_ENABLED = false;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_BASE_PATH = "/v1";
const DEFAULT_MODEL_ID = "mono-agent";

export const openAIApiFieldGroup: FieldGroup = defineFieldGroup({
  id: "openaiApi",
  label: "OpenAI API",
  description: "Optional OpenAI-compatible Chat Completions endpoint for OpenWebUI and similar clients.",
  fields: [
    {
      id: "openaiApi.enabled",
      label: "Enable OpenAI API",
      description: "Expose this Mono Agent as an OpenAI-compatible chat provider.",
      kind: "switch",
      path: ["openaiApi", "enabled"],
    },
    {
      id: "openaiApi.host",
      label: "Host",
      description: "Bind host. Defaults to 127.0.0.1.",
      kind: "string",
      placeholder: "127.0.0.1",
      path: ["openaiApi", "host"],
    },
    {
      id: "openaiApi.port",
      label: "Port",
      description: "Bind port. Use 0 to choose a free loopback port.",
      kind: "integer",
      min: 0,
      max: 65535,
      placeholder: "0",
      path: ["openaiApi", "port"],
    },
    {
      id: "openaiApi.basePath",
      label: "Base path",
      description: "OpenAI-compatible API base path. OpenWebUI should point to this URL.",
      kind: "string",
      placeholder: "/v1",
      path: ["openaiApi", "basePath"],
    },
    {
      id: "openaiApi.allowNonLoopback",
      label: "Allow non-loopback",
      description: "Explicitly allow public/non-loopback binding.",
      kind: "switch",
      path: ["openaiApi", "allowNonLoopback"],
    },
    {
      id: "openaiApi.apiKey",
      label: "API key",
      description: "Optional bearer token required from OpenWebUI. Never returned to the UI after save.",
      kind: "secret",
      path: ["openaiApi", "apiKey"],
    },
    {
      id: "openaiApi.modelId",
      label: "Model id",
      description: "Model id advertised through /models and selected in OpenWebUI.",
      kind: "string",
      placeholder: "mono-agent",
      path: ["openaiApi", "modelId"],
    },
  ],
});

export async function loadOpenAIApiAdapterConfig(
  input: LoadOpenAIApiAdapterConfigInput,
): Promise<OpenAIApiAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerOpenAIApiJsonOntoEnv(json, input.env);
  const apiKey = readOptionalString(env.MONO_AGENT_OPENAI_API_KEY);
  return {
    enabled: readBoolean(env.MONO_AGENT_OPENAI_API_ENABLED, DEFAULT_ENABLED, "MONO_AGENT_OPENAI_API_ENABLED"),
    host: readString(env.MONO_AGENT_OPENAI_API_HOST, DEFAULT_HOST),
    port: readInteger(env.MONO_AGENT_OPENAI_API_PORT, DEFAULT_PORT, "MONO_AGENT_OPENAI_API_PORT", { min: 0, max: 65535 }),
    basePath: readBasePath(env.MONO_AGENT_OPENAI_API_BASE_PATH),
    allowNonLoopback: readBoolean(env.MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK, false, "MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK"),
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
    apiKey: {
      present: config.apiKey !== undefined && config.apiKey.length > 0,
      redacted: true,
    },
    modelId: config.modelId,
  };
}

function layerOpenAIApiJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readOpenAIApiSection(json);
  const fromJson: Record<string, string | undefined> = {};
  setBoolean(fromJson, "MONO_AGENT_OPENAI_API_ENABLED", section.enabled);
  setString(fromJson, "MONO_AGENT_OPENAI_API_HOST", section.host);
  setInteger(fromJson, "MONO_AGENT_OPENAI_API_PORT", section.port);
  setString(fromJson, "MONO_AGENT_OPENAI_API_BASE_PATH", section.basePath);
  setBoolean(fromJson, "MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK", section.allowNonLoopback);
  setString(fromJson, "MONO_AGENT_OPENAI_API_KEY", section.apiKey);
  setString(fromJson, "MONO_AGENT_OPENAI_API_MODEL_ID", section.modelId);

  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      layered[key] = value;
    }
  }
  return layered;
}

function readOpenAIApiSection(json: SettingsJson): Record<string, unknown> {
  const section = json.openaiApi;
  if (section !== null && typeof section === "object" && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  return {};
}

function readString(raw: string | undefined, defaultValue: string): string {
  return readOptionalString(raw) ?? defaultValue;
}

function readBasePath(raw: string | undefined): string {
  const value = readString(raw, DEFAULT_BASE_PATH);
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new OpenAIApiAdapterError("invalid_config", "MONO_AGENT_OPENAI_API_BASE_PATH must be an absolute path without query or hash.");
  }
  return value.length === 1 ? "/" : value.replace(/\/+$/u, "");
}

function readBoolean(raw: string | undefined, defaultValue: boolean, envName: string): boolean {
  const normalized = readOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new OpenAIApiAdapterError("invalid_config", `${envName} must be true or false.`, { reason: normalized });
}

function readInteger(
  raw: string | undefined,
  defaultValue: number,
  envName: string,
  bounds: { readonly min: number; readonly max: number },
): number {
  const normalized = readOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(normalized)) {
    throw new OpenAIApiAdapterError("invalid_config", `${envName} must be an integer.`);
  }
  const value = Number(normalized);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new OpenAIApiAdapterError("invalid_config", `${envName} must be between ${bounds.min} and ${bounds.max}.`);
  }
  return value;
}

function setString(out: Record<string, string | undefined>, key: string, value: unknown): void {
  if (typeof value === "string") {
    out[key] = value;
  }
}

function setBoolean(out: Record<string, string | undefined>, key: string, value: unknown): void {
  if (typeof value === "boolean") {
    out[key] = value ? "true" : "false";
  }
}

function setInteger(out: Record<string, string | undefined>, key: string, value: unknown): void {
  if (Number.isInteger(value)) {
    out[key] = String(value);
  }
}

function readOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
