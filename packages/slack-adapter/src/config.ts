import {
  defineFieldGroup,
  layerJsonOntoEnv,
  readBoolean,
  readCsv,
  readJsonSection,
  readRequired,
  readSettingsJson,
  redactedSecret,
} from "@mono-agent/settings";
import type {
  FieldGroup,
  RedactedSecretValue,
  SettingsJson,
} from "@mono-agent/settings";

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
  readonly botToken: RedactedSecretValue;
  readonly appToken: RedactedSecretValue;
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

const missingConfig = (
  message: string,
  details?: Record<string, unknown>,
): SlackAdapterConfigError =>
  new SlackAdapterConfigError("missing_required_config", message, details);

const invalidConfig = (
  message: string,
  details?: Record<string, unknown>,
): SlackAdapterConfigError =>
  new SlackAdapterConfigError("invalid_config", message, details);

export async function loadSlackAdapterConfig(
  input: LoadSlackAdapterConfigInput,
): Promise<SlackAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerSlackJsonOntoEnv(json, input.env);
  const botToken = readRequired(env.MONO_AGENT_SLACK_BOT_TOKEN, "MONO_AGENT_SLACK_BOT_TOKEN", missingConfig);
  const appToken = readRequired(env.MONO_AGENT_SLACK_APP_TOKEN, "MONO_AGENT_SLACK_APP_TOKEN", missingConfig);
  const allowedChannelIds = readCsv(env.MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS);
  const allowAllChannels = readBoolean(
    env.MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS,
    "MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS",
    false,
    invalidConfig,
  );
  const botUserIds = readCsv(env.MONO_AGENT_SLACK_BOT_USER_IDS);
  const mentionTextAliases = readCsv(env.MONO_AGENT_SLACK_MENTION_TEXT_ALIASES);
  const stripMentionText = readBoolean(
    env.MONO_AGENT_SLACK_STRIP_MENTION_TEXT,
    "MONO_AGENT_SLACK_STRIP_MENTION_TEXT",
    botUserIds.length > 0 || mentionTextAliases.length > 0,
    invalidConfig,
  );

  if (!allowAllChannels && allowedChannelIds.length === 0) {
    throw missingConfig(
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
    botToken: redactedSecret(config.botToken),
    appToken: redactedSecret(config.appToken),
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
  const section = readJsonSection(json, "slack");
  return layerJsonOntoEnv(env, [
    { env: "MONO_AGENT_SLACK_BOT_TOKEN", value: section.botToken },
    { env: "MONO_AGENT_SLACK_APP_TOKEN", value: section.appToken },
    { env: "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS", value: section.allowedChannelIds, kind: "csv" },
    { env: "MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS", value: section.allowAllChannels, kind: "boolean" },
    { env: "MONO_AGENT_SLACK_BOT_USER_IDS", value: section.botUserIds, kind: "csv" },
    { env: "MONO_AGENT_SLACK_MENTION_TEXT_ALIASES", value: section.mentionTextAliases, kind: "csv" },
    { env: "MONO_AGENT_SLACK_STRIP_MENTION_TEXT", value: section.stripMentionText, kind: "boolean" },
  ]);
}
