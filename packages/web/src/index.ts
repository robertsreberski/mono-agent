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
  DeliverWebMonitorNotificationInput,
  DeliverWebProcessJobNotificationInput,
  DeliverWebThreadNotificationInput,
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
  PutWebAgentRunSettingsInput,
  StartWebLiveInputInput,
  StartWebTurnInput,
  WebAgentsChangedPayload,
  WebAgentStatus,
  WebAgentRunSettings,
  WebAgentSummary,
  WebConfigurationMessage,
  WebConfigurationProposal,
  WebConfigurationSession,
  WebAttachment,
  WebBootstrap,
  WebBootstrapScope,
  WebConsoleIdentity,
  WebEvent,
  WebEventType,
  WebLiveInputReceipt,
  WebMessage,
  WebMessageDelta,
  WebMessageDeltaOp,
  WebMessagePart,
  WebMessageStatus,
  WebModelOption,
  WebNotificationTriggerKind,
  WebThreadNotificationTriggerKind,
  WebPushBootstrap,
  WebPushSubscriptionState,
  WebPushSubscriptionStatus,
  WebQuote,
  WebRunState,
  WebRunAttribution,
  WebRunExecution,
  WebRunRetry,
  WebRunSelection,
  WebRunTransition,
  WebRunSettingSource,
  WebRunStatus,
  WebSkillAvailability,
  WebSkillInfo,
  WebSkillRegistry,
  WebSkillUnavailableReason,
  WebThread,
  WebThreadChangedPayload,
  WebThreadDetail,
  WebThreadSearchHit,
  WebThreadSearchPage,
  SearchWebThreadsInput,
  WebThreadTrigger,
  WebTheme,
} from "./contracts.js";

export {
  WEB_SEARCH_HIGHLIGHT_CLOSE,
  WEB_SEARCH_HIGHLIGHT_OPEN,
  WEB_THREAD_SEARCH_MAX,
  WEB_THREAD_SEARCH_MIN_QUERY,
} from "./store.js";

export { WebConsoleError } from "./errors.js";
