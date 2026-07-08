# @mono-agent/memory

## Category

Category: `context`

## Responsibility

Local memory building blocks published as one package with explicit subpaths. `@mono-agent/memory/store` owns the SQLite substrate, schema, FTS5/sqlite-vec hybrid recall, and rebuildable record database. `@mono-agent/memory/search` owns embedding providers, circuit-breaking, chunk gathering, and the in-memory cosine vector index. `@mono-agent/memory/bujo` owns the Bullet-Journal memory engine: markdown grammar, canonical daily files, tier-aware capture/recall, entity graph projection, reflection, migration, and the `memory-bujo` maintenance CLI.

The shared `MemoryBlock`, `MemoryStore`, and `MemoryWriteResult` contracts live in `@mono-agent/agent-contracts`. The store subpath re-exports them for local-store consumers, but `@mono-agent/agent-contracts` is the source of truth.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory run build
```

```ts
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import { createEmbeddingProvider } from "@mono-agent/memory/search";
import { openMemoryDb } from "@mono-agent/memory/store";
import type { MemoryStore } from "@mono-agent/agent-contracts";

const embeddings = createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text:v1.5" });
const store: MemoryStore = createBujoMemoryStore({
  root: "./memory",
  embeddings,
  dim: 768,
});

await store.appendHostSummary("conv-1", "User prefers concise answers.");
```

```bash
memory-bujo rebuild ./memory
memory-bujo recall ./memory "what did we decide about releases?"
```

## Public API

- `@mono-agent/memory/store`: `openMemoryDb`, `MemoryDb`, `DEFAULT_VEC_DIM`, `MEMORY_TYPES`, `MEMORY_STATUSES`, local record/entity/recall/stats types, and re-exported `MemoryBlock`, `MemoryStore`, `MemoryWriteResult`
- `@mono-agent/memory/search`: `createEmbeddingProvider`, `createCircuitBreakerEmbeddingProvider`, `createVectorMemoryIndex`, `gatherMemoryChunks`, embedding/search provider classes and types
- `@mono-agent/memory/bujo`: `createBujoMemoryStore`, `BujoMemoryStore`, `composeRecallBlock`, markdown grammar helpers, daily-file helpers, capture/reconcile/reflection/migration helpers, `createOllamaLlm`, and related BuJo/LLM types
- CLI: `memory-bujo`

## Dependency Boundary

This package may depend on core contracts and local persistence/search dependencies (`better-sqlite3`, `sqlite-vec`). It does not depend on hosts, harnesses, communication adapters, observability, provider runtimes, or external memory services. Internal subpaths use relative imports so the package has no package-to-self workspace dependency.

## What This Package Does Not Own

It does not own host configuration, backend selection, automatic `MemoryRecall` MCP wiring, external Supermemory storage, model runtime execution, communication channels, or run artifact persistence. `@mono-agent/agent-app` chooses which memory backend to build and wires the recall tool, while `@mono-agent/memory-supermemory` owns the external Supermemory backend.

## Verification

```bash
pnpm --filter @mono-agent/memory run build
pnpm --filter @mono-agent/memory run typecheck
pnpm --filter @mono-agent/memory run test
```
