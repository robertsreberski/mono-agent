import type {
  ChannelConfigInput,
  ChannelConfigViewField,
  ChannelConfigViewSection,
  ChannelDriver,
  JsonEnvFieldSpec,
  SettingsJson,
  SettingsJsonValue,
} from "@mono-agent/agent-contracts";
import {
  encodeJsonEnvValue,
  normalizeOptionalString,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/agent-contracts";

import { MESSENGER_CHANNEL_ID, messengerUserIdFromConversation } from "./adapter.js";
import {
  loadMessengerAdapterConfig,
  MessengerAdapterConfigError,
  MESSENGER_CONFIG_FIELDS,
  type MessengerAdapterConfig,
} from "./config.js";
import {
  startMessengerAdapter,
  type MessengerAdapterStartResult,
  type StartMessengerAdapterOptions,
} from "./start.js";

export type MessengerChannelDriverConfig = {
  readonly [key: string]: SettingsJsonValue;
};

export interface MessengerChannelDriverOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: MessengerChannelDriverConfig;
  readonly startAdapter?: (options: StartMessengerAdapterOptions) => Promise<MessengerAdapterStartResult>;
}

const BOOLEAN_RAW_CONFIG_FIELDS = ["enabled", "allowAllUsers", "allowNonLoopback"] as const;
const STRING_RAW_CONFIG_FIELDS = [
  "pageAccessToken",
  "appSecret",
  "verifyToken",
  "host",
  "webhookPath",
  "apiVersion",
  "proactiveMessagingType",
  "proactiveTag",
] as const;
const INTEGER_RAW_CONFIG_FIELDS = ["port"] as const;
const STRING_ARRAY_RAW_CONFIG_FIELDS = ["allowedUserIds"] as const;
const DEFAULT_CHANNEL_LABEL = "Facebook Messenger";
const DISABLED_REASON = "Messenger is disabled.";
const CONFIG_VIEW_PLACEHOLDER = "—";

export function createMessengerChannelDriver(
  options: MessengerChannelDriverOptions = {},
): ChannelDriver<MessengerAdapterConfig> {
  const id = options.id ?? MESSENGER_CHANNEL_ID;
  const label = options.label ?? DEFAULT_CHANNEL_LABEL;
  return {
    id,
    label,
    processJobs: { conversationScheme: MESSENGER_CHANNEL_ID },
    async configView(input) {
      const section = await readMessengerConfigViewSection(options, input);
      let status: ChannelConfigViewSection["status"] = "active";
      try {
        const config = await loadMessengerChannelConfig(options, input);
        if (!config.enabled) {
          status = "disabled";
        }
      } catch (error) {
        if (!isMessengerConfigError(error)) {
          throw error;
        }
      }
      return {
        id,
        label,
        status,
        fields: MESSENGER_CONFIG_FIELDS.map((field) => toChannelConfigViewField(field, section, input.env)),
      };
    },
    async loadConfig(input) {
      return await loadMessengerChannelConfig(options, input);
    },
    isConfigError(error) {
      return isMessengerConfigError(error);
    },
    disabledReason(config) {
      return config.enabled ? undefined : DISABLED_REASON;
    },
    async start(input) {
      const startAdapter = options.startAdapter ?? startMessengerAdapter;
      const result = await startAdapter({
        config: input.config,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        onServerError: (reason) => input.onFailure(`Messenger webhook server failed: ${reason}`),
      });
      const isAllowed = (userId: string): boolean =>
        input.config.allowAllUsers || input.config.allowedUserIds.includes(userId);
      return {
        summary: {
          host: result.host,
          port: result.port,
          path: result.webhookPath,
          webhookUrl: `http://${formatHost(result.host)}:${result.port}${result.webhookPath}`,
        },
        stop: () => result.stop(),
        notify: async ({ conversationId, text, verbatim, deliveryKey }) => {
          const userId = messengerUserIdFromConversation(conversationId);
          if (userId === undefined) {
            input.logger?.warn?.("Messenger proactive notify skipped: unparseable destination.", { conversationId });
            return { delivered: false, reason: "unparseable messenger destination", retryable: false };
          }
          if (!isAllowed(userId)) {
            input.logger?.warn?.("Messenger proactive notify skipped: destination not in allowlist.", { conversationId });
            return { delivered: false, reason: "messenger user is not in the adapter allowlist", retryable: false };
          }
          return await result.notify(userId, text, {
            ...(verbatim === undefined ? {} : { verbatim }),
            ...(deliveryKey === undefined ? {} : { deliveryKey }),
          });
        },
        processJobs: {
          update: async ({ conversationId, processJob }) => {
            const userId = messengerUserIdFromConversation(conversationId);
            if (userId === undefined
              || processJob.origin.channel !== MESSENGER_CHANNEL_ID
              || conversationId !== baseConversationId(processJob.origin.conversationId)) {
              return {
                delivered: false,
                code: "process_job_origin_mismatch",
                reason: "The process-job origin does not match the Messenger destination.",
                retryable: false,
              };
            }
            return await result.updateProcessJob(userId, processJob);
          },
          wake: async ({ conversationId, text, deliveryKey, processJob }) => {
            const userId = messengerUserIdFromConversation(conversationId);
            if (userId === undefined
              || processJob.origin.channel !== MESSENGER_CHANNEL_ID
              || conversationId !== baseConversationId(processJob.origin.conversationId)) {
              return {
                delivered: false,
                code: "process_job_origin_mismatch",
                reason: "The process-job origin does not match the Messenger destination.",
                retryable: false,
              };
            }
            return await result.notify(userId, text, { deliveryKey, steerActive: true });
          },
        },
      };
    },
  };
}

