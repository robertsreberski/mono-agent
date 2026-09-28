import type { TelegramChatId, TelegramMessage } from "./types.js";

/**
 * One Telegram conversation: a chat, optionally narrowed to a forum topic.
 *
 * Private chats, non-forum groups and a forum's General topic are addressed by
 * the chat alone, so their conversation id stays `telegram:<chat>`. A message
 * in any other forum topic belongs to `telegram:<chat>:<topic>` and keeps its
 * own history, queue, controls and outbound routing.
 */
export interface TelegramConversationTarget {
  readonly chatId: TelegramChatId;
  /** Forum topic (`message_thread_id`); absent for the chat's main conversation. */
  readonly messageThreadId?: number;
}

/** A bare chat id (its main conversation) or an explicit chat + topic target. */
export type TelegramDestination = TelegramChatId | TelegramConversationTarget;

const CONVERSATION_PREFIX = "telegram:";
const TOPIC_ID_PATTERN = /^[1-9]\d*$/u;
const NUMERIC_CHAT_ID_PATTERN = /^-?\d+$/u;

/** Normalize a destination into a target, dropping an invalid topic id. */
export function telegramConversationTarget(destination: TelegramDestination): TelegramConversationTarget {
  if (typeof destination === "object" && destination !== null) {
    return isTelegramTopicId(destination.messageThreadId)
      ? { chatId: destination.chatId, messageThreadId: destination.messageThreadId }
      : { chatId: destination.chatId };
  }
  return { chatId: destination };
}

/** The harness conversation id for a Telegram chat or forum topic. */
export function telegramConversationId(destination: TelegramDestination): string {
  const target = telegramConversationTarget(destination);
  return target.messageThreadId === undefined
    ? `${CONVERSATION_PREFIX}${String(target.chatId)}`
    : `${CONVERSATION_PREFIX}${String(target.chatId)}:${String(target.messageThreadId)}`;
}

/**
 * Parse `telegram:<chat>` or `telegram:<chat>:<topic>` (an optional `#bucket`
 * rollover suffix is ignored). Returns undefined for anything else, including a
 * non-positive or non-integer topic, so a malformed destination fails closed.
 */
export function parseTelegramConversationId(conversationId: string): TelegramConversationTarget | undefined {
  if (!conversationId.startsWith(CONVERSATION_PREFIX)) {
    return undefined;
  }
  const base = conversationId.slice(CONVERSATION_PREFIX.length).split("#", 1)[0]?.trim() ?? "";
  if (base.length === 0) {
    return undefined;
  }
  const parts = base.split(":");
  if (parts.length > 2) {
    return undefined;
  }
  const rawChat = parts[0]?.trim() ?? "";
  if (rawChat.length === 0) {
    return undefined;
  }
  const chatId: TelegramChatId = NUMERIC_CHAT_ID_PATTERN.test(rawChat) ? Number(rawChat) : rawChat;
  const rawTopic = parts[1];
  if (rawTopic === undefined) {
    return { chatId };
  }
  if (!TOPIC_ID_PATTERN.test(rawTopic)) {
    return undefined;
  }
  const messageThreadId = Number(rawTopic);
  return isTelegramTopicId(messageThreadId) ? { chatId, messageThreadId } : undefined;
}

/**
 * The forum topic an inbound message belongs to. Only `is_topic_message`
 * identifies a topic: a non-forum supergroup also sets `message_thread_id` for
 * ordinary reply threads, and the General topic carries no topic id.
 */
export function telegramMessageThreadId(
  message: Pick<TelegramMessage, "is_topic_message" | "message_thread_id">,
): number | undefined {
  return message.is_topic_message === true && isTelegramTopicId(message.message_thread_id)
    ? message.message_thread_id
    : undefined;
}

/** The conversation target an inbound message belongs to. */
export function telegramMessageTarget(message: TelegramMessage): TelegramConversationTarget {
  const messageThreadId = telegramMessageThreadId(message);
  return messageThreadId === undefined
    ? { chatId: message.chat.id }
    : { chatId: message.chat.id, messageThreadId };
}

/**
 * Drop the implicit reply Telegram attaches to every forum-topic message.
 *
 * A message typed into a topic without replying to anything still arrives with
 * `reply_to_message` set to the topic's root service message (the one carrying
 * `forum_topic_created`, whose id is the topic id). Treating that as a native
 * reply would quote an empty service message into every turn and, when the bot
 * opened the topic, satisfy mention mode's "reply to the bot" trigger for every
 * message in it. An explicit reply to a real message is kept unchanged.
 */
export function withoutImplicitTopicReply(message: TelegramMessage): TelegramMessage {
  const reply = message.reply_to_message;
  const topicId = telegramMessageThreadId(message);
  if (reply === undefined || topicId === undefined) {
    return message;
  }
  if (reply.message_id !== topicId && reply.forum_topic_created === undefined) {
    return message;
  }
  const { reply_to_message: _reply, quote: _quote, ...rest } = message;
  return rest as TelegramMessage;
}

/** Spread-ready `message_thread_id` for a Bot API send parameter object. */
export function telegramThreadParams(
  target: TelegramConversationTarget,
): { readonly message_thread_id?: number } {
  return target.messageThreadId === undefined ? {} : { message_thread_id: target.messageThreadId };
}

function isTelegramTopicId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
