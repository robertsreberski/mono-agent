# @mono-agent/memory-bujo

## Category

Category: `context`

## Responsibility

The Bullet-Journal memory engine. It owns the markdown bullet grammar (parse/serialize
round-trip), writes daily files as the canonical source of truth, upserts the SQLite
index via `@mono-agent/memory-store`, composes curated recall blocks, and exposes a
`rebuild` entrypoint that reconstructs `memory.db` from markdown deterministically.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-bujo run build
```

## Public API

- `BujoMemoryStore` — implements the `MemoryStore` contract over the SQLite substrate
- `rebuildFromMarkdown(root, db)` — no LLM; reconstructs the index from markdown
- `parseBullet`, `serializeBullet`, `parseDailyFile`, `serializeDailyFile`

## Dependency Boundary

Depends on `@mono-agent/memory-store` and `@mono-agent/memory-md` (for the
`MemoryStore` interface). Does not perform LLM calls. Markdown files are canonical;
`memory.db` is disposable and always rebuildable.

## What This Package Does Not Own

It does not own the SQLite schema, vector retrieval, embedding, entity extraction,
MCP tools, or config schema. Storage + retrieval lives in `@mono-agent/memory-store`.

## Verification

```bash
pnpm --filter @mono-agent/memory-bujo run build
pnpm --filter @mono-agent/memory-bujo run typecheck
pnpm --filter @mono-agent/memory-bujo run test
```
