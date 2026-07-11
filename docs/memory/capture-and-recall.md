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
| `append-host-summary` | Persist one deterministic, single-line host observation. Lite/Journal write the canonical daily log; BuJo writes the separate immutable raw audit. | all (lite/journal/bujo) | no |
| `capture` | **bujo only.** Preserve the raw audit synchronously, then curate durable facts and graph evidence in the background. | bujo | yes (chat model) |

The host deliberately skips memory writes for two low-signal successful turns, in every write mode: final answers equal to `NOTHING_TO_REPORT` (the cron/webhook no-op sentinel) and tiny explicit test/ping probes such as `test` / `test ok`. Short contextual acknowledgements are not skipped by this default.

Cron and webhook turns are also capture-hygienic: when they do write memory, only the assistant answer is written. The trigger prompt or webhook pre-instructions are never sent to the deterministic host summary or intelligent capture pipeline.

Memory persistence is **host-owned**. When a user says “remember this,” the agent should acknowledge the request normally and let the configured write mode decide whether and how to persist the completed turn after the reply succeeds. It must not use shell, filesystem, or database tools to edit `.mono-agent/memory`, canonical Markdown, SQLite rows, manifests, generations, or indexes directly. Operators should stop the agent and use the `mono-agent memory ...` maintenance commands when they need to rebuild, migrate, audit, or repair memory state.

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

### Strict tier write behavior

- **Lite:** appends the normalized host observation to `daily/YYYY-MM-DD.md` and indexes it for FTS synchronously. It never embeds and never calls a chat model.
- **Journal:** reserves a case-preserving, NFKC/whitespace-normalized SHA-256 identity, appends only a new canonical observation, and makes it available to FTS synchronously. Semantic indexing is queued after the successful turn in batches of up to 32, so Ollama/OpenAI embedding latency is not on the provider-success critical path. Repeated content converges on one markdown/index identity.
- **BuJo:** appends every compact host observation to `audit/YYYY-MM-DD.md`, outside curated recall. Only `writeMode: "capture"` asks the memory model to promote durable facts into canonical `daily/` notes and the graph. A model outage or queue overflow therefore cannot turn an uncurated raw transcript into recalled fact.

Both background paths are bounded and observable. Journal indexing holds at most 256 items / 2 MiB; BuJo curation holds at most 32 turns / 1 MiB. Each capture-model completion is rejected before JSON parsing when it exceeds 262,144 JavaScript characters. Queue snapshots report capacity, queued/in-flight/high-water counts and bytes, completed/failed/dropped/coalesced/discarded work, and recovery backlog. Shutdown gives accepted work up to 10 seconds to drain; after that deadline it discards queued best-effort work and aborts cooperative in-flight work instead of hanging indefinitely. Overflow or deadline loss preserves the lexical Journal row or BuJo raw audit and emits a warning.

### `capture` — per-turn intelligent capture (bujo)

`capture` writes the compact raw audit **synchronously**, then enqueues one bounded curation plan in the background, except for the low-signal skipped turns described above. The plan uses exactly one chat-LLM call to extract up to eight atomic memories plus their precise entities/relations, then at most one additional batched call to classify close existing candidates as `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP`. Clearly novel candidates skip the second call. Entity extraction is part of the first call, not a third pass.

Key properties:

- **Async and non-blocking.** Reply latency is unchanged; the capture runs after the turn returns.
- **Serialized per store.** Captures do not race each other against the same memory root.
- **Bounded shutdown.** A normal stop drains accepted work, with a 10-second safety deadline. If a provider ignores cancellation, stop still returns; queued curation may be discarded, while the synchronous raw audit remains outside recall.
- **Reconcile is intelligent**, not append-only: the pipeline classifies each observation as `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP` against existing memories to avoid duplication.
- **Associations are precise.** Each curated fact carries only the entity IDs explicitly extracted for that fact; the implementation never creates a turn-wide memory/entity Cartesian product.

Because it uses a chat LLM, `writeMode: "capture"` **requires `mode: "bujo"`** and fails config validation otherwise — there is no silent fallback or tier downshift.

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
The capture pipeline never fails the user's reply. An LLM/embedding timeout leaves the raw audit intact, emits a memory warning/run failure, and stores no curated facts for that turn. Raise the in-app per-call timeout — `memory.llm.timeoutMs` (env `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS`), **default `60000`** — for a slow model. The standalone legacy `memory-bujo reflect`/`migrate` path reads the same env var but defaults to `120000`; see [Validation & CLI](/memory/validation-and-cli/#the-two-memory-llm-timeouts).
:::

