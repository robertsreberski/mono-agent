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

/**
 * Normalize a destination into a target. An explicit topic id that is not a
 * positive safe integer throws instead of silently falling back to the chat's
 * main conversation, which would post topic content into General.
 */
export function telegramConversationTarget(destination: TelegramDestination): TelegramConversationTarget {
  if (typeof destination === "object" && destination !== null) {
    if (destination.messageThreadId === undefined) {
      return { chatId: destination.chatId };
    }
    if (!isTelegramTopicId(destination.messageThreadId)) {
      throw new TypeError("Telegram messageThreadId must be a positive safe integer.");
    }
    return { chatId: destination.chatId, messageThreadId: destination.messageThreadId };
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

const TOPIC_NAME_MAX_CHARS = 128;

/**
 * A forum topic's name as revealed by one inbound message, if any. Telegram
 * sends no topic name on ordinary messages; it appears on the topic's own
 * creation/rename service messages and on the implicit reply to the topic's
 * root that most typed messages carry. Names are user-chosen labels, bounded
 * here and sanitized again wherever they become model-visible.
 */
export function telegramTopicNameFromMessage(
  message: TelegramMessage,
): { readonly messageThreadId: number; readonly name: string } | undefined {
  const messageThreadId = telegramMessageThreadId(message);
  if (messageThreadId === undefined) {
    return undefined;
  }
  const reply = message.reply_to_message;
  const rootReply = reply !== undefined && (reply.message_id === messageThreadId || reply.forum_topic_created !== undefined)
    ? reply
    : undefined;
  const raw = message.forum_topic_edited?.name
    ?? message.forum_topic_created?.name
    ?? rootReply?.forum_topic_created?.name;
  if (typeof raw !== "string") {
    return undefined;
  }
  const name = Array.from(raw.replace(/\s+/gu, " ").trim()).slice(0, TOPIC_NAME_MAX_CHARS).join("");
  return name.length === 0 ? undefined : { messageThreadId, name };
}

/**
 * How a topic name was revealed. `created`/`edited` are the topic's own
 * service messages; `root_reply` is the creation name quoted by the implicit
 * reply to the topic root, which never reflects a later rename.
 */
export type TelegramTopicNameSource = "created" | "edited" | "root_reply";

/** One learned topic name plus the evidence that produced it. */
export interface TelegramTopicNameRecord {
  readonly name: string;
  readonly source: TelegramTopicNameSource;
  /** Telegram message id of the revealing message (orders explicit renames). */
  readonly messageId: number;
}

/**
 * What one inbound message from an allowlisted chat reveals about the chat and,
 * for a forum-topic message, its topic. A topic id is reported even when no name
 * is visible, so a host can record "unnamed topic seen" instead of nothing.
 */
export interface TelegramChatObservation {
  readonly chatId: TelegramChatId;
  /** Bounded chat title when the message carries one. */
  readonly chatTitle?: string;
  /** True when the chat is a forum (a supergroup with topics). */
  readonly isForum?: boolean;
  readonly topic?: {
    readonly messageThreadId: number;
    readonly nameRecord?: TelegramTopicNameRecord;
    /** Set by the topic's created/closed/reopened service messages. */
    readonly state?: "open" | "closed";
  };
}

/** A topic name a host persisted earlier and hands back at startup. */
export interface TelegramKnownTopicName {
  readonly chatId: TelegramChatId;
  readonly messageThreadId: number;
  readonly nameRecord: TelegramTopicNameRecord;
}

/** The observation one inbound message yields. Never undefined for a real chat message. */
export function telegramChatObservationFromMessage(message: TelegramMessage): TelegramChatObservation {
  const chatTitle = boundedLabel(message.chat.title);
  const isForum = message.chat.is_forum === true ? { isForum: true } : {};
  const messageThreadId = telegramMessageThreadId(message);
  if (messageThreadId === undefined) {
    return { chatId: message.chat.id, ...(chatTitle === undefined ? {} : { chatTitle }), ...isForum };
  }
  const nameRecord = telegramTopicNameRecordFromMessage(message);
  const state = message.forum_topic_closed !== undefined
    ? "closed" as const
    : message.forum_topic_reopened !== undefined || message.forum_topic_created !== undefined
      ? "open" as const
      : undefined;
  return {
    chatId: message.chat.id,
    ...(chatTitle === undefined ? {} : { chatTitle }),
    ...isForum,
    topic: {
      messageThreadId,
      ...(nameRecord === undefined ? {} : { nameRecord }),
      ...(state === undefined ? {} : { state }),
    },
  };
}

function telegramTopicNameRecordFromMessage(message: TelegramMessage): TelegramTopicNameRecord | undefined {
  const learned = telegramTopicNameFromMessage(message);
  if (learned === undefined) {
    return undefined;
  }
  const source: TelegramTopicNameSource = typeof message.forum_topic_edited?.name === "string"
    ? "edited"
    : typeof message.forum_topic_created?.name === "string"
      ? "created"
      : "root_reply";
  return { name: learned.name, source, messageId: message.message_id };
}

/**
 * Merge one observed topic name into the name already known. An explicit
 * rename always beats creation evidence: every later message quotes the topic
 * root, whose `forum_topic_created` still carries the ORIGINAL name, so letting
 * that evidence win would undo each rename on the next ordinary message.
 * Renames are ordered by message id. Returns the record to keep.
 */
export function mergeTelegramTopicName(
  existing: TelegramTopicNameRecord | undefined,
  observed: TelegramTopicNameRecord,
): TelegramTopicNameRecord {
  if (existing === undefined) {
    return observed;
  }
  if (observed.source === "edited") {
    return existing.source !== "edited" || observed.messageId >= existing.messageId ? observed : existing;
  }
  if (existing.source === "edited") {
    return existing;
  }
  // Both are creation evidence. A real creation service message is stronger
  // than a quoted root; otherwise keep the first-seen record stable.
  return observed.source === "created" || (existing.source === "root_reply" && existing.name !== observed.name)
    ? observed
    : existing;
}

function boundedLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const label = Array.from(raw.replace(/\s+/gu, " ").trim()).slice(0, TOPIC_NAME_MAX_CHARS).join("");
  return label.length === 0 ? undefined : label;
}

const FORUM_SERVICE_FIELDS = [
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
] as const;

/** Topic lifecycle service messages carry no user content and never start a turn. */
export function isTelegramForumServiceMessage(message: TelegramMessage): boolean {
  return FORUM_SERVICE_FIELDS.some((field) => message[field] !== undefined);
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
