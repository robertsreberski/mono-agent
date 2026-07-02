export type {
  TelegramBotApi,
  TelegramChat,
  TelegramChatId,
  TelegramDeleteWebhookParams,
  TelegramDocument,
  TelegramEditMessageTextParams,
  TelegramAudio,
  TelegramFileReference,
  TelegramGetUpdatesParams,
  TelegramMessage,
  TelegramMessageSender,
  TelegramPhotoSize,
  TelegramRequestOptions,
  TelegramSendDocumentParams,
  TelegramSendMessageParams,
  TelegramSendPhotoParams,
  TelegramSentMessage,
  TelegramUpdate,
  TelegramUser,
  TelegramVideo,
  TelegramVoice,
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
export { createGrammyTelegramApi, createTelegramMessageSender } from "./grammy-client.js";

export {
  TELEGRAM_ASK_CALLBACK_PREFIX,
  TELEGRAM_ASK_MAX_OPTIONS,
  isTelegramAskCallbackData,
  telegramAskCallbackData,
} from "./ask.js";

export { createTelegramBot } from "./bot.js";
export type {
  CreateTelegramBotOptions,
  TelegramBotController,
} from "./bot.js";

export {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
  downloadTelegramAttachments,
} from "./adapter.js";
export type {
  AgentRequest,
  AgentResponder,
  AgentResponse,
  DownloadTelegramAttachmentsOptions,
  TelegramFileDownloader,
  TelegramAgentMessageInput,
  TelegramAttachment,
  TelegramAttachmentBase,
  TelegramAttachmentKind,
  TelegramAdapterErrorText,
  TelegramAdapterErrorTextInput,
  TelegramAudioAttachment,
  TelegramDocumentAttachment,
  TelegramAdapterLogger,
  TelegramAdapterMessages,
  TelegramAdapterStreamOptions,
  TelegramPhotoAttachment,
  TelegramPhotoAttachmentSize,
  TelegramRequestMetadata,
  TelegramVideoAttachment,
  TelegramVoiceAttachment,
} from "./adapter.js";

export { startTelegramAdapter } from "./start.js";
export type {
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
} from "./start.js";

export {
  isWithinQuietHours,
  loadTelegramAdapterConfig,
  redactTelegramAdapterConfig,
  TELEGRAM_CONFIG_FIELDS,
  TelegramAdapterConfigError,
} from "./config.js";
export type {
  LoadTelegramAdapterConfigInput,
  RedactedTelegramAdapterConfig,
  TelegramAdapterConfig,
  TelegramAdapterConfigErrorCode,
  TelegramAdapterConfigErrorDetails,
  TelegramAttachmentsConfig,
  TelegramCommandConfig,
  TelegramQuietHours,
  TelegramReactionsConfig,
} from "./config.js";
