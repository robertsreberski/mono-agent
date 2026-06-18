# @mono-agent/observability-otel

## Category

Category: `observability`

## Responsibility

OTLP/HTTP **protobuf** trace exporter for agent run lifecycles, with a Phoenix preset. It maps a mono-agent run (root span) and its events into a SEMANTIC timeline of OTLP `ReadableSpan[]` — streaming assistant deltas coalesce into one "Assistant thoughts"/"Assistant message" span, and a tool invocation's `tool_use` + `tool_timing` + `tool_result` events merge by `tool_use_id` into one TOOL span (input = args, output = result) — then serializes them to a binary `ExportTraceServiceRequest` via `@opentelemetry/otlp-transformer` and POSTs it (`application/x-protobuf`) to a Phoenix OTLP HTTP traces endpoint, the only wire format Phoenix's `/v1/traces` accepts. Spans carry OpenInference semantics (`openinference.span.kind` = AGENT/LLM/TOOL/CHAIN, `input.value`/`output.value`) and route to a named project via the `openinference.project.name` resource attribute. Trace/span ids are deterministic (keyed on the run id) so a re-export overwrites in Phoenix instead of duplicating. The exporter is additive and best-effort: it implements the `RunExporter` contract from `@mono-agent/observability` and is composed alongside the JSONL run recorder, never replacing it.

## Install / Usage

```bash
pnpm --filter @mono-agent/observability-otel run build
```

```ts
import { createPhoenixRunExporter } from "@mono-agent/observability-otel";

const exporter = createPhoenixRunExporter({
  type: "phoenix",
  endpoint: "http://127.0.0.1:6006/v1/traces",
  includeSensitiveData: false,
});
```

The exporter buffers events as they are replayed through `onEvent` and emits the whole run as a single OTLP POST in `finish`/`fail` (batch-on-finish). It is normally wrapped by `createCompositeRunRecorder` from `@mono-agent/observability`, which owns the bounded timeout and swallows export failures so the run outcome is never affected.

## Public API

- `createPhoenixRunExporter(config, deps?)` — returns a `RunExporter`; `deps` injects `fetch`, `now`, and a per-run `idFactory` for hermetic tests.
- `DEFAULT_PHOENIX_ENDPOINT`
- `buildRunReadableSpans(input)` — pure run → OTLP `ReadableSpan[]` mapper (root + child spans, OpenInference attributes, project routing).
- `serializeTraceSpans(spans)` — protobuf `ExportTraceServiceRequest` bytes via `@opentelemetry/otlp-transformer`.
- `createDeterministicIdFactory(runId)` / `idToHex(bytes)` — deterministic, idempotent trace/span ids.
- `postOtlpProtobuf(input)` — native-fetch `application/x-protobuf` POST with `AbortController` timeout.

## Dependency Boundary

This package depends on `@mono-agent/observability` (for the `RunExporter` contract, run/summary types, and the pure `./run-export` attribute-mapping helpers) and on `@opentelemetry/otlp-transformer` (for protobuf serialization — Phoenix's `/v1/traces` accepts only `application/x-protobuf`, so a hand-rolled OTLP/JSON body cannot satisfy it). The HTTP transport itself is the platform `fetch` + `AbortController` + `setTimeout` idiom. It must not depend on the agent harness, runtime adapter, config, channels, or operator surfaces. Hosts compose the exporter via the composite recorder.

## What This Package Does Not Own

It does not write or read JSONL run artifacts (that stays in `@mono-agent/observability`), does not classify or summarize events (it reuses the pure mapping from the `./run-export` subpath), does not resolve config or env (that is `@mono-agent/config`), does not own the export timeout/best-effort isolation (the composite recorder does), and does not probe endpoint reachability (that is `mono-agent validate`). It never blocks or fails an agent run.

## Verification

```bash
pnpm --filter @mono-agent/observability-otel run build
pnpm --filter @mono-agent/observability-otel run typecheck
pnpm --filter @mono-agent/observability-otel run test
```
