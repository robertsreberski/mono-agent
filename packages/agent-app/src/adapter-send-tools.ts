import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  SlackChatPostMessageResult,
  SlackWebApi,
} from "@mono-agent/slack-adapter";
import type {
  TelegramChatId,
  TelegramMessageSender,
  TelegramSentMessage,
} from "@mono-agent/telegram-adapter";
import * as z from "zod/v4";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import { appendPostedMessage } from "./posted-message-index.js";

// Lazy per module (mirrors channels.ts): a config without slack/telegram
// send-tool policy never pulls either SDK in.
type SlackAdapterModule = typeof import("@mono-agent/slack-adapter");
type TelegramAdapterModule = typeof import("@mono-agent/telegram-adapter");
let slackModule: SlackAdapterModule | undefined;
let telegramModule: TelegramAdapterModule | undefined;
const loadSlackModule = async (): Promise<SlackAdapterModule> =>
  (slackModule ??= await import("@mono-agent/slack-adapter"));
const loadTelegramModule = async (): Promise<TelegramAdapterModule> =>
  (telegramModule ??= await import("@mono-agent/telegram-adapter"));

/**
 * Model-visible send tools for explicitly allowed, already-enabled communication adapters.
 *
 * This mirrors `memory_recall`: agent-app injects a stdio MCP server through
 * per-request runtime options. The adapter config remains the source of truth:
 * if Slack or Telegram is disabled, invalid, blocked by tool policy, or lacks an
 * allowed destination policy, the corresponding send tool is not exposed. When
 * exposed, each tool enforces the same adapter allowlist before calling the
 * adapter-owned sender.
 */

export const ADAPTER_SEND_TOOLS_MCP_SERVER_NAME = "mono-agent-adapter-send";

export interface SlackSendToolSettings {
  readonly botToken: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
}

export interface TelegramSendToolSettings {
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowAllChats: boolean;
  /** Which telegram tools the policy permits (the adapter config gates the rest). */
  readonly tools: {
    readonly send: boolean;
    readonly ask: boolean;
    readonly document: boolean;
    readonly photo: boolean;
  };
}

export interface AdapterSendToolsSettings {
  readonly slack?: SlackSendToolSettings;
  readonly telegram?: TelegramSendToolSettings;
}

export interface AdapterSendToolsClients {
  readonly slack?: Pick<SlackWebApi, "chatPostMessage">;
  readonly telegram?: Pick<TelegramMessageSender, "sendMessage" | "sendDocument" | "sendPhoto">;
}

export interface AdapterSendToolsRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
}

/**
 * Where a posted message should be linked back to its producing conversation.
 * Forwarded to the stdio child so `slack_send_message` can record
 * `(channel, ts) → conversationId` — see {@link appendPostedMessage}.
 */
export interface AdapterSendToolsIndexing {
  readonly conversationId: string;
  readonly indexPath: string;
}

/** Minimal shape of the per-request runtime-options input we read (the producing conversationId). */
interface AdapterSendToolsRequestInput {
  readonly request?: { readonly conversationId?: string };
}

export interface AdapterSendToolsResolveOptions {
  readonly allowedTools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly logger?: {
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
  } | undefined;
}

export async function resolveAdapterSendToolsSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions = {},
): Promise<AdapterSendToolsSettings | undefined> {
  const telegramSendAllowed = isAdapterToolAllowed("telegram_send_message", options);
  const telegramAskAllowed = isAdapterToolAllowed("telegram_ask", options);
  const telegramDocumentAllowed = isAdapterToolAllowed("telegram_send_document", options);
  const telegramPhotoAllowed = isAdapterToolAllowed("telegram_send_photo", options);
  const telegramAnyAllowed =
    telegramSendAllowed || telegramAskAllowed || telegramDocumentAllowed || telegramPhotoAllowed;
  const [slack, telegram] = await Promise.all([
    isAdapterToolAllowed("slack_send_message", options)
      ? resolveSlackSendToolSettings(input, options)
      : undefined,
    telegramAnyAllowed
      ? resolveTelegramSendToolSettings(input, options, {
          send: telegramSendAllowed,
          ask: telegramAskAllowed,
          document: telegramDocumentAllowed,
          photo: telegramPhotoAllowed,
        })
      : undefined,
  ]);
  if (slack === undefined && telegram === undefined) {
    return undefined;
  }
  return {
    ...(slack === undefined ? {} : { slack }),
    ...(telegram === undefined ? {} : { telegram }),
  };
}

