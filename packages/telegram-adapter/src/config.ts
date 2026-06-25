import {
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readCsv,
  readInteger,
  readJsonSection,
  readRecord,
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
  /** Pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`). Omit for dual-stack. */
  readonly ipFamily?: 4 | 6;
  /** Poll-liveness watchdog window (ms). Omit to use the adapter default (120000). */
  readonly pollWatchdogMs?: number;
}

export interface RedactedTelegramAdapterConfig {
  readonly enabled: boolean;
  readonly botToken: RedactedSecretValue;
  readonly allowedChatIds: { readonly count: number };
  readonly allowAllChats: boolean;
  readonly ipFamily?: 4 | 6;
  readonly pollWatchdogMs?: number;
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

  const ipFamily = readIpFamily(env.MONO_AGENT_TELEGRAM_IP_FAMILY);
  const pollWatchdogRaw = normalizeOptionalString(env.MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS);
  const pollWatchdogMs =
    pollWatchdogRaw === undefined
      ? undefined
      : readInteger(pollWatchdogRaw, "MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS", 0, invalidConfig, {
          min: 0,
          max: 3_600_000,
        });

  return {
    enabled: true,
    botToken,
    allowedChatIds,
    allowAllChats,
    ...(ipFamily === undefined ? {} : { ipFamily }),
    ...(pollWatchdogMs === undefined ? {} : { pollWatchdogMs }),
  };
}

/** Parse an optional IPv4/IPv6 transport pin. Empty → undefined; anything but 4/6 throws. */
function readIpFamily(raw: string | undefined): 4 | 6 | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return undefined;
  }
  if (normalized === "4") {
    return 4;
  }
  if (normalized === "6") {
    return 6;
  }
  throw invalidConfig("MONO_AGENT_TELEGRAM_IP_FAMILY must be 4 or 6.", {
    env: "MONO_AGENT_TELEGRAM_IP_FAMILY",
    reason: normalized,
  });
}

export function redactTelegramAdapterConfig(
  config: TelegramAdapterConfig,
): RedactedTelegramAdapterConfig {
  return {
    enabled: config.enabled,
    botToken: redactedSecret(config.botToken),
    allowedChatIds: { count: config.allowedChatIds.length },
    allowAllChats: config.allowAllChats,
    ...(config.ipFamily === undefined ? {} : { ipFamily: config.ipFamily }),
    ...(config.pollWatchdogMs === undefined ? {} : { pollWatchdogMs: config.pollWatchdogMs }),
  };
}

function layerTelegramJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readJsonSection(json, "telegram");
  const transport = readRecord(section.transport);
  return layerJsonOntoEnv(env, [
    { env: "MONO_AGENT_TELEGRAM_ENABLED", value: section.enabled, kind: "boolean" },
    { env: "MONO_AGENT_TELEGRAM_BOT_TOKEN", value: section.botToken },
    { env: "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS", value: section.allowedChatIds, kind: "csv" },
    { env: "MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS", value: section.allowAllChats, kind: "boolean" },
    { env: "MONO_AGENT_TELEGRAM_IP_FAMILY", value: transport.ipFamily, kind: "integer" },
    { env: "MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS", value: section.pollWatchdogMs, kind: "integer" },
  ]);
}
