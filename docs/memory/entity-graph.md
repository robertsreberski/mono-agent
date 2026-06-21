---
title: "Entity graph"
parent: "Memory"
nav_order: 4
---

# Entity graph

The bujo memory tier maintains a lightweight knowledge graph alongside the markdown rapid-log: as the agent captures observations, an LLM extracts **entities** (people, projects, orgs, concepts) and the **relations** between them, persisted to `graph.jsonl` inside the memory root. At recall time the graph drives a one-hop expansion so related context surfaces even when the query only names one node.

The entity graph is **bujo-only** and **auto** (coverage type: auto). It needs the chat model configured under `memory.llm` — there is no separate config switch to turn it on; it is part of the bujo capture pipeline. See [Capture and recall](capture-and-recall.md) for how captures are scheduled and how recall is invoked.

## Requirements

The graph is built and used only when the memory tier is `bujo`, which requires both an embeddings provider and a chat model:

```json
{
  "memory": {
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

Relevant env overrides: `MONO_AGENT_MEMORY_MODE=bujo`, `MONO_AGENT_MEMORY_LLM_PROVIDER`, `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_ENDPOINT`. The `lite` and `journal` tiers do not build a graph.

The `journal` and `bujo` tiers store the memory root under `memory.path`; `graph.jsonl` lives there next to the daily markdown notes (`daily/`), the rebuildable SQLite index (`memory.db`), and the living `index.md` / `future-log.md`.
{: .note }

## What gets extracted

During each capture the pipeline runs `distil → reconcile → entity extraction`. The extraction step reads the distilled, reconciled observation and emits entities and relations.

| Entity type | Captures |
| --- | --- |
| `person` | A named individual the agent interacts with or hears about |
| `project` | A piece of work, initiative, or repo |
| `org` | A company, team, or organization |
| `concept` | A topic, technology, or recurring idea |

Each entity is identified by a stable **slug** (a normalized identifier derived from its name) so that mentions across many captures collapse onto the same node instead of creating duplicates. Relations are directed edges between two entity slugs (for example, a `person` works on a `project`, a `project` belongs to an `org`). New facts about an existing entity reconcile onto the existing node rather than appending a fresh one.

Because extraction is part of the async, per-turn capture pipeline, it runs in the background and never blocks the reply. Capture is serialized per store and drained on graceful shutdown, so queued extractions are not lost on stop. If the chat LLM call fails or times out, the capture stores nothing for that turn rather than throwing — keep `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` generous for slow local models so extraction is not silently dropped.
{: .warning }

## One-hop expansion during recall

`memory_recall` is hybrid BM25 + vector search over the journal entries. On the bujo tier it additionally consults the graph: matched entries contribute their entities, and the recall result is expanded **one hop** along the graph edges. That means a query that surfaces one entity also pulls in its directly related entities and the entries that mention them, giving the agent connected context (the people on a project, the org behind it) without the user having to name every node.

The living `index.md`, regenerated during rituals and by the `index` CLI command, includes a table of the top entities so the graph is human-inspectable as plain markdown.

## Inspecting and rebuilding

The graph is rebuilt from the markdown files on disk by `memory-bujo rebuild`, and the entity table is rewritten by `memory-bujo index`. Recall (including one-hop expansion) can be exercised from the CLI with `memory-bujo recall`. See [Validation and CLI](validation-and-cli.md) for the full subcommand reference and the `mono-agent validate` liveness checks.

## Related pages

- [Capture and recall](capture-and-recall.md) — the capture pipeline that feeds the graph and the recall tool that uses it
- [Validation and CLI](validation-and-cli.md) — `memory-bujo` subcommands and validation
- [Embeddings](embeddings.md) — the embeddings provider bujo requires
- [Rituals](rituals.md) — reflection and migration passes that maintain the index
