import type {
  AgentRequestBase,
  AgentResponder as SharedAgentResponder,
  AgentResponse,
} from "@mono-agent/agent-contracts";

import {
  TelegramMessageStream,
  type AgentMessageStream,
  type TelegramMessageStreamLogger,
} from "./message-stream.js";
import type {
  TelegramChatId,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export interface AgentRequest extends AgentRequestBase {
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

export type { AgentResponse };
export type AgentResponder = SharedAgentResponder<AgentRequest, AgentMessageStream, AgentResponse>;

export interface TelegramAdapterMessages {
  welcomeText?: string;
  helpText?: string;
  busyText?: string;
  unauthorizedText?: string;
  cancelledText?: string;
  errorText?: TelegramAdapterErrorText;
  unsupportedText?: string;
}

export type TelegramAdapterErrorText =
  | string
  | ((input: TelegramAdapterErrorTextInput) => string | Promise<string>);

export interface TelegramAdapterErrorTextInput {
  readonly error: unknown;
  readonly request: AgentRequest;
}

export interface TelegramAdapterStreamOptions {
  initialStatusText?: string;
  editDebounceMs?: number;
  maxMessageChars?: number;
  maxSendRetries?: number;
  retryCapMs?: number;
  retryBaseDelayMs?: number;
  showThoughts?: boolean;
  formatMarkdown?: boolean;
}

export interface TelegramAdapterLogger extends TelegramMessageStreamLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export const DEFAULT_ERROR_TEXT = "The agent failed while processing your message.";

export const DEFAULT_MESSAGES: Required<TelegramAdapterMessages> = {
  welcomeText:
    "Hello! Send me a text message and I will pass it to the configured agent.",
  helpText:
    "Send a text message to talk to the agent. Use /cancel to stop the current response.",
  busyText: "I am still working on your previous message. Use /cancel to stop it.",
  unauthorizedText: "This Telegram chat is not authorized to use this bot.",
  cancelledText: "Cancelled.",
  errorText: DEFAULT_ERROR_TEXT,
  unsupportedText: "I can only handle text messages in this adapter for now.",
};

/**
 * Build the responder-facing {@link AgentRequest} from a Telegram update. The
 * grammY message handler passes `ctx.update` and `ctx.message`, which are
 * structurally compatible with the wire types this reads.
 */
export function buildAgentRequest(
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

/**
 * Deliver a terminal/system message (cancelled, error, …) in place. Such copy is
 * fixed text we author, not model output, so it is delivered as plain text
 * (`format: false`) — no MarkdownV2 escaping — while still reusing the stream's
 * resilient edit-or-recreate delivery.
 */
export async function finishSafely(
  stream: TelegramMessageStream,
  text: string,
  logger: TelegramAdapterLogger | undefined,
): Promise<void> {
  try {
    await stream.finish(text, { format: false });
  } catch (error) {
    logger?.error?.("Failed to send Telegram terminal stream message.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function resolveErrorText(input: {
  readonly configured: TelegramAdapterErrorText;
  readonly error: unknown;
  readonly request: AgentRequest;
  readonly logger: TelegramAdapterLogger | undefined;
}): Promise<string> {
  if (typeof input.configured === "string") {
    return input.configured;
  }

  try {
    const resolved = await input.configured({
      error: input.error,
      request: input.request,
    });
    if (typeof resolved === "string" && resolved.trim().length > 0) {
      return resolved;
    }
    input.logger?.warn?.("Telegram adapter error text callback returned empty text.");
  } catch (error) {
    input.logger?.error?.("Telegram adapter error text callback failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return DEFAULT_ERROR_TEXT;
}
