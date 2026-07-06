import type { JsonEnvFieldSpec, SettingsJsonValue } from "@mono-agent/agent-contracts";
import { CONFIG_ENV_KEYS } from "@mono-agent/config";
import type { ConfigViewFieldId, MonoAgentConfigJson } from "@mono-agent/config";
import { CRON_CONFIG_FIELDS } from "@mono-agent/cron-adapter";
import { OPENAI_API_CONFIG_FIELDS } from "@mono-agent/openai-api-adapter";
import { LIVE_CONFIG_FIELDS, TUI_CONFIG_FIELDS } from "@mono-agent/operator-adapter";
import { SLACK_CONFIG_FIELDS } from "@mono-agent/slack-adapter";
import { TELEGRAM_CONFIG_FIELDS } from "@mono-agent/telegram-adapter";
import { WEBHOOK_CONFIG_FIELDS } from "@mono-agent/webhook-adapter";

export const MONO_AGENT_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/robertsreberski/mono-agent/main/packages/agent-app/schema/mono-agent.config.schema.json";

const CORE_FIELDS: readonly ConfigReferenceField[] = Object.entries(CONFIG_ENV_KEYS).map(([jsonPath, env]) =>
  referenceField({
    jsonPath,
    env,
    type: inferType(jsonPath),
    defaultLabel: defaultLabelFor(jsonPath),
    defaultValue: defaultValueFor(jsonPath),
    example: exampleFor(jsonPath),
    description: descriptionFor(jsonPath),
  }),
);

const CHANNEL_FIELD_GROUPS: readonly (readonly JsonEnvFieldSpec[])[] = [
  TELEGRAM_CONFIG_FIELDS,
  SLACK_CONFIG_FIELDS,
  WEBHOOK_CONFIG_FIELDS,
  OPENAI_API_CONFIG_FIELDS,
  CRON_CONFIG_FIELDS,
  TUI_CONFIG_FIELDS,
  LIVE_CONFIG_FIELDS,
];

const CHANNEL_FIELDS: readonly ConfigReferenceField[] = CHANNEL_FIELD_GROUPS.flatMap((fields) =>
  fields.map((field) =>
    referenceField({
      jsonPath: field.id,
      env: field.env,
      type: typeFromKind(field.kind, field.id),
      defaultLabel: defaultLabelFor(field.id),
      defaultValue: defaultValueFor(field.id),
      example: exampleFor(field.id),
      description: descriptionFor(field.id),
      secret: field.secret === true,
    }),
  ),
);

const APP_FIELDS: readonly ConfigReferenceField[] = [
  {
    jsonPath: "interaction.bridge.host",
    env: "MONO_AGENT_INTERACTION_BRIDGE_HOST",
    type: "string",
    defaultLabel: "127.0.0.1",
    defaultValue: "127.0.0.1",
    example: "127.0.0.1",
    description: "Loopback host for the app-owned ask_user/tool-progress bridge.",
  },
  {
    jsonPath: "interaction.bridge.port",
    env: "MONO_AGENT_INTERACTION_BRIDGE_PORT",
    type: "integer",
    defaultLabel: "0",
    defaultValue: 0,
    example: 0,
    description: "Bridge port. 0 chooses an ephemeral port.",
  },
  {
    jsonPath: "interaction.askUser.timeoutMs",
    env: "MONO_AGENT_ASK_USER_TIMEOUT_MS",
    type: "integer",
    defaultLabel: "600000",
    defaultValue: 600_000,
    example: 600_000,
    description: "Maximum wait for one ask_user question.",
  },
  {
    jsonPath: "interaction.progress.enabled",
    env: "MONO_AGENT_PROGRESS_ENABLED",
    type: "boolean",
    defaultLabel: "true",
    defaultValue: true,
    example: true,
    description: "Whether tool progress posts are relayed to channel status messages.",
  },
  {
    jsonPath: "channels.plugins",
    env: "--",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ package: "@mono-agent/whatsapp-adapter", config: { enabled: true } }],
    description: "External channel plugin envelopes loaded by package name.",
  },
  {
    jsonPath: "cron.jobs",
    env: "MONO_AGENT_CRON_JOBS_JSON",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ id: "daily", expression: "0 8 * * *", prompt: "Summarize the overnight queue." }],
    description: "Inline scheduled jobs. Folder-based cron jobs still merge from cron.dir.",
  },
  {
    jsonPath: "webhook.endpoints",
    env: "MONO_AGENT_WEBHOOK_ENDPOINTS_JSON",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ id: "triage", path: "/webhook/triage", prompt: "Triage this payload." }],
    description: "Additional named webhook endpoints beyond webhook.path.",
  },
  {
    jsonPath: "slack.shortcuts",
    env: "--",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ callbackId: "triage", prompt: "Triage this Slack request." }],
    description: "Slack shortcut definitions handled by the Slack adapter.",
  },
  {
    jsonPath: "slack.homeTab",
    env: "--",
    type: "object",
    defaultLabel: "unset",
    example: { enabled: true },
    description: "Slack app home tab configuration.",
  },
  {
    jsonPath: "telegram.commands",
    env: "--",
    type: "array",
    defaultLabel: "[]",
    defaultValue: [],
    example: [{ command: "status", prompt: "Report current status." }],
    description: "Telegram command definitions handled by the Telegram adapter.",
  },
  {
    jsonPath: "telegram.reactions",
    env: "MONO_AGENT_TELEGRAM_REACTIONS",
    type: "object",
    defaultLabel: "unset",
    example: { working: true, done: true, error: true },
    description: "Telegram lifecycle reactions. The env override is boolean and toggles all states.",
  },
  {
    jsonPath: "telegram.quietHours",
    env: "--",
    type: "object",
    defaultLabel: "unset",
    example: { timezone: "Europe/Amsterdam", start: "22:00", end: "07:00" },
    description: "Quiet-hours rules for Telegram notifications.",
  },
];

