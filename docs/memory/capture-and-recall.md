---
title: "Write modes, capture & recall"
parent: "Memory"
nav_order: 2
---

This page covers the two halves of the memory loop: how the host **writes** each completed turn (`memory.writeMode`) and how the agent **reads** what it stored back through the auto-provisioned `memory_recall` tool. Both are driven by the single `config.memory` block — there is no separate `.mcp.json` entry to hand-wire.

For tier selection (lite / journal / bujo) and embeddings setup, start at the [Memory overview](../memory.md) and [Embeddings](./embeddings.md). Recall is the read path; rituals (reflect/migrate) are the maintenance path covered in [Rituals](./rituals.md).

## Write modes (`memory.writeMode`)

`memory.writeMode` controls how the **host runtime** persists each completed turn. It is independent of the tier's recall capability. Coverage: **config** (env: `MONO_AGENT_MEMORY_WRITE_MODE`).

| Mode | What it does | Tiers | LLM |
|------|--------------|-------|-----|
| `disabled` | Never persist turns. Recall still works over whatever is already on disk. | all | no |
| `append-host-summary` | Append a deterministic, single-line rapid-log of the turn to today's daily file. Fast and synchronous. | all (lite/journal/bujo) | no |
| `capture` | **bujo only.** A superset of `append-host-summary` — see below. | bujo | yes (chat model) |

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

`capture` still writes the deterministic rapid-log **synchronously** (so the canonical markdown rapid-log is durable), and *additionally* enqueues the intelligent capture pipeline — **distil → reconcile → entity extraction** — in the background.

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
    "llm": { "provider": "agent-host", "model": "pi:openai-codex:gpt-5.5" }
  }
}
```

```bash
MONO_AGENT_MEMORY_MODE=bujo
MONO_AGENT_MEMORY_WRITE_MODE=capture
```

The capture pipeline swallows LLM errors (never-throw), so a too-short timeout makes a capture **silently store nothing** rather than fail loudly. Raise `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` (default `120000`) for slow local chat models.
{: .warning }

The bujo chat model used by capture is the same `memory.llm` referenced for the [rituals](./rituals.md). With `memory.llm.provider: "agent-host"` it can point at an SDK runtime model reference (e.g. `pi:openai-codex:gpt-5.5`); the standalone CLI remains Ollama-only.

## The `memory_recall` tool

The agent reads memory back through a single, read-only `memory_recall` tool: hybrid **keyword (FTS) + vector** search over the same memory it writes to. Coverage: **config** (env: `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`).

`memory_recall` runs **no chat LLM** — recall is embeddings + full-text search only. Durable writes stay in-app on the agent-host LLM via [per-turn capture](#capture--per-turn-intelligent-capture-bujo); recall just reads.

### How it is provisioned

`agent-app` auto-provisions `memory_recall` from the single `config.memory` block when `config.memory.recallTool.enabled` is true. Under the hood it spawns a bundled stdio MCP child named `mono-agent-memory` (shipped inside `@mono-agent/agent-app`) that exposes only `memory_recall`, configured automatically from `config.memory` — it uses the **same memory root + embeddings** as the in-app memory, so there is nothing to keep in sync.

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
| **on** | `journal` or `bujo` tier with embeddings configured |
| off | `lite` tier (no vector recall) — or set explicitly to `false` |

This replaces the retired standalone `@mono-agent/memory-mcp` package (which also shipped `memory_capture` / `memory_note` write tools — both dropped, since in-app capture now covers durable writes). To build a recall server directly in your own code, compose `@mono-agent/memory-bujo` (`createBujoMemoryStore`) with `@mono-agent/memory-search` (`createEmbeddingProvider`) — exactly what the bundled server does. See [Programmatic composition](../programmatic/composition.md).

### Recall scoring

Recall fuses two retrievers and re-ranks the result:

- **BM25 keyword (FTS)** over the markdown entries.
- **Vector similarity** over the configured embeddings.
- Results are combined with **Reciprocal Rank Fusion (RRF)**, then weighted by **recency** and **salience** so fresh, important memories surface above stale or low-signal ones (salience decays over time via the nightly [reflect ritual](./rituals.md)).

You can exercise the exact same scoring offline against a memory root:

```bash
memory-bujo recall ./.mono-agent/memory "what did we decide about the rollout?"
```

### Tool policy: recall is gated by `recallTool.enabled`, not `allowedTools`

`memory_recall` is an MCP tool. Like every MCP server tool, it is **gated by its declaration, not by `tools.allowedTools`**. `tools.allowedTools` filters the built-in runtime tools (Read/Bash/…); it does **not** suppress app-injected MCP tools. So `tools.allowedTools: []` ("no built-in tools") still leaves `memory_recall` available when it is enabled.

To fully withhold memory reads from the agent, set `config.memory.recallTool.enabled: false` (or run a `lite` tier with no vector recall) — that is the switch that controls this tool, not the allowlist.
{: .warning }

See [Tool policy](../tools/policy.md) and [MCP tools](../tools/mcp.md) for how MCP-provided tools differ from the built-in allowlist.

## Environment variables

| Env var | Config key | Notes |
|---------|-----------|-------|
| `MONO_AGENT_MEMORY_WRITE_MODE` | `memory.writeMode` | `disabled` / `append-host-summary` / `capture` (`capture` requires `mode: bujo`) |
| `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | `memory.recallTool.enabled` | Auto-provisioned `memory_recall`; default on for journal/bujo with embeddings |
| `MONO_AGENT_MEMORY_MODE` | `memory.mode` | `lite` / `journal` / `bujo` |
| `MONO_AGENT_MEMORY_LLM_MODEL` | `memory.llm.model` | Chat model for the capture pipeline (and CLI reflect/migrate) |
| `MONO_AGENT_MEMORY_LLM_ENDPOINT` | `memory.llm.endpoint` | Ollama chat endpoint (default `http://localhost:11434`) |
| `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` | — | Per-call chat-LLM timeout (default `120000`) |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` | `ollama` / `openai`; required for vector recall |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` | Required in the app; the standalone CLI defaults to `nomic-embed-text:v1.5` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` | Required in the app; the standalone CLI defaults to `768` |

See [Environment variables](../config/env-vars.md) for the full table and precedence rules.

## Related pages

- [Memory overview](../memory.md) — tier matrix and the single `memory` config block
- [Embeddings](./embeddings.md) — the provider/model behind vector recall
- [Rituals](./rituals.md) — reflect (decay + salience) and migrate, which keep recall scoring fresh
- [Entity graph](./entity-graph.md) — what the capture pipeline's entity-extraction step builds
- [Validation & CLI](./validation-and-cli.md) — `mono-agent validate` checks and the `memory-bujo` binary
