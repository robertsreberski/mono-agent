# @mono-agent/memory-search

## Category

Category: `context`

## Responsibility

Local semantic search over memory. It embeds text with a pluggable
provider (Ollama `nomic-embed-text` by default, OpenAI as a fallback) and stores
vectors in a dependency-free JSON Lines index searched by brute-force cosine
similarity — fast and simple well under ~50k chunks, with no external vector
database or native build. It also gathers indexable chunks from the journal
archive and an entity snapshot.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-search run build
```

```ts
import { createEmbeddingProvider, createVectorMemoryIndex, gatherMemoryChunks } from "@mono-agent/memory-search";

const embeddings = createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text" });
const index = createVectorMemoryIndex({ path: "./.mono-agent/memory/index/embeddings.jsonl", embeddings });
await index.rebuild(await gatherMemoryChunks("./.mono-agent/memory", entities));
const hits = await index.search("what did we decide about pricing?");
```

## Public API

- `createEmbeddingProvider`, `OllamaEmbeddingProvider`, `OpenAIEmbeddingProvider`
- `createVectorMemoryIndex`, `VectorMemoryIndex`
- `gatherMemoryChunks`
- `MemorySearchError`
- `EmbeddingProvider`, `EmbeddingProviderConfig`, `MemoryChunk`, `SearchHit`, `VectorMemoryIndexOptions`, `EntityLike`, `MemorySearchErrorCode`

## Dependency Boundary

This package depends only on the local filesystem and the Fetch API (for the
embedding service). It has no other runtime dependencies and no native build. The
caller decides when to rebuild the index (typically the nightly consolidation job).

## What This Package Does Not Own

It does not own the journal or graph storage, does not extract entities, does not
schedule consolidation, and does not expose MCP tools. It only embeds, indexes, and
ranks. Keyword fallback lives in `@mono-agent/memory-mcp`.

## Verification

```bash
pnpm --filter @mono-agent/memory-search run build
pnpm --filter @mono-agent/memory-search run typecheck
pnpm --filter @mono-agent/memory-search run test
```
