import {
  defineFieldGroup,
  readSettingsJson,
} from "@mono-agent/settings";
import type { FieldGroup, SettingsJson } from "@mono-agent/settings";

import { WebhookAdapterError, type WebhookInvocationMode } from "./server.js";

export interface WebhookAdapterConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly allowNonLoopback: boolean;
  readonly defaultMode: WebhookInvocationMode;
  readonly retentionMs: number;
  readonly maxStoredRequests: number;
}

export type RedactedWebhookAdapterConfig = WebhookAdapterConfig;

export interface LoadWebhookAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const DEFAULT_ENABLED = false;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_PATH = "/webhook/invoke";
const DEFAULT_MODE: WebhookInvocationMode = "sync";
const DEFAULT_RETENTION_MS = 300_000;
const DEFAULT_MAX_STORED_REQUESTS = 100;

export const webhookFieldGroup: FieldGroup = defineFieldGroup({
  id: "webhook",
  label: "Webhook",
  description: "Optional HTTP webhook invocation adapter configuration.",
  fields: [
    {
      id: "webhook.enabled",
      label: "Enable webhook",
      description: "Expose an HTTP endpoint that can invoke the configured agent.",
      kind: "switch",
      path: ["webhook", "enabled"],
    },
    {
      id: "webhook.host",
      label: "Host",
      description: "Bind host. Defaults to 127.0.0.1.",
      kind: "string",
      placeholder: "127.0.0.1",
      path: ["webhook", "host"],
    },
    {
      id: "webhook.port",
      label: "Port",
      description: "Bind port. Use 0 to choose a free loopback port.",
      kind: "integer",
      min: 0,
      max: 65535,
      placeholder: "0",
      path: ["webhook", "port"],
    },
    {
      id: "webhook.path",
      label: "Path",
      description: "POST path for agent invocation.",
      kind: "string",
      placeholder: "/webhook/invoke",
      path: ["webhook", "path"],
    },
    {
      id: "webhook.allowNonLoopback",
      label: "Allow non-loopback",
      description: "Explicitly allow public/non-loopback binding.",
      kind: "switch",
      path: ["webhook", "allowNonLoopback"],
    },
    {
      id: "webhook.defaultMode",
      label: "Default mode",
      description: "Invocation mode used when the request body omits mode.",
      kind: "select",
      options: [
        { value: "sync", label: "sync" },
        { value: "async", label: "async" },
      ],
      path: ["webhook", "defaultMode"],
    },
    {
      id: "webhook.retentionMs",
      label: "Status retention",
      description: "How long async request status remains in memory.",
      kind: "integer",
      min: 1,
      max: 86_400_000,
      placeholder: "300000",
      path: ["webhook", "retentionMs"],
    },
    {
      id: "webhook.maxStoredRequests",
      label: "Max stored requests",
      description: "Maximum number of in-memory async statuses to retain.",
      kind: "integer",
      min: 1,
      max: 10_000,
      placeholder: "100",
      path: ["webhook", "maxStoredRequests"],
    },
  ],
});

export async function loadWebhookAdapterConfig(
  input: LoadWebhookAdapterConfigInput,
): Promise<WebhookAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerWebhookJsonOntoEnv(json, input.env);
  const defaultMode = readMode(env.MONO_AGENT_WEBHOOK_DEFAULT_MODE);
  return {
    enabled: readBoolean(env.MONO_AGENT_WEBHOOK_ENABLED, DEFAULT_ENABLED, "MONO_AGENT_WEBHOOK_ENABLED"),
    host: readString(env.MONO_AGENT_WEBHOOK_HOST, DEFAULT_HOST),
    port: readInteger(env.MONO_AGENT_WEBHOOK_PORT, DEFAULT_PORT, "MONO_AGENT_WEBHOOK_PORT", { min: 0, max: 65535 }),
    path: readString(env.MONO_AGENT_WEBHOOK_PATH, DEFAULT_PATH),
    allowNonLoopback: readBoolean(env.MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK, false, "MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK"),
    defaultMode,
    retentionMs: readInteger(env.MONO_AGENT_WEBHOOK_RETENTION_MS, DEFAULT_RETENTION_MS, "MONO_AGENT_WEBHOOK_RETENTION_MS", { min: 1, max: 86_400_000 }),
    maxStoredRequests: readInteger(env.MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS, DEFAULT_MAX_STORED_REQUESTS, "MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS", { min: 1, max: 10_000 }),
  };
}

export function redactWebhookAdapterConfig(config: WebhookAdapterConfig): RedactedWebhookAdapterConfig {
  return { ...config };
}

function layerWebhookJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readWebhookSection(json);
  const fromJson: Record<string, string | undefined> = {};
  setBoolean(fromJson, "MONO_AGENT_WEBHOOK_ENABLED", section.enabled);
  setString(fromJson, "MONO_AGENT_WEBHOOK_HOST", section.host);
  setInteger(fromJson, "MONO_AGENT_WEBHOOK_PORT", section.port);
  setString(fromJson, "MONO_AGENT_WEBHOOK_PATH", section.path);
  setBoolean(fromJson, "MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK", section.allowNonLoopback);
  setString(fromJson, "MONO_AGENT_WEBHOOK_DEFAULT_MODE", section.defaultMode);
  setInteger(fromJson, "MONO_AGENT_WEBHOOK_RETENTION_MS", section.retentionMs);
  setInteger(fromJson, "MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS", section.maxStoredRequests);

  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      layered[key] = value;
    }
  }
  return layered;
}

function readWebhookSection(json: SettingsJson): Record<string, unknown> {
  const section = json.webhook;
  if (section !== null && typeof section === "object" && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  return {};
}

function readString(raw: string | undefined, defaultValue: string): string {
  return normalizeOptionalString(raw) ?? defaultValue;
}

function readMode(raw: string | undefined): WebhookInvocationMode {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return DEFAULT_MODE;
  }
  if (normalized === "sync" || normalized === "async") {
    return normalized;
  }
  throw new WebhookAdapterError("invalid_config", "MONO_AGENT_WEBHOOK_DEFAULT_MODE must be sync or async.", {
    reason: normalized,
  });
}

function readBoolean(raw: string | undefined, defaultValue: boolean, envName: string): boolean {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new WebhookAdapterError("invalid_config", `${envName} must be true or false.`, { reason: normalized });
}

function readInteger(
  raw: string | undefined,
  defaultValue: number,
  envName: string,
  bounds: { readonly min: number; readonly max: number },
): number {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(normalized)) {
    throw new WebhookAdapterError("invalid_config", `${envName} must be an integer.`);
  }
  const value = Number(normalized);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new WebhookAdapterError("invalid_config", `${envName} must be between ${bounds.min} and ${bounds.max}.`);
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

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
