---
title: "Observability & CLI"
sidebar:
  order: 0
---

# Observability & CLI

Every mono-agent run is recorded locally as append-only JSONL artifacts — the always-on source of truth — and optionally exported to [Phoenix](/observability/phoenix-and-backfill/) for a semantic trace timeline. A trace-source registry lets dashboards discover running agents, the `mono-agent` CLI operates the whole lifecycle, and operator surfaces (`tui` and `web`) give you live views over running agents. This page maps those surfaces and links the detail pages.

## The surfaces

| Surface | What it is | Coverage | Page |
| --- | --- | --- | --- |
| JSONL run artifacts | Per-run `run-*.events.jsonl` + `run-*.summary.json`, secrets redacted | config / auto | [Run artifacts & traces](/observability/artifacts-and-traces/) |
| Trace-source registry | Heartbeat manifest so dashboards discover live agents | config | [Run artifacts & traces](/observability/artifacts-and-traces/) |
| Phoenix exporter + backfill | Best-effort OTLP/HTTP export of run lifecycles; retroactive backfill | config / cli | [Phoenix export & backfill](/observability/phoenix-and-backfill/) |
| `mono-agent` CLI | init / validate / start / stop / logs / restart / tui / web / backfill / audit-runs / metrics / install-skill | cli | [CLI reference](/observability/cli-reference/) |
| TUI | Operator console: live chat with thinking/tool/telemetry insight, run replay, config view | cli | [TUI](/observability/tui/) |
| Web PWA | Read-only Session Recorder: all discovered agents, run lists/details, live sub-run updates | cli | [CLI reference](/observability/cli-reference/#web) |

## JSONL run artifacts (always on)

Run artifacts are the local source of truth and are written for every run regardless of whether any exporter is configured. Each run produces an events JSONL stream and a summary JSON, with secrets redacted and long strings truncated. They also carry the metrics other tools build on: per-run usage/cost/cache (`observability.cost-tracking`), per-turn `provider_bridge_latency`, per-tool `tool_timing` (`execution_ms`), and `mcp_call_duration_ms` on MCP results — letting you separate model-reasoning time from tool/MCP time.

```json
{
  "artifacts": { "dir": "./.mono-agent/artifacts" }
}
```

Override the directory with `MONO_AGENT_ARTIFACT_DIR`. The [tool bloat-guard](/runtime/tools-and-guards/) also persists truncated tool output here, so artifacts double as the overflow store for large results.

Each summary carries a final `status` (`succeeded` / `failed` / `cancelled` / `interrupted`). A run left at `running` by a crashed process is reconciled to `interrupted` at the next startup, so a dead process never leaves a run "running" forever. See [Run status and stale-run reconciliation](/observability/artifacts-and-traces/#run-status-and-stale-run-reconciliation).

See [Run artifacts & traces](/observability/artifacts-and-traces/) for the event schema and how to read a run.

## Trace-source registry

The host publishes a heartbeat manifest into a registry directory so external dashboards (and `mono-agent start`/`status`) can discover which agents are currently running and whether a source has gone stale.

```json
{
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000
  }
}
```

The matching env vars are `MONO_AGENT_TRACE_*` (e.g. `MONO_AGENT_TRACE_REGISTRY_DIR`, `MONO_AGENT_TRACE_SOURCE_ID`, `MONO_AGENT_TRACE_SOURCE_LABEL`). The Phoenix exporter reuses `sourceLabel`/`sourceId` as its default project name.

## Phoenix export + backfill

Adding a Phoenix exporter turns each run lifecycle into a semantic OpenInference timeline: streaming assistant deltas coalesce into one assistant span, and a tool's `tool_use` + `tool_timing` + `tool_result` events merge by `tool_use_id` into one TOOL span. Export is additive and best-effort — failures are bounded by a timeout and never change the run outcome or suppress the JSONL writes.

```json
{
  "observability": {
    "exporters": [
      { "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces" }
    ]
  }
}
```

Omitting the `observability.exporters` entry keeps only the local JSONL artifacts. The whole array can be supplied via `MONO_AGENT_OBSERVABILITY_EXPORTERS` (a JSON array). Already-recorded runs can be exported retroactively with `mono-agent backfill (--run <id> | --all)`, reusing the live OTLP mapping with historical timestamps; deterministic per-run ids make re-export overwrite rather than duplicate.

:::caution
Phoenix export is best-effort and metadata-only by default. Set `includeSensitiveData: true` on the exporter only if you intend span input/output values to carry prompt and tool payloads.
:::

See [Phoenix export & backfill](/observability/phoenix-and-backfill/) for the full exporter options, `validate` compatibility check, and backfill flags.

## The CLI

`mono-agent` drives the entire agent lifecycle from one config: `init` scaffolds non-destructively, `validate` prints a per-section report (including observability and every channel), `start` launches traceability plus every configured channel (a background launchd service on macOS by default), and `stop` / `logs` / `restart` operate the running instance. `backfill` exports historical runs to Phoenix, while `audit-runs` scans local run summaries read-only and [artifact metrics](/observability/artifacts-and-traces/#artifact-metrics) aggregates local latency, cost, and failure rates.

The full command and flag matrix is in the [CLI reference](/observability/cli-reference/).

## The TUI

`mono-agent tui` opens the operator console from any directory and connects to any running agent on the machine: live chat with full thinking/tool/telemetry insight, a recorded-run replay browser (every channel's turns), and a source-annotated config view.

```bash
mono-agent tui                        # discover running agents and connect
mono-agent tui --agent personal-agent # pick one directly
```

See the [TUI page](/observability/tui/) for details, including the embedded `--responder` mode for custom hosts.

## The web PWA

`mono-agent web` serves the read-only Session Recorder from any directory. It discovers every running agent via the trace-source registry, folds local run artifacts with each agent's default-on `live` relay, and streams updates to the browser.

```bash
mono-agent web
mono-agent web --port 4599 --no-open
mono-agent web --include-memory
```

The backend binds loopback on the stable default port `4599`. Startup prints the exact URL for reverse proxies plus a Tailscale serve hint. Run lists and the initial browser stream are summary-only; a run's full timeline is loaded lazily from its detail endpoint when opened. Memory-maintenance runs are hidden by default; pass `--include-memory` to inspect them. `--allow-non-loopback` generates a tokenized URL and protects `/api/*` plus `/api/stream`; use it only on a trusted network boundary.

The Session Recorder loads recent runs first and pages older history on demand.
The browser treats stale `running` summaries as `stalled`, shows recorded
failure kinds/error text/failover attempts, and uses each instance's discovered
timezone for single-instance lists and run details. Mixed-instance views fall
back to the viewer locale/timezone.

## Related

- [Configuration blueprint](/config/blueprint/) — every key in context, including `artifacts`, `traceability`, and `observability`.
- [Environment variables](/config/env-vars/) — the `MONO_AGENT_*` overrides for the keys above.
- [Sessions & concurrency](/runtime/sessions-concurrency/) — what a "run" is and how sessions roll over.
