export type {
  TelegramBotApi,
  TelegramChat,
  TelegramChatId,
  TelegramDeleteWebhookParams,
  TelegramEditMessageTextParams,
  TelegramGetUpdatesParams,
  TelegramMessage,
  TelegramMessageSender,
  TelegramRequestOptions,
  TelegramSendMessageParams,
  TelegramSentMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export { TelegramApiError } from "./telegram-error.js";
export type {
  TelegramApiErrorDetails,
  TelegramApiErrorKind,
} from "./telegram-error.js";

export {
  TelegramDeliveryError,
  TelegramMessageStream,
  classifyTelegramError,
} from "./message-stream.js";
export type {
  AgentMessageStream,
  TelegramMessageStreamLogger,
  TelegramMessageStreamOptions,
  TelegramSendOutcome,
} from "./message-stream.js";

export { renderTelegramMarkdown } from "./telegram-markdown.js";
export { createGrammyTelegramApi } from "./grammy-client.js";

export { createTelegramBot } from "./bot.js";
export type {
  CreateTelegramBotOptions,
  TelegramBotController,
} from "./bot.js";

export type {
  AgentRequest,
  AgentResponder,
  AgentResponse,
  TelegramAdapterErrorText,
  TelegramAdapterErrorTextInput,
  TelegramAdapterLogger,
  TelegramAdapterMessages,
  TelegramAdapterStreamOptions,
  TelegramRequestMetadata,
} from "./adapter.js";

export { startTelegramAdapter } from "./start.js";
export type {
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
} from "./start.js";

export {
  loadTelegramAdapterConfig,
  redactTelegramAdapterConfig,
  TelegramAdapterConfigError,
  telegramFieldGroup,
} from "./config.js";
export type {
  LoadTelegramAdapterConfigInput,
  RedactedTelegramAdapterConfig,
  TelegramAdapterConfig,
  TelegramAdapterConfigErrorCode,
  TelegramAdapterConfigErrorDetails,
} from "./config.js";
