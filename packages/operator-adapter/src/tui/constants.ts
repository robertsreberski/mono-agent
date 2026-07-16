export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 0;
export const DEFAULT_BASE_PATH = "/tui";

/**
 * Wire schema version surfaced by GET /v1/info so a version-skewed TUI can
 * detect an incompatible agent before starting a turn.
 */
export const TUI_WIRE_SCHEMA = 1;

/**
 * Upper bound for one serialized NDJSON frame. Oversized payloads (huge tool
 * results / progress chunks) are truncated with a marker rather than stalling
 * or ballooning the socket. JSONL replay has its own redaction/string caps and
 * terminal-only event-file boundary, so it is not a full-payload recovery path.
 */
export const MAX_FRAME_BYTES = 256 * 1024;
