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

/** A Slack shortcut binding: invoking `callbackId` runs `prompt` as a turn. */
export interface SlackShortcutConfig {
  readonly callbackId: string;
  readonly prompt: string;
  /** Destination channel for the reply. Required for global shortcuts (no source channel). */
  readonly channelId?: string;
  /** Optional message posted instantly on invocation, before the run (e.g. "🔄 Syncing…"). */
  readonly ackText?: string;
}

/** An App Home tab button: clicking it runs `prompt`; `label` is the button text. */
export interface SlackHomeButtonConfig {
  readonly actionId: string;
  readonly label: string;
  readonly prompt: string;
  /** Destination channel for the reply (the Home tab has none of its own). */
  readonly channelId?: string;
  /** Optional message posted instantly on click, before the run. */
  readonly ackText?: string;
}

/** App Home tab config: whether to publish it, an optional header, and its buttons. */
export interface SlackHomeTabConfig {
  readonly enabled: boolean;
  readonly headerText?: string;
  readonly buttons: readonly SlackHomeButtonConfig[];
}

export interface SlackAdapterConfig {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly appToken: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
  readonly botUserIds: readonly string[];
  readonly mentionTextAliases: readonly string[];
  readonly stripMentionText: boolean;
  /** Shortcut bindings, read from the `slack.shortcuts` JSON array. */
  readonly shortcuts: readonly SlackShortcutConfig[];
  /** App Home tab config, read from the `slack.homeTab` JSON object. */
  readonly homeTab: SlackHomeTabConfig;
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
  readonly shortcuts: { readonly count: number };
  readonly homeTab: { readonly enabled: boolean; readonly buttonCount: number };
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
      id: "slack.enabled",
      label: "Enable Slack",
      description: "Start the Slack adapter with the app. Off by default.",
      kind: "switch",
      path: ["slack", "enabled"],
    },
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
      placeholder: "@agent, Assistant",
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
  // Shortcut bindings and the Home tab are structured config, so they are read
  // straight from the JSON section rather than via env layering.
  const shortcuts = readSlackShortcuts(json);
  const homeTab = readSlackHomeTab(json);
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
      shortcuts,
      homeTab,
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
    shortcuts,
    homeTab,
  };
}

/**
 * Read `slack.shortcuts` (shortcut bindings) straight from the JSON config
 * section. Absent → none; a non-array or a malformed entry is a hard config
 * error so a typo surfaces loudly instead of silently dropping a shortcut.
 */
function readSlackShortcuts(json: SettingsJson): readonly SlackShortcutConfig[] {
  const section = readJsonSection(json, "slack");
  const raw = section.shortcuts;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw invalidConfig("slack.shortcuts must be an array of { callbackId, prompt } objects.");
  }
  return raw.map((entry, index) => normalizeShortcutConfig(entry, index));
}

function normalizeShortcutConfig(entry: unknown, index: number): SlackShortcutConfig {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw invalidConfig("slack.shortcuts entries must be objects.", { index });
  }
  const record = entry as Record<string, unknown>;
  const callbackId = record.callbackId;
  const prompt = record.prompt;
  const channelId = record.channelId;
  const ackText = record.ackText;
  if (typeof callbackId !== "string" || callbackId.trim().length === 0) {
    throw invalidConfig("slack.shortcuts entries require a non-empty callbackId.", { index });
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw invalidConfig("slack.shortcuts entries require a non-empty prompt.", { index });
  }
  if (channelId !== undefined && (typeof channelId !== "string" || channelId.trim().length === 0)) {
    throw invalidConfig("slack.shortcuts channelId must be a non-empty string when set.", { index });
  }
  if (ackText !== undefined && (typeof ackText !== "string" || ackText.trim().length === 0)) {
    throw invalidConfig("slack.shortcuts ackText must be a non-empty string when set.", { index });
  }
  const config: { callbackId: string; prompt: string; channelId?: string; ackText?: string } = {
    callbackId,
    prompt,
  };
  if (channelId !== undefined) {
    config.channelId = channelId;
  }
  if (ackText !== undefined) {
    config.ackText = ackText;
  }
  return config;
}

/**
 * Read `slack.homeTab` (App Home tab config) from the JSON section. Absent →
 * disabled with no buttons; a malformed shape or button is a hard config error.
 */
function readSlackHomeTab(json: SettingsJson): SlackHomeTabConfig {
  const section = readJsonSection(json, "slack");
  const raw = section.homeTab;
  if (raw === undefined) {
    return { enabled: false, buttons: [] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidConfig("slack.homeTab must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled === true;
  const headerText = record.headerText;
  if (headerText !== undefined && (typeof headerText !== "string" || headerText.trim().length === 0)) {
    throw invalidConfig("slack.homeTab.headerText must be a non-empty string when set.");
  }
  const rawButtons = record.buttons;
  if (rawButtons !== undefined && !Array.isArray(rawButtons)) {
    throw invalidConfig("slack.homeTab.buttons must be an array of button objects.");
  }
  const buttons = (rawButtons ?? []).map((entry, index) => normalizeHomeButtonConfig(entry, index));
  const config: { enabled: boolean; headerText?: string; buttons: readonly SlackHomeButtonConfig[] } = {
    enabled,
    buttons,
  };
  if (headerText !== undefined) {
    config.headerText = headerText;
  }
  return config;
}

function normalizeHomeButtonConfig(entry: unknown, index: number): SlackHomeButtonConfig {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw invalidConfig("slack.homeTab.buttons entries must be objects.", { index });
  }
  const record = entry as Record<string, unknown>;
  const actionId = record.actionId;
  const label = record.label;
  const prompt = record.prompt;
  const channelId = record.channelId;
  const ackText = record.ackText;
  if (typeof actionId !== "string" || actionId.trim().length === 0) {
    throw invalidConfig("slack.homeTab.buttons entries require a non-empty actionId.", { index });
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    throw invalidConfig("slack.homeTab.buttons entries require a non-empty label.", { index });
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw invalidConfig("slack.homeTab.buttons entries require a non-empty prompt.", { index });
  }
  if (channelId !== undefined && (typeof channelId !== "string" || channelId.trim().length === 0)) {
    throw invalidConfig("slack.homeTab.buttons channelId must be a non-empty string when set.", { index });
  }
  if (ackText !== undefined && (typeof ackText !== "string" || ackText.trim().length === 0)) {
    throw invalidConfig("slack.homeTab.buttons ackText must be a non-empty string when set.", { index });
  }
  const config: { actionId: string; label: string; prompt: string; channelId?: string; ackText?: string } = {
    actionId,
    label,
    prompt,
  };
  if (channelId !== undefined) {
    config.channelId = channelId;
  }
  if (ackText !== undefined) {
    config.ackText = ackText;
  }
  return config;
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
    shortcuts: { count: config.shortcuts.length },
    homeTab: { enabled: config.homeTab.enabled, buttonCount: config.homeTab.buttons.length },
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
