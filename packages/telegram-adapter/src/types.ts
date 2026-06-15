export type TelegramChatId = number | string;

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  [key: string]: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  [key: string]: unknown;
}

export type TelegramSentMessage = TelegramMessage;

export interface TelegramRequestOptions {
  signal?: AbortSignal;
}

export interface TelegramSendMessageParams {
  chat_id: TelegramChatId;
  text: string;
  parse_mode?: string;
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
}

export interface TelegramEditMessageTextParams {
  chat_id?: TelegramChatId;
  message_id?: number;
  inline_message_id?: string;
  text: string;
  parse_mode?: string;
  disable_web_page_preview?: boolean;
}

export interface TelegramGetUpdatesParams {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export interface TelegramDeleteWebhookParams {
  drop_pending_updates?: boolean;
}

/**
 * The minimal Telegram surface the streaming delivery layer needs: sending a
 * message and editing it in place. Update polling lives in the grammY runner, so
 * the delivery layer depends only on these two calls.
 */
export interface TelegramMessageSender {
  sendMessage(
    params: TelegramSendMessageParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage>;
  editMessageText(
    params: TelegramEditMessageTextParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramSentMessage | true>;
}

export interface TelegramBotApi extends TelegramMessageSender {
  getUpdates(
    params: TelegramGetUpdatesParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramUpdate[]>;
  deleteWebhook?(
    params?: TelegramDeleteWebhookParams,
    options?: TelegramRequestOptions,
  ): Promise<true>;
}
