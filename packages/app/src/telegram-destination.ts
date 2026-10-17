import { parseTelegramConversationId, telegramMessageThreadId, type TelegramConversationTarget } from "@mono-agent/channel-telegram/conversation";

/** App surfaces may not have selected a conversation yet. */
export function telegramTargetFromConversation(
  conversationId: string | undefined,
): TelegramConversationTarget | undefined {
  return conversationId === undefined ? undefined : parseTelegramConversationId(conversationId);
}

/** App API responses are untyped until their message layer is checked. */
export function telegramTopicOfMessage(message: {
  readonly is_topic_message?: unknown;
  readonly message_thread_id?: unknown;
}): number | undefined {
  const thread = message.message_thread_id;
  return message.is_topic_message === true && typeof thread === "number"
    ? telegramMessageThreadId({ is_topic_message: true, message_thread_id: thread })
    : undefined;
}
