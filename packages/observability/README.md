# @mono-agent/observability

## Category

Category: `observability`

## Responsibility

Local JSONL run observability and host trace source discovery. It records runtime events and compact summaries, redacts sensitive payload fields by default, lists recorded runs, reads selected run detail for local operator surfaces, and lets running agent processes register their artifact directories in a file-backed trace registry.

## Install / Usage

```bash
pnpm --filter @mono-agent/observability run build
```

```ts
import {
  createJsonlRunRecorder,
  auditRecordedRuns,
  registerTraceSource,
  combineRecordedRunEvents,
  listRecordedRuns,
  listTraceRuns,
  pruneRunArtifacts,
  readRecordedRun,
} from "@mono-agent/observability";
```

## Public API

- `createJsonlRunRecorder`, `JsonlRunRecorder`
- `auditRecordedRuns`
- `listRecordedRuns`, `readRecordedRun`, `pruneRunArtifacts`, `classifyRecordedRunEvent`
- `combineRecordedRunEvents`
- `registerTraceSource`, `listTraceSources`, `listTraceRuns`, `readTraceRun`
- `redactJsonValue`
- `createCompositeRunRecorder` plus the `RunExporter` / `RunExportContext` / `RunExportEventContext` contracts
- `buildRootSpanAttributes`, `buildEventSpanAttributes`, `countRuntimeWarnings`, `spanKindHint` and the exporter-config types (`PhoenixExporterConfig`, `ObservabilityExporterConfig`)
- `ObservabilityError`, `ObservabilityReadError`
- Recorder, summary, list, detail, event, trace source, and trace run types

## Timeline Display

Raw `.events.jsonl` artifacts stay append-only and one event per line. UI surfaces that need readable timelines can call `combineRecordedRunEvents()` to collapse adjacent assistant `thinking` or visible `text` stream chunks into bounded display rows while preserving raw source index ranges and event counts. Browser bundles can import the helper from `@mono-agent/observability/event-timeline` without pulling in the Node-backed artifact readers.

## Trace Registry

The trace registry is a directory of `agent-runtime.trace-source.v1` manifest JSON files. A running host registers one source with a stable `sourceId`, label, artifact directory, process id, status, and heartbeat timestamp. The registry only discovers agents and their artifact locations; run summaries and event JSONL files remain in each source's artifact directory.

Running sources become `stale` when their heartbeat is older than the configured stale interval. Stopped and failed sources remain listed so the dashboard can distinguish a clean shutdown from a crashed or misconfigured host. The registry reader validates source/run ids against path traversal, ignores malformed manifests with warnings, and reuses the recorded-run reader's redaction and bounded-read limits.

## Run Export Contract

The package defines the `RunExporter` contract (`start`/`onEvent`/`finish`/`fail`/`flush`/`close`, all optional and async-capable) and a pure `createCompositeRunRecorder` that wraps the unchanged JSONL recorder. The composite keeps `RunRecorder.onEvent` synchronous, runs the JSONL recorder first and unchanged, buffers events, and replays them to the exporter batch-on-finish under a bounded timeout. Exporter failures and timeouts are swallowed and surfaced as warnings, so export never changes the run outcome and never suppresses JSONL writes.

The `./run-export` subpath exposes the pure, node-free event-to-span attribute mapping (`buildRootSpanAttributes`, `buildEventSpanAttributes`, `countRuntimeWarnings`, `spanKindHint`) plus the exporter-config types. It imports only node-free helpers (guards, redaction, event-classify, content) so it is safe for browser graphs, exactly like `./event-timeline`.

Privacy default is metadata-only: when `includeSensitiveData` is `false`, raw payloads are omitted and only summaries/labels are mapped; when `true`, `redactJsonValue` still runs over the payload before it leaves the process. The actual network transport (OTLP/HTTP+JSON, the Phoenix preset) lives in the separate `@mono-agent/observability-otel` package, not here.

## Dependency Boundary

This package writes and reads local artifact and registry files only. It has no runtime, adapter, UI, database, queue, or network dependency. The exporter contract and pure span mapping live here, but the OTLP network transport is out-of-package (in `@mono-agent/observability-otel`), keeping this package free of any network dependency.

## What This Package Does Not Own

It does not provide a hosted trace backend, metrics service, durable database, UI, LangSmith export, OpenTelemetry exporter, or model-specific telemetry collector.

## Verification

```bash
pnpm --filter @mono-agent/observability run build
pnpm --filter @mono-agent/observability run typecheck
pnpm --filter @mono-agent/observability run test
```
