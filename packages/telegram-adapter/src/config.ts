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

export interface TelegramAdapterConfig {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowAllChats: boolean;
}

export interface RedactedTelegramAdapterConfig {
  readonly enabled: boolean;
  readonly botToken: RedactedSecretValue;
  readonly allowedChatIds: { readonly count: number };
  readonly allowAllChats: boolean;
}

export type TelegramAdapterConfigErrorCode =
  | "missing_required_config"
  | "invalid_config";

export interface TelegramAdapterConfigErrorDetails {
  readonly code?: TelegramAdapterConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class TelegramAdapterConfigError extends Error {
  readonly code: TelegramAdapterConfigErrorCode;
  readonly details: TelegramAdapterConfigErrorDetails;

  constructor(
    code: TelegramAdapterConfigErrorCode,
    message: string,
    details: TelegramAdapterConfigErrorDetails = {},
  ) {
    super(message);
    this.name = "TelegramAdapterConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface LoadTelegramAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const missingRequiredConfig = (
  message: string,
  details?: Record<string, unknown>,
): TelegramAdapterConfigError =>
  new TelegramAdapterConfigError("missing_required_config", message, details);

const invalidConfig = (
  message: string,
  details?: Record<string, unknown>,
): TelegramAdapterConfigError =>
  new TelegramAdapterConfigError("invalid_config", message, details);

export const telegramFieldGroup: FieldGroup = defineFieldGroup({
  id: "telegram",
  label: "Telegram",
  description: "Optional Telegram adapter configuration. The token is write-only.",
  fields: [
    {
      id: "telegram.enabled",
      label: "Enable Telegram",
      description: "Start the Telegram adapter with the app. Off by default.",
      kind: "switch",
      path: ["telegram", "enabled"],
    },
    {
      id: "telegram.botToken",
      label: "Bot token",
      description: "Bot API token. Stored on disk only; never returned to the UI after save.",
      kind: "secret",
      path: ["telegram", "botToken"],
    },
    {
      id: "telegram.allowedChatIds",
      label: "Allowed chat ids",
      description: "Comma-separated list of chat ids the bot will respond to.",
      kind: "csv",
      placeholder: "111111111, 222222222",
      path: ["telegram", "allowedChatIds"],
    },
    {
      id: "telegram.allowAllChats",
      label: "Allow all chats",
      description: "Explicitly permit every chat. Leave off when using an allowlist.",
      kind: "switch",
      path: ["telegram", "allowAllChats"],
    },
  ],
});

export async function loadTelegramAdapterConfig(
  input: LoadTelegramAdapterConfigInput,
): Promise<TelegramAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerTelegramJsonOntoEnv(json, input.env);
  const enabled = readBoolean(
    env.MONO_AGENT_TELEGRAM_ENABLED,
    "MONO_AGENT_TELEGRAM_ENABLED",
    false,
    invalidConfig,
  );
  const allowedChatIds = readCsv(env.MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS);
  const allowAllChats = readBoolean(
    env.MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS,
    "MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS",
    false,
    invalidConfig,
  );

  // A disabled channel never validates its credentials: the status surface reads
  // it as "disabled", not "waiting for config". Only an enabled channel demands
  // its required fields (a missing token then becomes a real "waiting" reason).
  if (!enabled) {
    return { enabled: false, botToken: "", allowedChatIds, allowAllChats };
  }

  const botToken = readRequired(
    env.MONO_AGENT_TELEGRAM_BOT_TOKEN,
    "MONO_AGENT_TELEGRAM_BOT_TOKEN",
    missingRequiredConfig,
  );

  if (!allowAllChats && allowedChatIds.length === 0) {
    throw missingRequiredConfig(
      "Telegram adapter requires MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS or MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS=true.",
      { env: "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS" },
    );
  }

  return { enabled: true, botToken, allowedChatIds, allowAllChats };
}

export function redactTelegramAdapterConfig(
  config: TelegramAdapterConfig,
): RedactedTelegramAdapterConfig {
  return {
    enabled: config.enabled,
    botToken: redactedSecret(config.botToken),
    allowedChatIds: { count: config.allowedChatIds.length },
    allowAllChats: config.allowAllChats,
  };
}

function layerTelegramJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readJsonSection(json, "telegram");
  return layerJsonOntoEnv(env, [
    { env: "MONO_AGENT_TELEGRAM_ENABLED", value: section.enabled, kind: "boolean" },
    { env: "MONO_AGENT_TELEGRAM_BOT_TOKEN", value: section.botToken },
    { env: "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS", value: section.allowedChatIds, kind: "csv" },
    { env: "MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS", value: section.allowAllChats, kind: "boolean" },
  ]);
}
