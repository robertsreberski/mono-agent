# @worklab-ai/observability

## Category

Category: `observability`

## Responsibility

Local JSONL run observability. It records runtime events and compact summaries, redacts sensitive payload fields by default, lists recorded runs, and reads a selected run detail for local operator surfaces.

## Install / Usage

```bash
pnpm --filter @worklab-ai/observability run build
```

```ts
import {
  createJsonlRunRecorder,
  listRecordedRuns,
  readRecordedRun,
} from "@worklab-ai/observability";
```

## Public API

- `createJsonlRunRecorder`, `JsonlRunRecorder`
- `listRecordedRuns`, `readRecordedRun`, `classifyRecordedRunEvent`
- `redactJsonValue`
- `ObservabilityError`, `ObservabilityReadError`
- Recorder, summary, list, detail, and event types

## Dependency Boundary

This package writes and reads local artifact files only. It has no runtime, adapter, UI, database, queue, or network dependency.

## What This Package Does Not Own

It does not provide a hosted trace backend, metrics service, durable database, UI, or model-specific telemetry collector.

## Verification

```bash
pnpm --filter @worklab-ai/observability run build
pnpm --filter @worklab-ai/observability run typecheck
pnpm --filter @worklab-ai/observability run test
```
