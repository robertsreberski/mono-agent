# @mono-agent/observability

## Category

Category: `observability`

## Responsibility

Local JSONL run observability and host trace source discovery. It records runtime events and compact summaries, applies key-based redaction and string bounds, lists recorded runs, reads selected run detail for local operator surfaces, and lets running agent processes register their artifact directories plus optional content-free memory health in a file-backed trace registry. Redaction replaces non-numeric values under sensitive-looking object keys; it does not scan free text for secret-shaped content.

Numeric values under matched keys are retained. Current matcher limitations remain follow-up work: space-, dot-, slash-, and colon-separated `private`/`api` + `key` spellings are not matched, while substring matching conservatively redacts string values under benign keys such as `credentialType`, `bearerStatus`, and `privateKeyboard`.

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

The Phoenix OTLP exporter is available from the `./otel` subpath so ordinary
observability imports do not load OpenTelemetry or network transport code:

```ts
import { createPhoenixRunExporter } from "@mono-agent/observability/otel";
```

## Public API

- `createJsonlRunRecorder`, `JsonlRunRecorder`
- `auditRecordedRuns`
- `listRecordedRuns`, `readRecordedRun`, `pruneRunArtifacts`, `classifyRecordedRunEvent`, `isSafeRunId`
- `combineRecordedRunEvents`
- `registerTraceSource`, `listTraceSources`, `listTraceRuns`, `readTraceRun`, and the closed `TraceSourceMemoryHealth` backend/mode/status/issue/count types
- `redactJsonValue`
- `createCompositeRunRecorder` plus the `RunExporter` / `RunExportContext` / `RunExportEventContext` contracts
- `buildRootSpanAttributes`, `buildEventSpanAttributes`, `countRuntimeWarnings`, `spanKindHint` and the exporter-config types (`PhoenixExporterConfig`, `ObservabilityExporterConfig`)
- `ObservabilityError`, `ObservabilityReadError`
- Recorder, summary, list, detail, event, trace source, and trace run types

`readRecordedRun` keeps the first `maxEventsPerRun` events by default. Readers
that need bounded final-output evidence can set `eventSelection: "head-tail"` to
split that same cap between the beginning and end while preserving original
event indexes so an omitted middle remains detectable. Head-tail reads stream
into a fixed-size ring and refuse event artifacts above the 16 MiB safety bound.

## OTLP / Phoenix Subpath

`@mono-agent/observability/otel` exposes the optional network exporter:

- `createPhoenixRunExporter(config, deps?)`
- `DEFAULT_PHOENIX_ENDPOINT`
- `buildRunReadableSpans(input)`
- `serializeTraceSpans(spans)`
- `createDeterministicIdFactory(runId)` / `idToHex(bytes)`
- `postOtlpProtobuf(input)`

The subpath maps a mono-agent run and events into OpenInference-flavored OTLP
spans, serializes them with `@opentelemetry/otlp-transformer`, and posts binary
protobuf (`application/x-protobuf`) to a Phoenix OTLP HTTP traces endpoint.
Hosts compose it through `createCompositeRunRecorder`; export stays additive,
best-effort, and isolated from the JSONL recorder.

## Timeline Display

`.events.jsonl` artifacts contain one key-redacted, bounded event per line after a
terminal recorder boundary. Event strings use a 4,096-byte default cap. The
recorder replaces that terminal snapshot at the boundary; it does not append
events while a run is in progress. UI surfaces that need readable
timelines can call `combineRecordedRunEvents()` to collapse adjacent assistant
`thinking` or visible `text` stream chunks into bounded display rows while
preserving raw source index ranges and event counts. Browser bundles can import
the helper from
`@mono-agent/observability/event-timeline` without pulling in the Node-backed
artifact readers.

## Trace Registry

The trace registry is a directory of `agent-runtime.trace-source.v1` manifest JSON files. A running host registers one source with a stable `sourceId`, label, artifact directory, process id, status, and heartbeat timestamp. The registry only discovers agents and their artifact locations; run summaries and event JSONL files remain in each source's artifact directory.

