import {
  TelegramMessageStream,
  type AgentMessageStream,
  type TelegramMessageStreamLogger,
  type TelegramMessageStreamOptions,
} from "./message-stream.js";
import type {
  TelegramBotApi,
  TelegramChatId,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export interface AgentRequest {
  conversationId: string;
  chatId: TelegramChatId;
  messageId: number;
  updateId: number;
  userId?: number;
  username?: string;
  text: string;
  abortSignal: AbortSignal;
  metadata: {
    telegram: TelegramRequestMetadata;
    [key: string]: unknown;
  };
}

export interface TelegramRequestMetadata {
  updateId: number;
  chat: {
    id: TelegramChatId;
    type?: string;
    title?: string;
    username?: string;
  };
  message: {
    id: number;
    date?: number;
  };
  from?: {
    id: number;
    isBot?: boolean;
    username?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
  };
}

export interface AgentResponse {
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentResponder {
  respond(
    request: AgentRequest,
    stream: AgentMessageStream,
  ): Promise<AgentResponse>;
}

export interface AgentResponderCancelledErrorOptions {
  reason?: unknown;
}

export class AgentResponderCancelledError extends Error {
  readonly reason?: unknown;

  constructor(
    message = "Agent response was cancelled.",
    options: AgentResponderCancelledErrorOptions = {},
  ) {
    super(message);
    this.name = "AgentResponderCancelledError";
    if (options.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

export function isAgentResponderCancelledError(error: unknown): boolean {
  return error instanceof AgentResponderCancelledError;
}

export interface TelegramBridgeMessages {
  welcomeText?: string;
  helpText?: string;
  busyText?: string;
  unauthorizedText?: string;
  cancelledText?: string;
  errorText?: string;
  unsupportedText?: string;
}

export interface TelegramBridgeStreamOptions {
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
}

export interface TelegramBridgeLogger extends TelegramMessageStreamLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export interface TelegramBridgeOptions {
  api: TelegramBotApi;
  responder: AgentResponder;
  allowedChatIds?: TelegramChatId[];
  allowAllChats?: boolean;
  stream?: TelegramBridgeStreamOptions;
  messages?: TelegramBridgeMessages;
  logger?: TelegramBridgeLogger;
}

export type TelegramUpdateHandlingResult =
  | {
      kind: "handled";
      updateId: number;
      chatId: TelegramChatId;
      action: "command" | "responded";
      command?: "start" | "help";
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "ignored";
      updateId: number;
      reason: "non_message_update" | "unsupported_message" | "empty_text";
      chatId?: TelegramChatId;
    }
  | {
      kind: "unauthorized";
      updateId: number;
      chatId: TelegramChatId;
    }
  | {
      kind: "busy";
      updateId: number;
      chatId: TelegramChatId;
    }
  | {
      kind: "cancelled";
      updateId: number;
      chatId: TelegramChatId;
    }
  | {
      kind: "error";
      updateId: number;
      chatId?: TelegramChatId;
      error: unknown;
    };

interface ActiveRun {
  controller: AbortController;
}

interface NormalizedCommand {
  name: string;
}

const DEFAULT_MESSAGES: Required<TelegramBridgeMessages> = {
  welcomeText:
    "Hello! Send me a text message and I will pass it to the configured agent.",
  helpText:
    "Send a text message to talk to the agent. Use /cancel to stop the current response.",
  busyText: "I am still working on your previous message. Use /cancel to stop it.",
  unauthorizedText: "This Telegram chat is not authorized to use this bot.",
  cancelledText: "Cancelled.",
  errorText: "The agent failed while processing your message.",
  unsupportedText: "I can only handle text messages in this bridge for now.",
};

export class TelegramBridge {
  private readonly api: TelegramBotApi;
  private readonly responder: AgentResponder;
  private readonly allowAllChats: boolean;
  private readonly allowedChatIds: Set<string>;
  private readonly streamOptions: TelegramBridgeStreamOptions;
  private readonly messages: Required<TelegramBridgeMessages>;
  private readonly logger: TelegramBridgeLogger | undefined;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: TelegramBridgeOptions) {
    this.api = options.api;
    this.responder = options.responder;
    this.allowAllChats = options.allowAllChats === true;
    this.allowedChatIds = new Set(
      options.allowedChatIds?.map((chatId) => String(chatId)) ?? [],
    );
    this.streamOptions = options.stream ?? {};
    this.messages = { ...DEFAULT_MESSAGES, ...options.messages };
    this.logger = options.logger;

    if (!this.allowAllChats && this.allowedChatIds.size === 0) {
      throw new TypeError(
        "TelegramBridge requires allowedChatIds or allowAllChats: true.",
      );
    }
  }

  async handleUpdate(
    update: TelegramUpdate,
  ): Promise<TelegramUpdateHandlingResult> {
    const message = update.message;
    if (message === undefined) {
      return { kind: "ignored", updateId: update.update_id, reason: "non_message_update" };
    }

    const chatId = message.chat.id;
    if (!this.isAuthorized(chatId)) {
      await this.api.sendMessage({
        chat_id: chatId,
        text: this.messages.unauthorizedText,
      });
      return { kind: "unauthorized", updateId: update.update_id, chatId };
    }

    const text = message.text;
    if (typeof text !== "string") {
      await this.api.sendMessage({
        chat_id: chatId,
        text: this.messages.unsupportedText,
      });
      return {
        kind: "ignored",
        updateId: update.update_id,
        chatId,
        reason: "unsupported_message",
      };
    }

    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      await this.api.sendMessage({
        chat_id: chatId,
        text: this.messages.unsupportedText,
      });
      return {
        kind: "ignored",
        updateId: update.update_id,
        chatId,
        reason: "empty_text",
      };
    }

    const command = parseCommand(trimmedText);
    if (command?.name === "start") {
      await this.api.sendMessage({ chat_id: chatId, text: this.messages.welcomeText });
      return {
        kind: "handled",
        updateId: update.update_id,
        chatId,
        action: "command",
        command: "start",
      };
    }

    if (command?.name === "help") {
      await this.api.sendMessage({ chat_id: chatId, text: this.messages.helpText });
      return {
        kind: "handled",
        updateId: update.update_id,
        chatId,
        action: "command",
        command: "help",
      };
    }

    const runKey = String(chatId);
    const activeRun = this.activeRuns.get(runKey);
    if (command?.name === "cancel") {
      if (activeRun !== undefined) {
        activeRun.controller.abort(new Error("Cancelled by Telegram user."));
      }
      await this.api.sendMessage({
        chat_id: chatId,
        text: this.messages.cancelledText,
      });
      return { kind: "cancelled", updateId: update.update_id, chatId };
    }

    if (activeRun !== undefined) {
      await this.api.sendMessage({ chat_id: chatId, text: this.messages.busyText });
      return { kind: "busy", updateId: update.update_id, chatId };
    }

    return await this.respondToMessage(update, message, trimmedText, runKey);
  }

  private async respondToMessage(
    update: TelegramUpdate,
    message: TelegramMessage,
    text: string,
    runKey: string,
  ): Promise<TelegramUpdateHandlingResult> {
    const chatId = message.chat.id;
    const controller = new AbortController();
    const activeRun: ActiveRun = { controller };
    this.activeRuns.set(runKey, activeRun);

    const telegramStreamOptions: TelegramMessageStreamOptions = {
      api: this.api,
      chatId,
      replyToMessageId: message.message_id,
    };
    if (this.streamOptions.initialStatusText !== undefined) {
      telegramStreamOptions.initialStatusText = this.streamOptions.initialStatusText;
    }
    if (this.streamOptions.editDebounceMs !== undefined) {
      telegramStreamOptions.editDebounceMs = this.streamOptions.editDebounceMs;
    }
    if (this.streamOptions.maxMessageChars !== undefined) {
      telegramStreamOptions.maxMessageChars = this.streamOptions.maxMessageChars;
    }
    if (this.logger !== undefined) {
      telegramStreamOptions.logger = this.logger;
    }

    const stream = new TelegramMessageStream(telegramStreamOptions);

    try {
      await stream.status(this.streamOptions.initialStatusText ?? "Thinking…");
      if (controller.signal.aborted) {
        await stream.finish(this.messages.cancelledText);
        return { kind: "cancelled", updateId: update.update_id, chatId };
      }

      const request = buildAgentRequest(update, message, text, controller.signal);
      const response = await this.responder.respond(request, stream);

      if (controller.signal.aborted) {
        await stream.finish(this.messages.cancelledText);
        return { kind: "cancelled", updateId: update.update_id, chatId };
      }

      await stream.finish(response.text);
      const result: TelegramUpdateHandlingResult = {
        kind: "handled",
        updateId: update.update_id,
        chatId,
        action: "responded",
      };
      if (response.metadata !== undefined) {
        result.metadata = response.metadata;
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted || isAgentResponderCancelledError(error)) {
        await finishSafely(stream, this.messages.cancelledText, this.logger);
        return { kind: "cancelled", updateId: update.update_id, chatId };
      }

      this.logger?.error?.("Telegram bridge responder failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      await finishSafely(stream, this.messages.errorText, this.logger);
      return { kind: "error", updateId: update.update_id, chatId, error };
    } finally {
      if (this.activeRuns.get(runKey) === activeRun) {
        this.activeRuns.delete(runKey);
      }
    }
  }

  private isAuthorized(chatId: TelegramChatId): boolean {
    return this.allowAllChats || this.allowedChatIds.has(String(chatId));
  }
}

function buildAgentRequest(
  update: TelegramUpdate,
  message: TelegramMessage,
  text: string,
  abortSignal: AbortSignal,
): AgentRequest {
  const from = metadataFromUser(message.from);
  const request: AgentRequest = {
    conversationId: `telegram:${String(message.chat.id)}`,
    chatId: message.chat.id,
    messageId: message.message_id,
    updateId: update.update_id,
    text,
    abortSignal,
    metadata: {
      telegram: {
        updateId: update.update_id,
        chat: metadataFromChat(message.chat),
        message: metadataFromMessage(message),
      },
    },
  };

  if (message.from?.id !== undefined) {
    request.userId = message.from.id;
  }
  if (message.from?.username !== undefined) {
    request.username = message.from.username;
  }
  if (from !== undefined) {
    request.metadata.telegram.from = from;
  }

  return request;
}

function metadataFromChat(messageChat: TelegramMessage["chat"]): TelegramRequestMetadata["chat"] {
  const chat: TelegramRequestMetadata["chat"] = { id: messageChat.id };
  if (messageChat.type !== undefined) {
    chat.type = messageChat.type;
  }
  if (messageChat.title !== undefined) {
    chat.title = messageChat.title;
  }
  if (messageChat.username !== undefined) {
    chat.username = messageChat.username;
  }
  return chat;
}

function metadataFromMessage(
  message: TelegramMessage,
): TelegramRequestMetadata["message"] {
  const metadata: TelegramRequestMetadata["message"] = { id: message.message_id };
  if (message.date !== undefined) {
    metadata.date = message.date;
  }
  return metadata;
}

function metadataFromUser(
  user: TelegramUser | undefined,
): TelegramRequestMetadata["from"] | undefined {
  if (user === undefined) {
    return undefined;
  }

  const metadata: NonNullable<TelegramRequestMetadata["from"]> = { id: user.id };
  if (user.is_bot !== undefined) {
    metadata.isBot = user.is_bot;
  }
  if (user.username !== undefined) {
    metadata.username = user.username;
  }
  if (user.first_name !== undefined) {
    metadata.firstName = user.first_name;
  }
  if (user.last_name !== undefined) {
    metadata.lastName = user.last_name;
  }
  if (user.language_code !== undefined) {
    metadata.languageCode = user.language_code;
  }
  return metadata;
}

function parseCommand(text: string): NormalizedCommand | undefined {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/u);
  if (match?.[1] === undefined) {
    return undefined;
  }

  return { name: match[1].toLowerCase() };
}

async function finishSafely(
  stream: AgentMessageStream,
  text: string,
  logger: TelegramBridgeLogger | undefined,
): Promise<void> {
  try {
    await stream.finish(text);
  } catch (error) {
    logger?.error?.("Failed to send Telegram terminal stream message.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
