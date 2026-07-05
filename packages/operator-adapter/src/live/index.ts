export { startLiveAdapter } from "./server.js";
export type {
  LiveAdapterHandle,
  LiveAdapterLogger,
  LiveAdapterOptions,
} from "./server.js";
export { LiveAdapterError } from "./errors.js";
export type { LiveAdapterErrorCode, LiveAdapterErrorDetails } from "./errors.js";
export { loadLiveAdapterConfig, redactLiveAdapterConfig, LIVE_CONFIG_FIELDS } from "./config.js";
export type {
  LiveAdapterConfig,
  RedactedLiveAdapterConfig,
  LoadLiveAdapterConfigInput,
} from "./config.js";
export {
  DEFAULT_LIVE_BASE_PATH,
  DEFAULT_LIVE_HOST,
  DEFAULT_LIVE_PORT,
  LIVE_ADAPTER_INFO_SCHEMA,
  LIVE_HEARTBEAT_INTERVAL_MS,
} from "./constants.js";

// Re-export the shared live-event contract + the in-process bus factory (both live
// in core) so consumers can build/type producers and subscribers from one import.
export { LIVE_EVENT_SCHEMA, createLiveEventBus } from "@mono-agent/agent-contracts";
export type {
  CreateLiveEventBusOptions,
  RunEventBus,
  RunEventFrame,
  RunEventSink,
} from "@mono-agent/agent-contracts";
