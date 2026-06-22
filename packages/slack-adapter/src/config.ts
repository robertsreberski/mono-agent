import {
  layerJsonOntoEnv,
  readBoolean,
  readCsv,
  readJsonSection,
  readRequired,
  readSettingsJson,
  redactedSecret,
} from "@mono-agent/settings";
import type {
  RedactedSecretValue,
  SettingsJson,
} from "@mono-agent/settings";

export interface SlackAdapterConfig {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly appToken: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
  readonly botUserIds: readonly string[];
  readonly mentionTextAliases: readonly string[];
  readonly stripMentionText: boolean;
}

export interface RedactedSlackAdapterConfig {
  readonly enabled: boolean;
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
  const enabled = readBoolean(env.MONO_AGENT_SLACK_ENABLED, "MONO_AGENT_SLACK_ENABLED", false, invalidConfig);
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

  // A disabled channel never validates its credentials: the status surface reads
  // it as "disabled", not "waiting for config". Only an enabled channel demands
  // its tokens (a missing token then becomes a real "waiting" reason).
  if (!enabled) {
    return {
      enabled: false,
      botToken: "",
      appToken: "",
      allowedChannelIds,
      allowAllChannels,
      botUserIds,
      mentionTextAliases,
      stripMentionText,
    };
  }

  const botToken = readRequired(env.MONO_AGENT_SLACK_BOT_TOKEN, "MONO_AGENT_SLACK_BOT_TOKEN", missingConfig);
  const appToken = readRequired(env.MONO_AGENT_SLACK_APP_TOKEN, "MONO_AGENT_SLACK_APP_TOKEN", missingConfig);

  if (!allowAllChannels && allowedChannelIds.length === 0) {
    throw missingConfig(
      "Slack adapter requires MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS or MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS=true.",
      { env: "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS" },
    );
  }

  return {
    enabled: true,
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
    enabled: config.enabled,
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
    { env: "MONO_AGENT_SLACK_ENABLED", value: section.enabled, kind: "boolean" },
    { env: "MONO_AGENT_SLACK_BOT_TOKEN", value: section.botToken },
    { env: "MONO_AGENT_SLACK_APP_TOKEN", value: section.appToken },
    { env: "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS", value: section.allowedChannelIds, kind: "csv" },
    { env: "MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS", value: section.allowAllChannels, kind: "boolean" },
    { env: "MONO_AGENT_SLACK_BOT_USER_IDS", value: section.botUserIds, kind: "csv" },
    { env: "MONO_AGENT_SLACK_MENTION_TEXT_ALIASES", value: section.mentionTextAliases, kind: "csv" },
    { env: "MONO_AGENT_SLACK_STRIP_MENTION_TEXT", value: section.stripMentionText, kind: "boolean" },
  ]);
}
