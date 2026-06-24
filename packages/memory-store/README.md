# @mono-agent/memory-store

## Category

Category: `context`

## Responsibility

The local SQLite substrate for agent memory. It stores bi-temporal memory
records, embeds them with an injected `EmbeddingProvider`, and retrieves them by
hybrid search — BM25 keyword (FTS5) fused with `sqlite-vec` vector similarity via
Reciprocal Rank Fusion, then re-scored by recency, salience, and insight. It
supports incremental upsert, bi-temporal supersession (never hard-deletes), edge
storage with one-hop expansion, and full rebuild from supplied records.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-store run build
```

```ts
import { openMemoryDb } from "@mono-agent/memory-store";
import { createEmbeddingProvider } from "@mono-agent/memory-search";

const db = openMemoryDb({
  path: "./memory/memory.db",
  embeddings: createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text:v1.5" }),
  dim: 768,
});
await db.upsert({ id: "01J...", type: "note", status: "open", text: "Example Operator prefers opt-in memory.", salience: 0.9, isInsight: true, createdAt: new Date().toISOString(), accessCount: 0, tags: [], source: {} });
const hits = await db.recall("memory preferences", { topK: 5 });
```

## Public API

- `openMemoryDb`, `MemoryDb`
- `rrfFuse`, `reScore` (pure ranking helpers)
- `MemoryRecord`, `MemoryType`, `MemoryStatus`, `MemoryEdgeKind`, `RecallHit`, `RecallOptions`, `RecallWeights`, `MemoryDbOptions`

## Dependency Boundary

Depends on `@mono-agent/memory-search` (for the `EmbeddingProvider` interface),
`better-sqlite3`, and `sqlite-vec`. It does not embed text itself (the provider is
injected) and performs no LLM calls.

## What This Package Does Not Own

It does not own markdown files, the bullet grammar, entity extraction, reflection,
migration scheduling, or MCP tools. It is storage + retrieval only.

## Verification

```bash
pnpm --filter @mono-agent/memory-store run build
pnpm --filter @mono-agent/memory-store run typecheck
pnpm --filter @mono-agent/memory-store run test
```
