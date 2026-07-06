---
title: "Custom memory backends"
sidebar:
  order: 6
---

This page covers plugging your own memory backend into the agent. Two built-in backends are config-driven (`memory.backend: "bujo"` — the default local SQLite/BuJo stack — and `"supermemory"`; see [Backends comparison](/memory/backends-comparison/)). Anything else — a vector database, your company's knowledge service, a plain key-value store — is a **code** capability: implement the `MemoryStore` contract and inject it programmatically.

## The MemoryStore contract

The contract lives in **`@mono-agent/agent-contracts`**. You only need its types:

```ts
import type { MemoryStore } from "@mono-agent/agent-contracts";
```

`MemoryStore` is structural: implement the recall/capture/lifecycle methods your backend supports. The harness treats memory as best-effort — a failing `recall` degrades to an empty result (with a `memory_degraded` diagnostic) rather than failing the turn, and `capture` runs after the reply, so a slow backend never blocks the user.

The two built-in stores are reference implementations: `@mono-agent/memory/bujo` (`createBujoMemoryStore`) for the local tiered store, and `@mono-agent/memory-supermemory` (`createSupermemoryStore`) for a REST-backed external service — the latter is the best template for wrapping your own remote API.

## Injecting the store

Pass your store to the composition layer via the `memory` option — it wins over anything `config.memory` would build, and `config.memory` may be omitted entirely:

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";
import { myVectorStore } from "./my-vector-store.js";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "mono-agent.config.json",
});

// Note the await: the configured composition functions are async because
// built-in memory backends load lazily (an agent that injects its own store
// never loads the SQLite/BuJo stack or the Supermemory client).
const responder = await createConfiguredAgentResponder({
  config,
  memory: myVectorStore,
});
```

The same `memory` option exists on `createConfiguredAgentHarness`. When running the full host, build the responder yourself and hand your channel drivers to `startMonoAgentApp` — or run transports directly against the responder (see [Composition](/programmatic/composition/)).

## What the host does with the store

- **Recall**: before each turn, recalled entries are appended to the user message (not the system prompt), so they survive provider session resume. The auto-provisioned `memory_recall` tool serves on-demand recall from the same config.
- **Capture**: gated by `memory.writeMode` (`disabled` / `append-host-summary` / `capture`). Your store's capture method is only called when the mode allows writes.
- **Consolidation**: the in-app scheduler only schedules `consolidate()` for stores that report the `bujo` tier — a custom store without that lifecycle method is simply left alone.

## When to prefer which path

| Situation | Path |
| --- | --- |
| Local memory, no infra | `memory.mode: lite\|journal\|bujo` (config only) |
| Managed external memory service with a mono-agent integration | `memory.backend: "supermemory"` (config only) |
| Your own backend/service | Implement `MemoryStore`, inject via `createConfiguredAgentResponder({ memory })` |

## Related pages

- [Backends comparison](/memory/backends-comparison/) — bujo vs supermemory trade-offs.
- [Capture and recall](/memory/capture-and-recall/) — how the host reads/writes memory each turn.
- [Composition](/programmatic/composition/) — the programmatic entry points this page builds on.
