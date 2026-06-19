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
| **Requires embeddings** | no | **yes** | **yes** |
| **Requires chat model** | no | no | **yes** |

### `lite`

FTS keyword recall plus rapid-log daily capture. No external dependencies — SQLite
is bundled. Suitable when you want lightweight, predictable context injection without
running Ollama. Host summaries can be appended after each run
(`writeMode: "append-host-summary"`).

### `journal`

Adds hybrid recall (BM25 + vector RRF) and salience decay on top of the lite tier.
Requires a configured embeddings provider, either Ollama or OpenAI. No chat model needed.

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

Requires embeddings and a chat model for the LLM pipelines. The app-level chat model can
be a direct Ollama model or an `agent-host` runtime model reference such as
`pi:openai-codex:gpt-5.5`.

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
      "model": "qwen3.6:latest",         // any local chat model; set MONO_AGENT_MEMORY_LLM_MODEL for CLI
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

For Pi SDK memory capture through the host runtime, use:

```jsonc
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKeyEnv": "OPENAI_API_KEY",
      "dim": 1536
    },
    "llm": {
      "provider": "agent-host",
      "model": "pi:openai-codex:gpt-5.5",
      "executionMode": "sdk"
    }
  }
}
```

`agent-host` memory LLMs are SDK-only for now. CLI-backed refs such as
`codex:gpt-5.5`, or explicit `executionMode: "cli"`, are rejected because those
runtimes cannot yet guarantee a no-tools/no-external-actions memory turn.

### Per-turn write mode (`memory.writeMode`)

