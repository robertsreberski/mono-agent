---
title: "Rituals: reflection & migration"
sidebar:
  order: 3
---

# Rituals: reflection & migration

The `bujo` memory tier maintains itself with two scheduled **rituals** that run
**in-app** — no external cron, launchd, or sidecar process. Reflection runs nightly
(decay + insight synthesis), migration runs monthly (promote / reschedule / cluster /
forget). This page covers how the in-app scheduler works, how to tune or disable each
ritual, and the living index files they keep up to date.

Rituals require the `bujo` tier with a chat model (`memory.llm`) configured. The `lite`
and `journal` tiers do not run rituals. For tier selection and the `memory.llm` block,
see [Capture & recall](/memory/capture-and-recall/) and the [Memory overview](/memory/).
Coverage type: **config** (the scheduler is automatic once `memory.mode: "bujo"`).

## The in-app scheduler

When `memory.mode` is `"bujo"`, `agent-app` starts a ritual scheduler alongside your
channels. It owns two passes:

| Ritual | What it does | Default cron | Default time |
|--------|--------------|--------------|--------------|
| Reflection | Decay aging memories + synthesize insights | `0 3 * * *` | nightly 03:00 |
| Migration | Promote / reschedule / cluster / forget | `0 4 1 * *` | 1st of month 04:00 |

The scheduler starts with the app and stops cleanly on shutdown. Each ritual is error
isolated: a failed pass is logged and the scheduler carries on — a single bad run never
throws or kills the process.

**Overlap protection:** a new run is skipped if the previous run of that ritual is still
in flight. Long passes will not stack up or run concurrently with themselves.

:::note
:::
Cron expressions are interpreted in the agent's configured timezone. The defaults aim at
quiet hours so the LLM-heavy passes do not compete with live traffic.

## Configuration

Both rituals live under `memory` with matching `{ enabled, cron }` shapes. They only do
anything when the tier is `bujo` and a chat model is available via `memory.llm`.

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "llm": { "provider": "ollama", "model": "qwen3.6:latest" },
    "reflection": { "enabled": true, "cron": "0 3 * * *" },
    "migration": { "enabled": true, "cron": "0 4 1 * *" }
  }
}
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `memory.reflection.enabled` | boolean | `true` | Run the nightly reflection pass |
| `memory.reflection.cron` | string | `0 3 * * *` | Reflection cadence |
| `memory.migration.enabled` | boolean | `true` | Run the monthly migration pass |
| `memory.migration.cron` | string | `0 4 1 * *` | Migration cadence |

### Per-ritual enable / disable

To keep the `bujo` tier but turn off one ritual, set its `enabled` to `false`. For
example, reflect nightly but never auto-migrate:

```json
{
  "memory": {
    "mode": "bujo",
    "reflection": { "enabled": true, "cron": "0 3 * * *" },
    "migration": { "enabled": false }
  }
}
```

You can also shift cadence — e.g. reflect every six hours:

```json
{
  "memory": {
    "mode": "bujo",
    "reflection": { "cron": "0 */6 * * *" }
  }
}
```

### Environment overrides

Each key has a `MONO_AGENT_MEMORY_*` env var that overrides the config value:

| Env var | Overrides |
|---------|-----------|
| `MONO_AGENT_MEMORY_REFLECTION_ENABLED` | `memory.reflection.enabled` |
| `MONO_AGENT_MEMORY_REFLECTION_CRON` | `memory.reflection.cron` |
| `MONO_AGENT_MEMORY_MIGRATION_ENABLED` | `memory.migration.enabled` |
| `MONO_AGENT_MEMORY_MIGRATION_CRON` | `memory.migration.cron` |

```bash
export MONO_AGENT_MEMORY_REFLECTION_CRON="0 */6 * * *"
export MONO_AGENT_MEMORY_MIGRATION_ENABLED=false
```

## Living index files

The rituals (and the `index` CLI command) maintain two markdown files at the root of your
`memory.path`:

- **`index.md`** — a living table of contents: entry counts, the top/most-relevant
  memories, and the entity graph summary. Regenerated as memories change.
- **`future-log.md`** — scheduled and deferred items surfaced by migration
  (reschedule/promote), so future-dated intentions stay visible.

Because the whole `bujo` store is plain markdown on disk, these files are human-readable
and diffable — you can browse them directly or commit them.

## Verifying the schedule

`mono-agent validate` reports the configured cadence (and the next fire time) in its
Memory section, and confirms the chat model is reachable:

```
[ok] memory.mode     bujo
[ok] reflection      0 3 * * * (next: …)
[ok] migration       0 4 1 * * (next: …)
```

See [Validation & CLI](/memory/validation-and-cli/) for the full liveness check. Validation
reports the cadence only when the tier is `bujo` with an `llm` configured; otherwise the
rituals will not run.

:::caution
:::
Rituals need a working chat model. If `memory.llm` is missing or unreachable, the
scheduler has nothing to run and reflection/migration are effectively disabled. Validate
before relying on automated maintenance.

## Manual / out-of-band runs

The `memory-bujo` CLI runs the same passes on demand against a memory root — useful for a
one-off backfill, a cron-free environment, or a different timezone. The in-app scheduler
already handles the routine cadence for `bujo`, so you rarely need these. The standalone
CLI is Ollama-only and requires `MONO_AGENT_MEMORY_LLM_MODEL`:

```bash
# Reflection pass: decay + insight synthesis
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo reflect ./memory

# Monthly migration: promote/reschedule/cluster/forget
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo migrate ./memory

# Rewrite the living index.md
memory-bujo index ./memory
```

`MONO_AGENT_MEMORY_LLM_ENDPOINT` overrides the Ollama endpoint (default
`http://localhost:11434`) and `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` the per-call timeout
(default `120000`). If `MONO_AGENT_MEMORY_LLM_MODEL` is unset, `reflect`/`migrate` exit
with a clear error. See [Validation & CLI](/memory/validation-and-cli/) for the full subcommand
reference, and [Embeddings](/memory/embeddings/) for the semantic-recall env vars these
commands share.
