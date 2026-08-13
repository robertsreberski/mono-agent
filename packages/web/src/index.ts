/**
 * `@mono-agent/web` — persistent, always-on local/LAN browser console for
 * discovering mono-agent instances and driving independent conversations.
 */
export {
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  startWebServer,
} from "./server.js";
export type { StartWebServerOptions, WebServerHandle } from "./server.js";

export {
  defaultWebStateDir,
  prepareWebState,
  prepareWebStatePaths,
  resetWebState,
  resolveWebStatePaths,
} from "./state-paths.js";
export type { WebStatePathOptions, WebStatePaths } from "./state-paths.js";

export { deliverWebNotification } from "./notification-client.js";
export type {
  DeliverWebNotificationInput,
  DeliverWebNotificationOptions,
  DeliverWebNotificationResult,
} from "./notification-client.js";

export {
  discoverAcpBridgeAgents,
  defaultTraceRegistryDir,
  discoverOperatorAgents,
  isTrustedOperatorBaseUrl,
  operatorBaseUrlFromMetadata,
} from "./discovery.js";
export type {
  DiscoverAcpBridgeAgentsOptions,
  DiscoverOperatorAgentsOptions,
  DiscoveredOperatorAgent,
} from "./discovery.js";

export { OperatorClient } from "./operator-client.js";
export type {
  OperatorClientOptions,
  OperatorConnection,
  OperatorInfo,
  OperatorTurnInput,
  OperatorTurnResult,
} from "./operator-client.js";

export {
  ACP_BRIDGE_DISCOVERY_SCHEMA,
  ACP_BRIDGE_SOURCE_SCHEMA,
  ACP_BRIDGE_VERSION,
  ACP_PROTOCOL_VERSION,
  DEFAULT_WEB_THEME,
  WEB_API_VERSION,
  WEB_MAX_CONCURRENT_UPLOADS,
  WEB_MAX_ACTIVE_ATTACHMENT_TURN_BYTES,
  WEB_MAX_FILES_PER_TURN,
  WEB_MAX_LIVE_INPUTS_PER_THREAD,
  WEB_MAX_STAGED_UPLOAD_BYTES,
  WEB_MAX_STAGED_UPLOADS,
  WEB_MAX_QUEUED_ATTACHMENT_TURNS,
  WEB_MAX_TURN_ATTACHMENT_BYTES,
  WEB_STAGED_UPLOAD_TTL_MS,
  WEB_THEMES,
} from "./contracts.js";
export type {
  AcpBridgeDiscovery,
  AcpBridgeSourceDescriptor,
  AcpBridgeSourceHealth,
  CreateWebThreadInput,
  CreateWebUploadInput,
  PatchWebAgentInput,
  PatchWebThreadInput,
  StartWebLiveInputInput,
  StartWebTurnInput,
  WebAgentStatus,
  WebAgentSummary,
  WebAttachment,
  WebBootstrap,
  WebConsoleIdentity,
  WebEvent,
  WebEventType,
  WebLiveInputReceipt,
  WebMessage,
  WebMessagePart,
  WebMessageStatus,
  WebModelOption,
  WebNotificationTriggerKind,
  WebQuote,
  WebRunState,
  WebRunStatus,
  WebSkillAvailability,
  WebSkillInfo,
  WebSkillRegistry,
  WebSkillUnavailableReason,
  WebThread,
  WebThreadDetail,
  WebThreadTrigger,
  WebTheme,
} from "./contracts.js";

export { WebConsoleError } from "./errors.js";