export interface ConfigReferenceField {
  readonly jsonPath: string;
  readonly env: string;
  readonly type: ConfigReferenceType;
  readonly defaultLabel: string;
  readonly defaultValue?: SettingsJsonValue;
  readonly example: SettingsJsonValue;
  readonly description: string;
  readonly secret?: boolean;
}

type ConfigReferenceType = "string" | "integer" | "boolean" | "string[]" | "object" | "array";

interface JsonSchema {
  readonly [key: string]: unknown;
}

function referenceField(input: Omit<ConfigReferenceField, "defaultValue" | "secret"> & {
  readonly defaultValue?: SettingsJsonValue | undefined;
  readonly secret?: boolean | undefined;
}): ConfigReferenceField {
  return {
    jsonPath: input.jsonPath,
    env: input.env,
    type: input.type,
    defaultLabel: input.defaultLabel,
    example: input.example,
    description: input.description,
    ...(input.defaultValue === undefined ? {} : { defaultValue: input.defaultValue }),
    ...(input.secret === true ? { secret: true } : {}),
  };
}

export function monoAgentConfigWithSchema(config: MonoAgentConfigJson): MonoAgentConfigJson {
  return { $schema: MONO_AGENT_CONFIG_SCHEMA_URL, ...config } as MonoAgentConfigJson;
}

export function allConfigReferenceFields(): readonly ConfigReferenceField[] {
  return [...CORE_FIELDS, ...APP_FIELDS, ...CHANNEL_FIELDS];
}

export function buildMonoAgentConfigSchema(): JsonSchema {
  const root: Record<string, JsonSchema> = {};
  for (const field of allConfigReferenceFields()) {
    setSchemaPath(root, field.jsonPath.split("."), schemaForField(field));
  }
  setRequired(root, ["runtime"], ["model"]);
  setRequired(root, ["context"], ["identityPath"]);
  setSchemaPath(root, ["channels", "plugins"], {
    type: "array",
    description: "External channel plugins loaded by package name.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["package"],
      properties: {
        package: { type: "string", description: "Package name exporting createChannelDriver(options)." },
        id: { type: "string", description: "Optional channel id override." },
        label: { type: "string", description: "Optional operator-facing label." },
        config: { type: "object", description: "Plugin-owned config payload.", additionalProperties: true },
      },
    },
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: MONO_AGENT_CONFIG_SCHEMA_URL,
    title: "mono-agent.config.json",
    type: "object",
    required: ["runtime", "context"],
    additionalProperties: false,
    properties: {
      $schema: { type: "string" },
      ...root,
    },
  };
}

