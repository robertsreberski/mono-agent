import {
  fieldSpecMappings,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readInteger,
  readJsonSection,
  readSettingsJson,
  readString,
  redactedSecret,
} from "@mono-agent/settings";
import type { JsonEnvFieldSpec, RedactedSecretValue, SettingsJson } from "@mono-agent/settings";

import { DEFAULT_LIVE_BASE_PATH, DEFAULT_LIVE_HOST, DEFAULT_LIVE_PORT } from "./constants.js";
import { LiveAdapterError } from "./errors.js";

export interface LiveAdapterConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly allowNonLoopback: boolean;
  readonly apiKey?: string;
}

export interface RedactedLiveAdapterConfig extends Omit<LiveAdapterConfig, "apiKey"> {
  readonly apiKey: RedactedSecretValue;
}

export interface LoadLiveAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

/**
 * Like the TUI endpoint (and unlike every chat channel, default OFF), the live
 * event relay is ON by default: it is a read-only operator surface, binds
 * loopback-only on an ephemeral port, and needs no credentials — so
 * `mono-agent web` can observe any running agent without a per-agent config edit.
 * Set `"live": { "enabled": false }` to opt out.
 */
const DEFAULT_ENABLED = true;

const invalidConfig = (message: string, details?: Record<string, unknown>): LiveAdapterError =>
  new LiveAdapterError("invalid_config", message, details);

export async function loadLiveAdapterConfig(
  input: LoadLiveAdapterConfigInput,
): Promise<LiveAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerLiveJsonOntoEnv(json, input.env);
  const apiKey = normalizeOptionalString(env.MONO_AGENT_LIVE_API_KEY);
  return {
    enabled: readBoolean(env.MONO_AGENT_LIVE_ENABLED, "MONO_AGENT_LIVE_ENABLED", DEFAULT_ENABLED, invalidConfig),
    host: readString(env.MONO_AGENT_LIVE_HOST, DEFAULT_LIVE_HOST),
    port: readInteger(env.MONO_AGENT_LIVE_PORT, "MONO_AGENT_LIVE_PORT", DEFAULT_LIVE_PORT, invalidConfig, {
      min: 0,
      max: 65535,
    }),
    basePath: readBasePath(env.MONO_AGENT_LIVE_BASE_PATH),
    allowNonLoopback: readBoolean(
      env.MONO_AGENT_LIVE_ALLOW_NON_LOOPBACK,
      "MONO_AGENT_LIVE_ALLOW_NON_LOOPBACK",
      false,
      invalidConfig,
    ),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

export function redactLiveAdapterConfig(config: LiveAdapterConfig): RedactedLiveAdapterConfig {
  return {
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    basePath: config.basePath,
    allowNonLoopback: config.allowNonLoopback,
    apiKey: redactedSecret(config.apiKey),
  };
}

/**
 * The `live` section's field registry: the single source of truth for JSON→env
 * layering and the app's config provenance view. The `live.apiKey` id doubles as
 * a cross-package contract — `mono-agent web` resolves a running agent's key by
 * reading this field from the agent's config file (the registry carries no secrets).
 */
export const LIVE_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "live.enabled", env: "MONO_AGENT_LIVE_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "live.host", env: "MONO_AGENT_LIVE_HOST", fromJson: (s) => s.host },
  { id: "live.port", env: "MONO_AGENT_LIVE_PORT", kind: "integer", fromJson: (s) => s.port },
  { id: "live.basePath", env: "MONO_AGENT_LIVE_BASE_PATH", fromJson: (s) => s.basePath },
  { id: "live.allowNonLoopback", env: "MONO_AGENT_LIVE_ALLOW_NON_LOOPBACK", kind: "boolean", fromJson: (s) => s.allowNonLoopback },
  { id: "live.apiKey", env: "MONO_AGENT_LIVE_API_KEY", secret: true, fromJson: (s) => s.apiKey },
];

function layerLiveJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return layerJsonOntoEnv(env, fieldSpecMappings(readJsonSection(json, "live"), LIVE_CONFIG_FIELDS));
}

function readBasePath(raw: string | undefined): string {
  const value = readString(raw, DEFAULT_LIVE_BASE_PATH);
  if (!isLiteralBasePath(value)) {
    throw invalidConfig("MONO_AGENT_LIVE_BASE_PATH must be an absolute literal path made of slash-separated URL path segments.");
  }
  const stripped = value.replace(/\/+$/u, "");
  return stripped.length === 0 ? "/" : stripped;
}

function isLiteralBasePath(basePath: string): boolean {
  return basePath === "/" || /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/u.test(basePath);
}
