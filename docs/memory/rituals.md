---
title: "Consolidation"
sidebar:
  order: 3
---

# Consolidation

The `bujo` memory tier maintains itself with one scheduled **consolidation** pass that
runs **in-app** — no external cron, launchd, or sidecar process. Consolidation is a
lightweight housekeeping cycle: decay salience, deduplicate near-identical bullets by
superseding duplicates, and rewrite the living index.

The `consolidate()` operation itself is deterministic and can run without a chat model.
The in-app scheduler, however, only starts for the effective `bujo` runtime tier. In
configuration terms, that means `memory.mode: "bujo"` plus `memory.llm`; without
`memory.llm`, the store resolves to `journal` and scheduled consolidation is skipped. The
`lite` and `journal` tiers do not run scheduled maintenance. For tier selection and the
`memory.llm` block, see [Capture & recall](/memory/capture-and-recall/) and the
[Memory overview](/memory/). Coverage type: **config**.

## The in-app scheduler

When the effective store tier is `bujo`, `agent-app` starts a consolidation scheduler
alongside your channels.

| Pass | What it does | Default cron |
| --- | --- | --- |
| Consolidation | Decay salience, supersede duplicate bullets, rewrite `index.md`, keep `future-log.md` empty | `0 */2 * * *` |

The scheduler starts with the app and stops cleanly on shutdown. The pass is error
isolated: a failed consolidation is logged and the scheduler carries on.

**Overlap protection:** a new run is skipped if the previous consolidation is still in
flight. Long passes will not stack up or run concurrently with themselves.

Cron expressions are evaluated by the in-app scheduler. The default runs every two hours
because the pass is intentionally cheap and does not synthesize long-form insights.

## Configuration

Consolidation lives under `memory.consolidation` with the same `{ enabled, cron }` shape
used elsewhere in config.

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "llm": { "provider": "ollama", "model": "qwen3.6:latest" },
    "consolidation": { "enabled": true, "cron": "0 */2 * * *" }
  }
}
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `memory.consolidation.enabled` | boolean | `true` | Run scheduled consolidation |
| `memory.consolidation.cron` | string | `0 */2 * * *` | Consolidation cadence |

### Enable / disable

To keep the `bujo` tier but turn off scheduled consolidation, set `enabled` to `false`:

```json
{
  "memory": {
    "mode": "bujo",
    "consolidation": { "enabled": false }
  }
}
```

You can also shift cadence — e.g. every four hours:

```json
{
  "memory": {
    "mode": "bujo",
    "consolidation": { "cron": "0 */4 * * *" }
  }
}
```

### Environment overrides

Each key has a `MONO_AGENT_MEMORY_*` env var that overrides the config value:

| Env var | Overrides |
|---------|-----------|
| `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED` | `memory.consolidation.enabled` |
| `MONO_AGENT_MEMORY_CONSOLIDATION_CRON` | `memory.consolidation.cron` |

```bash
export MONO_AGENT_MEMORY_CONSOLIDATION_CRON="0 */4 * * *"
export MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED=true
```

Retired `memory.reflection.*` / `memory.migration.*` keys and
`MONO_AGENT_MEMORY_REFLECTION_*` / `MONO_AGENT_MEMORY_MIGRATION_*` env vars are tolerated
but ignored. `mono-agent validate` reports value-free warnings when it sees them.

## Living index files

Consolidation (and the `index` CLI command) maintain markdown files at the root of your
`memory.path`:

- **`index.md`** — a living table of contents: entry counts, the top/most-relevant
  memories, and the entity graph summary. Regenerated as memories change.
- **`future-log.md`** — a retired compatibility stub. Consolidation writes it as exactly
  `# Future Log` and does not project future items there.

Because the whole `bujo` store is plain markdown on disk, these files are human-readable
and diffable — you can browse them directly or commit them.

## Verifying the schedule

`mono-agent validate` reports the configured cadence in its Memory section:

```
[ok] memory.mode     bujo
[ok] consolidation   0 */2 * * * (auto)
```

See [Validation & CLI](/memory/validation-and-cli/) for the full liveness check. Validation
reports scheduled consolidation only when the effective store tier is `bujo`; otherwise it
reports that consolidation is not scheduled.

:::caution
Scheduled consolidation needs the effective `bujo` runtime tier. If `memory.llm` is
missing, configured `bujo` mode resolves to the `journal` tier and the scheduler does not
run. Manual deterministic `consolidate()` remains available to callers that invoke the
store directly. Validate before relying on automated maintenance.
:::

## Manual / out-of-band runs

The `memory-bujo` CLI still includes the older `reflect` and `migrate` commands for
manual backfills and compatibility with older stores. They are not auto-scheduled by the
app. The standalone CLI is Ollama-only and requires `MONO_AGENT_MEMORY_LLM_MODEL`:

```bash
# Legacy reflection pass: decay + insight synthesis
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo reflect ./memory

# Legacy migration: promote/reschedule/cluster/forget
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo migrate ./memory

# Rewrite the living index.md
memory-bujo index ./memory
```

`MONO_AGENT_MEMORY_LLM_ENDPOINT` overrides the Ollama endpoint (default
`http://localhost:11434`) and `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` the per-call timeout
(CLI default `120000` — in-app capture uses `memory.llm.timeoutMs`, default `60000`;
see [the two memory-LLM timeouts](/memory/validation-and-cli/#the-two-memory-llm-timeouts)).
If `MONO_AGENT_MEMORY_LLM_MODEL` is unset, `reflect`/`migrate` exit
with a clear error. See [Validation & CLI](/memory/validation-and-cli/) for the full subcommand
reference, and [Embeddings](/memory/embeddings/) for the semantic-recall env vars these
commands share.
