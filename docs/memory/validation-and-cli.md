---
title: "Validation & CLI maintenance"
sidebar:
  order: 5
---

This page covers how `mono-agent validate` verifies memory liveness (writable root, Ollama reachability, ritual cadence) and how the standalone `memory-bujo` CLI runs out-of-band maintenance against a memory root. It also explains the `memory.llm` provider choices (`ollama` vs `agent-host`) that the validator inspects.

The memory subsystem **never silently falls back**: the host never downgrades the configured tier. Misconfiguration surfaces as a loud `[warn]` you must read, not a quiet degradation. Run `mono-agent validate` before cutover and after pulling any model.

## `mono-agent validate` — memory liveness

`mono-agent validate` (the agent-app doctor) runs a memory liveness check that **scales with the configured tier** (`memory.mode`). Failures emit a loud `[warn]` in the validate report's Memory section. The Memory section reports status `waiting` rather than `error`, so warnings do not flip the overall result — you must read the Memory section.

Coverage: cli.

| Tier | Checks performed |
| --- | --- |
| `lite` | Memory root creatable and writable. |
| `journal` | Root writable + Ollama embeddings reachable + embeddings model pulled (Ollama embeddings only). |
| `bujo` | All journal checks + chat model pulled (`llm.provider: "ollama"` only) + ritual cadence with next-run times. |

The individual probes for `journal` / `bujo`:

1. **Memory root writable** — confirms `memory.path` is creatable and writable.
2. **Ollama embeddings reachable** — only when `memory.embeddings.provider` is `ollama`; probes the embedding endpoint's `GET /api/tags` with a short timeout.
3. **Embeddings model pulled** — for Ollama embeddings only, confirms `nomic-embed-text:v1.5` (or whichever `memory.embeddings.model` you set) appears in that endpoint's `/api/tags`. If absent it emits:
   `⚠  memory embeddings model "nomic-embed-text:v1.5" not found — run: ollama pull nomic-embed-text:v1.5`
4. **Chat model pulled** (bujo only) — only when `memory.llm.provider` is `ollama`; probes the chat endpoint and checks the chat model against its `/api/tags`. `agent-host` chat LLMs are **not** checked against Ollama.
5. **Ritual cadence** (bujo only) — reports the reflection/migration cron expressions and whether the scheduler will run (tier is bujo with an `llm` configured).

A healthy bujo report looks like:

```
[ok] memory.mode     bujo
[ok] reflection      0 3 * * * (next: …)
[ok] migration       0 4 1 * * (next: …)
```

The embeddings reachability and pull checks only run when embeddings/chat actually use Ollama. With `embeddings.provider: "openai"` the embeddings probes are skipped, and with `llm.provider: "agent-host"` the chat-model pull check is skipped. See [Embeddings](/memory/embeddings/) for the provider matrix and [Rituals](/memory/rituals/) for the auto-scheduler.

:::caution
Use the exact `:v1.5` tag for the default embeddings model. The bare alias `nomic-embed-text` (no tag) may be absent from your Ollama install and will fail the provider at startup — `validate` checks for the exact tag.
:::

## `memory.llm` provider choices

The validator's behavior depends on `memory.llm.provider`. There are two providers, and which one you pick changes both what runs the reflection/migration LLM passes and what `validate` probes.

| Field | `ollama` | `agent-host` |
| --- | --- | --- |
| `provider` | `"ollama"` | `"agent-host"` |
| `model` | local model string, e.g. `qwen3.6:latest` | SDK runtime ref, e.g. `pi:openai-codex:gpt-5.5` |
| `executionMode` | (n/a) | must be `"sdk"` |
| `endpoint` | Ollama URL (default `http://localhost:11434`) | **rejected** — Ollama-only |
| `validate` chat-model check | yes (probes `/api/tags`) | no |

Env overrides: `MONO_AGENT_MEMORY_LLM_PROVIDER`, `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE`, `MONO_AGENT_MEMORY_LLM_ENDPOINT`.

