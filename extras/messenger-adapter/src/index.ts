export type {
  AgentRequest,
  AgentResponder,
  AgentResponse,
  MessengerAdapterLogger,
  MessengerAdapterMessages,
  MessengerAdapterOptions,
  MessengerAttachmentIngestOptions,
  MessengerEventResult,
  MessengerIgnoredReason,
  MessengerNotifyOptions,
  MessengerNotifyResult,
  MessengerProactiveOptions,
  MessengerRequestMetadata,
  MessengerWebhookAttachment,
  MessengerWebhookEvent,
} from "./adapter.js";
export {
  MESSENGER_CHANNEL_ID,
  MessengerAdapter,
  isSafeAttachmentUrl,
  messengerConversationId,
  messengerUserIdFromConversation,
} from "./adapter.js";

export {
  DEFAULT_MESSENGER_API_VERSION,
  DEFAULT_MESSENGER_HOST,
  DEFAULT_MESSENGER_PORT,
  DEFAULT_MESSENGER_WEBHOOK_PATH,
  MESSENGER_CONFIG_FIELDS,
  MESSENGER_MESSAGING_TYPES,
  MessengerAdapterConfigError,
  isLoopbackHost,
  loadMessengerAdapterConfig,
  redactMessengerAdapterConfig,
} from "./config.js";
export type {
  LoadMessengerAdapterConfigInput,
  MessengerAdapterConfig,
  MessengerAdapterConfigErrorCode,
  MessengerAdapterConfigErrorDetails,
  MessengerMessagingType,
  RedactedMessengerAdapterConfig,
} from "./config.js";

export {
  DEFAULT_GRAPH_API_BASE_URL,
  MessengerGraphClient,
  MessengerGraphError,
} from "./graph-client.js";
export type {
  MessengerGraphClientLike,
  MessengerGraphClientLogger,
  MessengerGraphClientOptions,
  MessengerSendOptions,
  MessengerSendResult,
  MessengerSenderAction,
} from "./graph-client.js";

export type { AgentMessageStream } from "@mono-agent/agent-contracts";
export { MessengerMessageStream } from "./message-stream.js";
export type { MessengerMessageStreamLogger, MessengerMessageStreamOptions } from "./message-stream.js";

export { createMessengerWebhookServer } from "./server.js";
export type {
  MessengerWebhookServer,
  MessengerWebhookServerLogger,
  MessengerWebhookServerOptions,
} from "./server.js";

export { startMessengerAdapter } from "./start.js";
export type {
  MessengerAdapterStartLogger,
  MessengerAdapterStartResult,
  StartMessengerAdapterOptions,
} from "./start.js";

export {
  MESSENGER_MAX_MESSAGE_CHARS,
  splitForMessenger,
  stripMarkdownForMessenger,
  verifyMessengerSignature,
} from "./text.js";

export { createChannelDriver, createMessengerChannelDriver } from "./channel-driver.js";
export type { MessengerChannelDriverConfig, MessengerChannelDriverOptions } from "./channel-driver.js";
