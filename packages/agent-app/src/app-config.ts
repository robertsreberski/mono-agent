import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  CORE_AGENT_FIELD_GROUPS,
  loadMonoAgentConfigWithSources,
  MonoAgentConfigError,
  readMonoAgentConfigJson,
} from "@mono-agent/config";
import type { MonoAgentConfig, ObservabilityExporterConfig } from "@mono-agent/config";
import type { FieldGroup } from "@mono-agent/settings";
import { a2aFieldGroup } from "@mono-agent/a2a-adapter";
import { cronFieldGroup } from "@mono-agent/cron-adapter";
import { openAIApiFieldGroup } from "@mono-agent/openai-api-adapter";
import { slackFieldGroup } from "@mono-agent/slack-adapter";
import { telegramFieldGroup } from "@mono-agent/telegram-adapter";
import { webhookFieldGroup } from "@mono-agent/webhook-adapter";
import { whatsappFieldGroup } from "@mono-agent/whatsapp-adapter";

import { selfCapabilitiesFieldGroup } from "./self-capabilities.js";

/**
 * Every settings group a config-first host exposes: the adapter-neutral core
 * config plus one group per communication channel.
 */
export const MONO_AGENT_APP_FIELD_GROUPS: readonly FieldGroup[] = [
  ...CORE_AGENT_FIELD_GROUPS,
  selfCapabilitiesFieldGroup,
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
 * file: observability and traceability must stay usable while the user is still
 * fixing their config, so they fall back to defaults instead of throwing on
 * unreadable JSON.
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

const DEFAULT_PHOENIX_ENDPOINT = "http://127.0.0.1:6006/v1/traces";
const DEFAULT_PHOENIX_TIMEOUT_MS = 5_000;
const OBSERVABILITY_EXPORTER_TYPES = ["phoenix"] as const;

/**
 * A validated observability exporter resolved for app startup/status/validate.
 * Mirrors {@link ObservabilityExporterConfig} but with the endpoint always
 * resolved (defaults applied) so callers never re-derive it.
 */
export type ResolvedExporter = ObservabilityExporterConfig & { readonly endpoint: string };

/**
 * Resolve observability exporters for the app: env-first
 * (`MONO_AGENT_OBSERVABILITY_EXPORTERS`, JSON array), then the
 * `observability.exporters` block of the config file, then `[]`. Like the other
 * app-level resolvers it tolerates an unreadable config file (returns `[]` so the
 * host stays usable while the user fixes their config), but it DOES throw
 * a {@link MonoAgentConfigError} for a present-but-invalid exporter shape so bad
 * config fails clearly before startup. No reachability probe runs here —
 * reachability is `validate`'s job (Phoenix may start after the agent).
 */
export async function resolveAppObservabilityExporters(
  input: MonoAgentAppConfigInput,
): Promise<readonly ResolvedExporter[]> {
  const envRaw = input.env.MONO_AGENT_OBSERVABILITY_EXPORTERS?.trim();
  if (envRaw !== undefined && envRaw.length > 0) {
    return parseExporters(parseExporterJson(envRaw), "MONO_AGENT_OBSERVABILITY_EXPORTERS");
  }

  let exportersJson: unknown;
  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    exportersJson = json.observability?.exporters;
  } catch {
    // Tolerate an unreadable config like the other resolvers.
    return [];
  }
  if (exportersJson === undefined) {
    return [];
  }
  return parseExporters(exportersJson, "observability.exporters");
}

function parseExporterJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new MonoAgentConfigError("invalid_env", "MONO_AGENT_OBSERVABILITY_EXPORTERS must contain valid JSON.", {
      env: "MONO_AGENT_OBSERVABILITY_EXPORTERS",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseExporters(value: unknown, source: string): readonly ResolvedExporter[] {
  if (!Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source} must be a JSON array.`, { env: source });
  }
  return value.map((entry, index) => parseExporter(entry, `${source}[${index}]`));
}

function parseExporter(value: unknown, source: string): ResolvedExporter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source} must be an object.`, { env: source });
  }
  const record = value as Record<string, unknown>;
  const rawType = typeof record.type === "string" ? record.type : undefined;
  if (rawType === undefined || !(OBSERVABILITY_EXPORTER_TYPES as readonly string[]).includes(rawType)) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${source}.type must be one of ${OBSERVABILITY_EXPORTER_TYPES.join(", ")}.`,
      { env: source },
    );
  }
  const type = rawType as (typeof OBSERVABILITY_EXPORTER_TYPES)[number];

  const endpoint = record.endpoint === undefined
    ? DEFAULT_PHOENIX_ENDPOINT
    : validateExporterEndpoint(record.endpoint, source);

  const headers = parseExporterHeaders(record.headers, source);

  const includeSensitiveData = record.includeSensitiveData === undefined
    ? false
    : typeof record.includeSensitiveData === "boolean"
      ? record.includeSensitiveData
      : (() => {
          throw new MonoAgentConfigError("invalid_env", `${source}.includeSensitiveData must be true or false.`, {
            env: source,
          });
        })();

  const timeoutMs = record.timeoutMs === undefined
    ? DEFAULT_PHOENIX_TIMEOUT_MS
    : validateExporterTimeout(record.timeoutMs, source);

  return {
    type,
    endpoint,
    ...(headers === undefined ? {} : { headers }),
    includeSensitiveData,
    timeoutMs,
  };
}

/**
 * Derive the Phoenix app base URL (origin) from an OTLP traces endpoint so the
 * CLI/status can point operators at the trace UI — e.g.
 * `http://127.0.0.1:6006/v1/traces` -> `http://127.0.0.1:6006`. Returns
 * undefined when the endpoint is not a parseable URL. Note: Phoenix does not
 * return a stable per-run trace URL from the OTLP ingest endpoint, so callers
 * print only the app base URL plus run identifiers.
 */
export function phoenixAppBaseUrl(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).origin;
  } catch {
    return undefined;
  }
}

function validateExporterEndpoint(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MonoAgentConfigError("invalid_env", `${source}.endpoint must be a non-empty string.`, { env: source });
  }
  try {
    // Shape-only validation — never performs a request (reachability is `validate`'s job).
    new URL(value);
  } catch {
    throw new MonoAgentConfigError("invalid_env", `${source}.endpoint must be a valid URL.`, { env: source });
  }
  return value;
}

function parseExporterHeaders(value: unknown, source: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_env", `${source}.headers must be an object.`, { env: source });
  }
  const out: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string" || headerValue.length === 0) {
      throw new MonoAgentConfigError("invalid_env", `${source}.headers.${key} must be a non-empty string.`, {
        env: source,
      });
    }
    out[key] = headerValue;
  }
  return out;
}

function validateExporterTimeout(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${source}.timeoutMs must be an integer between 1 and 60000.`,
      { env: source },
    );
  }
  return value;
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
