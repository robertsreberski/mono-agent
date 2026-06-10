import {
  defineFieldGroup,
  readSettingsJson,
} from "@mono-agent/settings";
import type { FieldGroup, SettingsJson } from "@mono-agent/settings";

export interface TelegramAdapterConfig {
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowAllChats: boolean;
}

export interface RedactedTelegramAdapterConfig {
  readonly botToken: { readonly present: boolean; readonly redacted: true };
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

export const telegramFieldGroup: FieldGroup = defineFieldGroup({
  id: "telegram",
  label: "Telegram",
  description: "Optional Telegram adapter configuration. The token is write-only.",
  fields: [
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
  const botToken = readRequired(env, "MONO_AGENT_TELEGRAM_BOT_TOKEN");
  const allowedChatIds = readCsv(env.MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS);
  const allowAllChats = readBoolean(env.MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS, false);

  if (!allowAllChats && allowedChatIds.length === 0) {
    throw new TelegramAdapterConfigError(
      "missing_required_config",
      "Telegram adapter requires MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS or MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS=true.",
      { env: "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS" },
    );
  }

  return { botToken, allowedChatIds, allowAllChats };
}

export function redactTelegramAdapterConfig(
  config: TelegramAdapterConfig,
): RedactedTelegramAdapterConfig {
  return {
    botToken: { present: config.botToken.length > 0, redacted: true },
    allowedChatIds: { count: config.allowedChatIds.length },
    allowAllChats: config.allowAllChats,
  };
}

function layerTelegramJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readTelegramSection(json);
  const fromJson: Record<string, string | undefined> = {};
  if (typeof section.botToken === "string") {
    fromJson.MONO_AGENT_TELEGRAM_BOT_TOKEN = section.botToken;
  }
  if (Array.isArray(section.allowedChatIds)) {
    fromJson.MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS = section.allowedChatIds
      .filter((value): value is string => typeof value === "string")
      .join(",");
  }
  if (typeof section.allowAllChats === "boolean") {
    fromJson.MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS = section.allowAllChats ? "true" : "false";
  }

  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      layered[key] = value;
    }
  }
  return layered;
}

function readTelegramSection(json: SettingsJson): Record<string, unknown> {
  const section = json.telegram;
  if (section !== null && typeof section === "object" && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  return {};
}

function readRequired(env: Record<string, string | undefined>, name: string): string {
  const value = normalizeOptionalString(env[name]);
  if (value === undefined) {
    throw new TelegramAdapterConfigError("missing_required_config", `${name} is required.`, { env: name });
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

function readBoolean(raw: string | undefined, defaultValue: boolean): boolean {
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
  throw new TelegramAdapterConfigError(
    "invalid_config",
    "MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS must be true or false.",
    { env: "MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS" },
  );
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
