---
title: "Write modes, capture & recall"
sidebar:
  order: 2
---

This page covers the two halves of the memory loop: how the host **writes** each completed turn (`memory.writeMode`) and how the agent **reads** what it stored back through the auto-provisioned `MemoryRecall` tool. Both are driven by the single `config.memory` block — there is no separate `.mcp.json` entry to hand-wire.

For tier selection (lite / journal / bujo) and embeddings setup, start at the [Memory overview](/memory/) and [Embeddings](/memory/embeddings/). Recall is the read path; scheduled consolidation is the maintenance path covered in [Consolidation](/memory/rituals/).

## Write modes (`memory.writeMode`)

`memory.writeMode` controls how the **host runtime** persists each completed turn. It is independent of the tier's recall capability. Coverage: **config** (env: `MONO_AGENT_MEMORY_WRITE_MODE`).

| Mode | What it does | Tiers | LLM |
|------|--------------|-------|-----|
| `disabled` | Never persist turns. Recall still works over whatever is already on disk. | all | no |
| `append-host-summary` | Append a deterministic, single-line rapid-log of the turn to today's daily file. Fast and synchronous. | all (lite/journal/bujo) | no |
| `capture` | **bujo only.** A superset of `append-host-summary` — see below. | bujo | yes (chat model) |

The host deliberately skips memory writes for two low-signal successful turns, in every write mode: final answers equal to `NOTHING_TO_REPORT` (the cron/webhook no-op sentinel) and tiny explicit test/ping probes such as `test` / `test ok`. Short contextual acknowledgements are not skipped by this default.

Cron and webhook turns are also capture-hygienic: when they do write memory, only the assistant answer is written. The trigger prompt or webhook pre-instructions are never sent to the deterministic host summary or intelligent capture pipeline.

```json
{
  "memory": {
    "mode": "journal",
    "writeMode": "append-host-summary",
    "path": "./.mono-agent/memory"
  }
}
```

```bash
MONO_AGENT_MEMORY_WRITE_MODE=append-host-summary
```

### `capture` — per-turn intelligent capture (bujo)

`capture` still writes the deterministic rapid-log **synchronously** (so the canonical markdown rapid-log is durable), and *additionally* enqueues the intelligent capture pipeline — **distil → reconcile → entity extraction** — in the background, except for the low-signal skipped turns described above.

Key properties:

- **Async and non-blocking.** Reply latency is unchanged; the capture runs after the turn returns.
- **Serialized per store.** Captures do not race each other against the same memory root.
- **Drained on graceful shutdown.** Nothing queued is lost on a clean stop. Even if a capture is interrupted, the synchronous markdown rapid-log already survived.
- **Reconcile is intelligent**, not append-only: the pipeline classifies each observation as `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP` against existing memories to avoid duplication.

Because it runs sequential chat-LLM calls, `writeMode: "capture"` **requires `mode: "bujo"`** and fails `mono-agent validate` otherwise — there is no silent fallback.

```json
{
  "memory": {
    "mode": "bujo",
    "writeMode": "capture",
    "path": "./.mono-agent/memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "llm": { "provider": "agent-host", "model": "pi:openai-codex:gpt-5.6-terra" }
  }
}
```

```bash
MONO_AGENT_MEMORY_MODE=bujo
MONO_AGENT_MEMORY_WRITE_MODE=capture
```

