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
