// The compaction compatibility kit needs only cancellation and optional telemetry.
// This is not a Chord Context and must never grow a general context runtime.
export const ENGINE_CONTEXT: Readonly<{ abortSignal: AbortSignal; }> = Object.freeze({ abortSignal: new AbortController().signal });