export function adapterSendToolNames(settings: AdapterSendToolsSettings): readonly string[] {
  const names: string[] = [];
  if (settings.slack !== undefined) {
    names.push("slack_send_message");
  }
  if (settings.telegram?.tools.send === true) {
    names.push("telegram_send_message");
  }
  if (settings.telegram?.tools.ask === true) {
    names.push("telegram_ask");
  }
  if (settings.telegram?.tools.document === true) {
    names.push("telegram_send_document");
  }
  if (settings.telegram?.tools.photo === true) {
    names.push("telegram_send_photo");
  }
  return names;
}

/**
 * Public re-export of the per-tool allow check so callers (e.g. the Telegram
 * channel driver) can gate behavior on whether a specific adapter send tool is
 * permitted by `tools.allowedTools`/`disallowedTools`, matching this module's policy.
 */
export function isAdapterSendToolAllowed(
  name: string,
  policy: { readonly allowedTools?: readonly string[]; readonly disallowedTools?: readonly string[] },
): boolean {
  return isAdapterToolAllowed(name, policy);
}

export function adapterSendToolsMcpEnv(
  configPath: string,
  allowedTools: readonly string[],
  indexing?: AdapterSendToolsIndexing,
): Record<string, string> {
  return {
    MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH: configPath,
    MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(allowedTools),
    ...(indexing === undefined
      ? {}
      : {
          MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID: indexing.conversationId,
          MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH: indexing.indexPath,
        }),
  };
}

export interface AdapterSendToolsChildConfig {
  readonly input: MonoAgentAppConfigInput;
  readonly allowedTools: readonly string[];
  readonly indexing?: AdapterSendToolsIndexing;
}

export function adapterSendToolsChildConfigFromEnv(env: Record<string, string | undefined>, cwd: string): AdapterSendToolsChildConfig {
  const configPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH);
  if (configPath === undefined) {
    throw new Error("adapter-send-tools: missing required environment (MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH).");
  }
  const conversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
  const indexPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH);
  // Both must be present to index; either alone is a misconfiguration we simply skip.
  const indexing = conversationId !== undefined && indexPath !== undefined ? { conversationId, indexPath } : undefined;
  return {
    input: { env, cwd, configPath },
    allowedTools: parseAllowedToolNames(env.MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS),
    ...(indexing === undefined ? {} : { indexing }),
  };
}

export function adapterSendToolsMcpServerSpec(
  configPath: string,
  cwd: string,
  allowedTools: readonly string[],
  indexing?: AdapterSendToolsIndexing,
): Record<string, unknown> {
  return {
    type: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./adapter-send-tools-main.js", import.meta.url))],
    cwd,
    env: adapterSendToolsMcpEnv(configPath, allowedTools, indexing),
  };
}

/**
 * Per-request runtime extension that injects the adapter-send stdio MCP server. It
 * reads the request's producing conversationId and, when an `indexPath` is
 * configured, forwards both to the child so a `slack_send_message` post is linked
 * back to this conversation (so a later in-thread reply resumes it).
 */
export function createAdapterSendToolsRuntimeExtension(
  configPath: string,
  cwd: string,
  allowedTools: readonly string[],
  indexPath?: string,
): (input: AdapterSendToolsRequestInput) => Promise<AdapterSendToolsRuntimeExtension> {
  return async (input) => {
    const conversationId = input?.request?.conversationId;
    const indexing =
      indexPath !== undefined && typeof conversationId === "string" && conversationId.trim().length > 0
        ? { conversationId, indexPath }
        : undefined;
    return {
      runtimeOptions: {
        mcpServers: {
          [ADAPTER_SEND_TOOLS_MCP_SERVER_NAME]: adapterSendToolsMcpServerSpec(configPath, cwd, allowedTools, indexing),
        },
      },
      cleanup: async () => {},
    };
  };
}

export async function createAdapterSendToolsClients(settings: AdapterSendToolsSettings): Promise<AdapterSendToolsClients> {
  const slack =
    settings.slack === undefined
      ? undefined
      : new (await loadSlackModule()).SlackWebApiClient({ botToken: settings.slack.botToken });
  const telegram =
    settings.telegram === undefined ? undefined : (await loadTelegramModule()).createTelegramMessageSender(settings.telegram.botToken);
  return {
    ...(slack === undefined ? {} : { slack }),
    ...(telegram === undefined ? {} : { telegram }),
  };
}

