---
title: "Embeddings"
sidebar:
  order: 1
---

# Embeddings

The `memory.embeddings` block configures the vector embedding provider used for semantic
recall. It is a **shared prerequisite** for both the `journal` and `bujo` memory tiers — it
is not a tier on its own. The `lite` tier needs no embeddings. This page covers the config
keys, the two providers (Ollama and OpenAI), the matching `MONO_AGENT_MEMORY_EMBEDDINGS_*`
env vars, and the timeout / circuit-breaker behavior.

For the tier model (lite / journal / bujo) and where this block fits, see
[../memory.md](/memory/). For how recall actually uses these embeddings at runtime, see
[capture-and-recall.md](/memory/capture-and-recall/).

Coverage: **config**. The standalone maintenance CLI can also enable embeddings via env vars
(see [validation-and-cli.md](/memory/validation-and-cli/)).

## When you need it

| Tier | Requires embeddings |
| --- | --- |
| `lite` | no |
| `journal` | **yes** |
| `bujo` | **yes** |

Both `journal` and `bujo` perform hybrid recall (BM25 keyword + vector RRF). Without a
configured `memory.embeddings` block, those tiers fail config validation — there is no
silent fallback.

## Configuration keys

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `provider` | `"ollama"` \| `"openai"` | yes | Selects the embedding backend. |
| `model` | string | yes | Exact model tag (see below). |
| `endpoint` | string | no | Defaults to `http://localhost:11434` (ollama) or `https://api.openai.com/v1` (openai). |
| `apiKeyEnv` | string | openai | Name of the env var holding the API key (preferred). |
| `apiKey` | string | openai | Inline key (use `apiKeyEnv` instead; keep secrets out of config). |
| `dim` | number | yes | Output dimension; must match the model (768 for `nomic-embed-text:v1.5`, 1536 for `text-embedding-3-small`). |

:::caution
The `model` and `dim` must agree with the actual model. A mismatched `dim` corrupts the
vector index. For OpenAI, supply the key via `apiKeyEnv` (preferred) or inline `apiKey`;
one of the two is required.
:::

## Ollama (local, no API key)

Local embeddings via Ollama's `/api/embed` endpoint. No key needed. Pull the model first —
use the **exact `:v1.5` tag**; the bare alias `nomic-embed-text` may not exist in your
install and will fail the embeddings provider at startup. `mono-agent validate` checks for
this exact tag.

```bash
ollama pull nomic-embed-text:v1.5
```

```json
{
  "memory": {
    "mode": "journal",
    "path": "./.mono-agent/memory",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    }
  }
}
```

## OpenAI (hosted, API key required)

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKeyEnv": "OPENAI_API_KEY",
      "dim": 1536
    }
  }
}
```

Set the key in the environment that `apiKeyEnv` names:

```bash
export OPENAI_API_KEY=sk-...
```

The default OpenAI endpoint is `https://api.openai.com/v1`; override `endpoint` to target an
OpenAI-compatible gateway.

## Environment variables

Every key has a `MONO_AGENT_MEMORY_EMBEDDINGS_*` override. See
[../config/env-vars.md](/config/env-vars/).

| Env var | Config key |
| --- | --- |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` |

For the standalone `memory-bujo` maintenance CLI, embeddings are opt-in: set
`MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` to enable semantic recall. When enabled, the model
defaults to `nomic-embed-text:v1.5` and `dim` to `768`. Without it, `recall`/`rebuild` run
FTS-only and need no embedding service.

## Timeout and circuit-breaker behavior

Each embedding request has a request timeout of **30 s** (default). Embedding calls are also
wrapped in a circuit breaker so a slow or failing embedding service cannot stall recall:

- After **3 consecutive failures** the breaker trips **OPEN** and fails fast, throwing
  `embedding_circuit_open` instead of waiting on the unhealthy backend.
- It stays OPEN for a **30 s cooldown**, then allows a single **HALF-OPEN** trial request.
- A successful trial closes the breaker; a failed trial re-opens it for a fresh cooldown.

:::note
These timeout and breaker thresholds are not exposed as config keys — they are code-level
defaults in `@mono-agent/memory-search`. If you embed the provider programmatically you can
tune them via `createEmbeddingProvider` / `createCircuitBreakerEmbeddingProvider`; see
[../programmatic/index.md](/programmatic/).
:::

## Validation

`mono-agent validate` probes embeddings health when `provider` is `ollama`: it checks the
embedding endpoint's `GET /api/tags` is reachable and that the configured `model` (e.g.
`nomic-embed-text:v1.5`) is actually pulled, warning with the exact `ollama pull` command if
not. See [validation-and-cli.md](/memory/validation-and-cli/).
