# @worklab-ai/memory-journal

## Category

Category: `context`

## Responsibility

Global daily-journal memory store for Mono Agent hosts. It implements the
`@worklab-ai/memory-md` `MemoryStore` contract so it drops into the harness
unchanged: `load()` returns today's daily note (capped, and optionally prefixed
with a long-term entity digest) for always-in-context recall, while
`appendHostSummary()` and `appendEntry()` continuously journal into
`<rootDir>/daily/<YYYY-MM-DD>.md`. It is a single global brain — the conversation
id is ignored for routing and only recorded inside entries for provenance.

## Install / Usage

```bash
pnpm --filter @worklab-ai/memory-journal run build
```

```ts
import { createJournalMemoryStore } from "@worklab-ai/memory-journal";

const memory = createJournalMemoryStore({ rootDir: "./.mono-agent/memory", maxBytes: 64_000 });
```

## Public API

- `createJournalMemoryStore`, `JournalMemoryStore`
- `journalDayFor`
- `JournalMemoryError`
- `JournalMemoryStoreOptions`, `EntityDigestProvider`, `JournalMemoryErrorCode`

## Dependency Boundary

This package depends only on the local filesystem and on `@worklab-ai/memory-md`
for the shared `MemoryStore` contract types. It is optional and host-wired; the
harness can run without memory. The entity digest is supplied by the host as a
callback, so this package never reaches into the entity graph or search index
directly.

## What This Package Does Not Own

It does not build the entity graph, run semantic search, summarize conversations,
call a model, decide what is worth remembering, or expose any MCP tools. Those are
owned by `@worklab-ai/memory-graph`, `@worklab-ai/memory-search`, and
`@worklab-ai/memory-mcp`.

## Verification

```bash
pnpm --filter @worklab-ai/memory-journal run build
pnpm --filter @worklab-ai/memory-journal run typecheck
pnpm --filter @worklab-ai/memory-journal run test
```
