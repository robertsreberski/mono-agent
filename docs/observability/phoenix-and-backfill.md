---
title: "Phoenix export & backfill"
sidebar:
  order: 2
---

This page covers the Phoenix OTLP exporter — an additive, best-effort export of every run lifecycle to [Arize Phoenix](https://phoenix.arize.com/) as semantic OpenInference spans — and the `mono-agent backfill` command that retroactively exports already-recorded run artifacts. Both reuse the same OTLP mapping, so live traces and backfilled traces are identical in Phoenix.

Phoenix export never changes a run's outcome and never suppresses the local JSONL artifacts. See [Artifacts & traces](/observability/artifacts-and-traces/) for the always-on run record that the exporter and backfill read from.

## What the exporter does

When you add a `phoenix` entry to `observability.exporters[]`, the host exports each run lifecycle over **OTLP/HTTP protobuf** as a semantic timeline:

- **Streaming assistant deltas coalesce** into one "Assistant thoughts" / "Assistant message" span instead of one span per token chunk.
- **A tool's three events merge into one span.** The `tool_use`, `tool_timing`, and `tool_result` events that share a `tool_use_id` are merged into a single `TOOL` span (input = args, output = result).
- **Spans carry OpenInference semantics** — `openinference.span.kind` is one of `AGENT`, `LLM`, `TOOL`, `CHAIN`, or `memory` (for memory-maintenance runs — see [below](#memory-maintenance-runs)), with `input.value` / `output.value` attributes. Spans route to a named project via `openinference.project.name`, which defaults to the trace source label/id.
- **Root spans carry rich roll-up attributes** — model, token counts, cost, and duration on every run (see [Per-run attributes](#per-run-attributes)).
- **Per-run span ids are deterministic**, so re-exporting the same run is idempotent — it overwrites rather than duplicates.

Export is **metadata-only by default**: span inputs/outputs are exported, but raw message/tool payloads are withheld unless you opt in (see `includeSensitiveData`). Failures are bounded by `timeoutMs` and are swallowed — a Phoenix outage cannot fail or stall a run.

:::note
The transport lives in the `@mono-agent/observability/otel` subpath (built on `@opentelemetry/otlp-transformer`). Coverage: **config**.
:::

### Per-run attributes

Every exported run span — channel and memory alike — carries roll-up attributes, so you can see model, cost, and token usage in Phoenix without opening the JSONL:

- `llm.model_name` / `mono.agent.model` — the serving model.
- `llm.token_count.prompt` / `.completion` / `.total`, plus `.prompt_details.cache_read` / `.cache_write` — token usage including prompt-cache hits.
- `mono.agent.cost_usd` — run cost (prefers the observer aggregate, falls back to `usage.cost_usd`).
- `mono.agent.duration_ms` — wall-clock duration.
- The system prompt as `llm.input_messages.0.message.{role,content}` (plus `llm.system` / `mono.agent.system_prompt`) — exported **only when `includeSensitiveData: true`**, redacted and capped at 32 KB. For channel runs this is the compiled identity prompt; for memory runs it is the maintenance prompt.

On a **failed / cancelled / interrupted** run, the root span also carries always-on operational metadata describing *why* it failed — so you can filter and read the cause in Phoenix without opening the JSONL:

- `mono.agent.error.message` — the underlying provider/runtime error text (e.g. `503 Service Unavailable`), redacted and capped at 500 chars.
- `mono.agent.failover.count` — the number of failover attempts the router made.
- `mono.agent.failover.detail` — the per-attempt chain rendered as `model → reason (req id)`, e.g. `pi:openai-codex:gpt-5.5 → timeout, pi:opencode-go:kimi-k2.6 → server_error (req abc123)`. `reason` prefers the retryable subkind, falling back to the raw failure kind.

These three attributes are **operational metadata, not gated content** — they are emitted regardless of `includeSensitiveData`, but only on non-success runs (succeeded runs omit them entirely). The failed-run root span's status **message** is also the composed failure detail (e.g. `provider_unavailable_exhausted: pi:openai-codex:gpt-5.5 → timeout, pi:opencode-go:kimi-k2.6 → server_error (req …); last error: 503 Service Unavailable …`) instead of the bare failure kind, so operators can read the cause straight from the span status.

:::note
The secret-redaction pass that runs before export no longer clobbers numeric token *counts*: fields like `input_tokens` match the `/token/` secret pattern but are numbers, so usage now survives into spans and summaries. (Secrets are strings; numeric values are skipped.)
:::

### Memory-maintenance runs

BuJo memory work — per-turn capture (`distill` → `reconcile` → `entities`) and the nightly `reflect` / monthly `migrate` rituals — records as its own `mem-*` runs. These export with:

- `openinference.span.kind = "memory"` (channel runs stay `AGENT`), so memory work is filterable in Phoenix.
- `mono.agent.run.kind` and `mono.agent.memory.operation` — the operation is one of `distill` / `reconcile` / `entities` / `reflect` / `migrate`.

This surfaces memory cost and latency alongside channel runs instead of hiding it inside generic `AGENT` spans. See [Capture & recall](/memory/capture-and-recall/) and [Rituals](/memory/rituals/) for what each operation does.

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

:::tip
The project name defaults to your traceability source. Set `traceability.sourceLabel` / `traceability.sourceId` (env `MONO_AGENT_TRACE_*`) to control it when you do not pass `projectName`. See [Artifacts & traces](/observability/artifacts-and-traces/) for the trace registry.
:::

## Verifying export-compatibility

`mono-agent start` and `mono-agent status` print the active traceability source — the Phoenix endpoint when a Phoenix exporter is configured, otherwise the local JSONL artifacts.

`mono-agent validate` goes further: it **POSTs an empty protobuf** to the configured endpoint to confirm export-compatibility, not just network reachability. This catches endpoints that resolve but reject the OTLP protobuf content type before you rely on them. See the [CLI reference](/observability/cli-reference/).

## Backfilling historical runs

The exporter only covers runs that happen while it is configured. To push already-recorded runs into Phoenix, use `mono-agent backfill`. It reads the recorded artifacts (`run-*.summary.json` + `run-*.events.jsonl`) from `artifacts.dir` and exports them with their **historical timestamps**, reusing the same live OTLP mapping. `--all` defaults to agent runs only; add `--include-memory` to export memory-maintenance `mem-*` runs from `artifacts.dir/memory/` and legacy mixed directories. Explicit `--run mem-*` can still target a single memory run without widening the whole scan. Coverage: **cli**.

```bash
mono-agent backfill --run <id>                    # one recorded run
mono-agent backfill --all                          # every recorded run
mono-agent backfill --all --since 2026-06-01T00:00:00Z
mono-agent backfill --all --until 2026-06-21T00:00:00Z
mono-agent backfill --all --dry-run                # list what would export, send nothing
mono-agent backfill --all --include-memory          # include memory-maintenance runs
```

| Flag | Meaning |
| --- | --- |
| `--run <id>` | Backfill a single recorded run by id. |
| `--all` | Backfill all recorded runs (combine with `--since` / `--until` to bound). |
| `--since <iso>` | Only runs at or after this ISO timestamp. |
| `--until <iso>` | Only runs at or before this ISO timestamp. |
| `--include-memory` | With `--all`, include memory-maintenance runs in addition to agent runs. |
| `--dry-run` | Report what would be exported without sending. |

:::note
Because per-run span ids are deterministic, re-running `backfill` over the same runs **overwrites rather than duplicates** them in Phoenix. You can safely re-run after fixing an endpoint or widening a date range. Backfill requires a configured Phoenix exporter so it knows where to send.
:::

## Related

- [Phoenix-observed agent](/playbooks/phoenix-observed-agent/) — end-to-end playbook: stand up Phoenix, configure the exporter, and read the resulting traces.
- [Backfill historical runs](/playbooks/backfill-historical-runs/) — playbook for retroactively exporting recorded artifacts.
- [Artifacts & traces](/observability/artifacts-and-traces/) — the always-on JSONL run record and trace registry the exporter reads from.
- [CLI reference](/observability/cli-reference/) — `validate`, `start`, `status`, and `backfill`.
