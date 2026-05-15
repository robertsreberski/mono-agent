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
export { splitTelegramText, TelegramMessageStream } from "./message-stream.js";
export type {
  AgentMessageStream,
  TelegramMessageStreamLogger,
  TelegramMessageStreamOptions,
} from "./message-stream.js";
export { TelegramBridge } from "./bridge.js";
export type {
  AgentRequest,
  AgentResponder,
  AgentResponse,
  TelegramBridgeLogger,
  TelegramBridgeMessages,
  TelegramBridgeOptions,
  TelegramBridgeStreamOptions,
  TelegramRequestMetadata,
  TelegramUpdateHandlingResult,
} from "./bridge.js";
