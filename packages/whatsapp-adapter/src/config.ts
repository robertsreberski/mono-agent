import {
  defineFieldGroup,
  readSettingsJson,
} from "@mono-agent/settings";
import type { FieldGroup, SettingsJson } from "@mono-agent/settings";

import type { WhatsAppGroupTriggerMode } from "./adapter.js";
import type { WhatsAppJid } from "./types.js";

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
      placeholder: "@mono, Mono Agent",
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
  const allowAllChats = readBoolean(env.MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS, false, "MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS");
  const groupMode = readGroupMode(env.MONO_AGENT_WHATSAPP_GROUP_MODE);
  const botJids = readCsv(env.MONO_AGENT_WHATSAPP_BOT_JIDS);
  const mentionTextAliases = readCsv(env.MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES);
  const stripMentionText = readBoolean(
    env.MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT,
    mentionTextAliases.length > 0,
    "MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT",
  );

  if (!allowAllChats && allowedChatJids.length === 0) {
    throw new WhatsAppAdapterConfigError(
      "missing_required_config",
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
  const section = readWhatsAppSection(json);
  const fromJson: Record<string, string | undefined> = {};
  if (Array.isArray(section.allowedChatJids)) {
    fromJson.MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS = section.allowedChatJids
      .filter((value): value is string => typeof value === "string")
      .join(",");
  }
  if (typeof section.allowAllChats === "boolean") {
    fromJson.MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS = section.allowAllChats ? "true" : "false";
  }
  if (typeof section.groupMode === "string") {
    fromJson.MONO_AGENT_WHATSAPP_GROUP_MODE = section.groupMode;
  }
  if (Array.isArray(section.botJids)) {
    fromJson.MONO_AGENT_WHATSAPP_BOT_JIDS = section.botJids
      .filter((value): value is string => typeof value === "string")
      .join(",");
  }
  if (Array.isArray(section.mentionTextAliases)) {
    fromJson.MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES = section.mentionTextAliases
      .filter((value): value is string => typeof value === "string")
      .join(",");
  }
  if (typeof section.stripMentionText === "boolean") {
    fromJson.MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT = section.stripMentionText ? "true" : "false";
  }

  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      layered[key] = value;
    }
  }
  return layered;
}

function readWhatsAppSection(json: SettingsJson): Record<string, unknown> {
  const section = json.whatsapp;
  if (section !== null && typeof section === "object" && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  return {};
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

function readBoolean(
  raw: string | undefined,
  defaultValue: boolean,
  envName: string,
): boolean {
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
  throw new WhatsAppAdapterConfigError(
    "invalid_config",
    `${envName} must be true or false.`,
    { env: envName },
  );
}

function readGroupMode(raw: string | undefined): WhatsAppGroupTriggerMode {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return "mention";
  }
  if (normalized === "mention" || normalized === "any") {
    return normalized;
  }
  throw new WhatsAppAdapterConfigError(
    "invalid_config",
    "MONO_AGENT_WHATSAPP_GROUP_MODE must be mention or any.",
    { env: "MONO_AGENT_WHATSAPP_GROUP_MODE" },
  );
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
