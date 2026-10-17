if (false) {
  const target: import("@mono-agent/channel-telegram/conversation").TelegramConversationTarget = { chatId: "@fictional" };
  // @ts-expect-error packed conversation targets remain readonly.
  target.chatId = 1;
  // @ts-expect-error packed optional topics require narrowing.
  const thread: number = target.messageThreadId;
  void thread;
}
