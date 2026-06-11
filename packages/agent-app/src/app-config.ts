import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  CORE_AGENT_FIELD_GROUPS,
  loadMonoAgentConfigWithSources,
  MonoAgentConfigError,
  readMonoAgentConfigJson,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import { defineFieldGroup } from "@mono-agent/settings";
import type { FieldGroup } from "@mono-agent/settings";
import { a2aFieldGroup } from "@mono-agent/a2a-adapter";
import { cronFieldGroup } from "@mono-agent/cron-adapter";
import { openAIApiFieldGroup } from "@mono-agent/openai-api-adapter";
import { slackFieldGroup } from "@mono-agent/slack-adapter";
import { telegramFieldGroup } from "@mono-agent/telegram-adapter";
import { webhookFieldGroup } from "@mono-agent/webhook-adapter";
import { whatsappFieldGroup } from "@mono-agent/whatsapp-adapter";

export const consoleFieldGroup = defineFieldGroup({
  id: "console",
  label: "Operator console",
  description: "The local browser console started alongside the agent.",
  fields: [
    {
      id: "console.enabled",
      label: "Enabled",
      description: "Start the loopback operator console with the app (on by default).",
      kind: "switch",
      path: ["console", "enabled"],
    },
    {
      id: "console.port",
      label: "Port",
      description: "Fixed loopback port for the console; omit (or 0) to pick a free port.",
      kind: "integer",
      min: 0,
      max: 65_535,
      placeholder: "0",
      path: ["console", "port"],
    },
  ],
});

/**
 * Every settings group a config-first host edits through the operator console:
 * the adapter-neutral core config, the console itself, plus one group per
 * communication channel.
 */
export const MONO_AGENT_APP_FIELD_GROUPS: readonly FieldGroup[] = [
  ...CORE_AGENT_FIELD_GROUPS,
  consoleFieldGroup,
  telegramFieldGroup,
  slackFieldGroup,
  a2aFieldGroup,
  webhookFieldGroup,
  openAIApiFieldGroup,
  cronFieldGroup,
  whatsappFieldGroup,
];

export interface MonoAgentAppConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
}

export async function loadAppCoreConfig(input: MonoAgentAppConfigInput): Promise<MonoAgentConfig> {
  return await loadMonoAgentConfigWithSources({
    env: input.env,
    cwd: input.cwd,
    jsonPath: input.configPath,
  });
}

export function isAppCoreConfigError(error: unknown): error is MonoAgentConfigError {
  return error instanceof MonoAgentConfigError;
}

const DEFAULT_TRACE_HEARTBEAT_MS = 10_000;
const DEFAULT_TRACE_STALE_AFTER_MS = 30_000;
const DEFAULT_TRACE_SOURCE_ID_PREFIX = "mono-agent";
const DEFAULT_TRACE_SOURCE_LABEL = "Mono Agent";

/**
 * Trace defaults a host can override without touching the user's config file
 * (e.g. the final demo labels its source "Final Agent Demo").
 */
export interface AppTraceDefaults {
  readonly sourceIdPrefix?: string;
  readonly sourceLabel?: string;
}

/**
 * The resolvers below intentionally tolerate an incomplete or invalid config
 * file: observability and the operator console must stay usable while the
 * user is still fixing their config, so they fall back to defaults instead of
 * throwing on unreadable JSON.
 */
export async function resolveAppArtifactDir(input: MonoAgentAppConfigInput): Promise<string> {
  const envDir = input.env.MONO_AGENT_ARTIFACT_DIR?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(input.cwd, envDir);
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const configDir = typeof json.artifacts?.dir === "string" ? json.artifacts.dir.trim() : "";
    if (configDir.length > 0) {
      return resolve(input.cwd, configDir);
    }
  } catch {
    // Fall through to the default below.
  }

  return resolve(input.cwd, ".mono-agent", "artifacts");
}

export interface AppConsoleSettings {
  readonly enabled: boolean;
  readonly port?: number;
}

/**
 * Operator console settings: env wins, then the `console` section of the
 * config file, then defaults (enabled, auto-selected port). Tolerates an
 * unreadable config file like the other app-level resolvers so the console
 * stays available while the user fixes their config.
 */
export async function resolveAppConsoleSettings(input: MonoAgentAppConfigInput): Promise<AppConsoleSettings> {
  let enabled = parseConsoleBoolean(input.env.MONO_AGENT_CONSOLE_ENABLED, "MONO_AGENT_CONSOLE_ENABLED");
  let port = parseConsolePort(input.env.MONO_AGENT_CONSOLE_PORT, "MONO_AGENT_CONSOLE_PORT");

  if (enabled === undefined || port === undefined) {
    try {
      const { json } = await readMonoAgentConfigJson(input.configPath);
      const section = json.console;
      if (typeof section === "object" && section !== null && !Array.isArray(section)) {
        const record = section as Record<string, unknown>;
        if (enabled === undefined && typeof record.enabled === "boolean") {
          enabled = record.enabled;
        }
        if (port === undefined && record.port !== undefined) {
          port = parseConsolePort(record.port, "console.port");
        }
      }
    } catch {
      // Keep defaults while the user fixes an incomplete or invalid config.
    }
  }

  return {
    enabled: enabled ?? true,
    ...(port === undefined ? {} : { port }),
  };
}

