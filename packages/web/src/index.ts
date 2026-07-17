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

export {
  defaultTraceRegistryDir,
  discoverOperatorAgents,
  isTrustedOperatorBaseUrl,
  operatorBaseUrlFromMetadata,
} from "./discovery.js";
export type {
  DiscoverOperatorAgentsOptions,
  DiscoveredOperatorAgent,
} from "./discovery.js";

export {
  WEB_API_VERSION,
  WEB_MAX_CONCURRENT_UPLOADS,
  WEB_MAX_ACTIVE_ATTACHMENT_TURN_BYTES,
  WEB_MAX_FILES_PER_TURN,
  WEB_MAX_STAGED_UPLOAD_BYTES,
  WEB_MAX_STAGED_UPLOADS,
  WEB_MAX_QUEUED_ATTACHMENT_TURNS,
  WEB_MAX_TURN_ATTACHMENT_BYTES,
  WEB_STAGED_UPLOAD_TTL_MS,
} from "./contracts.js";
export type {
  CreateWebThreadInput,
  CreateWebUploadInput,
  PatchWebThreadInput,
  StartWebTurnInput,
  WebAgentStatus,
  WebAgentSummary,
  WebAttachment,
  WebBootstrap,
  WebEvent,
  WebEventType,
  WebMessage,
  WebMessagePart,
  WebMessageStatus,
  WebModelOption,
  WebRunState,
  WebRunStatus,
  WebThread,
  WebThreadDetail,
} from "./contracts.js";

export { WebConsoleError } from "./errors.js";
