import process from "node:process";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bucketConversationId, createSqliteHistoryStore } from "@mono-agent/history-store";
import {
  SlackWebApiClient,
  loadSlackAdapterConfig,
} from "@mono-agent/slack-adapter";
import type {
  SlackChatPostMessageResult,
  SlackWebApi,
} from "@mono-agent/slack-adapter";
import {
  createTelegramMessageSender,
  loadTelegramAdapterConfig,
} from "@mono-agent/telegram-adapter";
import type {
  TelegramChatId,
  TelegramMessageSender,
  TelegramSentMessage,
} from "@mono-agent/telegram-adapter";
import * as z from "zod/v4";

import type { MonoAgentAppConfigInput } from "./app-config.js";

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
}

export interface AdapterSendToolsSettings {
  readonly slack?: SlackSendToolSettings;
  readonly telegram?: TelegramSendToolSettings;
}

export interface AdapterSendToolsClients {
  readonly slack?: Pick<SlackWebApi, "chatPostMessage">;
  readonly telegram?: Pick<TelegramMessageSender, "sendMessage">;
}

export interface AdapterSendToolsRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
}

/**
 * Where a proactive send is recorded so the destination channel sees it next
 * turn. `dbPath` is the shared history db; `rollover`/`rolloverTimezone` mirror
 * the responder's daily bucketing so the record keys to the same thread.
 */
export interface AdapterSendToolsHistoryConfig {
  readonly dbPath: string;
  readonly rollover?: string;
  readonly rolloverTimezone?: string;
}

/** Appends a sent message into the destination conversation's shared history. */
export interface SendRecorder {
  record(conversationId: string, text: string): Promise<void>;
}

/**
 * Build a recorder backed by the shared SQLite history store. A send is recorded
 * as an `assistant` turn tagged `source: "proactive"` so the next live turn can
 * tell a pushed message apart from an in-channel reply.
 */
