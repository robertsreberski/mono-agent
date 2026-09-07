import { createDeterministicIdFactory } from "./ids.js";
import { serializeTraceSpans } from "./serialize.js";
import { buildRunReadableSpans } from "./spans.js";
import type { BuildRunReadableSpansInput } from "./spans.js";

/** Complete protobuf payload for app-owned backfill without exposing SDK types. */
export function serializeRunTrace(
  input: Omit<BuildRunReadableSpansInput, "idFactory">,
): { readonly body: Uint8Array; readonly spanCount: number } {
  const spans = buildRunReadableSpans({
    ...input,
    idFactory: createDeterministicIdFactory(input.summary.runId),
  });
  return { body: serializeTraceSpans(spans), spanCount: spans.length };
}

/** Empty OTLP request for explicit endpoint-health probes. */
export function serializeEmptyTrace(): Uint8Array {
  return serializeTraceSpans([]);
}
