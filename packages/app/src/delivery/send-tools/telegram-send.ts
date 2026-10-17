import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramChatId, TelegramMessageSender, TelegramSentMessage } from "@mono-agent/channel-telegram";
import {
  formatTelegramConversationTarget,
  type TelegramConversationTarget,
} from "@mono-agent/channel-telegram/conversation";
import * as z from "zod/v4";

import {
  telegramTargetFromConversation,
  telegramTopicOfMessage,
} from "../../telegram-destination.js";
import { recordAdapterDeliveryHistory, withDeliveryHistoryWarning } from "./delivery-history.js";
import { readStrictTelegramFile, resolveTelegramFileBytes, resolveTelegramUploadPath } from "./telegram-file-access.js";
import type { TelegramAdapterModule, TelegramSendToolSettings, AdapterSendToolsDeliveryHistory } from "./types.js";

type TelegramSendToolName = "TelegramSendMessage" | "TelegramSendFile";

export function registerTelegramSendTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Pick<TelegramMessageSender, "sendMessage">,
  adapter: TelegramAdapterModule,
  deliveryHistory?: AdapterSendToolsDeliveryHistory,
  fetchImpl: typeof fetch = globalThis.fetch,
): void {
  // Project targets need the app-owned bridge; producing-conversation scope binds the destination already.
  const projectTargets = settings.projects === true && settings.sendTools?.scope !== "producing-conversation";
  server.registerTool(
    "TelegramSendMessage",
    {
      title: "Send Telegram message",
      description: projectTargets
        ? "Send a message to an allowed Telegram chat, or with projectId into the forum topic of a Telegram-linked project. Optionally add 2–8 non-blocking reply buttons; a tap arrives later as a new user turn."
        : "Send a message to an allowed Telegram chat. Optionally add 2–8 non-blocking reply buttons; a tap arrives later as a new user turn.",
      inputSchema: {
        chat_id: projectTargets
          ? z.union([z.string().min(1), z.number().int()]).optional().describe("Telegram chat id from the adapter allowlist. Omit when sending by projectId.")
          : z.union([z.string().min(1), z.number().int()]).describe("Telegram chat id from the adapter allowlist."),
        ...(projectTargets ? { projectId: TELEGRAM_PROJECT_ID_SCHEMA } : {}),
        text: z.string().min(1).describe("Message text to send."),
        parse_mode: z.string().min(1).optional().describe("Optional Telegram parse mode, e.g. MarkdownV2 or HTML."),
        message_thread_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional forum topic id to post into. When omitted, a send to the chat this conversation is in stays in the current topic; any other chat gets its main conversation (a forum's General topic)."),
        reply_to_message_id: z.number().int().optional().describe("Optional message id to reply to."),
        disable_web_page_preview: z.boolean().optional().describe("Disable Telegram link previews."),
        reply_options: z
          .array(z.string().min(1).max(75))
          .min(2)
          .max(8)
          .optional()
          .describe("Optional non-blocking reply button labels. Use AskUser when this run must wait for the selection."),
      },
    },
    async (args, extra) => {
      const projectId = "projectId" in args ? args.projectId as string | undefined : undefined;
      const project = projectId === undefined
        ? undefined
        : await resolveTelegramProjectTarget(settings, deliveryHistory, fetchImpl, projectId, "TelegramSendMessage",
          args.chat_id !== undefined || args.message_thread_id !== undefined);
      if (project === undefined && args.chat_id === undefined) throw new Error("TelegramSendMessage: chat_id or projectId is required.");
      const chatId = project?.target.chatId ?? args.chat_id!;
      assertTelegramChatAllowed(settings, chatId, "TelegramSendMessage");
      // A reply lands in the replied message's topic, so only a fresh post
      // inherits the current topic by default. A project names its own topic.
      const messageThreadId = project !== undefined
        ? project.target.messageThreadId
        : resolveTelegramThreadId(
            settings,
            chatId,
            args.message_thread_id,
            "TelegramSendMessage",
            args.reply_to_message_id === undefined,
          );
      const result: TelegramSentMessage = await withTopicGoneReport(settings, adapter, deliveryHistory, fetchImpl,
        formatTelegramConversationTarget({ chatId, ...(messageThreadId === undefined ? {} : { messageThreadId }) }),
        "TelegramSendMessage", () => client.sendMessage(
        {
          chat_id: chatId,
          ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
          text: args.text,
          ...(args.parse_mode === undefined ? {} : { parse_mode: args.parse_mode }),
          ...(args.reply_to_message_id === undefined ? {} : { reply_to_message_id: args.reply_to_message_id }),
          ...(args.disable_web_page_preview === undefined ? {} : { disable_web_page_preview: args.disable_web_page_preview }),
          ...(args.reply_options === undefined
            ? {}
            : {
                reply_markup: {
                  inline_keyboard: args.reply_options.map((label, index) => [{
                    text: label,
                    callback_data: adapter.telegramReplyCallbackData(index),
                  }]),
                },
              }),
        },
        { signal: extra.signal },
      ));
      // Record against the conversation the message actually landed in: a forum
      // topic keeps its own history, everything else the chat's main one. A
      // result without thread fields (a minimal custom client) trusts the request.
      const landedTopic = telegramTopicOfMessage(result)
        ?? (result.message_thread_id === undefined ? messageThreadId : undefined);
      const history = await recordAdapterDeliveryHistory({
        settings: deliveryHistory,
        fetchImpl,
        conversationId: formatTelegramConversationTarget({
          chatId: result.chat.id,
          ...(landedTopic === undefined ? {} : { messageThreadId: landedTopic }),
        }),
        text: args.text,
        idempotencyKey: `adapter-send:telegram:${String(result.chat.id)}:${String(result.message_id)}`,
      });
      // A project send reports the project, never the chat or topic ids behind it.
      const message = project === undefined
        ? `Sent Telegram message ${result.message_id} to ${String(result.chat.id)}.`
        : `Sent Telegram message ${result.message_id} to project ${JSON.stringify(project.label)}.`;
      return {
        content: [{ type: "text", text: withDeliveryHistoryWarning(message, history) }],
        structuredContent: {
          ok: true,
          ...(project === undefined
            ? { chat_id: result.chat.id, ...(landedTopic === undefined ? {} : { message_thread_id: landedTopic }) }
            : { projectId, destination: project.label }),
          message_id: result.message_id,
          ...(args.reply_options === undefined ? {} : { reply_options: args.reply_options }),
          ...(history === undefined ? {} : { history }),
        },
      };
    },
  );
}

/**
 * Register the single `TelegramSendFile` tool. A required `kind` param selects
 * `"document"` (any file, shown as a downloadable document) or `"photo"` (an image
 * shown inline). Both accept the file as base64 `data` (with a `filename`) OR a
 * workspace `path` (filename derived from the basename), enforce the adapter
 * allowlist, and bound the size to the adapter's inbound cap before uploading via
 * the adapter-owned sender. Producing-conversation scope omits `chat_id` from the
 * schema and derives it from trusted request context instead.
 */
export function registerTelegramSendFileTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Partial<Pick<TelegramMessageSender, "sendDocument" | "sendPhoto">>,
  adapter: TelegramAdapterModule,
  deliveryHistory?: AdapterSendToolsDeliveryHistory,
  fetchImpl: typeof fetch = globalThis.fetch,
): void {
  const producingConversationScope = settings.sendTools?.scope === "producing-conversation";
  const projectTargets = settings.projects === true && !producingConversationScope;
  const inputSchema = {
    kind: z.enum(["document", "photo"]).describe("`document` for any file (downloadable), `photo` for an image shown inline."),
    ...(producingConversationScope
      ? {}
      : {
          chat_id: projectTargets
            ? z
              .union([z.string().min(1), z.number().int()])
              .optional()
              .describe("Telegram chat id from the adapter allowlist. Omit when sending by projectId.")
            : z
              .union([z.string().min(1), z.number().int()])
              .describe("Telegram chat id from the adapter allowlist."),
          ...(projectTargets ? { projectId: TELEGRAM_PROJECT_ID_SCHEMA } : {}),
          message_thread_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional forum topic id to post into. When omitted, a send to the chat this conversation is in stays in the current topic; any other chat gets its main conversation (a forum's General topic)."),
        }),
    data: z.string().min(1).optional().describe("Base64-encoded file bytes. Provide this or `path`."),
    path: z.string().min(1).optional().describe("Path to a file to upload (resolved against the agent working dir). Provide this or `data`."),
    filename: z.string().min(1).optional().describe("Filename to present. Required with `data` for a document; derived from `path` otherwise."),
    caption: z.string().min(1).optional().describe("Optional caption shown with the file."),
  };
  server.registerTool(
    "TelegramSendFile",
    {
      title: "Send Telegram file",
      description: producingConversationScope
        ? "Upload and send a file to the Telegram conversation that produced this run. The host binds the destination; provide only the file content or path. Set `kind:\"document\"` to send any file (shown as a downloadable document) or `kind:\"photo\"` to send an image inline. Strict run-output paths are always read through a pinned descriptor."
        : "Upload and send a file to an allowed Telegram chat. Set `kind:\"document\"` to send any file (shown as a downloadable document) or `kind:\"photo\"` to send an image inline. Provide the bytes as base64 `data` (with a `filename` — required for a document), or a workspace `path`. A self-hosted Bot API can stream legacy path uploads.",
      inputSchema,
    },
    async (args, extra) => {
      extra.signal.throwIfAborted();
      const kind = args.kind;
      const sendDocument = client.sendDocument;
      const sendPhoto = client.sendPhoto;
      if ((kind === "document" && sendDocument === undefined) || (kind === "photo" && sendPhoto === undefined)) {
        throw new Error(`TelegramSendFile: the ${kind} sender is unavailable.`);
      }
      const requestedChatId = "chat_id" in args ? args.chat_id as TelegramChatId | undefined : undefined;
      const requestedThreadId = "message_thread_id" in args ? args.message_thread_id as number | undefined : undefined;
      const projectId = "projectId" in args ? args.projectId as string | undefined : undefined;
      const project = projectId === undefined
        ? undefined
        : await resolveTelegramProjectTarget(settings, deliveryHistory, fetchImpl, projectId, "TelegramSendFile",
          requestedChatId !== undefined || requestedThreadId !== undefined);
      const destination = project === undefined
        ? resolveTelegramSendFileDestination(settings, requestedChatId, requestedThreadId)
        : project.target;
      const chatId = destination.chatId;
      const landing = formatTelegramConversationTarget(destination);
      const reportGone = <T>(send: () => Promise<T>) => withTopicGoneReport(settings, adapter, deliveryHistory, fetchImpl, landing, "TelegramSendFile", send);
      const threadParams = destination.messageThreadId === undefined
        ? {}
        : { message_thread_id: destination.messageThreadId };
      if ((args.data !== undefined) === (args.path !== undefined)) {
        throw new Error("provide exactly one of `data` (base64) or `path`.");
      }
      const maxUploadBytes = settings.maxUploadBytes ?? adapter.DEFAULT_ATTACHMENT_MAX_BYTES;
      const strictPathUpload = args.path !== undefined && settings.sendTools?.pathScope === "run-output";
      const strictFile = strictPathUpload
        ? await readStrictTelegramFile(settings, args.path!, maxUploadBytes, extra.signal, args.filename)
        : undefined;
      const uploadPath = args.path === undefined || strictPathUpload
        ? undefined
        : await resolveTelegramUploadPath(args.path);
      // file:// fast path: a --local self-hosted server reads the file straight
      // from disk, so a path upload needs no buffering at any size — only a
      // stat-level cap check. Falls back once to the buffered path when the
      // server rejects the URI (e.g. a non---local self-hosted root).
      if (kind === "document" && settings.apiRoot !== undefined && uploadPath !== undefined && args.data === undefined) {
        const info = await stat(uploadPath);
        if (!info.isFile() || info.size === 0) {
          throw new Error("file is empty or not a regular file.");
        }
        if (info.size > maxUploadBytes) {
          throw new Error(`file exceeds the ${String(maxUploadBytes)}-byte upload cap.`);
        }
        try {
          const sent: TelegramSentMessage = await reportGone(() => sendDocument!(
            {
              chat_id: chatId,
              ...threadParams,
              document: pathToFileURL(uploadPath).href,
              ...(args.caption === undefined ? {} : { caption: args.caption }),
            },
            { signal: extra.signal },
          ));
          const name = basename(uploadPath);
          return telegramSendFileResult(producingConversationScope, kind, sent, name, project === undefined ? undefined : { projectId: projectId!, label: project.label });
        } catch (error) {
          // Retry buffered exactly once; rethrow anything that isn't a server-side rejection.
          if ((error as { kind?: string }).kind !== "telegram") {
            throw error;
          }
        }
      }
      const { bytes, filename } = strictFile ?? await resolveTelegramFileBytes({
          data: args.data,
          path: args.path,
          ...(uploadPath === undefined ? {} : { resolvedPath: uploadPath }),
          filename: args.filename,
          requireFilename: kind === "document",
          maxBytes: maxUploadBytes,
          signal: extra.signal,
      });
      const result: TelegramSentMessage = await reportGone(() =>
        kind === "document"
          ? sendDocument!(
              {
                chat_id: chatId,
                ...threadParams,
                document: bytes,
                filename,
                ...(args.caption === undefined ? {} : { caption: args.caption }),
              },
              { signal: extra.signal },
            )
          : sendPhoto!(
              {
                chat_id: chatId,
                ...threadParams,
                photo: bytes,
                filename,
                ...(args.caption === undefined ? {} : { caption: args.caption }),
              },
              { signal: extra.signal },
            ));
      return telegramSendFileResult(producingConversationScope, kind, result, filename, project === undefined ? undefined : { projectId: projectId!, label: project.label });
    },
  );
}

function resolveTelegramSendFileDestination(
  settings: TelegramSendToolSettings,
  requestedChatId: TelegramChatId | undefined,
  requestedThreadId: number | undefined,
): { readonly chatId: TelegramChatId; readonly messageThreadId?: number } {
  if (settings.sendTools?.scope === "producing-conversation") {
    const producing = producingTelegramTarget(settings);
    if (producing === undefined) {
      throw new Error("TelegramSendFile: producing Telegram conversation context is unavailable.");
    }
    const producingChatId = String(producing.chatId);
    assertTelegramChatAllowed(settings, producingChatId, "TelegramSendFile");
    return producing.messageThreadId === undefined
      ? { chatId: producingChatId }
      : { chatId: producingChatId, messageThreadId: producing.messageThreadId };
  }
  if (requestedChatId === undefined) {
    throw new Error("TelegramSendFile: chat_id is required outside producing-conversation scope.");
  }
  assertTelegramChatAllowed(settings, requestedChatId, "TelegramSendFile");
  const messageThreadId = requestedThreadId ?? currentTopicFor(settings, requestedChatId);
  return messageThreadId === undefined
    ? { chatId: requestedChatId }
    : { chatId: requestedChatId, messageThreadId };
}

/**
 * The forum topic a Telegram send targets. An explicit topic wins; otherwise a
 * send to the chat of the producing conversation stays in that conversation's
 * topic, so a run in a topic never spills into General by omission. In
 * producing-conversation scope a different explicit topic is rejected.
 */
function resolveTelegramThreadId(
  settings: TelegramSendToolSettings,
  chatId: TelegramChatId,
  requestedThreadId: number | undefined,
  toolName: TelegramSendToolName,
  inheritCurrentTopic = true,
): number | undefined {
  if (settings.sendTools?.scope !== "producing-conversation") {
    return requestedThreadId ?? (inheritCurrentTopic ? currentTopicFor(settings, chatId) : undefined);
  }
  const producing = producingTelegramTarget(settings);
  if (producing === undefined) {
    throw new Error(`${toolName}: producing Telegram conversation context is unavailable.`);
  }
  if (requestedThreadId !== undefined && requestedThreadId !== producing.messageThreadId) {
    throw new Error(`${toolName}: message_thread_id must match the producing Telegram conversation.`);
  }
  return producing.messageThreadId;
}

function producingTelegramTarget(settings: TelegramSendToolSettings): TelegramConversationTarget | undefined {
  return telegramTargetFromConversation(settings.producingConversationId);
}

/** The producing conversation's topic when `chatId` is that conversation's chat. */
function currentTopicFor(settings: TelegramSendToolSettings, chatId: TelegramChatId): number | undefined {
  const producing = producingTelegramTarget(settings);
  return producing !== undefined && String(producing.chatId) === String(chatId).trim()
    ? producing.messageThreadId
    : undefined;
}

function telegramSendFileResult(
  producingConversationScope: boolean,
  kind: "document" | "photo",
  sent: TelegramSentMessage,
  filename: string,
  project?: { readonly projectId: string; readonly label: string },
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const destination = project !== undefined
    ? `project ${JSON.stringify(project.label)}`
    : producingConversationScope
      ? "the producing Telegram conversation"
      : String(sent.chat.id);
  return {
    content: [{ type: "text", text: `Sent ${kind} ${sent.message_id} (${filename}) to ${destination}.` }],
    structuredContent: {
      ok: true,
      ...(project !== undefined
        ? { projectId: project.projectId, destination: project.label }
        : producingConversationScope ? {} : { chat_id: sent.chat.id }),
      message_id: sent.message_id,
      filename,
    },
  };
}

const TELEGRAM_PROJECT_ID_SCHEMA = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe("Send into the forum topic of this Telegram-linked project (an id from ListProjects or GetProject whose external.channel is telegram). Exclusive with chat_id and message_thread_id. Refused when the topic is closed or gone; never redirected to General. Names are not unique: ask the user when several projects match.");

const PROJECT_BRIDGE_TIMEOUT_MS = 5_000;

/**
 * Resolve `projectId` through the app-owned bridge to its forum topic. The
 * topic's chat and thread ids stay inside this app-owned child; the model only
 * ever sees the project id and its label. The allowlist is rechecked here and
 * by the parent.
 */
async function resolveTelegramProjectTarget(
  settings: TelegramSendToolSettings,
  bridge: AdapterSendToolsDeliveryHistory | undefined,
  fetchImpl: typeof fetch,
  projectId: string,
  toolName: TelegramSendToolName,
  conflictingTarget: boolean,
): Promise<{ readonly target: TelegramConversationTarget; readonly label: string }> {
  if (conflictingTarget) throw new Error(`${toolName}: projectId cannot be combined with chat_id or message_thread_id.`);
  if (bridge === undefined) throw new Error(`${toolName}: project destinations are unavailable in this run; nothing was sent.`);
  let response: Response;
  try {
    response = await fetchImpl(new URL("/v1/telegram/project-destination", bridge.bridgeUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(PROJECT_BRIDGE_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${toolName}: the project's Telegram topic could not be resolved; nothing was sent.`);
  }
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) {
    const message = typeof body?.message === "string" && body.message.length <= 300 ? body.message : "the project's Telegram topic could not be resolved";
    throw new Error(`${toolName}: ${message} Nothing was sent.`);
  }
  const target = telegramTargetFromConversation(typeof body?.conversationId === "string" ? body.conversationId : undefined);
  if (target === undefined || typeof body?.label !== "string") {
    throw new Error(`${toolName}: the project's Telegram topic could not be resolved; nothing was sent.`);
  }
  assertTelegramChatAllowed(settings, target.chatId, toolName);
  return { target, label: body.label };
}

/**
 * Run one send; with `telegram.projects` enabled, when Telegram answers that the forum topic no longer exists,
 * tell the parent (which marks its project "Telegram topic gone") and fail
 * with an honest message. Other failures pass through unchanged.
 */
async function withTopicGoneReport<T>(
  settings: TelegramSendToolSettings,
  adapter: TelegramAdapterModule,
  bridge: AdapterSendToolsDeliveryHistory | undefined,
  fetchImpl: typeof fetch,
  conversationId: string,
  toolName: TelegramSendToolName,
  send: () => Promise<T>,
): Promise<T> {
  // Without `telegram.projects` the send path and its errors stay exactly as before.
  if (settings.projects !== true) return await send();
  try {
    return await send();
  } catch (error) {
    if (telegramTargetFromConversation(conversationId)?.messageThreadId === undefined
      || typeof adapter.isTelegramTopicGoneError !== "function" || !adapter.isTelegramTopicGoneError(error)) throw error;
    if (bridge !== undefined) {
      await fetchImpl(new URL("/v1/telegram/topic-gone", bridge.bridgeUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.bridgeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ conversationId }),
        signal: AbortSignal.timeout(PROJECT_BRIDGE_TIMEOUT_MS),
      }).then((response) => response.body?.cancel()).catch(() => undefined);
    }
    throw new Error(`${toolName}: that Telegram forum topic no longer exists; nothing was sent.`, { cause: error });
  }
}

function assertTelegramChatAllowed(
  settings: TelegramSendToolSettings,
  chatId: TelegramChatId,
  toolName: TelegramSendToolName,
): void {
  const normalized = String(chatId);
  if (settings.sendTools?.scope === "producing-conversation") {
    const producing = producingTelegramTarget(settings);
    const producingChatId = producing === undefined ? undefined : String(producing.chatId);
    if (producingChatId === undefined) {
      throw new Error(`${toolName}: producing Telegram conversation context is unavailable.`);
    }
    if (normalized !== producingChatId) {
      throw new Error(`${toolName}: chat_id must match the producing Telegram conversation.`);
    }
  }
  if (settings.allowAllChats || settings.allowedChatIds.includes(normalized)) {
    return;
  }
  throw new Error(`${toolName}: chat_id is not allowed by Telegram adapter config.`);
}