:::caution
The capture pipeline swallows LLM errors (never-throw), so a too-short timeout makes a capture **silently store nothing** rather than fail loudly. Raise the in-app memory-LLM timeout — `memory.llm.timeoutMs` (env `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS`), **default `60000`** in the app — for slow local chat models. (The standalone `memory-bujo` CLI reads the same env var but defaults to `120000`; see [Validation & CLI](/memory/validation-and-cli/#the-two-memory-llm-timeouts).)
:::

The bujo chat model used by capture is the same `memory.llm` block that lets the app resolve the effective `bujo` tier for [scheduled consolidation](/memory/rituals/). With `memory.llm.provider: "agent-host"` it can point at an SDK runtime model reference (e.g. `pi:openai-codex:gpt-5.6-terra`); the standalone legacy `reflect`/`migrate` CLI commands remain Ollama-only.

## The `MemoryRecall` tool

The agent reads memory back through a single, read-only `MemoryRecall` tool: hybrid **keyword (FTS) + vector** search over the same memory it writes to. Coverage: **config** (env: `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`).

`MemoryRecall` runs **no chat LLM** — recall is embeddings + full-text search only. Durable writes stay in-app on the agent-host LLM via [per-turn capture](#capture--per-turn-intelligent-capture-bujo); recall just reads.

:::note
**Where recalled memory appears in the prompt.** Beyond this on-demand tool, the harness *automatically* appends recalled memory to the **user message** at the start of each turn (when a recall returns hits), clearly delimited as background context — it is **not** folded into the system prompt. Riding the user message is what lets memory survive a session resume on runtimes that drop the system prompt. The injected block is not persisted to history, and a `memory_recalled` diagnostic records that recall fired (source + byte size, not the content). See [Context assembly → Memory recall](/context/assembly/#memory-recall).
:::

### How it is provisioned

The configured harness auto-provisions `MemoryRecall` from the single `config.memory` block when `config.memory.recallTool.enabled` is true. This applies both to the full `agent-app` host and to direct `createConfiguredAgentHarness` / `createConfiguredAgentResponder` composition. It exposes a request-scoped loopback MCP endpoint backed by the **same open store and retrieval service** as automatic recall. Identical normalized automatic/tool queries share one per-turn lookup; a different tool query may search again. No second SQLite handle, embedding request, or hand-maintained MCP config is involved. Caller-supplied request extensions are composed with the default tool instead of replacing it.

The endpoint is allocated only after the turn acquires a provider-concurrency slot, so queued turns do not accumulate listeners. If endpoint startup fails, the host warns and omits the explicit tool for that turn; automatic recall and the provider response continue. If the memory backend itself fails during a tool call, `MemoryRecall` returns an explicit degraded result instead of fabricated hits.

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "recallTool": { "enabled": true }
  }
}
```

```bash
MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED=true
```

| `recallTool.enabled` default | Condition |
|------------------------------|-----------|
| **on** | every configured tier: Lite (FTS), Journal/BuJo (hybrid), and external backends |
| off | only when set explicitly to `false` |

This replaces the retired standalone `@mono-agent/memory-mcp` package (which also shipped `memory_capture` / `memory_note` write tools — both dropped, since in-app capture now covers durable writes). To build a recall server directly in your own code, compose `@mono-agent/memory/bujo` (`createBujoMemoryStore`) with `@mono-agent/memory/search` (`createEmbeddingProvider`) — exactly what the bundled server does. See [Programmatic composition](/programmatic/composition/).

### Recall scoring

Recall fuses two retrievers and re-ranks the result:

- **BM25 keyword (FTS)** over the markdown entries.
- **Vector similarity** over the configured embeddings.
- Results are combined with **Reciprocal Rank Fusion (RRF)** and evidence strength; salience/insight are small tie-breakers. `lastAccessedAt` and access counts are telemetry only and never affect ranking.
- Automatic recall treats raw embedding similarity as ranking evidence, not a calibrated probability: it first considers the `0.65` absolute / `77%` top-relative score band, then applies a deterministic answer-evidence gate to a bounded candidate window. The gate requires the recalled text to contain both the query subject and the requested attribute. Multi-record evidence is accepted only for an explicit named-entity relationship hop; unrelated or same-subject attribute fragments cannot be spliced into a fabricated answer. This check adds no embedding or chat-model call, works across provider score scales, injects nothing for unsupported questions, and remains capped at five hits / 8 KB. Deliberate `MemoryRecall` calls may inspect more results (up to the requested limit).

You can exercise the exact same scoring offline against a memory root:

```bash
memory-bujo recall ./.mono-agent/memory "what did we decide about the rollout?"
```

### Entity graph (bujo auto)

The BuJo tier also maintains a lightweight entity graph beside the markdown rapid-log. During `writeMode: "capture"` the pipeline runs `distil -> reconcile -> entity extraction`; the extraction step records people, projects, organizations, concepts, and directed relationships in `graph.jsonl` under `memory.path`.

There is no separate config switch. The graph is built only for the effective `bujo` tier, which means `memory.mode: "bujo"` plus embeddings and `memory.llm`. The `lite` and `journal` tiers do not build it. Capture is async and serialized per store, so graph extraction never blocks the user's reply; if the memory LLM fails or times out, that capture stores nothing for the turn rather than throwing.

Recall uses the graph for one-hop expansion: entries matched by BM25/vector search contribute their entities, and directly related entities can pull in neighboring context. The living `index.md`, regenerated by consolidation or `memory-bujo index`, includes a top-entities table so the graph is inspectable as plain markdown.

### Tool policy: recall is gated by `recallTool.enabled`, not `allowedTools`

`MemoryRecall` is an MCP tool. Like every MCP server tool, it is **gated by its declaration, not by `tools.allowedTools`**. `tools.allowedTools` filters the built-in runtime tools (Read/Bash/…); it does **not** suppress app-injected MCP tools. So `tools.allowedTools: []` ("no built-in tools") still leaves `MemoryRecall` available when it is enabled.

:::caution
To withhold the on-demand memory tool from the agent, set `config.memory.recallTool.enabled: false` — that is the switch that controls this tool, not the allowlist. Automatic score- and answer-evidence-gated context recall remains part of a configured memory backend.
:::

See [Tool policy](/tools/policy/) and [MCP tools](/tools/mcp/) for how MCP-provided tools differ from the built-in allowlist.

## Environment variables

| Env var | Config key | Notes |
|---------|-----------|-------|
| `MONO_AGENT_MEMORY_WRITE_MODE` | `memory.writeMode` | `disabled` / `append-host-summary` / `capture` (`capture` requires `mode: bujo`) |
| `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | `memory.recallTool.enabled` | Auto-provisioned `MemoryRecall`; default on for every configured tier |
| `MONO_AGENT_MEMORY_MODE` | `memory.mode` | `lite` / `journal` / `bujo` |
| `MONO_AGENT_MEMORY_LLM_MODEL` | `memory.llm.model` | Chat model for the capture pipeline (and legacy CLI `reflect`/`migrate`) |
| `MONO_AGENT_MEMORY_LLM_ENDPOINT` | `memory.llm.endpoint` | Ollama chat endpoint (default `http://localhost:11434`) |
| `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` | `memory.llm.timeoutMs` | Per-call chat-LLM timeout. **In-app (agent-app) default `60000`**; the standalone `memory-bujo` CLI reads the same var but defaults to `120000`. See [Validation & CLI](/memory/validation-and-cli/#the-two-memory-llm-timeouts). |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` | `ollama` / `openai`; required for vector recall |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` | Required in the app; the standalone CLI defaults to `nomic-embed-text:v1.5` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` | Required in the app; the standalone CLI defaults to `768` |

See [Environment variables](/config/env-vars/) for the full table and precedence rules.

## Related pages

- [Memory overview](/memory/) — tier matrix and the single `memory` config block
- [Embeddings](/memory/embeddings/) — the provider/model behind vector recall
- [Consolidation](/memory/rituals/) — scheduled salience decay, duplicate superseding, and index maintenance
- [Validation & CLI](/memory/validation-and-cli/) — `mono-agent validate` checks and the `memory-bujo` binary
