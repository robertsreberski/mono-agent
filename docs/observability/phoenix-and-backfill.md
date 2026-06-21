---
title: "Phoenix export & backfill"
parent: "Observability & CLI"
nav_order: 2
---

This page covers the Phoenix OTLP exporter — an additive, best-effort export of every run lifecycle to [Arize Phoenix](https://phoenix.arize.com/) as semantic OpenInference spans — and the `mono-agent backfill` command that retroactively exports already-recorded run artifacts. Both reuse the same OTLP mapping, so live traces and backfilled traces are identical in Phoenix.

Phoenix export never changes a run's outcome and never suppresses the local JSONL artifacts. See [Artifacts & traces](artifacts-and-traces.md) for the always-on run record that the exporter and backfill read from.

## What the exporter does

When you add a `phoenix` entry to `observability.exporters[]`, the host exports each run lifecycle over **OTLP/HTTP protobuf** as a semantic timeline:

- **Streaming assistant deltas coalesce** into one "Assistant thoughts" / "Assistant message" span instead of one span per token chunk.
- **A tool's three events merge into one span.** The `tool_use`, `tool_timing`, and `tool_result` events that share a `tool_use_id` are merged into a single `TOOL` span (input = args, output = result).
- **Spans carry OpenInference semantics** — `openinference.span.kind` is one of `AGENT`, `LLM`, `TOOL`, or `CHAIN`, with `input.value` / `output.value` attributes. Spans route to a named project via `openinference.project.name`, which defaults to the trace source label/id.
- **Per-run span ids are deterministic**, so re-exporting the same run is idempotent — it overwrites rather than duplicates.

Export is **metadata-only by default**: span inputs/outputs are exported, but raw message/tool payloads are withheld unless you opt in (see `includeSensitiveData`). Failures are bounded by `timeoutMs` and are swallowed — a Phoenix outage cannot fail or stall a run.

The transport lives in `@mono-agent/observability-otel` (built on `@opentelemetry/otlp-transformer`). Coverage: **config**.
{: .note }

## Configuration

Add one `phoenix` entry to `observability.exporters[]`. Omit the whole `observability` block to keep only local JSONL artifacts.

```json
{
  "observability": {
    "exporters": [
      {
        "type": "phoenix",
        "endpoint": "http://127.0.0.1:6006/v1/traces",
        "projectName": "my-agent",
        "includeSensitiveData": false,
        "headers": { "authorization": "Bearer sk-..." },
        "timeoutMs": 5000
      }
    ]
  }
}
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `type` | string | — | Must be `"phoenix"`. |
| `endpoint` | string | — | OTLP/HTTP traces URL, e.g. `http://127.0.0.1:6006/v1/traces`. |
| `projectName` | string | trace source label/id | Sets `openinference.project.name`; groups runs under a project in Phoenix. |
| `includeSensitiveData` | boolean | `false` | When `false`, raw message/tool payloads are withheld (metadata-only). Set `true` to export full inputs/outputs. |
| `headers` | object | — | Extra HTTP headers, e.g. an auth token for Phoenix Cloud. Keep secrets as placeholders in committed config. |
| `timeoutMs` | number | — | Per-export request timeout; bounds how long a failing export can block. |

### Environment variable

The exporter list can be supplied entirely from the environment as a JSON array, which overrides the config value:

```bash
export MONO_AGENT_OBSERVABILITY_EXPORTERS='[{"type":"phoenix","endpoint":"http://127.0.0.1:6006/v1/traces","projectName":"my-agent"}]'
```

The project name defaults to your traceability source. Set `traceability.sourceLabel` / `traceability.sourceId` (env `MONO_AGENT_TRACE_*`) to control it when you do not pass `projectName`. See [Artifacts & traces](artifacts-and-traces.md) for the trace registry.
{: .tip }

## Verifying export-compatibility

`mono-agent start` and `mono-agent status` print the active traceability source — the Phoenix endpoint when a Phoenix exporter is configured, otherwise the local JSONL artifacts.

`mono-agent validate` goes further: it **POSTs an empty protobuf** to the configured endpoint to confirm export-compatibility, not just network reachability. This catches endpoints that resolve but reject the OTLP protobuf content type before you rely on them. See the [CLI reference](cli-reference.md).

## Backfilling historical runs

The exporter only covers runs that happen while it is configured. To push already-recorded runs into Phoenix, use `mono-agent backfill`. It reads the recorded artifacts (`run-*.summary.json` + `run-*.events.jsonl`) from `artifacts.dir` and exports them with their **historical timestamps**, reusing the same live OTLP mapping. Coverage: **cli**.

```bash
mono-agent backfill --run <id>                    # one recorded run
mono-agent backfill --all                          # every recorded run
mono-agent backfill --all --since 2026-06-01T00:00:00Z
mono-agent backfill --all --until 2026-06-21T00:00:00Z
mono-agent backfill --all --dry-run                # list what would export, send nothing
```

| Flag | Meaning |
| --- | --- |
| `--run <id>` | Backfill a single recorded run by id. |
| `--all` | Backfill all recorded runs (combine with `--since` / `--until` to bound). |
| `--since <iso>` | Only runs at or after this ISO timestamp. |
| `--until <iso>` | Only runs at or before this ISO timestamp. |
| `--dry-run` | Report what would be exported without sending. |

Because per-run span ids are deterministic, re-running `backfill` over the same runs **overwrites rather than duplicates** them in Phoenix. You can safely re-run after fixing an endpoint or widening a date range. Backfill requires a configured Phoenix exporter so it knows where to send.
{: .note }

## Related

- [Phoenix-observed agent](../playbooks/phoenix-observed-agent.md) — end-to-end playbook: stand up Phoenix, configure the exporter, and read the resulting traces.
- [Backfill historical runs](../playbooks/backfill-historical-runs.md) — playbook for retroactively exporting recorded artifacts.
- [Artifacts & traces](artifacts-and-traces.md) — the always-on JSONL run record and trace registry the exporter reads from.
- [CLI reference](cli-reference.md) — `validate`, `start`, `status`, and `backfill`.