export async function createAdapterSendToolsServer(
  settings: AdapterSendToolsSettings,
  clients: AdapterSendToolsClients,
  indexing?: AdapterSendToolsIndexing,
): Promise<McpServer> {
  const server = new McpServer({ name: "agent-adapter-send-tools", version: "0.3.0" });

  if (settings.slack !== undefined && clients.slack !== undefined) {
    registerSlackSendTool(server, settings.slack, clients.slack, indexing);
  }
  if (settings.telegram !== undefined && clients.telegram !== undefined) {
    // Loaded once here (not per-register-call) because registerTelegramAskTool
    // needs TELEGRAM_ASK_MAX_OPTIONS synchronously while building its zod
    // schema, at registration time — not deferred into the request handler.
    const adapter = await loadTelegramModule();
    if (settings.telegram.tools.send) {
      registerTelegramSendTool(server, settings.telegram, clients.telegram);
    }
    if (settings.telegram.tools.ask) {
      registerTelegramAskTool(server, settings.telegram, clients.telegram, adapter);
    }
    if (settings.telegram.tools.document) {
      registerTelegramSendFileTool(server, settings.telegram, clients.telegram, "document", adapter);
    }
    if (settings.telegram.tools.photo) {
      registerTelegramSendFileTool(server, settings.telegram, clients.telegram, "photo", adapter);
    }
  }

  return server;
}

function registerSlackSendTool(
  server: McpServer,
  settings: SlackSendToolSettings,
  client: Pick<SlackWebApi, "chatPostMessage">,
  indexing?: AdapterSendToolsIndexing,
): void {
  server.registerTool(
    "slack_send_message",
    {
      title: "Send Slack message",
      description: "Send a message to an allowed Slack channel or DM ID using the configured Slack adapter bot token.",
      inputSchema: {
        channel: z.string().min(1).describe("Slack channel or DM ID, e.g. C123456 or D123456."),
        text: z.string().min(1).describe("Message text to send."),
        thread_ts: z.string().min(1).optional().describe("Optional Slack thread timestamp to reply in."),
        mrkdwn: z.boolean().optional().describe("Whether Slack mrkdwn formatting is enabled."),
        unfurl_links: z.boolean().optional().describe("Whether Slack should unfurl links."),
        unfurl_media: z.boolean().optional().describe("Whether Slack should unfurl media."),
      },
    },
    async (args) => {
      assertSlackChannelAllowed(settings, args.channel);
      const result: SlackChatPostMessageResult = await client.chatPostMessage({
        channel: args.channel.trim(),
        text: args.text,
        ...(args.thread_ts === undefined ? {} : { thread_ts: args.thread_ts }),
        ...(args.mrkdwn === undefined ? {} : { mrkdwn: args.mrkdwn }),
        ...(args.unfurl_links === undefined ? {} : { unfurl_links: args.unfurl_links }),
        ...(args.unfurl_media === undefined ? {} : { unfurl_media: args.unfurl_media }),
      });
      // Link the posted message back to this conversation so an in-thread reply can
      // resume it. Best-effort: appendPostedMessage never throws, so a failed index
      // write can never fail the send.
      if (indexing !== undefined) {
        await appendPostedMessage(indexing.indexPath, {
          channelId: result.channel,
          ts: result.ts,
          conversationId: indexing.conversationId,
        });
      }
      return {
        content: [{ type: "text", text: `Sent Slack message to ${result.channel} at ${result.ts}.` }],
        structuredContent: { ok: true, channel: result.channel, ts: result.ts },
      };
    },
  );
}

function registerTelegramSendTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Pick<TelegramMessageSender, "sendMessage">,
): void {
  server.registerTool(
    "telegram_send_message",
    {
      title: "Send Telegram message",
      description: "Send a message to an allowed Telegram chat using the configured Telegram adapter bot token.",
      inputSchema: {
        chat_id: z.union([z.string().min(1), z.number().int()]).describe("Telegram chat id from the adapter allowlist."),
        text: z.string().min(1).describe("Message text to send."),
        parse_mode: z.string().min(1).optional().describe("Optional Telegram parse mode, e.g. MarkdownV2 or HTML."),
        reply_to_message_id: z.number().int().optional().describe("Optional message id to reply to."),
        disable_web_page_preview: z.boolean().optional().describe("Disable Telegram link previews."),
      },
    },
    async (args) => {
      assertTelegramChatAllowed(settings, args.chat_id);
      const result: TelegramSentMessage = await client.sendMessage({
        chat_id: args.chat_id,
        text: args.text,
        ...(args.parse_mode === undefined ? {} : { parse_mode: args.parse_mode }),
        ...(args.reply_to_message_id === undefined ? {} : { reply_to_message_id: args.reply_to_message_id }),
        ...(args.disable_web_page_preview === undefined ? {} : { disable_web_page_preview: args.disable_web_page_preview }),
      });
      return {
        content: [{ type: "text", text: `Sent Telegram message ${result.message_id} to ${String(result.chat.id)}.` }],
        structuredContent: { ok: true, chat_id: result.chat.id, message_id: result.message_id },
      };
    },
  );
}

function registerTelegramAskTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Pick<TelegramMessageSender, "sendMessage">,
  adapter: TelegramAdapterModule,
): void {
  server.registerTool(
    "telegram_ask",
    {
      title: "Ask via Telegram buttons",
      description:
        "Ask the owner a question in an allowed Telegram chat with tappable inline-keyboard options (e.g. a confirmation or a multiple-choice). This tool returns immediately after posting the question; it does NOT wait for the answer. When the user taps a button, their choice arrives as a new message on the same conversation, so continue on that next turn.",
      inputSchema: {
        chat_id: z.union([z.string().min(1), z.number().int()]).describe("Telegram chat id from the adapter allowlist."),
        question: z.string().min(1).describe("The question to show above the buttons."),
        options: z
          .array(z.string().min(1).max(100))
          .min(2)
          .max(adapter.TELEGRAM_ASK_MAX_OPTIONS)
          .describe("Button labels (2–8). The label the user taps is echoed back as a new message."),
        note: z.string().min(1).optional().describe("Optional extra context shown beneath the question."),
      },
    },
    async (args) => {
      assertTelegramChatAllowed(settings, args.chat_id);
      const inlineKeyboard = args.options.map((label, index) => [
        { text: label, callback_data: adapter.telegramAskCallbackData(index) },
      ]);
      const text = args.note === undefined ? args.question : `${args.question}\n\n${args.note}`;
      const result: TelegramSentMessage = await client.sendMessage({
        chat_id: args.chat_id,
        text,
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
      return {
        content: [
          {
            type: "text",
            text: `Posted question ${result.message_id} to ${String(result.chat.id)} with ${String(args.options.length)} options. The user's choice will arrive as a new message.`,
          },
        ],
        structuredContent: {
          ok: true,
          chat_id: result.chat.id,
          message_id: result.message_id,
          options: args.options,
        },
      };
    },
  );
}

/**
 * Register `telegram_send_document` / `telegram_send_photo`. Both accept the file
 * as base64 `data` (with a `filename`) OR a workspace `path` (filename derived
 * from the basename), enforce the adapter allowlist, and bound the size to the
 * adapter's inbound cap before uploading via the adapter-owned sender.
 */
function registerTelegramSendFileTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Pick<TelegramMessageSender, "sendDocument" | "sendPhoto">,
  kind: "document" | "photo",
  adapter: TelegramAdapterModule,
): void {
  const toolName = kind === "document" ? "telegram_send_document" : "telegram_send_photo";
  server.registerTool(
    toolName,
    {
      title: kind === "document" ? "Send Telegram document" : "Send Telegram photo",
      description:
        kind === "document"
          ? "Upload and send a file (document) to an allowed Telegram chat. Provide the bytes as base64 `data` with a `filename`, or a workspace `path`."
          : "Upload and send an image (photo, shown inline) to an allowed Telegram chat. Provide the bytes as base64 `data`, or a workspace `path`.",
      inputSchema: {
        chat_id: z.union([z.string().min(1), z.number().int()]).describe("Telegram chat id from the adapter allowlist."),
        data: z.string().min(1).optional().describe("Base64-encoded file bytes. Provide this or `path`."),
        path: z.string().min(1).optional().describe("Path to a file to upload (resolved against the agent working dir). Provide this or `data`."),
        filename: z.string().min(1).optional().describe("Filename to present. Required with `data` for a document; derived from `path` otherwise."),
        caption: z.string().min(1).optional().describe("Optional caption shown with the file."),
      },
    },
    async (args) => {
      assertTelegramChatAllowed(settings, args.chat_id);
      const { bytes, filename } = await resolveTelegramFileBytes({
        data: args.data,
        path: args.path,
        filename: args.filename,
        requireFilename: kind === "document",
        maxBytes: adapter.DEFAULT_ATTACHMENT_MAX_BYTES,
      });
      const result: TelegramSentMessage =
        kind === "document"
          ? await client.sendDocument!({
              chat_id: args.chat_id,
              document: bytes,
              filename,
              ...(args.caption === undefined ? {} : { caption: args.caption }),
            })
          : await client.sendPhoto!({
              chat_id: args.chat_id,
              photo: bytes,
              filename,
              ...(args.caption === undefined ? {} : { caption: args.caption }),
            });
      return {
        content: [{ type: "text", text: `Sent ${kind} ${result.message_id} (${filename}) to ${String(result.chat.id)}.` }],
        structuredContent: { ok: true, chat_id: result.chat.id, message_id: result.message_id, filename },
      };
    },
  );
}

/** Resolve the upload bytes + filename from exactly one of base64 `data` or a `path`. */
async function resolveTelegramFileBytes(input: {
  data: string | undefined;
  path: string | undefined;
  filename: string | undefined;
  requireFilename: boolean;
  maxBytes: number;
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const hasData = input.data !== undefined;
  const hasPath = input.path !== undefined;
  if (hasData === hasPath) {
    throw new Error("provide exactly one of `data` (base64) or `path`.");
  }
  let bytes: Uint8Array;
  let filename: string;
  if (hasData) {
    bytes = new Uint8Array(Buffer.from(input.data!, "base64"));
    if (input.filename === undefined) {
      if (input.requireFilename) {
        throw new Error("`filename` is required when sending a document by `data`.");
      }
      filename = "image";
    } else {
      filename = input.filename;
    }
  } else {
    const resolved = resolvePath(process.cwd(), input.path!);
    bytes = new Uint8Array(await readFile(resolved));
    filename = input.filename ?? basename(resolved);
  }
  if (bytes.byteLength === 0) {
    throw new Error("file is empty.");
  }
  if (bytes.byteLength > input.maxBytes) {
    throw new Error(`file exceeds the ${String(input.maxBytes)}-byte upload cap.`);
  }
  return { bytes, filename };
}

async function resolveSlackSendToolSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions,
): Promise<SlackSendToolSettings | undefined> {
  try {
    const adapter = await loadSlackModule();
    const config = await adapter.loadSlackAdapterConfig({ env: input.env, jsonPath: input.configPath });
    if (!config.enabled) {
      return undefined;
    }
    return {
      botToken: config.botToken,
      allowedChannelIds: config.allowedChannelIds.map(normalizeSlackChannelId),
      allowAllChannels: config.allowAllChannels,
    };
  } catch (error) {
    options.logger?.warn?.("Slack send tool skipped because Slack adapter config is unavailable.", {
      reason: reasonOf(error),
    });
    return undefined;
  }
}

async function resolveTelegramSendToolSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions,
  tools: TelegramSendToolSettings["tools"],
): Promise<TelegramSendToolSettings | undefined> {
  try {
    const adapter = await loadTelegramModule();
    const config = await adapter.loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    if (!config.enabled) {
      return undefined;
    }
    return {
      botToken: config.botToken,
      allowedChatIds: config.allowedChatIds,
      allowAllChats: config.allowAllChats,
      tools,
    };
  } catch (error) {
    options.logger?.warn?.("Telegram send tool skipped because Telegram adapter config is unavailable.", {
      reason: reasonOf(error),
    });
    return undefined;
  }
}