How the **host** persists each completed turn (independent of the tier's recall):

- `disabled` — never write.
- `append-host-summary` — append a deterministic, single-line rapid-log of the turn to today's daily file (fast, no LLM). Available in every tier.
- `capture` — **bujo only.** A superset of `append-host-summary`: it still writes the deterministic rapid-log synchronously (durable), and *additionally* runs the intelligent capture pipeline (distil → reconcile → entity extraction) in the background. Capture is **async and non-blocking** (reply latency is unchanged), serialized per store, and **drained on graceful shutdown** (nothing queued is lost on stop; the canonical markdown rapid-log survives even if a capture is interrupted). Because it needs a chat LLM, `writeMode: "capture"` requires `mode: "bujo"` and fails config validation otherwise — no silent fallback.

```jsonc
{ "memory": { "mode": "bujo", "writeMode": "capture", "path": "./.mono-agent/memory" /* + embeddings + llm */ } }
```

## Prerequisites

### Lite tier

No external prerequisites. SQLite is bundled.

### Journal tier

**Embeddings model (required when using the Ollama embeddings provider):**

```bash
ollama pull nomic-embed-text:v1.5
```

Use the exact `:v1.5` tag. The bare alias `nomic-embed-text` (without a tag) may not
be present in your Ollama installation and will cause the embeddings provider to fail
at startup. `mono-agent validate` checks for this exact tag.

### Bujo tier

**Embeddings model (required when using the Ollama embeddings provider):**

```bash
ollama pull nomic-embed-text:v1.5
```

**Chat model (required for LLM pipelines when using `llm.provider: "ollama"`):**

```bash
ollama pull qwen3.6:latest   # or any local chat model you prefer
```

Set `MONO_AGENT_MEMORY_LLM_MODEL` to the model name when running the standalone CLI
reflect/migrate commands manually. The standalone CLI remains Ollama-only. For the app
runtime, `memory.llm.provider: "agent-host"` may instead point at a SDK runtime model
reference such as `pi:openai-codex:gpt-5.5`.

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

# Reflection pass: decay + insight synthesis (requires MONO_AGENT_MEMORY_LLM_MODEL)
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo reflect <root>

# Monthly migration: promote/reschedule/cluster/forget (requires MONO_AGENT_MEMORY_LLM_MODEL)
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo migrate <root>
```

The standalone CLI reads the **same embedding/root `MONO_AGENT_MEMORY_*` env vars** as the
agent (the memory root is the positional `<root>` argument).
Embeddings are **opt-in**: set
`MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` (`ollama`/`openai`) to enable semantic recall — without
it, `recall`/`rebuild` run FTS-only and need no embedding service. When enabled, the model
defaults to `nomic-embed-text:v1.5` (`MONO_AGENT_MEMORY_EMBEDDINGS_MODEL`) and dim to 768
(`MONO_AGENT_MEMORY_EMBEDDINGS_DIM`). For `reflect`/`migrate`, the standalone CLI uses the
built-in Ollama chat adapter: `MONO_AGENT_MEMORY_LLM_ENDPOINT` overrides the Ollama endpoint
for the chat model (default `http://localhost:11434`). If `MONO_AGENT_MEMORY_LLM_MODEL` is
unset when running `reflect` or `migrate`, the command prints a clear error and exits 2.

`MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` sets the per-call chat-LLM timeout (default `120000`). A
single capture runs several sequential LLM calls (distil → reconcile → entity extraction), and
slow local models can take tens of seconds each; because those steps swallow LLM errors
(never-throw), a too-short timeout makes a capture *silently store nothing* rather than fail
loudly. Raise it for slow models (the `memory-bujo` `reflect`/`migrate` CLI honors it).

## Liveness Check — `mono-agent validate`

`mono-agent validate` (the agent-app doctor) runs a memory liveness check that scales
with the configured tier:

**lite:** confirms the memory root is creatable and writable.

**journal / bujo:**
1. **Memory root writable** — confirms `memory.path` is creatable and writable.
2. **Ollama embeddings reachable** — only when `memory.embeddings.provider` is `ollama`;
   probes that embedding endpoint's `GET /api/tags` with a short timeout.
3. **Embeddings model pulled** — for Ollama embeddings only, confirms
   `nomic-embed-text:v1.5` (or whichever `memory.embeddings.model` you set) appears in
   that endpoint's `/api/tags`. If absent it emits:
   `⚠  memory embeddings model "nomic-embed-text:v1.5" not found — run: ollama pull nomic-embed-text:v1.5`

**bujo (additional):**
4. **Chat model pulled** — only when `memory.llm.provider` is `ollama`; probes the chat
   endpoint and checks the chat model against that endpoint's `/api/tags`. `agent-host`
   chat LLMs are not checked against Ollama.
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

## Recall Tool (`memory_recall`)

The agent gets a single read-only `memory_recall` tool — hybrid (keyword + semantic) search over the same memory it writes to. It is **auto-provisioned by `agent-app`** from the single `config.memory` block when `config.memory.recallTool.enabled` is true (default **on** for the journal/bujo tiers with embeddings configured; set it to `false` to disable). There is no hand-wired `.mcp.json` entry and no separate local LLM to run.

Under the hood `agent-app` spawns a bundled stdio MCP child named `mono-agent-memory` (bundled in `@mono-agent/agent-app`) that exposes only `memory_recall`. It is configured automatically from `config.memory` — it uses the **same memory root + embeddings** as the in-app memory, so there is no separate config to keep in sync. Recall needs no chat LLM; durable writes stay in-app on the agent-host LLM via per-turn capture (`writeMode: "capture"`). This replaces the retired standalone `@mono-agent/memory-mcp` package (which also shipped `memory_capture`/`memory_note` — both dropped, since in-app capture already covers durable writes).

**Migrating off `@mono-agent/memory-mcp` (external consumers):** the package is removed from this repo (the published `0.3.0` stays on npm but receives no further updates). If you depended on it directly: (1) **as an MCP server bin / `node .../memory-mcp/dist/main.js` in a `.mcp.json`** — drop that entry and instead set `config.memory.recallTool.enabled: true` so the host auto-provisions the bundled `mono-agent-memory` recall server (no hand-wired entry, no separate LLM); (2) **as a library import (`@mono-agent/memory-mcp`)** — build directly on `@mono-agent/memory-bujo` (`createBujoMemoryStore`) + `@mono-agent/memory-search` (`createEmbeddingProvider`), which is exactly what the recall server does; (3) **the `memory_capture` / `memory_note` write tools have no replacement tool** — durable writes are now host-driven per turn via `memory.writeMode: "capture"` (or `append-host-summary`), so the agent no longer needs an explicit write tool.

**Tool-policy note (fail-closed):** `memory_recall` is an MCP tool, and like every MCP server tool (config `mcpServers`, ask-collaborator) it is **gated by its declaration, not by `tools.allowedTools`**. `tools.allowedTools` filters the built-in runtime tools (Read/Bash/…); it does **not** suppress app-injected MCP tools. So `tools.allowedTools: []` ("no built-in tools") still leaves `memory_recall` available when it is enabled. To fully withhold memory reads from the agent, set `config.memory.recallTool.enabled: false` (or use a `lite` tier with no recall) — that is the switch that controls this tool, not the allowlist.

## References

- Design specs: `docs/superpowers/specs/2026-06-15-memory-bujo-design.md`, `docs/superpowers/specs/2026-06-16-memory-bujo-followups-design.md`
- Implementation plans: `docs/superpowers/plans/2026-06-15-memory-bujo-p*.md`, `docs/superpowers/plans/2026-06-16-memory-bujo-p5-tiered-offering.md`, `docs/superpowers/plans/2026-06-16-memory-bujo-p6-followups.md`
- Feature registry rows: `docs/feature-registry.md` — `memory.lite`, `memory.journal`, `memory.bujo`, `memory.write-mode`, `memory.per-turn-capture`, `memory.recall-tool`
