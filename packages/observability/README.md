# @worklab-ai/observability

## Category

Category: `observability`

## Responsibility

Local JSONL run observability and host trace source discovery. It records runtime events and compact summaries, redacts sensitive payload fields by default, lists recorded runs, reads selected run detail for local operator surfaces, and lets running Mono Agent processes register their artifact directories in a file-backed trace registry.

## Install / Usage

```bash
pnpm --filter @worklab-ai/observability run build
```

```ts
import {
  createJsonlRunRecorder,
  registerTraceSource,
  combineRecordedRunEvents,
  listRecordedRuns,
  listTraceRuns,
  readRecordedRun,
} from "@worklab-ai/observability";
```

## Public API

- `createJsonlRunRecorder`, `JsonlRunRecorder`
- `listRecordedRuns`, `readRecordedRun`, `classifyRecordedRunEvent`
- `combineRecordedRunEvents`
- `registerTraceSource`, `listTraceSources`, `listTraceRuns`, `readTraceRun`
- `redactJsonValue`
- `ObservabilityError`, `ObservabilityReadError`
- Recorder, summary, list, detail, event, trace source, and trace run types

## Timeline Display

Raw `.events.jsonl` artifacts stay append-only and one event per line. UI surfaces that need readable timelines can call `combineRecordedRunEvents()` to collapse adjacent assistant `thinking` or visible `text` stream chunks into bounded display rows while preserving raw source index ranges and event counts. Browser bundles can import the helper from `@worklab-ai/observability/event-timeline` without pulling in the Node-backed artifact readers.

## Trace Registry

The trace registry is a directory of `worklab.trace-source.v1` manifest JSON files. A running host registers one source with a stable `sourceId`, label, artifact directory, process id, status, and heartbeat timestamp. The registry only discovers agents and their artifact locations; run summaries and event JSONL files remain in each source's artifact directory.

Running sources become `stale` when their heartbeat is older than the configured stale interval. Stopped and failed sources remain listed so the dashboard can distinguish a clean shutdown from a crashed or misconfigured host. The registry reader validates source/run ids against path traversal, ignores malformed manifests with warnings, and reuses the recorded-run reader's redaction and bounded-read limits.

## Dependency Boundary

This package writes and reads local artifact and registry files only. It has no runtime, adapter, UI, database, queue, or network dependency.

## What This Package Does Not Own

It does not provide a hosted trace backend, metrics service, durable database, UI, LangSmith export, OpenTelemetry exporter, or model-specific telemetry collector.

## Verification

```bash
pnpm --filter @worklab-ai/observability run build
pnpm --filter @worklab-ai/observability run typecheck
pnpm --filter @worklab-ai/observability run test
```
