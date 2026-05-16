# @worklab-ai/observability

Run event recording and artifact summaries for Mono Agent hosts.

`createJsonlRunRecorder()` records runtime-like events, redacts obvious secrets, and writes JSONL event artifacts plus compact JSON summaries containing status, duration, usage, cost, provider session id, failure kind, warnings, diagnostics, and capabilities used.

## Recorded run reader

`listRecordedRuns()` and `readRecordedRun()` provide the read-side contract used by the config UI Observability view. They read only from a configured artifact directory, never from request-provided paths.

```ts
import { listRecordedRuns, readRecordedRun } from "@worklab-ai/observability";

const list = await listRecordedRuns({
  artifactDir: "/path/to/.mono-agent/artifacts",
  maxRuns: 50,
});

const detail = await readRecordedRun(
  { artifactDir: "/path/to/.mono-agent/artifacts", maxEventsPerRun: 500 },
  list.runs[0]?.runId ?? "",
);
```

The reader:

- lists `*.summary.json` files newest first and returns an empty list if the artifact directory does not exist yet;
- validates the minimal recorded-run shape instead of treating arbitrary JSON as a run;
- reads matching `*.events.jsonl` files by sanitized run id;
- caps list/event sizes and string payload sizes;
- redacts sensitive keys again on read so older artifacts do not leak obvious secrets;
- skips malformed individual JSONL lines with warnings rather than failing the whole run detail; and
- classifies visible runtime events into `tool`, `thinking`, `message`, `runtime`, or `error` buckets from explicit event types/keys only.

The `thinking` bucket means a runtime emitted a visible reasoning/thinking-process event. This package does not infer or expose private model chain-of-thought.