A manifest may include `memoryHealth` independently of process health. The typed
shape is discriminated by backend: built-in `bujo` requires its mode and closed
status/issues (plus optional whitelisted counts), `supermemory` is `unknown`, and
`none` is `not_configured|unknown`; remote/absent variants omit mode/issues/counts.
Readers normalize this untrusted field, discard unknown structural/count extras,
reject impossible calendar instants, and turn malformed issue lists or contradictory
known counts into timestamp-preserving `unknown`. Issue arrays must use the closed
producer order without duplicates. Duplicate sources merge their freshest memory
snapshot independently by `checkedAt`.
The contract contains no paths, ids, text, payloads, or raw errors.

Per-source writes are serialized and terminal stop is final: an already-entered
heartbeat or update cannot overwrite the stopped manifest.

Running sources become `stale` when their heartbeat is older than the configured stale interval. Stopped and failed sources remain listed so the dashboard can distinguish a clean shutdown from a crashed or misconfigured host. The registry reader validates source/run ids against path traversal, ignores malformed manifests with warnings, and reuses the recorded-run reader's redaction and bounded-read limits.

Stale-run reconciliation repairs summary status from persisted data only. At
`start()`, the JSONL recorder performs separate atomic replacements for an empty
events file and a `running` summary. It then buffers key-redacted events in memory.
Terminal `finish()`/`fail()` uses separate atomic replacements for the bounded
events snapshot first and the summary second. These writes provide no append,
checkpoint, fsync, or cross-file transaction guarantee: a process death can lose
buffered events and reconcile as `process_death` with `eventCount: 0`. The app's
live broadcast gives connected TUI/web clients best-effort visibility, not
recovery or post-mortem evidence.

## Run Export Contract

The package defines the `RunExporter` contract (`start`/`onEvent`/`finish`/`fail`/`flush`/`close`, all optional and async-capable) and a pure `createCompositeRunRecorder` that wraps the unchanged JSONL recorder. The composite keeps `RunRecorder.onEvent` synchronous, runs the JSONL recorder first and unchanged, buffers events, and replays them to the exporter batch-on-finish under a bounded timeout. Exporter failures and timeouts are swallowed and surfaced as warnings, so export never changes the run outcome and never suppresses JSONL writes.

The `./run-export` subpath exposes the pure, node-free event-to-span attribute mapping (`buildRootSpanAttributes`, `buildEventSpanAttributes`, `countRuntimeWarnings`, `spanKindHint`) plus the exporter-config types. It imports only node-free helpers (guards, redaction, event-classify, content) so it is safe for browser graphs, exactly like `./event-timeline`.

Privacy default is metadata-only: when `includeSensitiveData` is `false`, raw payloads are omitted and only summaries/labels are mapped. When `true`, non-numeric values under sensitive-looking object keys are redacted, numeric values under matched keys are retained, and strings are capped before export, but free-text user input, assistant replies, tool prose, error text, and system prompts are not content-scanned or scrubbed. Treat this flag as exporting substantive run content. The actual network transport (OTLP/HTTP protobuf, the Phoenix preset) lives behind the `@mono-agent/observability/otel` subpath.

## Dependency Boundary

The root import writes and reads local artifact and registry files only. It has no runtime, adapter, UI, database, queue, or network dependency. The exporter contract and pure span mapping live at the root / `./run-export`; the OTLP network transport is subpath-only in `./otel`, keeping normal observability imports free of OpenTelemetry runtime loading.

## What This Package Does Not Own

It does not provide a hosted trace backend, metrics service, durable database, UI, LangSmith export, or model-specific telemetry collector.

## Verification

```bash
pnpm --filter @mono-agent/observability run build
pnpm --filter @mono-agent/observability run typecheck
pnpm --filter @mono-agent/observability run test
```
