export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 0;
export const DEFAULT_BASE_PATH = "/v1";
export const DEFAULT_MODEL_ID = "agent";

/**
 * Maximum UTF-8 preview bytes retained for each tool argument/result rendered
 * into an SSE chunk. This mirrors the TUI's half-frame payload allowance while
 * leaving room for the other payload plus JSON/SSE/HTML framing metadata.
 */
export const DEFAULT_MAX_TOOL_PAYLOAD_BYTES = (256 * 1024) / 2;