function parseConsoleBoolean(raw: string | undefined, name: string): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new MonoAgentConfigError("invalid_env", `${name} must be true or false.`, { env: name });
}

function parseConsolePort(value: unknown, name: string): number | undefined {
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
    return undefined;
  }
  return parseTraceInteger(value, name, 0, 65_535);
}

export async function resolveAppTraceRegistryDir(input: MonoAgentAppConfigInput): Promise<string> {
  const envDir = input.env.MONO_AGENT_TRACE_REGISTRY_DIR?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(input.cwd, envDir);
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const registryDir = typeof json.traceability?.registryDir === "string" ? json.traceability.registryDir.trim() : "";
    if (registryDir.length > 0) {
      return resolve(input.cwd, registryDir);
    }
  } catch {
    // Fall through to the default below.
  }

  return resolve(homedir(), ".mono-agent", "trace-sources");
}

export async function resolveAppTraceSourceId(
  input: MonoAgentAppConfigInput,
  defaults?: AppTraceDefaults,
): Promise<string> {
  const envSourceId = input.env.MONO_AGENT_TRACE_SOURCE_ID?.trim();
  if (envSourceId !== undefined && envSourceId.length > 0) {
    return envSourceId;
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const sourceId = typeof json.traceability?.sourceId === "string" ? json.traceability.sourceId.trim() : "";
    if (sourceId.length > 0) {
      return sourceId;
    }
  } catch {
    // Use the deterministic cwd/config fallback below.
  }

  const hash = createHash("sha256")
    .update(resolve(input.cwd))
    .update("\0")
    .update(resolve(input.configPath))
    .digest("hex")
    .slice(0, 12);
  return `${defaults?.sourceIdPrefix ?? DEFAULT_TRACE_SOURCE_ID_PREFIX}-${hash}`;
}

export async function resolveAppTraceSourceLabel(
  input: MonoAgentAppConfigInput,
  defaults?: AppTraceDefaults,
): Promise<string> {
  const envLabel = input.env.MONO_AGENT_TRACE_SOURCE_LABEL?.trim();
  if (envLabel !== undefined && envLabel.length > 0) {
    return envLabel;
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const label = typeof json.traceability?.sourceLabel === "string" ? json.traceability.sourceLabel.trim() : "";
    if (label.length > 0) {
      return label;
    }
  } catch {
    // Keep the default label below.
  }

  return defaults?.sourceLabel ?? DEFAULT_TRACE_SOURCE_LABEL;
}

export async function resolveAppTraceHeartbeatMs(input: MonoAgentAppConfigInput): Promise<number> {
  return await resolveTraceInteger({
    input,
    envName: "MONO_AGENT_TRACE_HEARTBEAT_MS",
    jsonKey: "heartbeatMs",
    defaultValue: DEFAULT_TRACE_HEARTBEAT_MS,
    min: 250,
    max: 86_400_000,
  });
}

export async function resolveAppTraceStaleAfterMs(input: MonoAgentAppConfigInput): Promise<number> {
  return await resolveTraceInteger({
    input,
    envName: "MONO_AGENT_TRACE_STALE_AFTER_MS",
    jsonKey: "staleAfterMs",
    defaultValue: DEFAULT_TRACE_STALE_AFTER_MS,
    min: 1_000,
    max: 604_800_000,
  });
}

async function resolveTraceInteger(options: {
  readonly input: MonoAgentAppConfigInput;
  readonly envName: string;
  readonly jsonKey: "heartbeatMs" | "staleAfterMs";
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}): Promise<number> {
  const envValue = options.input.env[options.envName]?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return parseTraceInteger(envValue, options.envName, options.min, options.max);
  }

  try {
    const { json } = await readMonoAgentConfigJson(options.input.configPath);
    const value = json.traceability?.[options.jsonKey];
    if (value !== undefined) {
      return parseTraceInteger(value, `traceability.${options.jsonKey}`, options.min, options.max);
    }
  } catch {
    // Use the default while the user fixes an incomplete or invalid config.
  }

  return options.defaultValue;
}

function parseTraceInteger(value: unknown, name: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${name} must be an integer between ${min} and ${max}.`,
      { env: name, reason: "integer_range" },
    );
  }
  return parsed;
}
