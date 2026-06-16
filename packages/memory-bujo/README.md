# @mono-agent/memory-bujo

## Category

Category: `context`

## Responsibility

The Bullet-Journal memory engine. It owns the markdown bullet grammar (lossless
parse/serialize), writes daily files as the canonical source of truth, mirrors
them into the SQLite substrate (`@mono-agent/memory-store`), composes a curated
always-in-context recall block, and rebuilds the index from markdown with no LLM.
In the `bujo` tier it also owns the LLM-driven capture pipeline (distill →
reconcile → entity/relation extraction into `graph.jsonl`) and the reflection /
migration rituals. It implements the `MemoryStore` contract so agent hosts can
adopt it as a drop-in memory mode.

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

Standalone CLI commands that need an LLM (`reflect`, `migrate`) are Ollama-only:

```bash
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest \
node packages/memory-bujo/dist/cli.js reflect ./memory
```

## Public API

- `createBujoMemoryStore`, `BujoMemoryStore`
- `parseBullet`, `serializeBullet`, `parseDailyFile`, `serializeDailyFile`
- `appendBullet`, `dailyFilePath`, `createIdFactory`, `composeRecallBlock`
- `rebuildFromMarkdown`
- Capture (bujo tier): `captureTurn`, `distill`, `reconcile`, `extractEntities`, `readGraph`
- Rituals (bujo tier): `reflect`, `migrate`, `writeIndex`, `writeFutureLog`
- Built-in LLM adapter: `createOllamaLlm`
- `Bullet`, `BujoOptions`, `BujoTier`, `LlmComplete`, `CandidateMemory`, `ReconcileAction`, `ReconcileDeps`

## Dependency Boundary

Depends on `@mono-agent/memory-store` (SQLite substrate + `MemoryStore` contract) and
`@mono-agent/memory-search` (embedding provider). It performs no LLM calls in the
lite/journal tiers — writes are deterministic rapid-log appends. LLM calls happen
only in the `bujo` tier (capture + rituals) via the injected `LlmComplete`.

The core package only receives `llm?: LlmComplete`; it does not parse provider
names, model references, or app config such as `memory.llm`. Hosts may adapt any
runtime model to `LlmComplete` before calling `createBujoMemoryStore`, but that
adapter is outside this package.

The built-in adapter is `createOllamaLlm`, and the standalone `memory-bujo` CLI
uses that adapter directly. Both are Ollama-only: `MONO_AGENT_MEMORY_LLM_MODEL`
is a local Ollama chat model string, and `MONO_AGENT_MEMORY_LLM_ENDPOINT` is an
optional Ollama endpoint.

## What This Package Does Not Own

It does not own SQLite storage or ranking (that is `memory-store`) or embedding
implementations (that is `memory-search`). It defines the entity-extraction,
reflection, and migration *logic*, but the in-app cron wiring that triggers
rituals on a schedule lives in `@mono-agent/agent-app` (`startMemoryRituals`).
App-level `memory.llm` provider routing also lives outside this package. In
particular, `memory.llm.provider: "agent-host"` and SDK runtime model references such
as `pi:openai-codex:gpt-5.5` belong to `@mono-agent/config` /
`@mono-agent/agent-host`; they should be documented and implemented there, then
injected here as an ordinary `LlmComplete`.

## Verification

```bash
pnpm --filter @mono-agent/memory-bujo run build
pnpm --filter @mono-agent/memory-bujo run typecheck
pnpm --filter @mono-agent/memory-bujo run test
```