export function buildGeneratedConfigReferenceMarkdown(): string {
  const rows = allConfigReferenceFields()
    .slice()
    .sort((a, b) => a.jsonPath.localeCompare(b.jsonPath))
    .map((field) => `| \`${field.jsonPath}\` | \`${field.type}\` | \`${field.env}\` | ${escapeCell(field.defaultLabel)} | \`${jsonInline(field.example)}\` | ${escapeCell(field.description)} |`)
    .join("\n");
  return `---
title: "Generated config reference"
sidebar:
  order: 4
---

# Generated config reference

This page is generated from the same config field registries that power \`mono-agent config\`, recipe output, and the JSON Schema. Do not edit this table by hand; run \`pnpm run generate:config-reference\`.

Schema: \`${MONO_AGENT_CONFIG_SCHEMA_URL}\`

| JSON key | Type | Env override | Default | Example | Notes |
| --- | --- | --- | --- | --- | --- |
${rows}

## Plugin channels

\`channels.plugins[]\` entries are intentionally open at \`config\`: the plugin package owns that nested payload. The host validates the plugin envelope (\`package\`, optional \`id\`, optional \`label\`, and \`config\`) and each loaded plugin reports its own config warnings.
`;
}

export function findUnknownAppConfigWarnings(json: object): readonly string[] {
  return findUnknownJsonKeyWarnings(json, {
    knownPaths: [
      ...allConfigReferenceFields().map((field) => field.jsonPath),
      "channels.plugins",
      // Removed-but-tolerated keys are reported by findRemovedConfigWarnings.
      "memory.reflection",
      "memory.migration",
    ],
    permissivePaths: [
      "channels.plugins",
      "providers.local",
      "memory.reflection",
      "memory.migration",
      "observability.exporters",
      "cron.jobs",
      "webhook.endpoints",
      "slack.shortcuts",
      "slack.homeTab",
      "telegram.commands",
      "telegram.reactions",
      "telegram.quietHours",
    ],
  });
}

function findUnknownJsonKeyWarnings(
  json: object,
  options: {
    readonly knownPaths: readonly string[];
    readonly permissivePaths: readonly string[];
  },
): readonly string[] {
  const known = new Set(options.knownPaths);
  const containers = new Set<string>();
  for (const path of options.knownPaths) {
    const parts = path.split(".");
    for (let i = 1; i < parts.length; i += 1) {
      containers.add(parts.slice(0, i).join("."));
    }
  }
  const permissive = new Set(options.permissivePaths);
  const warnings: string[] = [];
  walkObject(json as Record<string, unknown>, "");
  return warnings;

  function walkObject(record: Record<string, unknown>, prefix: string): void {
    for (const [key, value] of Object.entries(record)) {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      if (path === "$schema") {
        continue;
      }
      if (isUnderPermissivePath(path, permissive)) {
        continue;
      }
      if (!known.has(path) && !containers.has(path)) {
        warnings.push(`[WARN] Unknown config key ${path} in mono-agent.config.json - it is ignored.`);
        continue;
      }
      if (isPlainObject(value)) {
        walkObject(value, path);
      }
    }
  }
}

