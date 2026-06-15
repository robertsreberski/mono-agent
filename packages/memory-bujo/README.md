# @mono-agent/memory-bujo

## Category

Category: `context`

## Responsibility

The Bullet-Journal memory engine. It owns the markdown bullet grammar (lossless
parse/serialize), writes daily files as the canonical source of truth, mirrors
them into the SQLite substrate (`@mono-agent/memory-store`), composes a curated
always-in-context recall block, and rebuilds the index from markdown with no LLM.
It implements the `MemoryStore` contract so agent hosts can adopt it as a drop-in
memory mode.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-bujo run build
node packages/memory-bujo/dist/cli.js rebuild ./memory
```

```ts
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import { createEmbeddingProvider } from "@mono-agent/memory-search";

const store = createBujoMemoryStore({
  root: "./memory",
  embeddings: createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text:v1.5" }),
  dim: 768,
});
const block = await store.load("global");
```

## Public API

- `createBujoMemoryStore`, `BujoMemoryStore`
- `parseBullet`, `serializeBullet`, `parseDailyFile`, `serializeDailyFile`
- `rebuildFromMarkdown`
- `Bullet`, `BujoOptions`

## Dependency Boundary

Depends on `@mono-agent/memory-store` (substrate), `@mono-agent/memory-search`
(embedding provider), and `@mono-agent/memory-md` (the `MemoryStore` contract). It
performs no LLM calls in Phase 1 — writes are deterministic rapid-log appends.

## What This Package Does Not Own

It does not own SQLite storage or ranking (that is `memory-store`), embedding
implementations (that is `memory-search`), entity extraction, reflection, or
migration scheduling (later phases).

## Verification

```bash
pnpm --filter @mono-agent/memory-bujo run build
pnpm --filter @mono-agent/memory-bujo run typecheck
pnpm --filter @mono-agent/memory-bujo run test
```
