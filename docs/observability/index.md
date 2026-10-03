---
title: "Observability & CLI"
description: "Map mono-agent's local run artifacts, trace-source registry, lifecycle CLI, and always-on web console."
sidebar:
  order: 0
---

Every mono-agent run produces bounded local JSONL evidence. The artifacts are the on-disk record after successful recorder boundaries, not a crash-safe in-flight journal. A trace-source registry lets operator surfaces discover running agents, the `mono-agent` CLI operates the lifecycle, and the always-on web console provides live operation.

The framework no longer bundles a Phoenix/OTLP trace exporter or historical export command. This does **not** make an agent network-isolated: configured providers, channels, MCP servers, web tools, and external memory services can still use the network.

## The surfaces

| Surface | What it is | Coverage | Page |
| --- | --- | --- | --- |
| JSONL run artifacts | Per-run `run-*.events.jsonl` + `run-*.summary.json`; sensitive-looking values are redacted and retained free text is scanned for a closed set of credential shapes | config / auto | [Run artifacts & traces](/observability/artifacts-and-traces/) |
| Trace-source registry | Heartbeat manifests for local operator discovery | config | [Run artifacts & traces](/observability/artifacts-and-traces/) |
| Run reports | Read-only audit, metrics, and bounded prior-run evidence over local artifacts | cli / code | [Run artifacts & traces](/observability/artifacts-and-traces/) |
| `mono-agent` CLI | init / validate / start / stop / logs / restart / web / runs / install-skill | cli | [CLI reference](/observability/cli-reference/) |
| Web console | Persistent multi-agent conversations, streamed turns, and local-device attachments | cli | [Web console](/observability/web-console/) |

## JSONL run artifacts

At `start()`, the recorder separately replaces an empty events file and a `running` summary. It applies bounded string and event limits, schedules best-effort checkpoints, and writes a terminal snapshot at `finish()` or `fail()`. Non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; retained free text is scanned for a closed set of high-confidence credential shapes.

```json
{
  "artifacts": { "dir": "./.mono-agent/artifacts" }
}
```

Set `artifacts.dir` in JSON to override the directory. The [tool bloat guard](/runtime/tools-and-guards/) also persists oversized tool output beneath the artifact root.

Each summary has a final `status` (`succeeded`, `failed`, `cancelled`, or `interrupted`). A run left at `running` by a dead prior process is reconciled to `interrupted` at the next startup. `mono-agent runs`, `runs audit`, and `runs report` read these artifacts locally without contacting a collector.

See [Run artifacts & traces](/observability/artifacts-and-traces/) for the write boundary, event schema, retention, history, and metrics contracts.

## Trace-source registry

The host publishes a heartbeat manifest so local operator surfaces can discover which agents are running and when a source becomes stale.

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

Configure traceability in the JSON `traceability` block.

## Exporter retirement and migration

First-party Phoenix/OTLP support, `observability.exporters`, `MONO_AGENT_OBSERVABILITY_EXPORTERS`, and `mono-agent backfill` are removed. Active legacy config fails before startup with fixed migration guidance instead of being silently ignored. An absent field, a blank environment assignment, environment `[]`, `observability: {}`, or `observability: { exporters: [] }` is accepted only as an inert upgrade tombstone and does not enable an exporter.

There is no automatic export, replacement selection, config rewrite, artifact conversion, local deletion, or remote-trace deletion. If a final historical export is required, perform it **before upgrading** with the complete currently working version set already used by that consumer. The public registry does not provide a separately installable Phoenix plugin, so this documentation does not invent a package pin. See [Framework simplification migration](/reference/framework-simplification-migration/#retired-phoenixotlp-export) and [Deprecations](/reference/deprecations/#removed-surfaces).

## The CLI

`mono-agent` drives the agent lifecycle from one config: `init` scaffolds non-destructively, `validate` prints a per-section report, `start` launches traceability plus configured channels, and `stop` / `logs` / `restart` operate the running instance. `runs audit` scans local summaries read-only and `runs report` aggregates local latency, cost, and failure rates.

Invoking `mono-agent backfill` or `mono-agent help backfill` now prints the removal and pre-upgrade migration pointer. The full command and flag matrix is in the [CLI reference](/observability/cli-reference/).

## Offline run inspection

`mono-agent runs list` and `mono-agent runs show <run-id>` read bounded, redacted
run evidence without contacting a provider. `mono-agent config` provides the
resolved configuration view. The former terminal renderer is removed; use the
web console for live operation.

## The always-on web console

`mono-agent web start` installs the persistent browser conversation console on macOS; `mono-agent web run` is the foreground cross-platform path. It auto-discovers running agents and keeps threads and in-flight work in an owner-private service store.

```bash
mono-agent web start
mono-agent web
```

A fresh install binds `127.0.0.1:5050`; `--host <addr>` explicitly widens the listener. There is no application login, so network reachability is authority to operate the agents. See the [web console guide](/observability/web-console/) for the complete boundary.

## Related

- [Configuration blueprint](/config/blueprint/)
- [Environment variables](/config/env-vars/)
- [Sessions & concurrency](/runtime/sessions-concurrency/)