function assertSlackChannelAllowed(settings: SlackSendToolSettings, channel: string): void {
  if (settings.allowAllChannels || settings.allowedChannelIds.includes(normalizeSlackChannelId(channel))) {
    return;
  }
  throw new Error("slack_send_message: channel is not allowed by Slack adapter config.");
}

function assertTelegramChatAllowed(settings: TelegramSendToolSettings, chatId: TelegramChatId): void {
  const normalized = String(chatId);
  if (settings.allowAllChats || settings.allowedChatIds.includes(normalized)) {
    return;
  }
  throw new Error("telegram_send_message: chat_id is not allowed by Telegram adapter config.");
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function normalizeSlackChannelId(value: string): string {
  return value.trim().toLowerCase();
}

function isAdapterToolAllowed(name: string, options: AdapterSendToolsResolveOptions): boolean {
  const wildcard = `mcp__${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}__*`;
  const aliases = [name, `mcp__${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}__${name}`];
  const allowed = options.allowedTools ?? [];
  const disallowed = options.disallowedTools ?? [];
  if (disallowed.includes(wildcard) || aliases.some((alias) => disallowed.includes(alias))) {
    return false;
  }
  if (aliases.some((alias) => allowed.includes(alias))) {
    return true;
  }
  return allowed.includes(wildcard);
}

function parseAllowedToolNames(raw: string | undefined): readonly string[] {
  const value = optionalString(raw);
  if (value === undefined) {
    throw new Error("adapter-send-tools: missing required environment (MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS).");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("adapter-send-tools: invalid MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS (expected a JSON string array).");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("adapter-send-tools: invalid MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS (expected a JSON string array).");
  }
  return parsed;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
