# Memory — Operator Guide

This guide covers the three memory tiers available in mono-agent, all backed by the
same `@mono-agent/memory-store` + `@mono-agent/memory-bujo` substrate. Pick the tier
that matches your external-dependency budget; all tiers share the same config shape —
only `memory.mode` and the optional embeddings/LLM blocks differ.

## Memory Tiers

| Capability | `lite` | `journal` | `bujo` |
| --- | --- | --- | --- |
| FTS keyword recall | yes | yes | yes |
| Rapid-log capture (host summaries appended) | yes | yes | yes |
| Hybrid recall (BM25 + vector RRF) | — | yes | yes |
| Salience decay | — | yes | yes |
| LLM capture/reconcile (ADD/UPDATE/SUPERSEDE/NOOP) | — | — | yes |
| Entity graph | — | — | yes |
| Reflection (decay + insight synthesis) | — | — | yes |
| Monthly migration (promote/reschedule/cluster/forget) | — | — | yes |
| Auto-scheduled rituals (in-app scheduler) | — | — | yes |
| Living `index.md` + `future-log.md` | — | — | yes |
| **Requires Ollama embeddings** | no | **yes** | **yes** |
| **Requires chat model** | no | no | **yes** |

### `lite`

FTS keyword recall plus rapid-log daily capture. No external dependencies — SQLite
is bundled. Suitable when you want lightweight, predictable context injection without
running Ollama. Host summaries can be appended after each run
(`writeMode: "append-host-summary"`).

### `journal`

Adds hybrid recall (BM25 + vector RRF) and salience decay on top of the lite tier.
Requires a locally running Ollama instance with the
`nomic-embed-text:v1.5` embeddings model. No chat model needed.

### `bujo` (BuJo — Bullet Journal memory)

The full tier: everything in `journal` plus an LLM-augmented capture-and-reconcile
pipeline, entity graph, reflection, and migration rituals. Captures agent observations
and conversation summaries into daily markdown notes, reconciles them against existing
memories (classifying each entry as ADD / UPDATE / SUPERSEDE / NOOP to avoid
duplication), and maintains hybrid recall via BM25 full-text + vector RRF with recency
and salience weighting.

A **reflection** pass applies temporal decay, synthesises cross-entry insights (with
provenance links), and surfaces overdue future-log items. A **migration** pass promotes
active memories, reschedules recurring patterns, clusters related entries, and forgets
stale ones (bi-temporal — never deleted). Both produce a living `index.md` and
`future-log.md` at the memory root.

The reflection and migration rituals are **auto-scheduled in-app** for the `bujo` tier:
the agent-app scheduler runs them at the configured cron cadence (default: nightly
reflect at `0 3 * * *`, monthly migrate at `0 4 1 * *`). No external cron or launchd
setup is required. Run `mono-agent validate` to confirm the cadence being used.

Requires Ollama for embeddings (`nomic-embed-text:v1.5`, dim 768) and a local chat
model for the LLM pipelines.

## Config

### Lite tier (no external deps)

```jsonc
{
  "memory": {
    "mode": "lite",
    "path": "./.mono-agent/memory",      // root directory; created on first run
    "writeMode": "append-host-summary",  // disabled | append-host-summary
    "maxBytes": 64000                    // context-load byte cap
  }
}
```

### Journal tier (embeddings, no chat model)

```jsonc
{
  "memory": {
    "mode": "journal",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary",
    "maxBytes": 64000,
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",  // IMPORTANT: use the exact :v1.5 tag — the
                                         // bare "nomic-embed-text" alias may not exist
      "endpoint": "http://localhost:11434",
      "dim": 768                         // nomic-embed-text:v1.5 output dimension
    }
  }
}
```

### Bujo tier (embeddings + chat model + auto-rituals)

```jsonc
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary",
    "maxBytes": 64000,
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    },
    "llm": {                             // required for bujo LLM pipelines
      "provider": "ollama",
      "model": "qwen3.6:latest",         // any local chat model; set MONO_AGENT_LLM_MODEL for CLI
      "endpoint": "http://localhost:11434"
    },
    // Reflection and migration are auto-scheduled in-app for the bujo tier.
    // Override the default cron expressions here if needed:
    "reflection": {
      "enabled": true,
      "cron": "0 3 * * *"              // nightly at 03:00 (default)
    },
    "migration": {
      "enabled": true,
      "cron": "0 4 1 * *"             // 1st of each month at 04:00 (default)
    }
  }
}
```

## Prerequisites

### Lite tier

No external prerequisites. SQLite is bundled.

### Journal tier

**Embeddings model (required):**

```bash
ollama pull nomic-embed-text:v1.5
```

Use the exact `:v1.5` tag. The bare alias `nomic-embed-text` (without a tag) may not
be present in your Ollama installation and will cause the embeddings provider to fail
at startup. `mono-agent validate` checks for this exact tag.

### Bujo tier

**Embeddings model (required):**

```bash
ollama pull nomic-embed-text:v1.5
```

