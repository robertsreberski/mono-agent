import {
  defineFieldGroup,
  layerJsonOntoEnv,
  readBoolean,
  readChoice,
  readInteger,
  readJsonSection,
  readSettingsJson,
  readString,
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

const WEBHOOK_MODES: readonly WebhookInvocationMode[] = ["sync", "async"];

const invalidConfig = (message: string, details?: Record<string, unknown>): WebhookAdapterError =>
  new WebhookAdapterError("invalid_config", message, details);

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
  return {
    enabled: readBoolean(env.MONO_AGENT_WEBHOOK_ENABLED, "MONO_AGENT_WEBHOOK_ENABLED", DEFAULT_ENABLED, invalidConfig),
    host: readString(env.MONO_AGENT_WEBHOOK_HOST, DEFAULT_HOST),
    port: readInteger(env.MONO_AGENT_WEBHOOK_PORT, "MONO_AGENT_WEBHOOK_PORT", DEFAULT_PORT, invalidConfig, { min: 0, max: 65535 }),
    path: readString(env.MONO_AGENT_WEBHOOK_PATH, DEFAULT_PATH),
    allowNonLoopback: readBoolean(env.MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK, "MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK", false, invalidConfig),
    defaultMode: readChoice(env.MONO_AGENT_WEBHOOK_DEFAULT_MODE, "MONO_AGENT_WEBHOOK_DEFAULT_MODE", WEBHOOK_MODES, DEFAULT_MODE, invalidConfig),
    retentionMs: readInteger(env.MONO_AGENT_WEBHOOK_RETENTION_MS, "MONO_AGENT_WEBHOOK_RETENTION_MS", DEFAULT_RETENTION_MS, invalidConfig, { min: 1, max: 86_400_000 }),
    maxStoredRequests: readInteger(env.MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS, "MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS", DEFAULT_MAX_STORED_REQUESTS, invalidConfig, { min: 1, max: 10_000 }),
  };
}

export function redactWebhookAdapterConfig(config: WebhookAdapterConfig): RedactedWebhookAdapterConfig {
  return { ...config };
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
    { env: "MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK", value: section.allowNonLoopback, kind: "boolean" },
    { env: "MONO_AGENT_WEBHOOK_DEFAULT_MODE", value: section.defaultMode },
    { env: "MONO_AGENT_WEBHOOK_RETENTION_MS", value: section.retentionMs, kind: "integer" },
    { env: "MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS", value: section.maxStoredRequests, kind: "integer" },
  ]);
}
