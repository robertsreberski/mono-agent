import { describe, expect, it } from "vitest";
import type { RunExportContext, RunSummary, RuntimeEventLike } from "@mono-agent/observability";

import { buildOtlpTraceRequest } from "../otlp-json.js";

const HEX_TRACE_ID = /^[0-9a-f]{32}$/u;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/u;

const summary: RunSummary = {
  runId: "run-1",
  conversationId: "conv-1",
  status: "succeeded",
  durationMs: 1234,
  eventCount: 2,
  artifactPaths: [],
  providerSessionId: "prov-1",
};

const ctx: RunExportContext = {
  runId: "run-1",
  conversationId: "conv-1",
  sourceId: "src-1",
  sourceLabel: "Source One",
  configPath: "/etc/mono.json",
  includeSensitiveData: false,
};

const events: readonly RuntimeEventLike[] = [
  { type: "tool_call", name: "Read", input: { path: "/tmp/x" } },
  { type: "assistant_message", content: "hello there" },
];

describe("buildOtlpTraceRequest", () => {
  it("produces a single resourceSpans -> scopeSpans with a root span and child event spans", () => {
    const request = buildOtlpTraceRequest({
      summary,
      events,
      context: ctx,
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: makeDeterministicIdFactory(),
    });

    expect(request.resourceSpans).toHaveLength(1);
    const resourceSpan = request.resourceSpans[0]!;
    expect(resourceSpan.scopeSpans).toHaveLength(1);
    const spans = resourceSpan.scopeSpans[0]!.spans;
    // one root + two events
    expect(spans).toHaveLength(3);
  });

  it("encodes traceId as 32-char hex and spanId as 16-char hex (OTLP/JSON spec, NOT base64)", () => {
    const request = buildOtlpTraceRequest({
      summary,
      events,
      context: ctx,
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: makeDeterministicIdFactory(),
    });
    const spans = request.resourceSpans[0]!.scopeSpans[0]!.spans;
    for (const span of spans) {
      // 16 trace bytes -> 32 hex chars; 8 span bytes -> 16 hex chars; lowercase only.
      expect(span.traceId).toMatch(HEX_TRACE_ID);
      expect(span.spanId).toMatch(HEX_SPAN_ID);
    }
    // Exact hex of the deterministic factory's bytes (trace = 1..16, root span = all 1s).
    const root = spans[0]!;
    expect(root.traceId).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(root.spanId).toBe("0101010101010101");
    expect(spans[1]!.spanId).toBe("0202020202020202");
    // all spans share the same trace id
    const traceIds = new Set(spans.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);
  });

  it("uses string-of-nanos for startTimeUnixNano/endTimeUnixNano", () => {
    const request = buildOtlpTraceRequest({
      summary,
      events,
      context: ctx,
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: makeDeterministicIdFactory(),
    });
    const root = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(typeof root.startTimeUnixNano).toBe("string");
    expect(root.startTimeUnixNano).toBe("1000000000");
    expect(typeof root.endTimeUnixNano).toBe("string");
    expect(root.endTimeUnixNano).toBe("2000000000");
  });

  it("sets child event spans' parentSpanId to the root span id", () => {
    const request = buildOtlpTraceRequest({
      summary,
      events,
      context: ctx,
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: makeDeterministicIdFactory(),
    });
    const spans = request.resourceSpans[0]!.scopeSpans[0]!.spans;
    const root = spans[0]!;
    expect(root.parentSpanId).toBeUndefined();
    for (const child of spans.slice(1)) {
      expect(child.parentSpanId).toBe(root.spanId);
    }
  });

  it("carries mono.agent.run_id attribute with a stringValue on the root span", () => {
    const request = buildOtlpTraceRequest({
      summary,
      events,
      context: ctx,
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: makeDeterministicIdFactory(),
    });
    const root = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const runIdAttr = root.attributes.find((a) => a.key === "mono.agent.run_id");
    expect(runIdAttr).toBeDefined();
    expect(runIdAttr!.value).toEqual({ stringValue: "run-1" });
  });

  it("encodes integer, boolean, and double attribute values with the correct OTLP key", () => {
    const request = buildOtlpTraceRequest({
      summary,
      events,
      context: ctx,
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: makeDeterministicIdFactory(),
    });
    const root = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const eventsCount = root.attributes.find((a) => a.key === "mono.agent.events.count");
    expect(eventsCount!.value).toEqual({ intValue: "2" });
  });

  it("marks span status ERROR (code 2) for a failed run", () => {
    const failedSummary: RunSummary = { ...summary, status: "failed", failureKind: "provider_error" };
    const request = buildOtlpTraceRequest({
      summary: failedSummary,
      events,
      context: ctx,
      startTimeUnixNanos: 1_000_000_000n,
      endTimeUnixNanos: 2_000_000_000n,
      idFactory: makeDeterministicIdFactory(),
    });
    const root = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(root.status?.code).toBe(2);
  });
});

function makeDeterministicIdFactory(): {
  traceId(): Uint8Array;
  spanId(): Uint8Array;
} {
  let span = 0;
  return {
    traceId(): Uint8Array {
      return new Uint8Array(Array.from({ length: 16 }, (_v, i) => i + 1));
    },
    spanId(): Uint8Array {
      span += 1;
      return new Uint8Array(Array.from({ length: 8 }, () => span));
    },
  };
}
