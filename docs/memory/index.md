---
title: "Memory"
sidebar:
  order: 0
---

# Memory — Operator Guide

This guide covers the three memory tiers available in mono-agent, all backed by the
same `@mono-agent/memory/store` + `@mono-agent/memory/bujo` substrate. Pick the tier
that matches your external-dependency budget; all tiers share the same config shape —
only `memory.mode` and the optional embeddings/LLM blocks differ.

Weighing the built-in engine against an external memory service? See
[Backends: BuJo vs Supermemory](/memory/backends-comparison/).

## Memory Tiers

| Capability | `lite` | `journal` | `bujo` |
| --- | --- | --- | --- |
| FTS keyword recall | yes | yes | yes |
| Deterministic host observation | canonical daily log | canonical daily log, hash-deduplicated | separate raw audit |
| Hybrid recall (BM25 + vector RRF) | — | yes | yes |
| Semantic indexing off the successful-turn path | — | yes, bounded batches | yes, during bounded curation |
| Salience decay | — | yes | yes |
| LLM capture/reconcile (ADD/UPDATE/SUPERSEDE/NOOP) | — | — | yes |
| Entity graph | — | — | yes |
| Lightweight consolidation (dedupe + salience decay) | — | — | yes |
| Auto-scheduled maintenance (in-app scheduler) | — | — | yes |
| Living `index.md` + retired `future-log.md` stub | — | — | yes |
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
The host commits a new lexical observation first, using a stable content-hash identity to
deduplicate repeated summaries, then queues vector indexing in bounded batches. A slow or
temporarily unavailable embedding provider therefore does not delay an otherwise successful
agent reply; the lexical memory remains durable and the vector backlog is retried.

### `bujo` (BuJo — Bullet Journal memory)

The full tier: hybrid recall plus bounded LLM curation, an entity graph, and lightweight
consolidation. The host first preserves a compact immutable observation in `audit/`, outside
curated recall. `writeMode: "capture"` then uses one batched memory/graph extraction and at
most one batched reconcile call to promote durable facts into daily notes, classifying close
entries as ADD / UPDATE / SUPERSEDE / NOOP. Each fact retains only its explicitly extracted
entity associations. The raw audit is never automatically treated as curated truth.

A **consolidation** pass keeps the store legible without writing an LLM essay: it applies
temporal decay, deduplicates near-identical bullets by superseding duplicates, rewrites
the living `index.md`, and leaves `future-log.md` as an empty retired stub (`# Future Log`).
It does not create monthly projection files.

Consolidation is **auto-scheduled in-app** for the `bujo` tier: the agent-app scheduler
runs `store.consolidate()` at the configured cron cadence (default `0 */2 * * *`, every
two hours). No external cron or launchd setup is required. Run `mono-agent validate` to
confirm whether automatic consolidation will run.

Requires embeddings and a chat model for the LLM pipelines. The app-level chat model can
be a direct Ollama model or an `agent-host` runtime model reference such as
`pi:openai-codex:gpt-5.6-terra`.

The tier matrix is strict. `lite` rejects embeddings/LLM configuration, `journal` requires
embeddings and rejects a memory LLM/consolidation, and `bujo` requires both embeddings and
the memory LLM. Invalid configuration fails instead of silently downshifting.

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

### Bujo tier (embeddings + chat model + consolidation)

```jsonc
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
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
    // Lightweight consolidation is auto-scheduled in-app for the bujo tier.
    "consolidation": {
      "enabled": true,
      "cron": "0 */2 * * *"            // every two hours (default)
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
      "model": "pi:openai-codex:gpt-5.6-terra",
      "executionMode": "sdk"
    }
  }
}
```

`agent-host` memory LLMs are SDK-only for now. CLI-backed refs such as
`codex:gpt-5.6-terra`, or explicit `executionMode: "cli"`, are rejected because those
runtimes cannot yet guarantee a no-tools/no-external-actions memory turn.

### Per-turn write mode (`memory.writeMode`)