function isUnderPermissivePath(path: string, permissive: ReadonlySet<string>): boolean {
  for (const prefix of permissive) {
    if (path === prefix || path.startsWith(`${prefix}.`)) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setSchemaPath(root: Record<string, JsonSchema>, parts: readonly string[], schema: JsonSchema): void {
  const [head, ...tail] = parts;
  if (head === undefined) {
    return;
  }
  if (tail.length === 0) {
    root[head] = schema;
    return;
  }
  const existing = root[head];
  const objectSchema = isSchemaObject(existing) ? existing : { type: "object", additionalProperties: false, properties: {} };
  const properties = objectSchema.properties as Record<string, JsonSchema>;
  setSchemaPath(properties, tail, schema);
  root[head] = objectSchema;
}

function setRequired(root: Record<string, JsonSchema>, parts: readonly string[], required: readonly string[]): void {
  const schema = schemaAt(root, parts);
  if (schema !== undefined) {
    (schema as Record<string, unknown>).required = required;
  }
}

function schemaAt(root: Record<string, JsonSchema>, parts: readonly string[]): JsonSchema | undefined {
  const [head, ...tail] = parts;
  if (head === undefined) {
    return undefined;
  }
  const schema = root[head];
  if (schema === undefined || tail.length === 0) {
    return schema;
  }
  if (!isSchemaObject(schema)) {
    return undefined;
  }
  return schemaAt(schema.properties, tail);
}

function isSchemaObject(value: unknown): value is JsonSchema & { properties: Record<string, JsonSchema> } {
  return isPlainObject(value) && isPlainObject(value.properties);
}

function schemaForField(field: ConfigReferenceField): JsonSchema {
  const schema: Record<string, unknown> = {
    description: field.description,
    examples: [field.example],
  };
  switch (field.type) {
    case "integer":
      schema.type = "integer";
      break;
    case "boolean":
      schema.type = "boolean";
      break;
    case "string[]":
      schema.type = "array";
      schema.items = { type: "string" };
      break;
    case "array":
      schema.type = "array";
      schema.items = arrayItemSchemaForField(field);
      break;
    case "object":
      schema.type = "object";
      schema.additionalProperties = true;
      break;
    case "string":
    default:
      schema.type = "string";
      break;
  }
  if (field.defaultValue !== undefined) {
    schema.default = field.defaultValue;
  }
  return schema;
}

function arrayItemSchemaForField(field: ConfigReferenceField): JsonSchema {
  if (field.jsonPath === "cron.jobs") {
    return {
      type: "object",
      additionalProperties: true,
      required: ["id", "expression", "prompt"],
      properties: {
        id: { type: "string" },
        enabled: { type: "boolean" },
        expression: { type: "string" },
        timezone: { type: "string" },
        prompt: { type: "string" },
        conversationId: { type: "string" },
        maxRunMs: { type: "integer" },
        notify: { type: "boolean" },
        notifyConversationId: { type: "string" },
        notifyFailureCooldownHours: { type: "integer" },
        model: { type: "string" },
        effort: { type: "string" },
      },
    };
  }
  if (field.jsonPath === "webhook.endpoints") {
    return {
      type: "object",
      additionalProperties: true,
      required: ["path"],
      properties: {
        name: { type: "string" },
        path: { type: "string" },
        mode: { enum: ["sync", "async"] },
        enabled: { type: "boolean" },
        prompt: { type: "string" },
        notify: { type: "boolean" },
        notifyConversationId: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
      },
    };
  }
  return { type: "object", additionalProperties: true };
}

function typeFromKind(kind: JsonEnvFieldSpec["kind"], id: string): ConfigReferenceType {
  if (kind === "boolean") {
    return "boolean";
  }
  if (kind === "integer") {
    return "integer";
  }
  if (kind === "csv") {
    return "string[]";
  }
  return inferType(id);
}

function inferType(id: string): ConfigReferenceType {
  if (id.endsWith("Models") || id.endsWith("Tools") || id.endsWith("Roots") || id.endsWith("allowlist") || id.endsWith("denyWrite") || id.endsWith("selectedSkills") || id.endsWith("Ids") || id.endsWith("Aliases")) {
    return "string[]";
  }
  if (id.endsWith("enabled") || id.endsWith("allowAllChats") || id.endsWith("allowAllChannels") || id.endsWith("allowNonLoopback") || id.endsWith("dryRun") || id.endsWith("globalDiscovery") || id.endsWith("rolloverNotice") || id.endsWith("isolateProactive") || id.endsWith("unsafeAllowHostProcess") || id.endsWith("trace") || id.endsWith("exposeMcpServer")) {
    return "boolean";
  }
  if (/(Ms|Bytes|Count|Days|Turns|Retries|Delay|port|dim|threshold|Hours|Runs)$/iu.test(id) || id.endsWith(".port")) {
    return "integer";
  }
  if (id === "providers.local" || id === "observability.exporters") {
    return "array";
  }
  return "string";
}

function defaultLabelFor(id: string): string {
  const value = defaultValueFor(id);
  if (value !== undefined) {
    return jsonInline(value);
  }
  if (id === "runtime.model" || id === "context.identityPath") {
    return "required";
  }
  return "unset";
}

function defaultValueFor(id: string): SettingsJsonValue | undefined {
  const defaults: Record<string, SettingsJsonValue> = {
    "runtime.executionMode": "inferred",
    "runtime.workspace": ".",
    "runtime.session.mode": "continuous",
    "runtime.session.idleTimeoutMs": 1_800_000,
    "runtime.session.rollover": "none",
    "runtime.session.rolloverNotice": false,
    "runtime.session.isolateProactive": false,
    "context.selectedSkills": [],
    "context.skillMaxBytes": 48_000,
    "context.skillDisclosure": "full",
    "memory.backend": "bujo",
    "memory.maxBytes": 64_000,
    "memory.writeMode": "append-host-summary",
    "memory.supermemory.timeoutMs": 10_000,
    "memory.supermemory.exposeMcpServer": false,
    "memory.embeddings.timeoutMs": 10_000,
    "memory.embeddings.circuitBreaker.failureThreshold": 3,
    "memory.embeddings.circuitBreaker.cooldownMs": 30_000,
    "memory.llm.trace": true,
    "memory.llm.timeoutMs": 60_000,
    "memory.consolidation.enabled": true,
    "memory.consolidation.cron": "0 */2 * * *",
    "tools.allowedTools": [],
    "tools.disallowedTools": [],
    "tools.mcpCallTimeoutMs": 120_000,
    "tools.mcpCallMaxTotalTimeoutMs": 2_700_000,
    "sandbox.network.mode": "none",
    "sandbox.fallback": "fail-closed",
    "sandbox.unsafeAllowHostProcess": false,
    "artifacts.dir": ".mono-agent/artifacts",
    "artifacts.retention.maxAgeDays": 365,
    "artifacts.retention.maxCount": 50_000,
    "artifacts.retention.dryRun": false,
    "artifacts.memoryRetention.maxAgeDays": 7,
    "artifacts.memoryRetention.maxCount": 5_000,
    "artifacts.memoryRetention.dryRun": false,
    "traceability.registryDir": ".mono-agent/trace-sources",
    "traceability.heartbeatMs": 10_000,
    "traceability.staleAfterMs": 30_000,
    "traceability.globalDiscovery": true,
    "providers.piNative.piMaxRetries": 2,
    "providers.piNative.maxRetryDelayMs": 60_000,
    "telegram.enabled": false,
    "telegram.allowAllChats": false,
    "slack.enabled": false,
    "slack.allowAllChannels": false,
    "slack.stripMentionText": false,
    "webhook.enabled": false,
    "webhook.host": "127.0.0.1",
    "webhook.port": 0,
    "webhook.path": "/webhook/invoke",
    "webhook.dir": "webhook",
    "webhook.defaultMode": "sync",
    "webhook.retentionMs": 300_000,
    "webhook.maxStoredRequests": 100,
    "cron.enabled": false,
    "cron.dir": "cron",
    "cron.timezone": "UTC",
    "cron.notify": false,
    "cron.notifyFailureCooldownHours": 6,
    "openaiApi.enabled": false,
    "openaiApi.host": "127.0.0.1",
    "openaiApi.port": 0,
    "openaiApi.basePath": "/v1",
    "openaiApi.allowNonLoopback": false,
    "openaiApi.modelId": "agent",
    "tui.enabled": true,
    "tui.host": "127.0.0.1",
    "tui.port": 0,
    "tui.basePath": "/tui",
    "tui.allowNonLoopback": false,
    "live.enabled": true,
    "live.host": "127.0.0.1",
    "live.port": 0,
    "live.basePath": "/live",
    "live.allowNonLoopback": false,
  };
  return defaults[id];
}

function exampleFor(id: string): SettingsJsonValue {
  const examples: Record<string, SettingsJsonValue> = {
    "runtime.model": "claude:claude-sonnet-4-6",
    "runtime.fallbackModels": ["pi:ollama:gemma4:31b"],
    "runtime.effort": "medium",
    "runtime.permissionMode": "default",
    "context.identityPath": "./IDENTITY.md",
    "memory.mode": "journal",
    "memory.path": "./.mono-agent/memory",
    "memory.embeddings.provider": "ollama",
    "memory.embeddings.model": "nomic-embed-text",
    "memory.llm.provider": "agent-host",
    "memory.llm.model": "claude:claude-sonnet-4-6",
    "sandbox.mode": "native",
    "traceability.sourceId": "my-agent",
    "traceability.sourceLabel": "My Agent",
    "providers.piAuthPath": "~/.pi/agent/auth.json",
    "telegram.botToken": "env:MONO_AGENT_TELEGRAM_BOT_TOKEN",
    "slack.botToken": "env:MONO_AGENT_SLACK_BOT_TOKEN",
    "slack.appToken": "env:MONO_AGENT_SLACK_APP_TOKEN",
    "openaiApi.apiKey": "env:MONO_AGENT_OPENAI_API_KEY",
  };
  if (examples[id] !== undefined) {
    return examples[id];
  }
  if (id.endsWith("enabled") || inferType(id) === "boolean") {
    return true;
  }
  if (inferType(id) === "integer") {
    return defaultValueFor(id) ?? 1;
  }
  if (inferType(id) === "string[]") {
    return id.endsWith("Tools") ? ["Read", "Grep"] : ["example"];
  }
  if (inferType(id) === "array") {
    return [];
  }
  return String(defaultValueFor(id) ?? "example");
}

function descriptionFor(id: string): string {
  const section = id.split(".")[0] ?? "config";
  const name = id.split(".").slice(1).join(".");
  if (id.includes("apiKey") || id.includes("Token")) {
    return `Secret value for ${id}; prefer the env override.`;
  }
  if (id.endsWith("enabled")) {
    return `Enables the ${section} capability.`;
  }
  return `Configures ${name.length > 0 ? name : id} for the ${section} section.`;
}

function jsonInline(value: SettingsJsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|");
}
