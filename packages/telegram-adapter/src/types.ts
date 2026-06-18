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
  caption?: string;
  /** Set on each message of a multi-photo/video album; shared across the group. */
  media_group_id?: string;
  animation?: unknown;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  audio?: TelegramAudio;
  video?: TelegramVideo;
  voice?: TelegramVoice;
  [key: string]: unknown;
}

export interface TelegramFileReference {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

export interface TelegramPhotoSize extends TelegramFileReference {
  width: number;
  height: number;
}

export interface TelegramDocument extends TelegramFileReference {
  file_name?: string;
  mime_type?: string;
}

export interface TelegramAudio extends TelegramFileReference {
  duration: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramVideo extends TelegramFileReference {
  duration: number;
  width: number;
  height: number;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramVoice extends TelegramFileReference {
  duration: number;
  mime_type?: string;
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

export interface TelegramSendChatActionParams {
  chat_id: TelegramChatId;
  /** Telegram chat action, e.g. "typing". */
  action: string;
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
  /** Optional: surface a transient chat action such as "typing". Best-effort. */
  sendChatAction?(
    params: TelegramSendChatActionParams,
    options?: TelegramRequestOptions,
  ): Promise<true>;
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
