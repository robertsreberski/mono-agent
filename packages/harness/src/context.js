// The compaction compatibility kit needs only cancellation and optional telemetry.
// This is not a Chord Context and must never grow a general context runtime.
/** @type {Readonly<{abortSignal: AbortSignal}>} */
export const HARNESS_CONTEXT = Object.freeze({ abortSignal: new AbortController().signal });
