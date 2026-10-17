// Hard wall clock for a single MCP tool call. Progress notifications reset the
// inactivity timeout above but must never extend a call past this cap (45 min) —
// sized for legitimately long tools (audio transcription, ask-the-user waits).
export const DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS = 2_700_000;
