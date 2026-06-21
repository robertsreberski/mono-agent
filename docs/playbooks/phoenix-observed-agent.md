---
title: "Phoenix-Observed Agent with TUI"
parent: "Playbooks"
nav_order: 10
---

# Phoenix-Observed Agent with TUI

This playbook wires a local mono-agent so every run lifecycle streams to a [Phoenix](https://phoenix.arize.com/) tracing dashboard as OpenInference semantic spans, while redacted JSONL artifacts are always written locally as the fallback. You drive the agent from the terminal TUI and watch each prompt show up as AGENT / LLM / TOOL spans.

## Who this is for

Agent builders evaluating runs in a tracing dashboard — you want to inspect prompts, model output, and tool calls visually instead of grepping logs.

## Goal

Run an agent locally with the TUI and stream every run lifecycle to Phoenix as OpenInference semantic spans, with local JSONL as the fallback.

## Features used

- [`observability.phoenix-exporter`](../observability/phoenix-and-backfill.md) — additive, best-effort OTLP/HTTP protobuf export of each run as a semantic timeline (config).
- [`observability.jsonl-artifacts`](../observability/artifacts-and-traces.md) — redacted `run-*.summary.json` + `run-*.events.jsonl` written on every run; the local fallback (config).
- [`observability.trace-registry`](../observability/artifacts-and-traces.md) — heartbeat manifests that `mono-agent status` reads (config).
- [`tui.chat`](../observability/tui.md) — terminal chat with transcript and a redacted config pane (cli).

## Configuration

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "artifacts": {
    "dir": ".mono-agent/artifacts"
  },
  "traceability": {
    "registryDir": ".mono-agent/trace-sources",
    "sourceId": "my-agent",
    "heartbeatMs": 10000
  },
  "observability": {
    "exporters": [
      {
        "type": "phoenix",
        "endpoint": "http://127.0.0.1:6006/v1/traces",
        "projectName": "my-project",
        "includeSensitiveData": false,
        "timeoutMs": 5000
      }
    ]
  }
}
```

The exporters array can also be supplied via the `MONO_AGENT_OBSERVABILITY_EXPORTERS` env var (a JSON array of exporter objects). JSONL artifacts are always written regardless of whether a Phoenix exporter is present — the Phoenix entry only adds the trace viewer on top.

With `includeSensitiveData: false`, exported spans are metadata-only and prompt/result payloads are redacted; set it to `true` only against a trusted local Phoenix.
{: .warning }

## Steps

1. Start Phoenix locally (listening on `6006`).
2. `mono-agent init --model claude:claude-sonnet-4-6`.
3. Add the `artifacts`, `traceability`, and `observability.exporters[]` phoenix entry to `mono-agent.config.json`.
4. `mono-agent validate` (it POSTs an empty protobuf to confirm export-compatibility, not just reachability), then `mono-agent start` (it prints the Phoenix endpoint as the trace source).
5. `mono-agent-tui --config ./mono-agent.config.json` and complete a prompt.
6. Open Phoenix and confirm the run appears as AGENT / LLM / TOOL spans under `my-project`.

## Smoke test

Complete one prompt in the TUI; confirm a redacted JSONL artifact is written AND the trace appears in Phoenix with merged tool spans and the correct project name.
{: .tip }

## Related

- [Phoenix exporter and backfill](../observability/phoenix-and-backfill.md)
- [Artifacts and traces](../observability/artifacts-and-traces.md)
- [Observability CLI reference](../observability/cli-reference.md)
- [TUI](../observability/tui.md)
- [Backfill historical runs](backfill-historical-runs.md)
- mono-agent composer skill: `packages/agent-app/skills/mono-agent-composer`
