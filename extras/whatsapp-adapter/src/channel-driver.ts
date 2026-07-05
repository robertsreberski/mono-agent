import { resolve } from "node:path";

import type {
  ChannelDriver,
  SettingsJson,
  SettingsJsonValue,
} from "@mono-agent/agent-contracts";

import {
  loadWhatsAppAdapterConfig,
  WhatsAppAdapterConfigError,
  type WhatsAppAdapterConfig,
} from "./config.js";
import {
  startWhatsAppAdapter,
  type StartWhatsAppAdapterOptions,
  type WhatsAppAdapterStartResult,
  type WhatsAppSocketFactory,
} from "./start.js";

export type WhatsAppChannelDriverConfig = {
  readonly [key: string]: SettingsJsonValue;
};

export interface WhatsAppChannelDriverOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: WhatsAppChannelDriverConfig;
  readonly authDir?: string;
  readonly socketFactory?: WhatsAppSocketFactory;
  readonly startAdapter?: (
    options: StartWhatsAppAdapterOptions,
  ) => Promise<WhatsAppAdapterStartResult>;
}

const BOOLEAN_RAW_CONFIG_FIELDS = ["enabled", "allowAllChats", "stripMentionText"] as const;
const STRING_RAW_CONFIG_FIELDS = ["groupMode"] as const;
const STRING_ARRAY_RAW_CONFIG_FIELDS = ["allowedChatJids", "botJids", "mentionTextAliases"] as const;

export function createWhatsAppChannelDriver(
  options: WhatsAppChannelDriverOptions = {},
): ChannelDriver<WhatsAppAdapterConfig> {
  return {
    id: options.id ?? "whatsapp",
    label: options.label ?? "WhatsApp",
    async loadConfig(input) {
      if (options.config !== undefined) {
        validateWhatsAppChannelDriverConfig(options.config);
        return await loadWhatsAppAdapterConfig({
          env: input.env,
          json: { whatsapp: options.config } satisfies SettingsJson,
        });
      }
      return await loadWhatsAppAdapterConfig({
        env: input.env,
        jsonPath: input.configPath,
      });
    },
    isConfigError(error) {
      return error instanceof WhatsAppAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "WhatsApp is disabled.";
    },
    async start(input) {
      const startAdapter = options.startAdapter ?? startWhatsAppAdapter;
      const result = await startAdapter({
        authDir: options.authDir ?? resolve(input.cwd, ".mono-agent", "whatsapp-auth"),
        config: input.config,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        onQr: (qr) => {
          input.logger?.info?.("WhatsApp login QR code received; scan it with the WhatsApp app.", { qr });
        },
        ...(options.socketFactory === undefined ? {} : { createSocket: options.socketFactory }),
      });
      return {
        summary: {},
        stop: () => result.stop(),
      };
    },
  };
}

export const createChannelDriver = createWhatsAppChannelDriver;

function validateWhatsAppChannelDriverConfig(config: WhatsAppChannelDriverConfig): void {
  for (const key of BOOLEAN_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, `whatsapp.${key}`, isBooleanValue, "a boolean");
  }
  for (const key of STRING_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, `whatsapp.${key}`, isStringValue, "a string");
  }
  for (const key of STRING_ARRAY_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, `whatsapp.${key}`, isStringArrayValue, "an array of strings");
  }
}

function validateRawField(
  config: WhatsAppChannelDriverConfig,
  key: string,
  field: string,
  isValid: (value: SettingsJsonValue | undefined) => boolean,
  expected: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(config, key)) {
    return;
  }
  const value = config[key];
  if (isValid(value)) {
    return;
  }
  throw new WhatsAppAdapterConfigError(
    "invalid_config",
    `${field} must be ${expected}.`,
    { field, expected, reason: describeRawValue(value) },
  );
}

function isBooleanValue(value: SettingsJsonValue | undefined): boolean {
  return typeof value === "boolean";
}

function isStringValue(value: SettingsJsonValue | undefined): boolean {
  return typeof value === "string";
}

function isStringArrayValue(value: SettingsJsonValue | undefined): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function describeRawValue(value: SettingsJsonValue | undefined): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
