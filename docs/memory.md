# Memory — Operator Guide

This guide covers the three memory modes available in mono-agent, with complete setup
instructions for the new **bujo** mode.

## Memory Modes

### `markdown` (default)

A single markdown file (or one per conversation when `scope: "per-conversation"`) is
loaded into every prompt. Host summaries can be appended after each run
(`writeMode: "append-host-summary"`). Suitable when you want lightweight, predictable
context injection and don't need cross-conversation recall. No external dependencies.

### `journal`

A daily markdown note (today's note always in context) plus a JSONL entity graph whose
salience digest folds into context. Optional MCP recall tools (`memory_read_day`,
`memory_list_days`, `memory_grep`, `memory_search`, `entity_get`) let the runtime query
past notes. Semantic `memory_search` is available when `memory.embeddings` is configured.
Good for personal agents that should remember past conversations without structured indexing.

### `bujo` (BuJo — Bullet Journal memory)

A fully intelligent memory system backed by a SQLite index. Captures agent observations
and conversation summaries into daily markdown notes, reconciles them against existing
memories (classifying each entry as ADD / UPDATE / SUPERSEDE / NOOP to avoid
duplication), and maintains hybrid recall via BM25 full-text + vector RRF with recency
and salience weighting. A **reflection** pass applies temporal decay, synthesises
cross-entry insights (with provenance links), and surfaces overdue future-log items; a
**migration** pass promotes active memories, reschedules recurring patterns, clusters
related entries, and forgets stale ones (bi-temporal — never deleted). Both produce a
living `index.md` and `future-log.md` at the memory root.

Bujo mode requires a locally running Ollama instance for embeddings. An optional local
chat model (also via Ollama) powers the capture-reconcile, reflection, and migration
pipelines; without it the recall + rapid-log capture still work but the LLM-augmented
steps are skipped.

> **Runtime scope (current).** At runtime, `mode: "bujo"` provides **hybrid recall** (an
> always-in-context curated block) plus **rapid-log capture** (each turn's host summary is
> appended to today's daily note when `writeMode: "append-host-summary"`). The
> **intelligent write path** (distill → reconcile ADD/UPDATE/SUPERSEDE/NOOP + entity
> extraction) and the **reflection/migration rituals** run **via the `memory-bujo` CLI**
> (or the `BujoMemoryStore.capture()/reflect()/migrate()` API) — they are not yet
> auto-invoked per turn or auto-scheduled. See [Automating the Rituals](#automating-the-rituals)
> to run them on a schedule.

## Config

```jsonc
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",      // root directory; created on first run
    "writeMode": "append-host-summary",  // disabled | append-host-summary
    "maxBytes": 64000,                   // context-load byte cap
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",  // IMPORTANT: use the exact :v1.5 tag — the
                                         // bare "nomic-embed-text" alias may not exist
      "endpoint": "http://localhost:11434",
      "dim": 768                         // nomic-embed-text:v1.5 output dimension
    },
    "llm": {                             // optional; omit to disable LLM-augmented pipelines
      "provider": "ollama",
      "model": "qwen3.6:latest",         // any local chat model; set MONO_AGENT_LLM_MODEL
      "endpoint": "http://localhost:11434"
    }
  }
}
```

## Prerequisites

**Embeddings model (required):**

```bash
ollama pull nomic-embed-text:v1.5
```

Use the exact `:v1.5` tag. The bare alias `nomic-embed-text` (without a tag) may not be
present in your Ollama installation and will cause the embeddings provider to fail at
startup. `mono-agent validate` checks for this exact tag.

**Chat model (optional — for capture/reflection/migration):**

```bash
ollama pull qwen3.6:latest   # or any local chat model you prefer
```

Set `MONO_AGENT_LLM_MODEL` to the model name when running the CLI reflect/migrate
commands. Without a chat model the bujo store still captures and indexes entries; it
just skips LLM-augmented reconciliation, insight synthesis, and migration clustering.

## CLI Subcommands

The `memory-bujo` binary provides out-of-band maintenance against a bujo root:

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
`MONO_AGENT_LLM_MODEL` is unset when running `reflect` or `migrate`, the command prints a
clear error and exits 2.

## Automating the Rituals

The reflection and migration rituals are **not auto-scheduled yet** — the agent does not
run them on its own. To get the BuJo cadence (nightly reflect, monthly migrate), schedule
the CLI from system `cron`/`launchd` against your memory root. With `crontab -e`:

```cron
# nightly reflection (decay + insight synthesis) at 03:00
0 3 * * *  MONO_AGENT_LLM_MODEL=qwen3.6:latest /path/to/memory-bujo reflect /path/to/memory
# monthly migration (promote/reschedule/cluster/forget) on the 1st at 04:00
0 4 1 * *  MONO_AGENT_LLM_MODEL=qwen3.6:latest /path/to/memory-bujo migrate /path/to/memory
```

`/path/to/memory-bujo` is the package bin (e.g. `node packages/memory-bujo/dist/cli.js`).
Likewise, the intelligent per-turn capture (`distill`/`reconcile`) is invoked via
`BujoMemoryStore.capture()` from the host or a scheduled job, not automatically on every
turn — wiring it into the live turn path is a planned follow-up.

## Liveness Check — `mono-agent validate`

When `memory.mode` is `"bujo"`, `mono-agent validate` (the agent-app doctor) runs a
bujo-specific liveness check that confirms:

1. **Ollama reachable** — probes `GET <endpoint>/api/tags` with a short timeout.
2. **Embeddings model pulled** — confirms `nomic-embed-text:v1.5` (or whichever
   `memory.embeddings.model` you set) appears in `/api/tags`. If absent it emits:
   `⚠  bujo embeddings model "nomic-embed-text:v1.5" not found — run: ollama pull nomic-embed-text:v1.5`
3. **Chat model pulled** (if `memory.llm` is configured) — same check for the chat model.
4. **Memory root writable** — confirms `memory.path` is creatable and writable.

Any failure emits a loud `[warn]` in the validate report's Memory section (status
`waiting`, so the bujo warnings do not flip the overall result to `error` — run
`validate` and read the Memory section). There is **no silent fallback**: the host owns
`mode: "bujo"` and never downgrades to markdown. Run `mono-agent validate` before cutover
(and after pulling models) to confirm bujo is live.

## Composer Integration

When composing an agent with `mono-agent-composer`, the composer proactively explains the
bujo option during the memory strategy step (question 6). The following covers what the
composer should ask and the config block it should write.

### Questions the composer asks

1. "Do you want intelligent, indexed memory that recalls past conversations by content and
   recency (bujo mode), or would you prefer the simpler markdown or journal mode?"
2. If bujo: "Which local Ollama embeddings model should power recall?
   (default: `nomic-embed-text:v1.5` — pull it first with `ollama pull nomic-embed-text:v1.5`)"
3. If bujo: "Do you also want a local chat model for reflection and migration
   (e.g. `qwen3.6:latest`)? This enables LLM-augmented insight synthesis and monthly
   cleanup. Omit to skip those pipelines for now."
4. If bujo + chat model: "Should I configure the Ollama endpoint, or is it on the default
   `http://localhost:11434`?"

Default: if the user does not opt into bujo, write `mode: "markdown"`.

### Config block written by the composer

```jsonc
// Bujo mode with embeddings only (no LLM pipeline):
"memory": {
  "mode": "bujo",
  "path": "./.mono-agent/memory",
  "writeMode": "append-host-summary",
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text:v1.5",
    "dim": 768
  }
}

// Bujo mode with embeddings + local chat model:
"memory": {
  "mode": "bujo",
  "path": "./.mono-agent/memory",
  "writeMode": "append-host-summary",
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text:v1.5",
    "dim": 768
  },
  "llm": {
    "provider": "ollama",
    "model": "qwen3.6:latest"
  }
}
```

After writing the config, the composer appends a prerequisite note reminding the user to
run `ollama pull nomic-embed-text:v1.5` (and the chat model pull if configured) before
running `mono-agent validate`.

## References

- Design spec: `docs/superpowers/specs/2026-06-15-memory-bujo-design.md`
- Phase 1–4 implementation plans: `docs/superpowers/plans/2026-06-15-memory-bujo-p*.md`
- Feature registry row: `docs/feature-registry.md` — `memory.bujo`, `memory.bujo-cli`, `memory.bujo-validate`