**Chat model (required for LLM pipelines):**

```bash
ollama pull qwen3.6:latest   # or any local chat model you prefer
```

Set `MONO_AGENT_LLM_MODEL` to the model name when running the CLI reflect/migrate
commands manually. Without a chat model the `bujo` tier cannot start the LLM-augmented
reconciliation, insight synthesis, and migration steps.

## Auto-Scheduler (bujo tier)

When `memory.mode` is `"bujo"` the agent-app starts an **in-app ritual scheduler**
alongside the other channels. It runs:

- `reflect` at the `memory.reflection.cron` cadence (default `0 3 * * *` — nightly at
  03:00). Decay + insight synthesis; never throws — failures are logged and the
  scheduler carries on.
- `migrate` at the `memory.migration.cron` cadence (default `0 4 1 * *` — 1st of each
  month at 04:00). Promote/reschedule/cluster/forget; same error isolation.

Overlap protection: a new run is skipped if the previous one is still in flight.
The scheduler starts with the app and stops cleanly on shutdown.

`mono-agent validate` reports the configured cadence in the Memory section:

```
[ok] memory.mode     bujo
[ok] reflection      0 3 * * * (next: …)
[ok] migration       0 4 1 * * (next: …)
```

To disable a ritual while keeping the tier, set `memory.reflection.enabled: false` or
`memory.migration.enabled: false`. Env overrides: `MONO_AGENT_MEMORY_REFLECTION_CRON`,
`MONO_AGENT_MEMORY_REFLECTION_ENABLED`, `MONO_AGENT_MEMORY_MIGRATION_CRON`,
`MONO_AGENT_MEMORY_MIGRATION_ENABLED`.

## CLI Subcommands

The `memory-bujo` binary provides out-of-band maintenance against a bujo root. It is
available for all tiers (lite/journal/bujo) for manual runs — the auto-scheduler
handles the routine cadence for `bujo` automatically.

```bash
# Rebuild the SQLite index from the markdown files on disk
memory-bujo rebuild <root>

# Recall: hybrid BM25+vector search (prints matching entries)
memory-bujo recall <root> "<query>"

# Write the living index.md (table of contents: counts, top memories, entities)
memory-bujo index <root>

# Reflection pass: decay + insight synthesis (requires MONO_AGENT_LLM_MODEL)
MONO_AGENT_LLM_MODEL=qwen3.6:latest memory-bujo reflect <root>

# Monthly migration: promote/reschedule/cluster/forget (requires MONO_AGENT_LLM_MODEL)
MONO_AGENT_LLM_MODEL=qwen3.6:latest memory-bujo migrate <root>
```

`MONO_AGENT_LLM_ENDPOINT` overrides the Ollama endpoint for the chat model (default
`http://localhost:11434`). The CLI reads the embeddings model from `MONO_AGENT_EMBED_MODEL`
(default `nomic-embed-text:v1.5`) and `MONO_AGENT_EMBED_DIM` (default 768). If
`MONO_AGENT_LLM_MODEL` is unset when running `reflect` or `migrate`, the command prints
a clear error and exits 2.

## Liveness Check — `mono-agent validate`

`mono-agent validate` (the agent-app doctor) runs a memory liveness check that scales
with the configured tier:

**lite:** confirms the memory root is creatable and writable.

**journal / bujo:**
1. **Ollama reachable** — probes `GET <endpoint>/api/tags` with a short timeout.
2. **Embeddings model pulled** — confirms `nomic-embed-text:v1.5` (or whichever
   `memory.embeddings.model` you set) appears in `/api/tags`. If absent it emits:
   `⚠  memory embeddings model "nomic-embed-text:v1.5" not found — run: ollama pull nomic-embed-text:v1.5`
3. **Memory root writable** — confirms `memory.path` is creatable and writable.

**bujo (additional):**
4. **Chat model pulled** (if `memory.llm` is configured) — same check for the chat
   model.
5. **Ritual cadence** — reports the reflection/migration cron expressions and whether
   the scheduler will run (tier is bujo with an llm configured).

Any failure emits a loud `[warn]` in the validate report's Memory section (status
`waiting`, so warnings do not flip the overall result to `error` — run `validate` and
read the Memory section). There is **no silent fallback**: the host never downgrades the
configured tier. Run `mono-agent validate` before cutover (and after pulling models) to
confirm the tier is live.

## Composer Integration

When composing an agent with `mono-agent-composer`, the composer explains the three
tiers during the memory strategy step (question 6). See
`packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md` for
the full question flow and config blocks the composer writes.

## References

- Design spec: `docs/superpowers/specs/2026-06-15-memory-bujo-design.md`
- Phase 1–5 implementation plans: `docs/superpowers/plans/2026-06-15-memory-bujo-p*.md`, `docs/superpowers/plans/2026-06-16-memory-bujo-p5-tiered-offering.md`
- Feature registry rows: `docs/feature-registry.md` — `memory.lite`, `memory.journal`, `memory.bujo`
