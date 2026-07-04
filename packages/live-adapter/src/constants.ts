/** Loopback-only default bind host — the adapter refuses non-loopback unless explicitly allowed. */
export const DEFAULT_LIVE_HOST = "127.0.0.1";

/** Default TCP port. `0` lets the OS pick a free ephemeral port (read back from the handle's baseUrl). */
export const DEFAULT_LIVE_PORT = 0;

/** Default URL prefix under which the adapter mounts `/v1/info` and `/v1/events`. */
export const DEFAULT_LIVE_BASE_PATH = "/live";

/**
 * Schema tag surfaced by GET /v1/info so a discovery probe can identify the
 * adapter and its wire version before subscribing to the event stream.
 */
export const LIVE_ADAPTER_INFO_SCHEMA = "live-adapter.v1";

/**
 * Interval between SSE heartbeat comment lines (`: ping\n\n`). Heartbeats keep
 * idle proxies/clients from dropping the connection between runs; the comment
 * form carries no data and is ignored by SSE parsers.
 */
export const LIVE_HEARTBEAT_INTERVAL_MS = 15_000;
