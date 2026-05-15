export type {
  TelegramBotApi,
  TelegramChat,
  TelegramChatId,
  TelegramDeleteWebhookParams,
  TelegramEditMessageTextParams,
  TelegramGetUpdatesParams,
  TelegramMessage,
  TelegramRequestOptions,
  TelegramSendMessageParams,
  TelegramSentMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export {
  TelegramApiError,
  TelegramBotApiClient,
} from "./telegram-client.js";
export type {
  TelegramApiErrorDetails,
  TelegramApiErrorKind,
  TelegramBotApiClientOptions,
} from "./telegram-client.js";