The BuJo chat model used by capture is the same required `memory.llm` block used by [scheduled consolidation](/memory/rituals/). With `memory.llm.provider: "agent-host"` it can point at an SDK runtime model reference (e.g. `pi:openai-codex:gpt-5.6-terra`); the standalone legacy `reflect`/`migrate` CLI commands remain Ollama-only.

## The `MemoryRecall` tool

The agent reads memory back through a single, read-only `MemoryRecall` tool: hybrid **keyword (FTS) + vector** search over the same memory it writes to. Coverage: **config** (env: `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`).

`MemoryRecall` runs **no chat LLM** — recall is embeddings + full-text search only. Durable writes stay in-app on the agent-host LLM via [per-turn capture](#capture--per-turn-intelligent-capture-bujo); recall just reads.

Questions about the active chat are intentionally not durable-memory queries. For unqualified prompts such as `What did you send in the last message?`, `What was your previous reply?`, or `What happened in this conversation?`, automatic recall injects nothing and `MemoryRecall` returns guidance to use the active conversation history without calling the memory backend. Qualified archived questions—such as `What did Alice's last message say?` or `What did we decide last month?`—still use durable recall. This prevents an older semantically similar record from displacing the actual latest Telegram message.

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
- Automatic recall treats raw embedding similarity as ranking evidence, not a calibrated probability: it first considers the `0.65` absolute / `77%` top-relative score band, then applies a deterministic direct-fact gate to a bounded candidate window. The gate admits only canonical, unambiguous shapes: an explicitly named possessive property (`Morgan's phone number is ...`), a direct choice (`Morgan selected ... as the deployment color`), a direct event date/time, or a direct work/live location. Coordination, reported or ditransitive speech, negation/unknown values, actor/relationship questions, subordinate clauses, and multi-hop evidence abstain. Those records remain available through the default-on `MemoryRecall` tool, where the model can inspect separate results and provenance instead of receiving a fabricated binding. The gate adds no embedding or chat-model call, works across provider score scales, injects nothing for unsupported questions, and remains capped at five hits / 8 KB. Deliberate tool calls may inspect more results (up to the requested limit).

You can exercise the direct hybrid scoring offline against a memory root:

```bash
memory-bujo recall ./.mono-agent/memory "what did we decide about the rollout?"
```

### Entity graph (bujo auto)

The BuJo tier also maintains a lightweight entity graph beside the curated daily notes. During `writeMode: "capture"`, the first bounded extraction plan records people, projects, organizations, concepts, precise per-memory associations, and directed relationships in `graph.jsonl` under `memory.path`.

There is no separate config switch. The graph is built only for a valid configured `bujo` tier: `memory.mode: "bujo"` plus embeddings and `memory.llm`. The `lite` and `journal` tiers do not build it. Capture is async and serialized per store, so graph extraction never blocks the user's reply; if the memory LLM fails or times out, that capture stores nothing for the turn rather than throwing.

Only an explicit `MemoryRecall` call uses the graph, and expansion is deterministic and limited to one hop: direct BM25/vector seeds contribute their associated entities, and one directly related entity may pull in neighboring memories. Automatic prompt injection stays direct-only and never synthesizes a graph answer in the background. Lite and Journal never expand the graph. The living `index.md`, regenerated by consolidation or `memory-bujo index`, includes a top-entities table so the graph is inspectable as plain markdown.

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
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` | `ollama` / `openai`; defaults to `ollama` once the required Journal/BuJo embeddings block is present |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` | Defaults by provider (`nomic-embed-text:v1.5` for Ollama) |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` | Defaults to `768`; set it when the model output dimension differs |

See [Environment variables](/config/env-vars/) for the full table and precedence rules.

Journal and BuJo require an explicit, non-empty `memory.embeddings` **block**, but they do not require every field in that block. Provider, model, and dimension use the defaults above; even a block that only overrides `dim` is valid.

## Related pages

- [Memory overview](/memory/) — tier matrix and the single `memory` config block
- [Embeddings](/memory/embeddings/) — the provider/model behind vector recall
- [Consolidation](/memory/rituals/) — scheduled salience decay, duplicate superseding, and index maintenance
- [Validation & CLI](/memory/validation-and-cli/) — `mono-agent validate` checks and the `memory-bujo` binary
