import {
  buildEventSpanAttributes,
  buildRootSpanAttributes,
  countRuntimeWarnings,
  spanStatusFor,
} from "@mono-agent/observability/run-export";
import type {
  EventSpanMapping,
  SpanAttributes,
  SpanAttributeValue,
} from "@mono-agent/observability/run-export";
import type {
  RunExportContext,
  RunSummary,
  RuntimeEventLike,
} from "@mono-agent/observability";

/**
 * Minimal, hand-rolled OTLP/HTTP+JSON request builder.
 *
 * Correctness notes (these are pinned by the golden-payload test):
 * - `traceId` is 16 raw bytes, `spanId` is 8 raw bytes, each encoded as a
 *   BASE64 string (NOT hex) per the OTLP/JSON encoding rules.
 * - `startTimeUnixNano` / `endTimeUnixNano` are JSON STRINGS of nanoseconds
 *   (numbers would overflow IEEE-754 for real timestamps).
 * - attributes use `{ key, value: { stringValue | intValue | boolValue |
 *   doubleValue } }`; integer values are emitted as STRINGS under `intValue`.
 *
 * This module is transport-free: it only shapes the JSON body. The network
 * POST lives in `./transport.ts`.
 */

export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly intValue: string }
  | { readonly boolValue: boolean }
  | { readonly doubleValue: number };

export interface OtlpStatus {
  readonly code: number;
  readonly message?: string;
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpAttribute[];
  readonly status?: OtlpStatus;
}

export interface OtlpScopeSpans {
  readonly scope: { readonly name: string; readonly version?: string };
  readonly spans: readonly OtlpSpan[];
}

export interface OtlpResourceSpans {
  readonly resource: { readonly attributes: readonly OtlpAttribute[] };
  readonly scopeSpans: readonly OtlpScopeSpans[];
}

export interface OtlpTraceRequest {
  readonly resourceSpans: readonly OtlpResourceSpans[];
}

export interface OtlpIdFactory {
  /** Returns 16 raw bytes for a trace id. */
  traceId(): Uint8Array;
  /** Returns 8 raw bytes for a span id. */
  spanId(): Uint8Array;
}

export interface BuildOtlpTraceRequestInput {
  readonly summary: RunSummary;
  readonly events: readonly RuntimeEventLike[];
  readonly context: RunExportContext;
  /** Run start time in nanoseconds since the Unix epoch. */
  readonly startTimeUnixNanos: bigint;
  /** Run end time in nanoseconds since the Unix epoch. */
  readonly endTimeUnixNanos: bigint;
  readonly idFactory: OtlpIdFactory;
}

const SCOPE_NAME = "@mono-agent/observability-otel";

// OTel SpanKind enum: 1=INTERNAL, 3=CLIENT (closest to TOOL/LLM external call).
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;

// OTel StatusCode enum: 0=UNSET, 1=OK, 2=ERROR.
const STATUS_CODE_UNSET = 0;
const STATUS_CODE_ERROR = 2;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function isIntegerValue(value: number): boolean {
  return Number.isInteger(value);
}

function toOtlpValue(value: SpanAttributeValue): OtlpAnyValue {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    return isIntegerValue(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function toOtlpAttributes(attributes: SpanAttributes): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    out.push({ key, value: toOtlpValue(value) });
  }
  return out;
}

function kindHintToOtlp(category: EventSpanMapping["category"]): number {
  switch (category) {
    case "tool":
    case "message":
    case "thinking":
      return SPAN_KIND_CLIENT;
    case "runtime":
    case "error":
      return SPAN_KIND_INTERNAL;
  }
}

/**
 * Build the full OTLP/HTTP+JSON `ExportTraceServiceRequest` for one run: a single
 * root span carrying run-level attributes plus one child span per buffered event
 * (all sharing the run's trace id, each child parented to the root).
 */
export function buildOtlpTraceRequest(input: BuildOtlpTraceRequestInput): OtlpTraceRequest {
  const { summary, events, context, startTimeUnixNanos, endTimeUnixNanos, idFactory } = input;

  const traceId = toBase64(idFactory.traceId());
  const rootSpanId = toBase64(idFactory.spanId());
  const start = startTimeUnixNanos.toString();
  const end = endTimeUnixNanos.toString();

  const warningsCount = countRuntimeWarnings(events);
  const rootAttributes = buildRootSpanAttributes(summary, context, warningsCount);
  const rootStatusHint = spanStatusFor(summary.status, "runtime");

  const rootSpan: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: `mono-agent run ${summary.runId}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: toOtlpAttributes(rootAttributes),
    ...(rootStatusHint === "ERROR"
      ? {
          status: {
            code: STATUS_CODE_ERROR,
            ...(summary.failureKind === undefined ? {} : { message: summary.failureKind }),
          },
        }
      : { status: { code: STATUS_CODE_UNSET } }),
  };

  const childSpans: OtlpSpan[] = [];
  events.forEach((event, index) => {
    const mapping = buildEventSpanAttributes(event, index, context);
    const attributes = toOtlpAttributes(mapping.attributes);
    if (mapping.payload !== undefined) {
      attributes.push({
        key: "mono.agent.event.payload",
        value: { stringValue: JSON.stringify(mapping.payload) },
      });
    }
    const eventStatusHint = spanStatusFor(summary.status, mapping.category);
    childSpans.push({
      traceId,
      spanId: toBase64(idFactory.spanId()),
      parentSpanId: rootSpanId,
      name: mapping.name,
      kind: kindHintToOtlp(mapping.category),
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes,
      ...(eventStatusHint === "ERROR"
        ? { status: { code: STATUS_CODE_ERROR } }
        : { status: { code: STATUS_CODE_UNSET } }),
    });
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "mono-agent" } }],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: [rootSpan, ...childSpans],
          },
        ],
      },
    ],
  };
}
