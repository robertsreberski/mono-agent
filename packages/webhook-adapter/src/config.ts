import { resolve } from "node:path";

import {
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readChoice,
  readInteger,
  readJsonSection,
  readSettingsJson,
  readString,
} from "@mono-agent/settings";
import type { SettingsJson } from "@mono-agent/settings";

import { loadWebhookEndpointsFromDirectory } from "./endpoints-dir.js";
import { normalizePath, WebhookAdapterError, type WebhookInvocationMode } from "./server.js";

/** One HTTP endpoint of the webhook server (shares the server's host + port). */
export interface WebhookEndpointConfig {
  readonly name: string;
  readonly path: string;
  readonly mode: WebhookInvocationMode;
  readonly enabled: boolean;
  /** Pre-instructions prepended to the incoming request text. Same role as a cron job's prompt. */
  readonly prompt?: string;
  readonly notify?: boolean;
  readonly notifyConversationId?: string;
  /** Per-endpoint runtime model override (e.g. `claude:claude-opus-4-8`). A request body `model` wins. */
  readonly model?: string;
  /** Per-endpoint reasoning effort override (e.g. `high`). A request body `effort` wins. */
  readonly effort?: string;
}

export interface WebhookAdapterConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly allowNonLoopback: boolean;
  readonly retentionMs: number;
  readonly maxStoredRequests: number;
  /** Wall-clock bound (ms) per webhook run. Omit to use the adapter default (20 min). */
  readonly maxRunMs?: number;
  readonly endpoints: readonly WebhookEndpointConfig[];
  /** Back-compat mirror of `endpoints[0].path`. */
  readonly path: string;
  /** Back-compat mirror of `endpoints[0].mode`. */
  readonly defaultMode: WebhookInvocationMode;
}

export type RedactedWebhookAdapterConfig = WebhookAdapterConfig;

export interface LoadWebhookAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
  /** Base directory the webhook endpoints folder resolves against (usually the app cwd). */
  readonly cwd?: string;
  /** Overrides the endpoints folder; defaults to `webhook.dir` / `MONO_AGENT_WEBHOOK_DIR` / `webhook`. */
  readonly dir?: string;
}

const DEFAULT_ENABLED = false;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_PATH = "/webhook/invoke";
const DEFAULT_MODE: WebhookInvocationMode = "sync";
const DEFAULT_RETENTION_MS = 300_000;
const DEFAULT_MAX_STORED_REQUESTS = 100;
const DEFAULT_WEBHOOK_DIR = "webhook";

const WEBHOOK_MODES: readonly WebhookInvocationMode[] = ["sync", "async"];

const invalidConfig = (message: string, details?: Record<string, unknown>): WebhookAdapterError =>
  new WebhookAdapterError("invalid_config", message, details);

export async function loadWebhookAdapterConfig(
  input: LoadWebhookAdapterConfigInput,
): Promise<WebhookAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerWebhookJsonOntoEnv(json, input.env);
  const enabled = readBoolean(env.MONO_AGENT_WEBHOOK_ENABLED, "MONO_AGENT_WEBHOOK_ENABLED", DEFAULT_ENABLED, invalidConfig);
  const host = readString(env.MONO_AGENT_WEBHOOK_HOST, DEFAULT_HOST);
  const port = readInteger(env.MONO_AGENT_WEBHOOK_PORT, "MONO_AGENT_WEBHOOK_PORT", DEFAULT_PORT, invalidConfig, { min: 0, max: 65535 });
  const allowNonLoopback = readBoolean(env.MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK, "MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK", false, invalidConfig);
  const defaultMode = readChoice(env.MONO_AGENT_WEBHOOK_DEFAULT_MODE, "MONO_AGENT_WEBHOOK_DEFAULT_MODE", WEBHOOK_MODES, DEFAULT_MODE, invalidConfig);
  const retentionMs = readInteger(env.MONO_AGENT_WEBHOOK_RETENTION_MS, "MONO_AGENT_WEBHOOK_RETENTION_MS", DEFAULT_RETENTION_MS, invalidConfig, { min: 1, max: 86_400_000 });
  const maxStoredRequests = readInteger(env.MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS, "MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS", DEFAULT_MAX_STORED_REQUESTS, invalidConfig, { min: 1, max: 10_000 });
  const maxRunMsRaw = normalizeOptionalString(env.MONO_AGENT_WEBHOOK_MAX_RUN_MS);
  const maxRunMs =
    maxRunMsRaw === undefined
      ? undefined
      : readInteger(maxRunMsRaw, "MONO_AGENT_WEBHOOK_MAX_RUN_MS", 0, invalidConfig, { min: 0, max: 86_400_000 });

  const configEndpoints = loadConfigEndpoints(json, env, defaultMode);
  const directoryEndpoints = await loadDirectoryEndpoints(json, input, defaultMode);
  const merged = mergeEndpoints(configEndpoints, directoryEndpoints);
  const endpoints = merged.length > 0 ? merged : [defaultEndpoint(defaultMode)];
  const primary = endpoints[0] ?? defaultEndpoint(defaultMode);

  return {
    enabled,
    host,
    port,
    allowNonLoopback,
    retentionMs,
    maxStoredRequests,
    ...(maxRunMs === undefined ? {} : { maxRunMs }),
    endpoints,
    path: primary.path,
    defaultMode: primary.mode,
  };
}

