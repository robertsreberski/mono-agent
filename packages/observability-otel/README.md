# @mono-agent/observability-otel

## Category

Category: `observability`

## Responsibility

Hand-rolled OTLP/HTTP+JSON trace exporter for agent run lifecycles, with a Phoenix preset. It maps a mono-agent run (root span) and its buffered events (child spans) into an OTLP `ExportTraceServiceRequest` and POSTs it to a Phoenix-compatible OTLP HTTP traces endpoint. The exporter is additive and best-effort: it implements the `RunExporter` contract from `@mono-agent/observability` and is composed alongside the JSONL run recorder, never replacing it.

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

- `createPhoenixRunExporter(config, deps?)` — returns a `RunExporter`; `deps` injects `fetch`, `now`, and `idFactory` for hermetic tests.
- `DEFAULT_PHOENIX_ENDPOINT`
- `buildOtlpTraceRequest(input)` — pure OTLP/HTTP+JSON request builder.
- `postOtlpJson(input)` — native-fetch OTLP POST with `AbortController` timeout.
- OTLP request, span, attribute, id-factory, and transport types.

## Dependency Boundary

This package depends only on `@mono-agent/observability` (for the `RunExporter` contract, run/summary types, and the pure `./run-export` attribute-mapping helpers). It adds ZERO external runtime dependencies: the OTLP/HTTP+JSON transport is built on the platform `fetch` + `AbortController` + `setTimeout` idiom. It must not depend on the agent harness, runtime adapter, config, channels, or operator surfaces. Hosts compose the exporter via the composite recorder.

## What This Package Does Not Own

It does not write or read JSONL run artifacts (that stays in `@mono-agent/observability`), does not classify or summarize events (it reuses the pure mapping from the `./run-export` subpath), does not resolve config or env (that is `@mono-agent/config`), does not own the export timeout/best-effort isolation (the composite recorder does), and does not probe endpoint reachability (that is `doctor`). It never blocks or fails an agent run.

## Verification

```bash
pnpm --filter @mono-agent/observability-otel run build
pnpm --filter @mono-agent/observability-otel run typecheck
pnpm --filter @mono-agent/observability-otel run test
```