How the **host** persists each completed turn (independent of the tier's recall):

- `disabled` — never write.
- `append-host-summary` — persist a deterministic single-line observation with no chat LLM. Lite/Journal put it in the canonical daily log; Journal queues semantic indexing after the lexical commit. BuJo puts it in the separate raw audit and does not promote it to curated recall.
- `capture` — **bujo only.** Preserve the raw audit synchronously, then enqueue bounded curation in the background. One extraction call plus at most one batch-reconcile call writes canonical facts and precise graph evidence. Accepted jobs are serialized and get a 10-second shutdown drain deadline; after it, queued work is discarded and cooperative in-flight work is aborted so stop cannot hang forever. A failure, overflow, or deadline keeps the raw audit but does not contaminate curated recall. Because it needs a chat LLM, `writeMode: "capture"` requires `mode: "bujo"` and fails config validation otherwise.

Low-signal successful turns are skipped in every write mode: the `NOTHING_TO_REPORT` no-op sentinel and tiny explicit test/ping probes such as `test` / `test ok`. Cron and webhook writes are assistant-answer-only, so trigger prompts and webhook pre-instructions do not enter memory.

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

Set `MONO_AGENT_MEMORY_LLM_MODEL` to the model name when running the legacy standalone
CLI `reflect`/`migrate` commands manually. The standalone CLI remains Ollama-only. For the app
runtime, `memory.llm.provider: "agent-host"` may instead point at a SDK runtime model
reference such as `pi:openai-codex:gpt-5.6-terra`.

## Auto-Scheduler (bujo tier)

When `memory.mode` is `"bujo"` and `memory.llm` is configured, the agent-app starts an
**in-app consolidation scheduler** alongside the other channels. It runs
`store.consolidate()` at the `memory.consolidation.cron` cadence (default `0 */2 * * *`,
every two hours). Consolidation applies decay, deduplicates repeated bullets by
superseding duplicates, rewrites the living `index.md`, and keeps `future-log.md` as a
literal empty stub.

Overlap protection: a new run is skipped if the previous consolidation is still in
flight. Failures are logged and the scheduler carries on. The scheduler starts with the
app and stops cleanly on shutdown.

`mono-agent validate` reports the configured cadence in the Memory section:

```
[ok] memory.mode     bujo
[ok] consolidation   0 */2 * * * (auto)
```

To disable scheduled consolidation while keeping the tier, set
`memory.consolidation.enabled: false`. Env overrides:
`MONO_AGENT_MEMORY_CONSOLIDATION_CRON` and `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED`.
Retired `memory.reflection.*` / `memory.migration.*` keys and their env vars are tolerated
but ignored; `mono-agent validate` reports a warning when it sees them.

## CLI maintenance

Use the config-aware CLI from the agent folder for index transitions. It reads the exact
tier/model/dimension from `mono-agent.config.json`, refuses a running configured agent,
builds a validated generation beside the active database, and switches it atomically.

```bash
mono-agent stop
mono-agent memory rebuild --json
mono-agent memory audit --json
mono-agent start

# If needed: stop, restore the prior tier/model/dim config, then swap generations
mono-agent memory rollback --json
```

Rebuild never calls the chat LLM or replays historical turns through a paid model. It may
re-embed canonical Journal/BuJo facts in bounded batches. The prior active generation is
retained for rollback, and pre-activation failures leave it active. See [Validation & CLI](/memory/validation-and-cli/#safe-index-generations-rebuild-and-rollback) for the generation layout, source accounting, safety gates, v1 cutover, and rollback procedure.

The lower-level `memory-bujo` binary remains for advanced root-oriented inspection and
legacy/manual maintenance. `rebuild`/`rollback` require an explicit tier and operate only
after a config-aware first activation:

```bash
memory-bujo rebuild <root> --tier journal
memory-bujo rollback <root> --tier journal

# Recall: hybrid BM25+vector search (prints matching entries)
memory-bujo recall <root> "<query>"

# Write the living index.md (table of contents: counts, top memories, entities)
memory-bujo index <root>

# Legacy reflection pass: decay + insight synthesis (requires MONO_AGENT_MEMORY_LLM_MODEL)
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo reflect <root>

# Legacy migration: promote/reschedule/cluster/forget (requires MONO_AGENT_MEMORY_LLM_MODEL)
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo migrate <root>
```

The standalone CLI reads the **same embedding/root `MONO_AGENT_MEMORY_*` env vars** as the
agent (the memory root is the positional `<root>` argument). Embeddings are opt-in for
read-only `recall`; safe rebuild/rollback instead enforce the declared tier identity
(`lite` forbids embeddings, while `journal`/`bujo` require them). When enabled, the model
defaults to `nomic-embed-text:v1.5` (`MONO_AGENT_MEMORY_EMBEDDINGS_MODEL`) and dim to 768
(`MONO_AGENT_MEMORY_EMBEDDINGS_DIM`). For legacy `reflect`/`migrate`, the standalone CLI uses the
built-in Ollama chat adapter: `MONO_AGENT_MEMORY_LLM_ENDPOINT` overrides the Ollama endpoint
for the chat model (default `http://localhost:11434`). If `MONO_AGENT_MEMORY_LLM_MODEL` is
unset when running `reflect` or `migrate`, the command prints a clear error and exits 2.

`MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` sets the per-call chat-LLM timeout, but the **default differs
by binary**: the standalone `memory-bujo` `reflect`/`migrate` CLI defaults to `120000`, while the
**in-app** memory LLM (per-turn capture) reads `memory.llm.timeoutMs` — the same env var maps
to it — and defaults to `60000`. A capture runs one extraction call and at most one reconcile
call; a timeout is recorded and warned without failing the user's reply. The raw audit survives,
but that turn produces no curated fact. Raise the timeout for slow models. See
[Validation & CLI](/memory/validation-and-cli/#the-two-memory-llm-timeouts).

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
5. **Consolidation cadence** — reports the consolidation cron expression and whether
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

## Recall Tool (`MemoryRecall`)

The agent gets a single read-only `MemoryRecall` tool — FTS search for Lite and hybrid keyword/semantic search for Journal/BuJo. It is **auto-provisioned by `agent-app`** from the single `config.memory` block and defaults on for every configured tier; set `recallTool.enabled` to `false` to opt out. There is no hand-wired `.mcp.json` entry and no separate local LLM to run.

Unqualified active-conversation questions are not durable-memory searches. For example,
`What did you send in the last message?` bypasses automatic recall, and a mistaken tool call
returns guidance to use the current provider conversation without querying the memory backend.
Qualified archived history still uses the tool. BuJo tool recall may add one deterministic graph
hop; automatic context remains direct-only, while Lite/Journal never expand the graph.

Recalled entries do **not** sit in the system prompt. The harness appends them to the **user message** each turn (when recall returns hits), so memory survives a session resume; a `memory_recalled` diagnostic keeps recall visible in run traces. The `MemoryRecall` tool described here is the *on-demand* path the agent can additionally call mid-turn to pull more. See [Context assembly → Memory recall](/context/assembly/#memory-recall).

Under the hood `agent-app` exposes a request-scoped loopback MCP endpoint over its **same app-owned retrieval service and store**. Automatic recall and an identical normalized tool query share one per-turn lookup; a materially different query may search again. Recall needs no chat LLM; durable writes stay in-app via per-turn capture (`writeMode: "capture"`). This replaces the retired standalone `@mono-agent/memory-mcp` package (which also shipped `memory_capture`/`memory_note` — both dropped, since in-app capture already covers durable writes).

**Migrating off `@mono-agent/memory-mcp` (external consumers):** the package is removed from this repo (the published `0.3.0` stays on npm but receives no further updates). If you depended on it directly: (1) **as an MCP server bin / `node .../memory-mcp/dist/main.js` in a `.mcp.json`** — drop that entry and instead set `config.memory.recallTool.enabled: true` so the host auto-provisions the bundled `mono-agent-memory` recall server (no hand-wired entry, no separate LLM); (2) **as a library import (`@mono-agent/memory-mcp`)** — build directly on `@mono-agent/memory/bujo` (`createBujoMemoryStore`) + `@mono-agent/memory/search` (`createEmbeddingProvider`), which is exactly what the recall server does; (3) **the `memory_capture` / `memory_note` write tools have no replacement tool** — durable writes are now host-driven per turn via `memory.writeMode: "capture"` (or `append-host-summary`), so the agent no longer needs an explicit write tool.

**Tool-policy note:** `MemoryRecall` is an MCP tool, and like every MCP server tool (config `mcpServers`, `AskCollaborator`) it is **gated by its declaration, not by `tools.allowedTools`**. `tools.allowedTools` filters the built-in runtime tools (Read/Bash/…) and adapter send tools; it does **not** suppress app-injected MCP tools. Set `config.memory.recallTool.enabled: false` to remove the on-demand tool; automatic score- and answer-evidence-gated context recall remains part of configured memory.

## References

- [Memory quality benchmark](/memory/benchmarking/) — disposable offline quality and efficiency gate
- Feature registry rows: `docs/reference/feature-registry.md` — `memory.lite`, `memory.journal`, `memory.bujo`, `memory.write-mode`, `memory.per-turn-capture`, `memory.recall-tool`
