if (false) {
  const target: import("@mono-agent/channel-telegram/conversation").TelegramConversationTarget = { chatId: "@fictional" };
  // @ts-expect-error packed conversation targets remain readonly.
  target.chatId = 1;
  // @ts-expect-error packed optional topics require narrowing.
  const thread: number = target.messageThreadId;
  void thread;
  const routing = {} as typeof import("@mono-agent/channel-telegram/conversation");
  // @ts-expect-error channel-internal validated destination handling is not public here.
  routing.telegramConversationId;
  // @ts-expect-error channel-internal thread request construction is not public here.
  routing.telegramThreadParams;
}
