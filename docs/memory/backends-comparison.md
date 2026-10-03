---
title: "Local memory tiers and custom stores"
description: "Compare Lite, Journal, and BuJo memory, and understand the programmatic custom-store boundary."
sidebar:
  order: 1
---

Mono-agent ships one first-party memory engine, selected with `memory.backend: "bujo"`
(the default). Its `memory.mode` chooses one of three local capability tiers:
`lite`, `journal`, or `bujo`. The tiers share the same durable completed-turn
admission contract and local root; they differ in provider requirements and curation.

| Dimension | Lite | Journal | BuJo |
| --- | --- | --- | --- |
| Local durable root | SQLite + canonical daily Markdown | SQLite + canonical daily Markdown | SQLite + raw audit, curated daily Markdown, graph, projections |
| Recall | BM25 FTS | BM25 + vector RRF | BM25 + vector RRF + one-hop graph expansion |
| Embeddings | none | required | required |
| Capture chat model | none | none | required |
| Completed-turn projection | deterministic host summary | deterministic host summary; vector work is restartable | durable raw observation followed by strict bounded curation |
| `MemoryJournal` chronology | yes | yes | yes; raw audit stays excluded |
| Consolidation | none | none | projection-only, scheduled in app |
| Best fit | minimal dependencies | semantic recall without a capture LLM | curated durable facts and entity relationships |

All tiers are local in the sense that canonical memory is rooted at `memory.path`.
That does **not** make the whole application network-isolated: model providers,
channels, web tools, embeddings providers, and operator-configured MCP servers may
still use the network.

## Choosing a tier

Use **Lite** when lexical recall and a human-readable chronological record are
enough. It requires no embeddings or chat model.

Use **Journal** when you want semantic ranking but do not want an LLM deciding what
to retain. The successful turn is admitted before vector indexing; an unavailable
embedding service therefore leaves restartable work instead of discarding the turn.

Use **BuJo** when you need strict model-guided extraction, reconciliation,
relationships, and projection-only consolidation. It requires both embeddings and a
capture LLM. Invalid or partial model output fails closed and remains retryable.

The tier matrix is strict. Mono-agent does not silently downgrade Journal or BuJo
when a required provider is missing.

## Configuration examples

Lite:

```jsonc
{
  "memory": {
    "backend": "bujo",
    "mode": "lite",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary"
  }
}
```

Journal adds an embeddings block:

```jsonc
{
  "memory": {
    "backend": "bujo",
    "mode": "journal",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    }
  }
}
```

BuJo adds a capture LLM and uses `capture`:

```jsonc
{
  "memory": {
    "backend": "bujo",
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
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

See [Memory](/memory/) for the full tier contract and [Capture and recall](/memory/capture-and-recall/)
for admission, persistence, and tool behavior.

## Programmatic custom stores

Framework embedders can inject any structural `MemoryStore` into
`createConfiguredAgentResponder`. This neutral contract remains supported and may be
implemented by a local or remote service. Injection is a code-level composition
choice; mono-agent does not infer a service from retired configuration and does not
silently reinterpret one backend as another.

A read-only store implements `load`. A writable store used with
`append-host-summary` or `capture` must also implement `persistCompletedTurn` and
honor stable `runId` admission. See [Programmatic composition](/programmatic/composition/#custom-memory-stores).

Generic MCP configuration is independent of memory selection. An operator-authored
server remains untouched even if its name or URL resembles a retired integration.

## Migrating retired first-party Supermemory support

First-party Supermemory config, automatic official MCP injection, and the optional
package have been removed. Active legacy selectors, blocks, or environment variables
fail closed with migration guidance; they are never converted to a local tier. An
exact empty `memory.supermemory: {}` object and blank retired environment assignments
are tolerated only as inert upgrade tombstones and enable nothing.

The upgrade performs no automatic replacement, export, local import, remote data
migration, or remote cleanup. Existing remote data remains untouched. If export or
cleanup is required, perform it separately with the known-good version and service
workflow you already operate before upgrading; this repository does not establish a
new package pin.

See [Framework simplification migration](/reference/framework-simplification-migration/#retired-first-party-supermemory-support)
for the exact removal checklist.