export function redactWebhookAdapterConfig(config: WebhookAdapterConfig): RedactedWebhookAdapterConfig {
  return { ...config, endpoints: config.endpoints.map((endpoint) => ({ ...endpoint })) };
}

/**
 * Endpoints defined inline in config: `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` (highest),
 * then the `webhook.endpoints` array, then the single legacy `webhook.path`/`prompt`
 * fields. Returns an empty list when nothing inline is configured (the webhook
 * folder may still add endpoints, and a default endpoint is synthesized when both
 * sources are empty).
 */
function loadConfigEndpoints(
  json: SettingsJson,
  env: Record<string, string | undefined>,
  defaultMode: WebhookInvocationMode,
): WebhookEndpointConfig[] {
  const endpointsJson = normalizeOptionalString(env.MONO_AGENT_WEBHOOK_ENDPOINTS_JSON);
  if (endpointsJson !== undefined) {
    return [...readEndpointsJson(endpointsJson, defaultMode)];
  }
  const section = readJsonSection(json, "webhook");
  if (section.endpoints !== undefined) {
    if (!Array.isArray(section.endpoints)) {
      throw invalidConfig("webhook.endpoints must be an array of endpoint objects.");
    }
    return section.endpoints.map((entry, index) => normalizeEndpointConfig(entry, index, defaultMode));
  }
  const path = normalizeOptionalString(env.MONO_AGENT_WEBHOOK_PATH);
  const prompt = normalizeOptionalString(env.MONO_AGENT_WEBHOOK_PROMPT);
  const notify = readBoolean(env.MONO_AGENT_WEBHOOK_NOTIFY, "MONO_AGENT_WEBHOOK_NOTIFY", false, invalidConfig);
  const notifyConversationId = normalizeOptionalString(env.MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID);
  const model = normalizeOptionalString(env.MONO_AGENT_WEBHOOK_MODEL);
  const effort = normalizeOptionalString(env.MONO_AGENT_WEBHOOK_EFFORT);
  if (
    path === undefined &&
    prompt === undefined &&
    !notify &&
    notifyConversationId === undefined &&
    model === undefined &&
    effort === undefined
  ) {
    return [];
  }
  return [{
    name: "default",
    path: normalizePath(path ?? DEFAULT_PATH),
    mode: defaultMode,
    enabled: true,
    ...(prompt === undefined ? {} : { prompt }),
    ...(notify ? { notify } : {}),
    ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }];
}

/**
 * Endpoints authored as `*.md` files in the webhook folder. Skipped unless a
 * base directory (`input.cwd`) is known, so a loader called without a host never
 * scans the process working directory implicitly.
 */
async function loadDirectoryEndpoints(
  json: SettingsJson,
  input: LoadWebhookAdapterConfigInput,
  defaultMode: WebhookInvocationMode,
): Promise<WebhookEndpointConfig[]> {
  if (input.cwd === undefined) {
    return [];
  }
  const section = readJsonSection(json, "webhook");
  if (section.dir !== undefined && typeof section.dir !== "string") {
    throw invalidConfig("webhook.dir must be a string.");
  }
  const dirName =
    normalizeOptionalString(input.dir) ??
    normalizeOptionalString(input.env.MONO_AGENT_WEBHOOK_DIR) ??
    asOptionalString(section.dir) ??
    DEFAULT_WEBHOOK_DIR;
  return await loadWebhookEndpointsFromDirectory(resolve(input.cwd, dirName), defaultMode);
}

/** Combine inline-config endpoints with folder endpoints; duplicate name or path is a hard error. */
function mergeEndpoints(
  configEndpoints: WebhookEndpointConfig[],
  directoryEndpoints: WebhookEndpointConfig[],
): WebhookEndpointConfig[] {
  const merged: WebhookEndpointConfig[] = [];
  const nameSource = new Map<string, string>();
  const pathSource = new Map<string, string>();
  const append = (endpoint: WebhookEndpointConfig, source: string): void => {
    const priorName = nameSource.get(endpoint.name);
    if (priorName !== undefined) {
      throw invalidConfig(`Duplicate webhook endpoint name "${endpoint.name}" from ${priorName} and ${source}.`, { name: endpoint.name });
    }
    const priorPath = pathSource.get(endpoint.path);
    if (priorPath !== undefined) {
      throw invalidConfig(`Duplicate webhook endpoint path "${endpoint.path}" from ${priorPath} and ${source}.`, { path: endpoint.path });
    }
    nameSource.set(endpoint.name, source);
    pathSource.set(endpoint.path, source);
    merged.push(endpoint);
  };
  for (const endpoint of configEndpoints) {
    append(endpoint, "config");
  }
  for (const endpoint of directoryEndpoints) {
    append(endpoint, "webhook folder");
  }
  return merged;
}

