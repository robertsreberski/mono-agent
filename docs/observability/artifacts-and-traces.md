---
title: "Artifacts, latency & trace registry"
sidebar:
  order: 1
---

# Artifacts, latency & trace registry

mono-agent is local-first about observability: every run appends a JSONL event log and a summary to a folder on disk, and the host publishes a small heartbeat manifest so the CLI can discover running agents. None of this requires a cloud collector — the JSONL artifacts are the always-on substrate, and the [Phoenix exporter](/observability/phoenix-and-backfill/) is an optional, additive layer on top.

This page covers where artifacts land, the latency-attribution events inside them, and the trace-source registry that `mono-agent status` reads.

## Run artifacts (JSONL)

Each agent run writes two files into `artifacts.dir`:

- `run-<id>.events.jsonl` — an append-only event stream (assistant deltas, tool calls/results, timing, usage/cost).
- `run-<id>.summary.json` — a roll-up of the run (final `status`, aggregate usage/cost, model). See [Run status](#run-status-and-stale-run-reconciliation) for the status values. A failed run also persists `error` (the redacted underlying provider/runtime message — the "why" behind `failureKind`) and, when the fallback router exhausted its chain, `failoverHistory` — an array of per-attempt records (`{ model, failureKind, subkind, requestId }`) canonicalized from the router's `ModelRef` + `retryableSubkind` shape. These show *which* models were tried and *how* each failed, instead of only the collapsed `provider_unavailable_exhausted` kind.

Memory-maintenance runs (`mem-*`, used by BuJo capture and rituals) write the same two-file shape under `artifacts.dir/memory/`. Keeping them in a separate namespace lets operator surfaces default to human-facing agent runs while still allowing explicit memory export, audit, and metrics flows.

Artifacts are written for every run regardless of whether any exporter is configured. Secrets are redacted and long strings are truncated before they hit disk, so the files are safe to keep and to ship to a viewer. The same tool-bloat guard that truncates oversized tool output persists the full payload here as an artifact (coverage: `auto`).

```json
{
  "artifacts": {
    "dir": "./.mono-agent/artifacts",
    "retention": {
      "maxAgeDays": 365,
      "maxCount": 50000,
      "dryRun": false
    },
    "memoryRetention": {
      "maxAgeDays": 7,
      "maxCount": 5000,
      "dryRun": false
    }
  }
}
```

| Key | Default | Env var | Coverage |
| --- | --- | --- | --- |
| `artifacts.dir` | `./.mono-agent/artifacts` | `MONO_AGENT_ARTIFACT_DIR` | config |
| `artifacts.retention.maxAgeDays` | `365` | `MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS` | config |
| `artifacts.retention.maxCount` | `50000` | `MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT` | config |
| `artifacts.retention.dryRun` | `false` | `MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN` | config |
| `artifacts.memoryRetention.maxAgeDays` | `7` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS` | config |
| `artifacts.memoryRetention.maxCount` | `5000` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT` | config |
| `artifacts.memoryRetention.dryRun` | `artifacts.retention.dryRun` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN` | config |

These files are exactly what the [backfill command](/observability/phoenix-and-backfill/) replays into Phoenix after the fact — `run-*.summary.json` plus `run-*.events.jsonl` are read back and exported with their original historical timestamps. The default backfill/audit/metrics/operator views read agent runs only; pass `--include-memory` where supported to add memory-maintenance runs. Explicit `--run mem-*` backfills can still reach memory artifacts, including legacy top-level `mem-*` files from older mixed directories. The `error` / `failoverHistory` fields are written into the live record *and* re-canonicalized by the recorded-runs list reader, so they surface for both freshly-failed runs and re-read artifacts (artifacts written before this field was added carry no source data to recover).

The host applies artifact retention once at startup, after stale-run reconciliation, and then on a periodic in-app sweep. Agent runs use `artifacts.retention`; memory runs use `artifacts.memoryRetention`, defaulting to a shorter 7-day / 5,000-run window. Retention deletes only terminal run summaries and their matching event files; summaries still marked `running` are never deleted by the retention pass. Set `dryRun: true` to log which runs would be pruned without removing files; memory retention inherits the agent dry-run setting when its own `dryRun` is unset.

### Run status and stale-run reconciliation

A run summary's `status` is one of:

| Status | Meaning |
| --- | --- |
| `running` | The run is in flight (not yet settled). |
| `succeeded` | The turn completed normally. |
| `failed` | The turn ended with an error. |
| `cancelled` | The turn was aborted by a caller (e.g. a newer follow-up cancelled it). |
| `interrupted` | The run never settled on its own — the process died mid-run, or a watchdog (e.g. the [cron run watchdog](/channels/cron/#run-watchdog-a-wedged-run-is-aborted-not-left-to-starve)) aborted a wedged run. |

A crashed process can leave a summary stuck at `running` forever. To self-heal that, the host runs `reconcileStaleRunArtifacts()` **once at startup**: it scans the artifacts directory and rewrites any summary left at `running` by a *previous* process to `interrupted` (failure kind `process_death`). It is fire-and-forget — best-effort, runs in the background, and never gates readiness — so a large artifacts directory can never delay start. In the [Phoenix export](/observability/phoenix-and-backfill/), `interrupted` maps to an ERROR span, alongside `failed` and `cancelled`.

Failure kinds are an open string set because provider/runtime adapters can surface new values. The display taxonomy currently explains the common operator-facing kinds including `usage_limit`, `process_death`, `cancelled` and its cancellation variants, `provider_unavailable`, `provider_unavailable_exhausted`, `runtime_error`, `session_not_found`, and `session_busy`; unknown values stay visible and get a generic artifact/log inspection hint.

For a read-only inventory, run `mono-agent audit-runs`. It scans every `*.summary.json` file in the artifact directory, reports malformed summaries, status and failure-kind histograms, unrecognized values, stale `running` summaries, and failure-kind rates. Unlike startup reconciliation, the audit never rewrites `running` summaries; it only flags what the startup reconciler would consider stale.

```bash
mono-agent audit-runs --consumer /path/to/agent --json
mono-agent audit-runs --artifact-dir /path/to/.mono-agent/artifacts --stale-after-ms 30000
```

:::tip
The artifacts directory is the durable record of what your agent did. Keep it out of version control (it grows per run) but back it up if you care about historical runs you might want to backfill or audit later.
:::

## Artifact metrics

`mono-agent metrics` aggregates recorded run summaries into operational numbers: status rates, failure-kind rates, duration percentiles, and total plus per-run cost. It is offline and read-only. It reads `*.summary.json` files from `artifacts.dir` or an explicit artifact directory; it does not read exporter config, contact Phoenix, reconcile stale runs, or rewrite artifacts. By default it reports agent runs only; pass `--include-memory` to include memory-maintenance `mem-*` runs from the `memory/` namespace and legacy mixed directories.

```bash
mono-agent metrics --artifacts ./.mono-agent/artifacts
mono-agent metrics --since 2026-06-01T00:00:00Z --until 2026-06-24T00:00:00Z
mono-agent metrics --by model --json
mono-agent metrics --include-memory --json
```

| Flag | Effect |
| --- | --- |
| `--artifacts <path>` | Read this artifact directory directly. Wins over config-based `artifacts.dir` resolution. |
| `--config <path>` | Use a non-default config file when resolving `artifacts.dir`. |
| `--env-file <path>` | Load env overrides before resolving `MONO_AGENT_ARTIFACT_DIR`. |
| `--since <iso>` / `--until <iso>` | Include only summaries whose `startedAt` falls inside the ISO window. Summaries with missing or unparseable timestamps are excluded once a window is active. |
| `--by model\|channel\|failureKind` | Add grouped buckets after the overall totals. Channel grouping is derived from the `conversationId` prefix before `:` until summaries carry a first-class channel field. |
| `--include-memory` | Include memory-maintenance summaries in addition to default agent runs. |
| `--json` | Print the full machine-readable metrics report. |

Each bucket reports `totalRuns`, status counts/rates, failure-kind counts/rates, `durationMs` p50/p90/p99/max using linear interpolation, and cost totals. Cost prefers `cost.cumulativeUsd`, then `cost.totalUsd`, then `usage.cost_usd`; non-numeric values are ignored.

## Latency attribution

The event stream is annotated so you can separate model-reasoning time from time spent in tools and MCP servers (coverage: `auto` — emitted automatically into the run JSONL, nothing to enable):

| Event / field | Scope | What it measures |
| --- | --- | --- |
| `provider_bridge_latency` | per turn | Breaks a turn into provider + tool + IO time vs. harness overhead, so you can see how much wall-clock the bridge itself added. |
| `tool_timing` (`execution_ms`) | per tool call | How long each tool's execution took. |
| `mcp_call_duration_ms` | per MCP tool result | Duration of the underlying MCP call, carried on the result. |

Because these live in the JSONL, you get the attribution even with no exporter configured. When the Phoenix exporter is on, a tool's `tool_use` + `tool_timing` + `tool_result` events merge by `tool_use_id` into a single TOOL span — see [Phoenix export & backfill](/observability/phoenix-and-backfill/).

## Trace-source registry

The host periodically writes a heartbeat manifest describing this agent into `traceability.registryDir`. `mono-agent status` reads that directory to list known trace sources and mark any whose last heartbeat is older than `staleAfterMs` as stale. This is how the CLI discovers running agents on the machine without a central service.

When `registryDir` is a config-local override (as `mono-agent init` scaffolds), the same manifest is ALSO best-effort mirrored into the global `~/.mono-agent/trace-sources` registry (`traceability.globalDiscovery`, default `true`), so `mono-agent tui`/`status` run from anywhere on the machine still finds this agent. See [Terminal UI](/observability/tui/) for how discovery merges the two registries.

```json
{
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000,
    "globalDiscovery": true
  }
}
```

| Key | Default | Env var | Notes |
| --- | --- | --- | --- |
| `traceability.registryDir` | `./.mono-agent/trace-sources` | `MONO_AGENT_TRACE_REGISTRY_DIR` | Directory of heartbeat manifests. |
| `traceability.sourceId` | `my-agent` | `MONO_AGENT_TRACE_SOURCE_ID` | Stable id for this agent; keys its manifest. |
| `traceability.sourceLabel` | `My Agent` | `MONO_AGENT_TRACE_SOURCE_LABEL` | Human-friendly name shown by `status` (and used as the default Phoenix project name). |
| `traceability.heartbeatMs` | `10000` | `MONO_AGENT_TRACE_HEARTBEAT_MS` | How often the manifest is refreshed. |
| `traceability.staleAfterMs` | `30000` | `MONO_AGENT_TRACE_STALE_AFTER_MS` | Age after which `status` marks a source stale. |
| `traceability.globalDiscovery` | `true` | `MONO_AGENT_TRACE_GLOBAL_DISCOVERY` | When `registryDir` differs from the global default, also mirror this agent's manifest there. Set `false` to keep registration local-only. |

Keep `staleAfterMs` comfortably larger than `heartbeatMs` (the defaults give a 3× margin) so a single missed write does not flap a healthy agent into the stale state. Registries also self-prune: manifests whose heartbeat is older than 7 days AND whose process is no longer running are deleted automatically the next time an agent starts or `mono-agent tui` runs.

:::note
:::
`sourceLabel` doubles as the default Phoenix project name when no `projectName` is set on the exporter, so pick a label that reads well in a trace UI as well as in the CLI.

## How `start` and `status` use this

`mono-agent start` prints the active traceability source — Phoenix when an `observability.exporters` Phoenix entry is configured, otherwise the local JSONL artifacts — and `mono-agent status` reads the registry to report each known source as live or stale. See the [CLI reference](/observability/cli-reference/) for the full command surface, and [Phoenix export & backfill](/observability/phoenix-and-backfill/) for sending these same events to a trace viewer.

To wire any of this up from code rather than config (custom hosts, embedding the runtime), see [Programmatic usage](/programmatic/).
