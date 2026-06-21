---
title: "Artifacts, latency & trace registry"
parent: "Observability & CLI"
nav_order: 1
---

# Artifacts, latency & trace registry

mono-agent is local-first about observability: every run appends a JSONL event log and a summary to a folder on disk, and the host publishes a small heartbeat manifest so the CLI can discover running agents. None of this requires a cloud collector — the JSONL artifacts are the always-on substrate, and the [Phoenix exporter](phoenix-and-backfill.md) is an optional, additive layer on top.

This page covers where artifacts land, the latency-attribution events inside them, and the trace-source registry that `mono-agent status` reads.

## Run artifacts (JSONL)

Each run writes two files into `artifacts.dir`:

- `run-<id>.events.jsonl` — an append-only event stream (assistant deltas, tool calls/results, timing, usage/cost).
- `run-<id>.summary.json` — a roll-up of the run (final outcome, aggregate usage/cost).

Artifacts are written for every run regardless of whether any exporter is configured. Secrets are redacted and long strings are truncated before they hit disk, so the files are safe to keep and to ship to a viewer. The same tool-bloat guard that truncates oversized tool output persists the full payload here as an artifact (coverage: `auto`).

```json
{
  "artifacts": { "dir": "./.mono-agent/artifacts" }
}
```

| Key | Default | Env var | Coverage |
| --- | --- | --- | --- |
| `artifacts.dir` | `./.mono-agent/artifacts` | `MONO_AGENT_ARTIFACT_DIR` | config |

These files are exactly what the [backfill command](phoenix-and-backfill.md) replays into Phoenix after the fact — `run-*.summary.json` plus `run-*.events.jsonl` are read back and exported with their original historical timestamps.

{: .tip }
The artifacts directory is the durable record of what your agent did. Keep it out of version control (it grows per run) but back it up if you care about historical runs you might want to backfill or audit later.

## Latency attribution

The event stream is annotated so you can separate model-reasoning time from time spent in tools and MCP servers (coverage: `auto` — emitted automatically into the run JSONL, nothing to enable):

| Event / field | Scope | What it measures |
| --- | --- | --- |
| `provider_bridge_latency` | per turn | Breaks a turn into provider + tool + IO time vs. harness overhead, so you can see how much wall-clock the bridge itself added. |
| `tool_timing` (`execution_ms`) | per tool call | How long each tool's execution took. |
| `mcp_call_duration_ms` | per MCP tool result | Duration of the underlying MCP call, carried on the result. |

Because these live in the JSONL, you get the attribution even with no exporter configured. When the Phoenix exporter is on, a tool's `tool_use` + `tool_timing` + `tool_result` events merge by `tool_use_id` into a single TOOL span — see [Phoenix export & backfill](phoenix-and-backfill.md).

## Trace-source registry

The host periodically writes a heartbeat manifest describing this agent into `traceability.registryDir`. `mono-agent status` reads that directory to list known trace sources and mark any whose last heartbeat is older than `staleAfterMs` as stale. This is how the CLI discovers running agents on the machine without a central service.

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

| Key | Default | Env var | Notes |
| --- | --- | --- | --- |
| `traceability.registryDir` | `./.mono-agent/trace-sources` | `MONO_AGENT_TRACE_REGISTRY_DIR` | Directory of heartbeat manifests. |
| `traceability.sourceId` | `my-agent` | `MONO_AGENT_TRACE_SOURCE_ID` | Stable id for this agent; keys its manifest. |
| `traceability.sourceLabel` | `My Agent` | `MONO_AGENT_TRACE_SOURCE_LABEL` | Human-friendly name shown by `status` (and used as the default Phoenix project name). |
| `traceability.heartbeatMs` | `10000` | `MONO_AGENT_TRACE_HEARTBEAT_MS` | How often the manifest is refreshed. |
| `traceability.staleAfterMs` | `30000` | `MONO_AGENT_TRACE_STALE_AFTER_MS` | Age after which `status` marks a source stale. |

Keep `staleAfterMs` comfortably larger than `heartbeatMs` (the defaults give a 3× margin) so a single missed write does not flap a healthy agent into the stale state.

{: .note }
`sourceLabel` doubles as the default Phoenix project name when no `projectName` is set on the exporter, so pick a label that reads well in a trace UI as well as in the CLI.

## How `start` and `status` use this

`mono-agent start` prints the active traceability source — Phoenix when an `observability.exporters` Phoenix entry is configured, otherwise the local JSONL artifacts — and `mono-agent status` reads the registry to report each known source as live or stale. See the [CLI reference](cli-reference.md) for the full command surface, and [Phoenix export & backfill](phoenix-and-backfill.md) for sending these same events to a trace viewer.

To wire any of this up from code rather than config (custom hosts, embedding the runtime), see [Programmatic usage](../programmatic/index.md).