function defaultEndpoint(defaultMode: WebhookInvocationMode): WebhookEndpointConfig {
  return { name: "default", path: DEFAULT_PATH, mode: defaultMode, enabled: true };
}

function readEndpointsJson(value: string, defaultMode: WebhookInvocationMode): readonly WebhookEndpointConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invalidConfig("MONO_AGENT_WEBHOOK_ENDPOINTS_JSON must contain valid JSON.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    throw invalidConfig("MONO_AGENT_WEBHOOK_ENDPOINTS_JSON must be an array.");
  }
  return parsed.map((entry, index) => normalizeEndpointConfig(entry, index, defaultMode));
}

function normalizeEndpointConfig(
  entry: unknown,
  index: number,
  defaultMode: WebhookInvocationMode,
): WebhookEndpointConfig {
  if (!isRecord(entry)) {
    throw invalidConfig("Webhook endpoint entries must be objects.", { index });
  }
  const rawPath = asOptionalString(entry.path);
  if (rawPath === undefined) {
    throw invalidConfig("Webhook endpoints require a path.", { index });
  }
  const path = normalizePath(rawPath);
  const mode = readEndpointMode(entry.mode, index, defaultMode);
  const prompt = asOptionalString(entry.prompt);
  const notify = asOptionalBoolean(entry.notify, "webhook.endpoints[].notify", { index });
  const notifyConversationId = asOptionalString(entry.notifyConversationId);
  const model = asOptionalString(entry.model);
  const effort = asOptionalString(entry.effort);
  const name = asOptionalString(entry.name) ?? deriveEndpointName(path);
  const enabled = typeof entry.enabled === "boolean" ? entry.enabled : true;
  return {
    name,
    path,
    mode,
    enabled,
    ...(prompt === undefined ? {} : { prompt }),
    ...(notify === undefined ? {} : { notify }),
    ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function readEndpointMode(value: unknown, index: number, defaultMode: WebhookInvocationMode): WebhookInvocationMode {
  const mode = asOptionalString(value);
  if (mode === undefined) {
    return defaultMode;
  }
  if (mode !== "sync" && mode !== "async") {
    throw invalidConfig("Webhook endpoint mode must be sync or async.", { index });
  }
  return mode;
}

/** Default an endpoint name to the last path segment (e.g. `/webhook/results` → `results`). */
function deriveEndpointName(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "default";
}

function layerWebhookJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readJsonSection(json, "webhook");
  return layerJsonOntoEnv(env, [
    { env: "MONO_AGENT_WEBHOOK_ENABLED", value: section.enabled, kind: "boolean" },
    { env: "MONO_AGENT_WEBHOOK_HOST", value: section.host },
    { env: "MONO_AGENT_WEBHOOK_PORT", value: section.port, kind: "integer" },
    { env: "MONO_AGENT_WEBHOOK_PATH", value: section.path },
    { env: "MONO_AGENT_WEBHOOK_PROMPT", value: section.prompt },
    { env: "MONO_AGENT_WEBHOOK_NOTIFY", value: section.notify, kind: "boolean" },
    { env: "MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID", value: section.notifyConversationId },
    { env: "MONO_AGENT_WEBHOOK_MODEL", value: section.model },
    { env: "MONO_AGENT_WEBHOOK_EFFORT", value: section.effort },
    { env: "MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK", value: section.allowNonLoopback, kind: "boolean" },
    { env: "MONO_AGENT_WEBHOOK_DEFAULT_MODE", value: section.defaultMode },
    { env: "MONO_AGENT_WEBHOOK_RETENTION_MS", value: section.retentionMs, kind: "integer" },
    { env: "MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS", value: section.maxStoredRequests, kind: "integer" },
    { env: "MONO_AGENT_WEBHOOK_MAX_RUN_MS", value: section.maxRunMs, kind: "integer" },
  ]);
}

/** Trim a JSON value to a non-empty string, treating non-strings as absent. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function asOptionalBoolean(
  value: unknown,
  field: string,
  details: Record<string, unknown>,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw invalidConfig(`${field} must be a boolean.`, { ...details, value });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