export const createChannelDriver = createMessengerChannelDriver;

function baseConversationId(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function loadMessengerChannelConfig(
  options: MessengerChannelDriverOptions,
  input: ChannelConfigInput,
): Promise<MessengerAdapterConfig> {
  if (options.config !== undefined) {
    validateMessengerChannelDriverConfig(options.config);
    return await loadMessengerAdapterConfig({
      env: input.env,
      json: { messenger: options.config } satisfies SettingsJson,
    });
  }
  return await loadMessengerAdapterConfig({ env: input.env, jsonPath: input.configPath });
}

async function readMessengerConfigViewSection(
  options: MessengerChannelDriverOptions,
  input: ChannelConfigInput,
): Promise<Record<string, unknown>> {
  if (options.config !== undefined) {
    return options.config as Record<string, unknown>;
  }
  const { json } = await readSettingsJson(input.configPath);
  return readJsonSection(json, MESSENGER_CHANNEL_ID);
}

function isMessengerConfigError(error: unknown): boolean {
  return error instanceof MessengerAdapterConfigError;
}

function toChannelConfigViewField(
  field: JsonEnvFieldSpec,
  section: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ChannelConfigViewField {
  const envValue = normalizeOptionalString(env[field.env]);
  const jsonValue = encodeJsonEnvValue(field.fromJson(section), field.kind ?? "string");
  const resolved = envValue ?? jsonValue;
  const source = envValue !== undefined ? "env" : jsonValue !== undefined ? "json" : "default";
  return {
    id: field.id,
    label: labelForFieldId(field.id),
    value: field.secret === true ? (resolved === undefined ? "unset" : "set") : resolved ?? CONFIG_VIEW_PLACEHOLDER,
    source,
    ...(field.secret === true ? { redacted: true } : {}),
    envKey: field.env,
  };
}

function labelForFieldId(id: string): string {
  const words = id
    .split(".")
    .slice(1)
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function validateMessengerChannelDriverConfig(config: MessengerChannelDriverConfig): void {
  for (const key of BOOLEAN_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, (value) => typeof value === "boolean", "a boolean");
  }
  for (const key of STRING_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, (value) => typeof value === "string", "a string");
  }
  for (const key of INTEGER_RAW_CONFIG_FIELDS) {
    validateRawField(config, key, (value) => typeof value === "number" && Number.isInteger(value), "an integer");
  }
  for (const key of STRING_ARRAY_RAW_CONFIG_FIELDS) {
    validateRawField(
      config,
      key,
      (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
      "an array of strings",
    );
  }
}

function validateRawField(
  config: MessengerChannelDriverConfig,
  key: string,
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
  throw new MessengerAdapterConfigError(
    "invalid_config",
    `messenger.${key} must be ${expected}.`,
    { field: `messenger.${key}`, expected, reason: describeRawValue(value) },
  );
}

function describeRawValue(value: SettingsJsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
