/**
 * `@mono-agent/session-web` — the read-only web operator surface backend. Discovers
 * local agent instances via the trace-source registry, folds their recorded-run
 * history and live sub-run streams into one session model, and serves the built SPA
 * plus a JSON API and a browser SSE stream.
 *
 * `operator-surface` category: depends only on `core` + `observability`. It reaches
 * running agents' `live-adapter` endpoints over HTTP only — never importing that
 * (or any) `communication` adapter.
 */
export { startSessionWebServer } from "./server.js";
export type { SessionWebServerHandle, StartSessionWebServerOptions } from "./server.js";

export { defaultTraceRegistryDir, discoverWebInstances, liveBaseUrlFromMetadata, resolveLiveApiKey } from "./discovery.js";
export type { DiscoverWebInstancesOptions, DiscoveredWebInstance } from "./discovery.js";

export type { BrowserStreamFrame, WebInstance } from "./session-model.js";

// Re-export the frozen UI Session model from observability (never redefined here).
export type {
  Session,
  SessionOutcome,
  SessionStep,
  SessionStepUsage,
  SessionThink,
  SessionToolCall,
  SessionTotals,
} from "@mono-agent/observability";