export function createHistorySendRecorder(history: AdapterSendToolsHistoryConfig): SendRecorder {
  const store = createSqliteHistoryStore({ path: history.dbPath });
  return {
    async record(conversationId, text) {
      const bucketed = bucketConversationId(conversationId, history.rollover, history.rolloverTimezone, () => new Date());
      await store.append(bucketed, [
        { role: "assistant", content: text, source: "proactive", timestamp: new Date().toISOString() },
      ]);
    },
  };
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
  const [slack, telegram] = await Promise.all([
    isAdapterToolAllowed("slack_send_message", options)
      ? resolveSlackSendToolSettings(input, options)
      : undefined,
    isAdapterToolAllowed("telegram_send_message", options)
      ? resolveTelegramSendToolSettings(input, options)
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
  if (settings.telegram !== undefined) {
    names.push("telegram_send_message");
  }
  return names;
}

export function adapterSendToolsMcpEnv(
  configPath: string,
  allowedTools: readonly string[],
  history?: AdapterSendToolsHistoryConfig,
): Record<string, string> {
  return {
    MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH: configPath,
    MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(allowedTools),
    ...(history === undefined
      ? {}
      : {
          MONO_AGENT_HISTORY_DB_PATH: history.dbPath,
          ...(history.rollover === undefined ? {} : { MONO_AGENT_HISTORY_ROLLOVER: history.rollover }),
          ...(history.rolloverTimezone === undefined ? {} : { MONO_AGENT_HISTORY_ROLLOVER_TZ: history.rolloverTimezone }),
        }),
  };
}

export interface AdapterSendToolsChildConfig {
  readonly input: MonoAgentAppConfigInput;
  readonly allowedTools: readonly string[];
  readonly history?: AdapterSendToolsHistoryConfig;
}

export function adapterSendToolsChildConfigFromEnv(env: Record<string, string | undefined>, cwd: string): AdapterSendToolsChildConfig {
  const configPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH);
  if (configPath === undefined) {
    throw new Error("adapter-send-tools: missing required environment (MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH).");
  }
  const dbPath = optionalString(env.MONO_AGENT_HISTORY_DB_PATH);
  const rollover = optionalString(env.MONO_AGENT_HISTORY_ROLLOVER);
  const rolloverTimezone = optionalString(env.MONO_AGENT_HISTORY_ROLLOVER_TZ);
  const history: AdapterSendToolsHistoryConfig | undefined =
    dbPath === undefined
      ? undefined
      : {
          dbPath,
          ...(rollover === undefined ? {} : { rollover }),
          ...(rolloverTimezone === undefined ? {} : { rolloverTimezone }),
        };
  return {
    input: { env, cwd, configPath },
    allowedTools: parseAllowedToolNames(env.MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS),
    ...(history === undefined ? {} : { history }),
  };
}

export function adapterSendToolsMcpServerSpec(
  configPath: string,
  cwd: string,
  allowedTools: readonly string[],
  history?: AdapterSendToolsHistoryConfig,
): Record<string, unknown> {
  return {
    type: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./adapter-send-tools-main.js", import.meta.url))],
    cwd,
    env: adapterSendToolsMcpEnv(configPath, allowedTools, history),
  };
}

export function createAdapterSendToolsRuntimeExtension(
  configPath: string,
  cwd: string,
  allowedTools: readonly string[],
  history?: AdapterSendToolsHistoryConfig,
): () => Promise<AdapterSendToolsRuntimeExtension> {
  return async () => ({
    runtimeOptions: {
      mcpServers: {
        [ADAPTER_SEND_TOOLS_MCP_SERVER_NAME]: adapterSendToolsMcpServerSpec(configPath, cwd, allowedTools, history),
      },
    },
    cleanup: async () => {},
  });
}

export function createAdapterSendToolsClients(settings: AdapterSendToolsSettings): AdapterSendToolsClients {
  return {
    ...(settings.slack === undefined
      ? {}
      : {
          slack: new SlackWebApiClient({
            botToken: settings.slack.botToken,
          }),
        }),
    ...(settings.telegram === undefined
      ? {}
      : {
          telegram: createTelegramMessageSender(settings.telegram.botToken),
        }),
  };
}

export function createAdapterSendToolsServer(
  settings: AdapterSendToolsSettings,
  clients: AdapterSendToolsClients,
  recorder?: SendRecorder,
): McpServer {
  const server = new McpServer({ name: "agent-adapter-send-tools", version: "0.3.0" });

  if (settings.slack !== undefined && clients.slack !== undefined) {
    registerSlackSendTool(server, settings.slack, clients.slack, recorder);
  }
  if (settings.telegram !== undefined && clients.telegram !== undefined) {
    registerTelegramSendTool(server, settings.telegram, clients.telegram, recorder);
  }

  return server;
}

/**
 * Record a proactive send into the destination conversation's shared history,
 * best-effort: the message already went out, so a recording failure must not
 * fail the tool call.
 */
async function recordSend(recorder: SendRecorder | undefined, conversationId: string, text: string): Promise<void> {
  if (recorder === undefined) {
    return;
  }
  try {
    await recorder.record(conversationId, text);
  } catch {
    // Best-effort: the send succeeded; swallow recording errors.
  }
}

function registerSlackSendTool(
  server: McpServer,
  settings: SlackSendToolSettings,
  client: Pick<SlackWebApi, "chatPostMessage">,
  recorder?: SendRecorder,
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
      // Record the proactive send under the same conversationId the Slack adapter
      // derives (slack:<channel>:<threadTs>) so the destination thread sees it.
      await recordSend(recorder, `slack:${result.channel}:${args.thread_ts ?? result.ts}`, args.text);
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
  recorder?: SendRecorder,
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
      // Record under the same conversationId the Telegram adapter derives
      // (telegram:<chat.id>) so the destination chat sees it next turn.
      await recordSend(recorder, `telegram:${String(result.chat.id)}`, args.text);
      return {
        content: [{ type: "text", text: `Sent Telegram message ${result.message_id} to ${String(result.chat.id)}.` }],
        structuredContent: { ok: true, chat_id: result.chat.id, message_id: result.message_id },
      };
    },
  );
}

async function resolveSlackSendToolSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions,
): Promise<SlackSendToolSettings | undefined> {
  try {
    const config = await loadSlackAdapterConfig({ env: input.env, jsonPath: input.configPath });
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
): Promise<TelegramSendToolSettings | undefined> {
  try {
    const config = await loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    if (!config.enabled) {
      return undefined;
    }
    return {
      botToken: config.botToken,
      allowedChatIds: config.allowedChatIds,
      allowAllChats: config.allowAllChats,
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
