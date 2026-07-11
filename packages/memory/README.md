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
memory-bujo recall ./memory "what did we decide about releases?"
```

Normal index maintenance is config-aware and owned by `@mono-agent/agent-app`:

```bash
mono-agent stop
mono-agent memory rebuild --json
mono-agent memory audit --json
mono-agent start
```

This performs the first managed activation and builds and validates a side-by-side generation. A prior index is retained for `mono-agent memory rollback` only as a fresh immutable online-backup generation whose indexed payload exactly matches the current canonical source (Journal may retain its recoverable vector backlog). Its manifest commits the full WAL-visible logical state, including vectors, lifecycle, edges, hashes, graph, FTS, and metadata; same-source/provider rebuilds also compare every retained vector with the newly embedded candidate. SQLite writer fences cover source snapshotting and the final manifest rename; staged and final manifest bytes/identity are checked through durability confirmation. A source-ahead/stale index is never relabeled as safe; a divergent legacy `memory.db` remains byte-for-byte in place but is not advertised as rollback. The lower-level `memory-bujo rebuild|rollback <root> --tier <lite|journal|bujo>` commands are for already-managed roots; they deliberately refuse to infer tier identity or perform the first activation.

## Public API

- `@mono-agent/memory/store`: `openMemoryDb`, `MemoryDb`, `DEFAULT_VEC_DIM`, `MEMORY_TYPES`, `MEMORY_STATUSES`, local record/entity/recall/stats/audit types, and re-exported `MemoryBlock`, `MemoryLoadOptions`, `MemoryStore`, `MemoryWriteResult`
- `@mono-agent/memory/search`: `createEmbeddingProvider`, `createCircuitBreakerEmbeddingProvider`, `createVectorMemoryIndex`, `gatherMemoryChunks`, embedding/search provider classes and types
- `@mono-agent/memory/bujo`: `createBujoMemoryStore`, `BujoMemoryStore`, `composeRecallBlock`, `safeRebuildMemoryIndex`, `rollbackMemoryIndex`, `resolveActiveMemoryDbPath`, managed-generation helpers, privacy-safe runtime-snapshot reader/types, markdown grammar helpers, batched capture/reconcile/reflection/migration helpers, `createOllamaLlm`, and related BuJo/LLM types
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
