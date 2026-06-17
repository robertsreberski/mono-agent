import { buildEventDescriptors } from "./event-classify.js";
import { DEFAULT_MAX_STRING_BYTES } from "./guards.js";
import { redactJsonValue } from "./redaction.js";
import type {
  RecordedRunEventCategory,
  RunExportContext,
  RunSummary,
  RunSummaryStatus,
  RuntimeEventLike,
} from "./types.js";

/**
 * Pure, node-free event -> span attribute mapping for the Phoenix/OTLP export
 * surface. Imports ONLY node-free modules (event-classify/guards/redaction/
 * types) so the built `dist/run-export-mapping.js` stays browser-safe and can be
 * imported through the './run-export' subpath without dragging node:fs/node:path
 * into the operator-console graph. The concrete network transport lives in
 * @mono-agent/observability-otel; this module only shapes attribute bags.
 */

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;

export type SpanKindHint = "TOOL" | "LLM" | "INTERNAL";
export type SpanStatusHint = "ERROR" | "UNSET";

export interface EventSpanMapping {
  readonly name: string;
  readonly category: RecordedRunEventCategory;
  readonly attributes: SpanAttributes;
  /**
   * Only set when sensitive export is opt-in (includeSensitiveData=true). The
   * payload is STILL passed through `redactJsonValue` before it is attached, so
   * sensitive keys collapse to `[redacted]` even in opt-in mode.
   */
  readonly payload?: unknown;
}

/**
 * Build the root run span attribute bag (spec section 7 root keys). Optional
 * context fields are omitted entirely when absent (conditional spreads, never
 * `key: undefined`). `artifact_dir` is gated behind `includeSensitiveData`
 * because it discloses a local filesystem path ("only when explicitly allowed
 * for local debug").
 *
 * `warningsCount` is supplied by the caller via {@link countRuntimeWarnings};
 * it is intentionally EVENT-DERIVED (counting `type === 'runtime_warning'`)
 * rather than read from `summary.runtimeWarnings`, so the exported integer stays
 * stable regardless of the loosely-typed `runtimeWarnings` payload shape.
 */
export function buildRootSpanAttributes(
  summary: RunSummary,
  ctx: RunExportContext,
  warningsCount: number,
): SpanAttributes {
  return {
    "service.name": "mono-agent",
    "mono.agent.run_id": summary.runId,
    "mono.agent.conversation_id": summary.conversationId,
    ...(ctx.sourceId === undefined ? {} : { "mono.agent.source_id": ctx.sourceId }),
    ...(ctx.sourceLabel === undefined ? {} : { "mono.agent.source_label": ctx.sourceLabel }),
    ...(ctx.configPath === undefined ? {} : { "mono.agent.config_path": ctx.configPath }),
    "mono.agent.status": summary.status,
    ...(summary.failureKind === undefined ? {} : { "mono.agent.failure_kind": summary.failureKind }),
    ...(summary.providerSessionId === undefined || summary.providerSessionId === null
      ? {}
      : { "mono.agent.provider_session_id": summary.providerSessionId }),
    "mono.agent.events.count": summary.eventCount,
    "mono.agent.warnings.count": warningsCount,
    ...(ctx.includeSensitiveData && ctx.artifactDir !== undefined
      ? { "mono.agent.artifact_dir": ctx.artifactDir }
      : {}),
  };
}

/**
 * Build a per-event child span mapping. Category/label/summary are derived via
 * {@link buildEventDescriptors} (the single source of truth shared with the
 * recorded-run reader) so the export never re-derives classification logic.
 *
 * Provider/model latency events (e.g. `provider_bridge_latency`, `tool_timing`)
 * ride this generic per-event span path: they classify as `runtime` and become
 * ordinary child spans rather than a bespoke model span, satisfying spec 6.4's
 * "root span event" option without inventing a dedicated latency mapping.
 */
export function buildEventSpanAttributes(
  event: RuntimeEventLike,
  index: number,
  ctx: RunExportContext,
  maxStringBytes: number = DEFAULT_MAX_STRING_BYTES,
): EventSpanMapping {
  const { category, label, summary } = buildEventDescriptors(event, maxStringBytes);
  const eventType = typeof event.type === "string" ? event.type : "";
  const attributes: SpanAttributes = {
    "mono.agent.event.index": index,
    "mono.agent.event.type": eventType,
    "mono.agent.event.category": category,
    "mono.agent.event.label": label,
    "mono.agent.event.summary": summary,
    "mono.agent.run_id": ctx.runId,
    ...(ctx.sourceId === undefined ? {} : { "mono.agent.source_id": ctx.sourceId }),
  };
  return {
    name: label,
    category,
    attributes,
    // Metadata-only by default: omit the raw payload entirely. When sensitive
    // export is opted in, STILL redact before attaching (spec section 7).
    ...(ctx.includeSensitiveData ? { payload: redactJsonValue(event, maxStringBytes) } : {}),
  };
}

/**
 * Count runtime warnings from the buffered event stream. Intentionally
 * event-derived (`type === 'runtime_warning'`) so the integer is stable and does
 * not depend on the loosely-typed `RunSummary.runtimeWarnings` payload shape.
 */
export function countRuntimeWarnings(events: readonly RuntimeEventLike[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "runtime_warning") {
      count += 1;
    }
  }
  return count;
}

/** Suggest an OTel span kind for a recorded-event category. */
export function spanKindHint(category: RecordedRunEventCategory): SpanKindHint {
  switch (category) {
    case "tool":
      return "TOOL";
    case "message":
    case "thinking":
      return "LLM";
    case "runtime":
    case "error":
      return "INTERNAL";
  }
}

/**
 * Derive a span status. A failed/cancelled run, or an `error`-category event,
 * maps to ERROR; everything else is UNSET. A `runtime_warning` event (which
 * classifies as `runtime`) on a succeeded run therefore never forces ERROR.
 */
export function spanStatusFor(
  status: RunSummaryStatus,
  category: RecordedRunEventCategory,
): SpanStatusHint {
  if (status === "failed" || status === "cancelled" || category === "error") {
    return "ERROR";
  }
  return "UNSET";
}
