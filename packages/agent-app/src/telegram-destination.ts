/**
 * Pure Telegram destination parsing for app-owned surfaces (channel driver,
 * send tools) that must not load the Telegram SDK just to route a message.
 *
 * `telegram:<chat>` is a chat's main conversation (private chat, non-forum
 * group, or a forum's General topic); `telegram:<chat>:<topic>` is one forum
 * topic. An optional `#bucket` rollover suffix is ignored. Mirrors
 * `parseTelegramConversationId` in `@mono-agent/telegram-adapter`.
 */
export interface TelegramDestinationTarget {
  readonly chatId: number | string;
  /** Forum topic (`message_thread_id`); absent for the chat's main conversation. */
  readonly messageThreadId?: number;
}

const PREFIX = "telegram:";
const TOPIC_ID_PATTERN = /^[1-9]\d*$/u;
const NUMERIC_CHAT_ID_PATTERN = /^-?\d+$/u;

/** Parse a Telegram conversation id into its chat and optional forum topic. */
export function telegramTargetFromConversation(
  conversationId: string | undefined,
): TelegramDestinationTarget | undefined {
  if (conversationId === undefined || !conversationId.startsWith(PREFIX)) {
    return undefined;
  }
  const base = conversationId.slice(PREFIX.length).split("#", 1)[0]?.trim() ?? "";
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
  const chatId = NUMERIC_CHAT_ID_PATTERN.test(rawChat) ? Number(rawChat) : rawChat;
  const rawTopic = parts[1];
  if (rawTopic === undefined) {
    return { chatId };
  }
  if (!TOPIC_ID_PATTERN.test(rawTopic)) {
    return undefined;
  }
  const messageThreadId = Number(rawTopic);
  return Number.isSafeInteger(messageThreadId) ? { chatId, messageThreadId } : undefined;
}

/** The harness conversation id for a Telegram chat or forum topic. */
export function telegramConversationIdFor(target: TelegramDestinationTarget): string {
  return target.messageThreadId === undefined
    ? `${PREFIX}${String(target.chatId)}`
    : `${PREFIX}${String(target.chatId)}:${String(target.messageThreadId)}`;
}

/**
 * The forum topic a sent/received Telegram message belongs to. Only
 * `is_topic_message` marks a topic; non-forum reply threads also carry a
 * `message_thread_id` and stay in the chat's main conversation.
 */
export function telegramTopicOfMessage(message: {
  readonly is_topic_message?: unknown;
  readonly message_thread_id?: unknown;
}): number | undefined {
  const thread = message.message_thread_id;
  return message.is_topic_message === true
    && typeof thread === "number"
    && Number.isSafeInteger(thread)
    && thread > 0
    ? thread
    : undefined;
}
