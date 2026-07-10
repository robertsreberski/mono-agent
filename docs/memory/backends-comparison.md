---
title: "Backends: BuJo vs Supermemory"
sidebar:
  order: 0.5
---

# Memory backends: BuJo vs Supermemory

mono-agent's memory engine is pluggable. `memory.backend` selects it:

- **BuJo** (`backend: "bujo"`, the default) — the built-in engine
  (`@mono-agent/memory/store` + `@mono-agent/memory/bujo`) across its three tiers
  (`lite` / `journal` / `bujo`). Fully local: SQLite + markdown notes, optional Ollama
  embeddings, optional local chat model.
- **Supermemory** (`backend: "supermemory"`) — an explicitly installed plugin backed by an external memory service
  ([supermemory.ai](https://supermemory.ai)) reached over REST. Runs locally as a single
  OSS binary or against the hosted cloud. It extracts and consolidates memories
  server-side.

Both implement the same internal `MemoryStore` contract and surface through the same
`MemoryRecall` tool, so the agent's behavior is identical from the model's point of
view — what differs is where memory lives, how it's built, and what it costs to run.

Supermemory is not in the default app install. Before selecting it, install the
exact lockstep package version printed by `mono-agent --version`:

```bash
APP_VERSION="$(mono-agent --version | sed 's/^mono-agent //')"
npm install "@mono-agent/memory-supermemory@${APP_VERSION}"
```

> Terminology: "BuJo" names the whole built-in engine here. Its top `bujo` tier (LLM
> capture + entity graph + consolidation) is the fairest like-for-like comparison with
> Supermemory; the `lite`/`journal` tiers are lighter. For tier selection within BuJo, see
> the [Memory overview](/memory/).

## At a glance

| Dimension | BuJo (built-in) | Supermemory (external) |
| --- | --- | --- |
| Where data lives | Local SQLite + markdown at `memory.path` — yours, human-readable | Supermemory instance (local binary or hosted cloud); its own store |
| Runs without a network | Yes (fully local) | Yes with the local binary; the cloud is off-machine |
| Memory extraction | `bujo` tier: in-app LLM capture/reconcile + entity graph. `lite`/`journal`: deterministic rapid-log, no LLM | Server-side, inside Supermemory — you just POST turns |
| Dependencies | Ollama embeddings (`journal`/`bujo`) + optional chat model (`bujo`) | The Supermemory binary + an OpenAI-compatible LLM endpoint for its extractor (Ollama works); embeddings bundled |
| Recall | Embeddings + FTS, RRF fusion + decay/salience, no LLM | Hybrid search (`/v4/search`, legacy `/v3` fallback) |
| Capture latency | Host summary written synchronously; intelligent capture async | Ingestion is **async** ("queued") — a just-captured turn isn't instantly searchable |
| Maintenance | `bujo`: lightweight consolidation every two hours by default (in-app scheduler) | Consolidation happens server-side; BuJo scheduled consolidation is a no-op |
| Cost model | Your tokens for `bujo` capture; embeddings local | Extraction runs on Supermemory's configured LLM endpoint |
| Privacy / ownership | Fully local, plain-text markdown you can read and `grep` | Local binary keeps data on-machine; the hosted cloud sends it out |
| Setup effort | Pull Ollama models (for `journal`/`bujo`); zero extra services for `lite` | Install the optional mono-agent plugin plus `supermemory-server` (and point it at an LLM) |
| Lock-in / portability | Open SQLite + markdown; no service | Data lives in Supermemory; no shared index with BuJo |
| `MemoryRecall` tool | Same tool, same shape | Same tool (proxies Supermemory search behind the same name) |

## How they differ

### Architecture & storage
BuJo is a single embedded SQLite database plus living markdown notes under
`memory.path` — everything is on disk, human-readable, and yours. Supermemory is a
separate service: the OSS binary `supermemory-server` (default
`http://127.0.0.1:6767`) with an embedded graph engine, or the hosted cloud. With
Supermemory there is no local mono-agent store — memory lives in the instance. The
resolved config retains compatibility defaults for `memory.path`/`mode`, but operators
do not need to set them and the plugin ignores them; `embeddings`/`llm` are also ignored.

### Memory extraction
This is the biggest conceptual difference. BuJo's `bujo` tier runs an **in-app** LLM
pipeline that distills each turn into atomic memories and reconciles them against the
existing store (classifying ADD / UPDATE / SUPERSEDE / NOOP) and builds an entity graph —
so it needs a chat model (`memory.llm`). The `lite` and `journal` tiers skip the LLM
entirely (deterministic rapid-log + hybrid recall). Supermemory does extraction and
consolidation **server-side**: you POST raw turns and it decides what to remember, so no
`memory.llm` is needed on the mono-agent side. See
[Write modes, capture & recall](/memory/capture-and-recall/).

### Recall
Both back the auto-provisioned `MemoryRecall` tool and the per-turn recall-into-context.
BuJo ranks with embeddings + full-text BM25 fused via RRF, with relevance-first salience/insight
weighting and no LLM call (see [Embeddings](/memory/embeddings/)). Supermemory runs its
own hybrid search. Deliberate tool/search calls return their top-ranked hits; automatic
context recall applies the host confidence floor and injects nothing when no result clears it.

### Latency & read-after-write
BuJo appends the per-turn host summary synchronously and runs intelligent capture in the
background. Supermemory ingestion is **asynchronous** (the API returns `queued`), so a
fact captured this turn may take seconds to minutes to become searchable — don't rely on
reading it back within the same turn.

### Maintenance & consolidation
BuJo's `bujo` tier auto-runs lightweight **consolidation** every two hours by default:
temporal decay, duplicate superseding, `index.md` refresh, and an empty retired
`future-log.md` stub — see [Consolidation](/memory/rituals/). Supermemory performs its own
consolidation server-side, so the BuJo scheduler does not run for the Supermemory backend.

### Privacy & data ownership
BuJo keeps everything local in formats you own and can inspect. The Supermemory **local
binary** is also fully on-machine, but in its own store/format. The Supermemory **hosted
cloud** sends your memory off-machine — choose the local binary if that matters.

## Config side by side

BuJo (`bujo` tier — full capture + consolidation):

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5" },
    "llm": { "provider": "agent-host", "model": "claude:claude-sonnet-4-6" },
    "recallTool": { "enabled": true }
  }
}
```

Supermemory (server-side extraction — no local path, embeddings, or memory LLM required):

```json
{
  "memory": {
    "backend": "supermemory",
    "writeMode": "capture",
    "supermemory": { "baseUrl": "http://127.0.0.1:6767", "container": "my-agent" },
    "recallTool": { "enabled": true }
  }
}
```

The Supermemory API key is supplied via the environment
(`MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY`), never written into JSON. For the full key list
(including `apiKeyEnv`, `timeoutMs`, `exposeMcpServer`) see
[Environment variables → Memory](/config/env-vars/). `writeMode: "capture"` is the
recommended mode for Supermemory (full turns → server-side extraction); BuJo's lighter
tiers default to `append-host-summary`.

## When to use what

**Use BuJo (the default) when:**

- You want a fully local, zero-or-Ollama-only setup with no extra service to run.
- You value human-readable, owned memory you can read, `grep`, and version.
- You want the entity graph, lightweight consolidation, and deterministic, inspectable
  recall.
- You're on `lite`/`journal` and don't want any LLM in the memory loop at all.

Within BuJo, pick the tier by your dependency budget (`lite` → no deps, `journal` →
embeddings, `bujo` → embeddings + chat model). See the [Memory overview](/memory/).

**Use Supermemory when:**

- You want best-in-class server-side extraction/consolidation **without running a capture
  LLM yourself** in mono-agent.
- You already run Supermemory, or want to use its hosted cloud.
- You're comparing external memory layers and want a first-class, swappable backend rather
  than the model calling memory tools ad hoc.

A full, runnable example lives in the
[Telegram + Supermemory playbook](/playbooks/telegram-supermemory-memory/).

## Limits & gotchas

- **No shared index.** Switching `memory.backend` does **not** migrate existing memories —
  BuJo and Supermemory are separate stores and never share data.
- **Async ingestion.** Supermemory captures are eventually searchable, not immediately
  (see latency above).
- **MCP server is cloud-only.** Supermemory's hosted MCP server can't point at a
  self-hosted instance, so recall here uses the in-app REST-proxied `MemoryRecall` tool
  (works everywhere). `memory.supermemory.exposeMcpServer: true` additionally injects the
  hosted MCP server for cloud deployments with an API key.
- **Scheduled consolidation is BuJo-only.** The BuJo scheduler does not run for external backends.

## See also

- [Memory overview & tiers](/memory/)
- [Write modes, capture & recall](/memory/capture-and-recall/)
- [Consolidation](/memory/rituals/)
- [Embeddings](/memory/embeddings/)
- [Environment variables → Memory](/config/env-vars/)
- [Telegram + Supermemory playbook](/playbooks/telegram-supermemory-memory/)
