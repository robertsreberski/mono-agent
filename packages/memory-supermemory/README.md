# @mono-agent/memory-supermemory

A `MemoryStore` (from `@mono-agent/memory-store`) backed by an external [Supermemory](https://supermemory.ai) instance — a local OSS binary (`supermemory-server`, MIT) or the hosted cloud. Selected via `config.memory.backend: "supermemory"`; the built-in BuJo engine remains the default.

Supermemory extracts and consolidates memories **server-side**, so this backend needs no embeddings model and no memory chat LLM — the adapter just posts turns and searches.

## What it does

- `load(query)` → `POST /v4/search` (falls back to legacy `/v3/search`), formats ranked hits into a markdown block, capped at `maxBytes`. Degrades to `undefined` on any error — recall never fails a turn.
- `appendHostSummary(summary)` → `POST /v3/documents` (one line, idempotent `customId`). Never throws.
- `scheduleCapture(text)` → async `POST /v3/documents` (full turn, server-side extraction), serialized + fire-and-forget.
- `recall(query)` → search hits shaped for the in-app `memory_recall` MCP tool.

Ingestion is asynchronous (the server returns `status: "queued"`), so a just-captured turn is not immediately searchable.

## Usage

```ts
import { createSupermemoryStore } from "@mono-agent/memory-supermemory";

const store = createSupermemoryStore({
  baseUrl: "http://127.0.0.1:6767", // local binary; or https://api.supermemory.ai for cloud
  apiKey: process.env.SUPERMEMORY_API_KEY, // optional; omit for a keyless local instance
  container: "my-agent",            // namespace tag scoping all add + search
  maxBytes: 64_000,
});
```

The client uses raw `fetch` behind an injectable seam (`SupermemoryFetch`), so the store is fully unit-testable without a network or the Supermemory SDK.
