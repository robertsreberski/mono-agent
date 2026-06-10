import {
  defineFieldGroup,
  layerJsonOntoEnv,
  readBoolean,
  readChoice,
  readCsv,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/settings";
import type { FieldGroup, SettingsJson } from "@mono-agent/settings";

import type { WhatsAppGroupTriggerMode } from "./adapter.js";
import type { WhatsAppJid } from "./types.js";

const WHATSAPP_GROUP_MODES = ["mention", "any"] as const satisfies readonly WhatsAppGroupTriggerMode[];

export interface WhatsAppAdapterTriggerConfig {
  readonly groupMode: WhatsAppGroupTriggerMode;
  readonly botJids: readonly WhatsAppJid[];
  readonly mentionTextAliases: readonly string[];
  readonly stripMentionText: boolean;
}

export interface WhatsAppAdapterConfig {
  readonly allowedChatJids: readonly WhatsAppJid[];
  readonly allowAllChats: boolean;
  readonly trigger: WhatsAppAdapterTriggerConfig;
}

export interface RedactedWhatsAppAdapterConfig {
  readonly allowedChatJids: { readonly count: number };
  readonly allowAllChats: boolean;
  readonly trigger: {
    readonly groupMode: WhatsAppGroupTriggerMode;
    readonly botJids: { readonly count: number };
    readonly mentionTextAliases: { readonly count: number };
    readonly stripMentionText: boolean;
  };
}

export type WhatsAppAdapterConfigErrorCode =
  | "missing_required_config"
  | "invalid_config";

export interface WhatsAppAdapterConfigErrorDetails {
  readonly code?: WhatsAppAdapterConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class WhatsAppAdapterConfigError extends Error {
  readonly code: WhatsAppAdapterConfigErrorCode;
  readonly details: WhatsAppAdapterConfigErrorDetails;

  constructor(
    code: WhatsAppAdapterConfigErrorCode,
    message: string,
    details: WhatsAppAdapterConfigErrorDetails = {},
  ) {
    super(message);
    this.name = "WhatsAppAdapterConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface LoadWhatsAppAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const invalidConfig = (
  message: string,
  details?: Record<string, unknown>,
): WhatsAppAdapterConfigError =>
  new WhatsAppAdapterConfigError("invalid_config", message, details);

const missingRequiredConfig = (
  message: string,
  details?: Record<string, unknown>,
): WhatsAppAdapterConfigError =>
  new WhatsAppAdapterConfigError("missing_required_config", message, details);

export const whatsappFieldGroup: FieldGroup = defineFieldGroup({
  id: "whatsapp",
  label: "WhatsApp",
  description: "Optional WhatsApp adapter allowlist and group trigger configuration.",
  fields: [
    {
      id: "whatsapp.allowedChatJids",
      label: "Allowed chat JIDs",
      description: "Comma-separated list of chat JIDs the adapter will respond to.",
      kind: "csv",
      placeholder: "123@s.whatsapp.net, 456@g.us",
      path: ["whatsapp", "allowedChatJids"],
    },
    {
      id: "whatsapp.allowAllChats",
      label: "Allow all chats",
      description: "Explicitly permit every chat. Leave off when using an allowlist.",
      kind: "switch",
      path: ["whatsapp", "allowAllChats"],
    },
    {
      id: "whatsapp.groupMode",
      label: "Group mode",
      description: "Whether group messages require a configured bot mention or any group text may trigger.",
      kind: "select",
      options: [
        { value: "mention", label: "mention" },
        { value: "any", label: "any" },
      ],
      path: ["whatsapp", "groupMode"],
    },
    {
      id: "whatsapp.botJids",
      label: "Bot JIDs",
      description: "Comma-separated JIDs that count as bot mentions in groups.",
      kind: "csv",
      placeholder: "123@s.whatsapp.net",
      path: ["whatsapp", "botJids"],
    },
    {
      id: "whatsapp.mentionTextAliases",
      label: "Mention aliases",
      description: "Comma-separated mention text aliases to strip from triggered messages.",
      kind: "csv",
      placeholder: "@agent, Assistant",
      path: ["whatsapp", "mentionTextAliases"],
    },
    {
      id: "whatsapp.stripMentionText",
      label: "Strip mention text",
      description: "Remove configured mention aliases before sending text to the responder.",
      kind: "switch",
      path: ["whatsapp", "stripMentionText"],
    },
  ],
});

export async function loadWhatsAppAdapterConfig(
  input: LoadWhatsAppAdapterConfigInput,
): Promise<WhatsAppAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerWhatsAppJsonOntoEnv(json, input.env);
  const allowedChatJids = readCsv(env.MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS);
  const allowAllChats = readBoolean(
    env.MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS,
    "MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS",
    false,
    invalidConfig,
  );
  const groupMode = readChoice(
    env.MONO_AGENT_WHATSAPP_GROUP_MODE,
    "MONO_AGENT_WHATSAPP_GROUP_MODE",
    WHATSAPP_GROUP_MODES,
    "mention",
    invalidConfig,
  );
  const botJids = readCsv(env.MONO_AGENT_WHATSAPP_BOT_JIDS);
  const mentionTextAliases = readCsv(env.MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES);
  const stripMentionText = readBoolean(
    env.MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT,
    "MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT",
    mentionTextAliases.length > 0,
    invalidConfig,
  );

  if (!allowAllChats && allowedChatJids.length === 0) {
    throw missingRequiredConfig(
      "WhatsApp adapter requires MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS or MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS=true.",
      { env: "MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS" },
    );
  }

  return {
    allowedChatJids,
    allowAllChats,
    trigger: {
      groupMode,
      botJids,
      mentionTextAliases,
      stripMentionText,
    },
  };
}

export function redactWhatsAppAdapterConfig(
  config: WhatsAppAdapterConfig,
): RedactedWhatsAppAdapterConfig {
  return {
    allowedChatJids: { count: config.allowedChatJids.length },
    allowAllChats: config.allowAllChats,
    trigger: {
      groupMode: config.trigger.groupMode,
      botJids: { count: config.trigger.botJids.length },
      mentionTextAliases: { count: config.trigger.mentionTextAliases.length },
      stripMentionText: config.trigger.stripMentionText,
    },
  };
}

function layerWhatsAppJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readJsonSection(json, "whatsapp");
  return layerJsonOntoEnv(env, [
    { env: "MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS", value: section.allowedChatJids, kind: "csv" },
    { env: "MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS", value: section.allowAllChats, kind: "boolean" },
    { env: "MONO_AGENT_WHATSAPP_GROUP_MODE", value: section.groupMode },
    { env: "MONO_AGENT_WHATSAPP_BOT_JIDS", value: section.botJids, kind: "csv" },
    { env: "MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES", value: section.mentionTextAliases, kind: "csv" },
    { env: "MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT", value: section.stripMentionText, kind: "boolean" },
  ]);
}