### Ollama-backed memory LLM

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    },
    "llm": {
      "provider": "ollama",
      "model": "qwen3.6:latest",
      "endpoint": "http://localhost:11434"
    }
  }
}
```

### Host-runtime (SDK) memory LLM

The `agent-host` provider runs memory LLM passes through the agent's own SDK runtime, so there is no separate local chat model to pull. The `model` is a runtime reference and `executionMode` **must** be `"sdk"`. Do not set `endpoint` — it is Ollama-only and rejected here.

```json
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

:::caution
`agent-host` memory LLMs are SDK-only for now. CLI-backed refs (e.g. `codex:gpt-5.5`) or an explicit `executionMode: "cli"` are **rejected** at config validation, because those runtimes cannot yet guarantee a no-tools / no-external-actions memory turn.
:::

## `memory-bujo` CLI — out-of-band maintenance

The `memory-bujo` binary runs maintenance directly against a bujo memory root (the positional `<root>` argument). It is available for all tiers for manual runs; the in-app [auto-scheduler](/memory/rituals/) handles the routine cadence for `bujo` automatically.

Coverage: cli.

```bash
# Rebuild the SQLite index from the markdown files on disk
memory-bujo rebuild <root>

# Recall: hybrid BM25 + vector search (prints matching entries)
memory-bujo recall <root> "<query>"

# Write the living index.md (counts, top memories, entities)
memory-bujo index <root>

# Reflection pass: decay + insight synthesis (Ollama-only; needs MONO_AGENT_MEMORY_LLM_MODEL)
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo reflect <root>

# Monthly migration: promote/reschedule/cluster/forget (Ollama-only; needs MONO_AGENT_MEMORY_LLM_MODEL)
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo migrate <root>
```

| Command | Needs embeddings? | Needs chat LLM? |
| --- | --- | --- |
| `rebuild` | only if `MONO_AGENT_MEMORY_EMBEDDINGS_*` set (else FTS-only) | no |
| `recall` | only if `MONO_AGENT_MEMORY_EMBEDDINGS_*` set (else FTS-only) | no |
| `index` | no | no |
| `reflect` | no | yes — Ollama-only, `MONO_AGENT_MEMORY_LLM_MODEL` required |
| `migrate` | no | yes — Ollama-only, `MONO_AGENT_MEMORY_LLM_MODEL` required |

### Semantic recall is opt-in

The standalone CLI reads the **same `MONO_AGENT_MEMORY_*` env vars** as the app. Embeddings are opt-in: set `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` (`ollama` / `openai`) to enable semantic recall. Without it, `recall` / `rebuild` run FTS-only and need no embedding service. When enabled, the model defaults to `nomic-embed-text:v1.5` (`MONO_AGENT_MEMORY_EMBEDDINGS_MODEL`) and the dimension to 768 (`MONO_AGENT_MEMORY_EMBEDDINGS_DIM`). See [Embeddings](/memory/embeddings/) for the full env list.

### reflect / migrate are Ollama-only

The standalone CLI uses the built-in Ollama chat adapter for `reflect` / `migrate` — it does **not** route through the agent host, so `memory.llm.provider: "agent-host"` does not apply to the CLI. You must set `MONO_AGENT_MEMORY_LLM_MODEL`; if it is unset when running `reflect` or `migrate`, the command prints a clear error and exits `2` (no silent fallback). `MONO_AGENT_MEMORY_LLM_ENDPOINT` overrides the Ollama endpoint (default `http://localhost:11434`), and `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` sets the per-call timeout (default `120000`); raise it for slow models.

For the in-app runtime you can instead use `memory.llm.provider: "agent-host"` to run rituals through an SDK model — see the [provider choices](#memoryllm-provider-choices) above and [Rituals](/memory/rituals/) for the auto-scheduler the CLI complements.

## Related

- [Embeddings](/memory/embeddings/) — providers, models, dimensions, and env vars.
- [Capture & recall](/memory/capture-and-recall/) — `writeMode` and the `memory_recall` tool.
- [Rituals](/memory/rituals/) — in-app reflection/migration auto-scheduler.
- [Config blueprint](/config/blueprint/) — the full annotated `memory` block.
- [Environment variables](/config/env-vars/) — every `MONO_AGENT_MEMORY_*` override.
- [CLI reference](/observability/cli-reference/) — the broader `mono-agent` command surface.
