import {
  defineFieldGroup,
  readSettingsJson,
} from "@mono-agent/settings";
import type { FieldGroup, SettingsJson } from "@mono-agent/settings";

export interface SlackAdapterConfig {
  readonly botToken: string;
  readonly appToken: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
  readonly botUserIds: readonly string[];
  readonly mentionTextAliases: readonly string[];
  readonly stripMentionText: boolean;
}

export interface RedactedSlackAdapterConfig {
  readonly botToken: { readonly present: boolean; readonly redacted: true };
  readonly appToken: { readonly present: boolean; readonly redacted: true };
  readonly allowedChannelIds: { readonly count: number };
  readonly allowAllChannels: boolean;
  readonly botUserIds: { readonly count: number };
  readonly mentionTextAliases: { readonly count: number };
  readonly stripMentionText: boolean;
}

export type SlackAdapterConfigErrorCode =
  | "missing_required_config"
  | "invalid_config";

export interface SlackAdapterConfigErrorDetails {
  readonly code?: SlackAdapterConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class SlackAdapterConfigError extends Error {
  readonly code: SlackAdapterConfigErrorCode;
  readonly details: SlackAdapterConfigErrorDetails;

  constructor(
    code: SlackAdapterConfigErrorCode,
    message: string,
    details: SlackAdapterConfigErrorDetails = {},
  ) {
    super(message);
    this.name = "SlackAdapterConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface LoadSlackAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

export const slackFieldGroup: FieldGroup = defineFieldGroup({
  id: "slack",
  label: "Slack",
  description: "Optional Slack Socket Mode adapter configuration. Tokens are write-only.",
  fields: [
    {
      id: "slack.botToken",
      label: "Bot token",
      description: "Slack bot token used for chat.postMessage and chat.update.",
      kind: "secret",
      path: ["slack", "botToken"],
    },
    {
      id: "slack.appToken",
      label: "App token",
      description: "Slack app-level token with connections:write for Socket Mode.",
      kind: "secret",
      path: ["slack", "appToken"],
    },
    {
      id: "slack.allowedChannelIds",
      label: "Allowed channel IDs",
      description: "Comma-separated Slack channel or DM IDs the adapter may respond to.",
      kind: "csv",
      placeholder: "D123456, C123456",
      path: ["slack", "allowedChannelIds"],
    },
    {
      id: "slack.allowAllChannels",
      label: "Allow all channels",
      description: "Explicitly permit every channel delivered to the app.",
      kind: "switch",
      path: ["slack", "allowAllChannels"],
    },
    {
      id: "slack.botUserIds",
      label: "Bot user IDs",
      description: "Comma-separated Slack user IDs that should count as this bot.",
      kind: "csv",
      placeholder: "U123456",
      path: ["slack", "botUserIds"],
    },
    {
      id: "slack.mentionTextAliases",
      label: "Mention aliases",
      description: "Comma-separated mention text aliases to strip before runtime calls.",
      kind: "csv",
      placeholder: "@mono, Mono Agent",
      path: ["slack", "mentionTextAliases"],
    },
    {
      id: "slack.stripMentionText",
      label: "Strip mention text",
      description: "Remove configured bot mentions and aliases before sending text to the responder.",
      kind: "switch",
      path: ["slack", "stripMentionText"],
    },
  ],
});

export async function loadSlackAdapterConfig(
  input: LoadSlackAdapterConfigInput,
): Promise<SlackAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerSlackJsonOntoEnv(json, input.env);
  const botToken = readRequired(env, "MONO_AGENT_SLACK_BOT_TOKEN");
  const appToken = readRequired(env, "MONO_AGENT_SLACK_APP_TOKEN");
  const allowedChannelIds = readCsv(env.MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS);
  const allowAllChannels = readBoolean(env.MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS, false, "MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS");
  const botUserIds = readCsv(env.MONO_AGENT_SLACK_BOT_USER_IDS);
  const mentionTextAliases = readCsv(env.MONO_AGENT_SLACK_MENTION_TEXT_ALIASES);
  const stripMentionText = readBoolean(
    env.MONO_AGENT_SLACK_STRIP_MENTION_TEXT,
    botUserIds.length > 0 || mentionTextAliases.length > 0,
    "MONO_AGENT_SLACK_STRIP_MENTION_TEXT",
  );

  if (!allowAllChannels && allowedChannelIds.length === 0) {
    throw new SlackAdapterConfigError(
      "missing_required_config",
      "Slack adapter requires MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS or MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS=true.",
      { env: "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS" },
    );
  }

  return {
    botToken,
    appToken,
    allowedChannelIds,
    allowAllChannels,
    botUserIds,
    mentionTextAliases,
    stripMentionText,
  };
}

export function redactSlackAdapterConfig(
  config: SlackAdapterConfig,
): RedactedSlackAdapterConfig {
  return {
    botToken: { present: config.botToken.length > 0, redacted: true },
    appToken: { present: config.appToken.length > 0, redacted: true },
    allowedChannelIds: { count: config.allowedChannelIds.length },
    allowAllChannels: config.allowAllChannels,
    botUserIds: { count: config.botUserIds.length },
    mentionTextAliases: { count: config.mentionTextAliases.length },
    stripMentionText: config.stripMentionText,
  };
}

function layerSlackJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readSlackSection(json);
  const fromJson: Record<string, string | undefined> = {};
  if (typeof section.botToken === "string") {
    fromJson.MONO_AGENT_SLACK_BOT_TOKEN = section.botToken;
  }
  if (typeof section.appToken === "string") {
    fromJson.MONO_AGENT_SLACK_APP_TOKEN = section.appToken;
  }
  if (Array.isArray(section.allowedChannelIds)) {
    fromJson.MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS = section.allowedChannelIds
      .filter((value): value is string => typeof value === "string")
      .join(",");
  }
  if (typeof section.allowAllChannels === "boolean") {
    fromJson.MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS = section.allowAllChannels ? "true" : "false";
  }
  if (Array.isArray(section.botUserIds)) {
    fromJson.MONO_AGENT_SLACK_BOT_USER_IDS = section.botUserIds
      .filter((value): value is string => typeof value === "string")
      .join(",");
  }
  if (Array.isArray(section.mentionTextAliases)) {
    fromJson.MONO_AGENT_SLACK_MENTION_TEXT_ALIASES = section.mentionTextAliases
      .filter((value): value is string => typeof value === "string")
      .join(",");
  }
  if (typeof section.stripMentionText === "boolean") {
    fromJson.MONO_AGENT_SLACK_STRIP_MENTION_TEXT = section.stripMentionText ? "true" : "false";
  }

  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      layered[key] = value;
    }
  }
  return layered;
}

function readSlackSection(json: SettingsJson): Record<string, unknown> {
  const section = json.slack;
  if (section !== null && typeof section === "object" && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  return {};
}

function readRequired(env: Record<string, string | undefined>, name: string): string {
  const value = normalizeOptionalString(env[name]);
  if (value === undefined) {
    throw new SlackAdapterConfigError("missing_required_config", `${name} is required.`, { env: name });
  }
  return value;
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

function readBoolean(
  raw: string | undefined,
  defaultValue: boolean,
  envName: string,
): boolean {
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
  throw new SlackAdapterConfigError(
    "invalid_config",
    `${envName} must be true or false.`,
    { env: envName },
  );
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
