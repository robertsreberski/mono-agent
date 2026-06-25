/**
 * Shared convention for the `telegram_ask` inline-keyboard round-trip.
 *
 * The agent-app `telegram_ask` tool builds an inline keyboard whose buttons carry
 * `callback_data` of the form `ask:<index>` (well under Telegram's 64-byte cap).
 * On tap the bot's `callback_query` handler recognizes the prefix and resolves the
 * chosen LABEL from the tapped message's own `reply_markup` — so no cross-process
 * state is needed and the mapping survives a bot restart.
 */
export const TELEGRAM_ASK_CALLBACK_PREFIX = "ask:";

/** Maximum number of options a single `telegram_ask` keyboard may carry. */
export const TELEGRAM_ASK_MAX_OPTIONS = 8;

/** Build the `callback_data` for the option at `index` (0-based). */
export function telegramAskCallbackData(index: number): string {
  return `${TELEGRAM_ASK_CALLBACK_PREFIX}${index}`;
}

/** True when `data` is a `telegram_ask` callback payload. */
export function isTelegramAskCallbackData(data: string): boolean {
  return data.startsWith(TELEGRAM_ASK_CALLBACK_PREFIX);
}
