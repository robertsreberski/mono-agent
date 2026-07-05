# @mono-agent/memory-supermemory

## Category

Category: `context`

## Responsibility

Provides a `MemoryStore` (from `@mono-agent/agent-contracts`) backed by an external
[Supermemory](https://supermemory.ai) instance — a local OSS binary
(`supermemory-server`, MIT) or the hosted cloud — reached over its REST API. Selected via
`config.memory.backend: "supermemory"`; the built-in BuJo engine remains the default.
Supermemory extracts and consolidates memories **server-side**, so this backend needs no
embeddings model and no memory chat LLM — the adapter just posts turns and searches.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-supermemory run build
```

```ts
import { createSupermemoryStore } from "@mono-agent/memory-supermemory";

const store = createSupermemoryStore({
  baseUrl: "http://127.0.0.1:6767", // local binary; or https://api.supermemory.ai for cloud
  apiKey: process.env.SUPERMEMORY_API_KEY, // optional; omit for a keyless local instance
  container: "my-agent",            // namespace tag scoping every add + search
  maxBytes: 64_000,
});

await store.appendHostSummary("conv-1", "User prefers dark mode.");
const block = await store.load("conv-1", "preferences");
```

- `load(query)` → `POST /v4/search` (cached `/v3` fallback), formats ranked hits into a
  markdown block capped at `maxBytes`. Degrades to `undefined` on any error.
- `appendHostSummary` / `scheduleCapture` → `POST /v3/documents` (one-liner / full turn,
  async server-side extraction). Writes never throw.
- `recall(query)` → hits shaped for the in-app `memory_recall` MCP tool.

## Public API

- `createSupermemoryStore`, `SupermemoryMemoryStore`
- `createSupermemoryHttpClient`
- `formatHitsAsBlock`, `SUPERMEMORY_SOURCE`
- `CreateSupermemoryStoreConfig`, `SupermemoryStoreOptions`, `SupermemoryRecallHit`
- `SupermemoryClient`, `SupermemoryHttpClientConfig`, `SupermemoryAddParams`,
  `SupermemorySearchParams`, `SupermemoryHit`, `SupermemoryMetadataValue`,
  `SupermemorySearchMode`, `SupermemoryFetch`, `SupermemoryFetchResponse`

## Dependency Boundary

Depends only on `@mono-agent/agent-contracts` (for the `MemoryStore` contract types) and the
Fetch API. No native build, no SDK dependency — the REST client uses raw `fetch` behind an
injectable seam (`SupermemoryFetch`) so the store is fully unit-testable without a network.

## What This Package Does Not Own

It does not own backend selection (that is `config.memory.backend`) or the
`memory_recall` tool wiring; both are resolved in `@mono-agent/agent-app`. It also does not own
the Supermemory service itself (extraction, consolidation, and storage all happen
server-side). It does not run BuJo rituals and ignores `mode`/`embeddings`/`llm`.

## Verification

```bash
pnpm --filter @mono-agent/memory-supermemory run build
pnpm --filter @mono-agent/memory-supermemory run typecheck
pnpm --filter @mono-agent/memory-supermemory run test
```

A gated real-instance round-trip runs when `MONO_AGENT_TEST_SUPERMEMORY_BASE_URL` points
at a running Supermemory instance (skipped otherwise).
