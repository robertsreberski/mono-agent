# @mono-agent/memory-supermemory

## Category

Category: `context`

Plugin tier: this package is released in the mono-agent lockstep, but is not
installed with `@mono-agent/agent-app`; the operator installs and selects it explicitly.

## Responsibility

Provides a `MemoryStore` (from `@mono-agent/agent-contracts`) backed by an external
[Supermemory](https://supermemory.ai) instance — a local OSS binary
(`supermemory-server`, MIT) or the hosted cloud — reached over its REST API. Selected via
`config.memory.backend: "supermemory"`; the built-in BuJo engine remains the default.
Supermemory extracts and consolidates memories **server-side**, so this backend needs no
embeddings model and no memory chat LLM — the adapter just posts turns and searches.

## Install / Usage

```bash
npm install @mono-agent/memory-supermemory@<matching-mono-agent-version>
```

The package also ships `skills/mono-agent-supermemory/SKILL.md`, which guides a
local configuration agent through service selection, privacy disclosure,
validation, and a real recall smoke test. Installing the package never enables
the backend by itself; `memory.backend: "supermemory"` remains the explicit opt-in.
There is deliberately no separate plugin-preset loader: an installed plugin is
offered by the normal wizard, while the skill owns later configuration changes.

```ts
import { createSupermemoryStore } from "@mono-agent/memory-supermemory";

const store = createSupermemoryStore({
  baseUrl: "http://127.0.0.1:6767", // local binary; or https://api.supermemory.ai for cloud
  apiKey: process.env.SUPERMEMORY_API_KEY, // optional; omit for a keyless local instance
  container: "my-agent",            // namespace tag scoping every add + search
  maxBytes: 64_000,
});

await store.persistCompletedTurn({
  runId: "run-018f...",
  conversationId: "conv-1",
  summary: "User prefers dark mode.",
  captureText: "User: Use dark mode.\nAssistant: Done.",
});
const block = await store.load("conv-1", "preferences");
```

- `load(query)` → `POST /v4/search` (cached `/v3` fallback), formats ranked hits into a
  markdown block capped at `maxBytes`. Degrades to `undefined` on any error.
- `persistCompletedTurn` → one awaited `POST /v3/documents` containing the deterministic
  summary and optional full capture text. A SHA-256-derived custom id keyed only by `runId`
  keeps remote retries on one logical upsert. During one store lifetime an exact retry returns
  as a duplicate without another request, while conflicting reuse of a run id fails before a
  request. That exact lifetime check retains only two SHA-256 digests per distinct run—never raw
  run ids, conversation ids, or turn content. After a process restart the remote API does not
  expose enough conditional/read state
  to distinguish a new document from a retry. Success returns the stable custom id after remote
  admission, while any failure emits a constant content-free warning and is thrown so the harness
  can report degradation. Raw run and
  conversation ids are not placed in remote metadata. Documents over 1,000,000 bytes are
  rejected rather than partially captured.
- Legacy `appendHostSummary` / `scheduleCapture` remain compatible best-effort writes (one-liner /
  full turn, async server-side extraction) and never throw. The harness does not call them when
  the strong method is present.
- `recall(query)` → hits shaped for the in-app `MemoryRecall` MCP tool.

## Public API

- `createSupermemoryStore`, `SupermemoryMemoryStore`
- `validateSupermemoryConfig`, `SupermemoryConfigValidation`
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
`MemoryRecall` tool wiring; both are resolved in `@mono-agent/agent-app`. It also does not own
the Supermemory service itself (extraction, consolidation, and storage all happen
server-side). It does not run BuJo scheduled consolidation and ignores `mode`/`embeddings`/`llm`.

## Verification

```bash
pnpm --filter @mono-agent/memory-supermemory run build
pnpm --filter @mono-agent/memory-supermemory run typecheck
pnpm --filter @mono-agent/memory-supermemory run test
```

A gated real-instance round-trip runs when `MONO_AGENT_TEST_SUPERMEMORY_BASE_URL` points
at a running Supermemory instance (skipped otherwise). To require and run the
package-owned, data-writing smoke explicitly:

```bash
MONO_AGENT_TEST_SUPERMEMORY_BASE_URL=http://127.0.0.1:6767 \
  pnpm --filter @mono-agent/memory-supermemory run smoke
```
