# @mono-agent/memory-md

## Category

Category: `context`

## Responsibility

Optional Markdown memory store for agent hosts. It reads capped memory blocks and appends host-owned summaries to either one shared file or safe per-conversation files.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-md run build
```

```ts
import { createMarkdownMemoryStore } from "@mono-agent/memory-md";
```

## Public API

- `createMarkdownMemoryStore`, `MarkdownMemoryStore`
- `safeConversationFileName`
- `MarkdownMemoryError`
- `MemoryStore`, `MemoryBlock`, `MemoryWriteResult`, `MarkdownMemoryStoreOptions`

## Dependency Boundary

This package depends only on local filesystem behavior. It is optional and host-wired; the harness can run without memory.

## What This Package Does Not Own

It does not summarize conversations, decide what should be remembered, call a model, expose a database, or rewrite memory autonomously.

## Verification

```bash
pnpm --filter @mono-agent/memory-md run build
pnpm --filter @mono-agent/memory-md run typecheck
pnpm --filter @mono-agent/memory-md run test
```
