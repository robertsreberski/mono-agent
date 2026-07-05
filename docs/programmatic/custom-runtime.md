---
title: "Custom runtimes"
sidebar:
  order: 7
---

This page covers swapping the model runtime itself. Four backends are config-driven through `runtime.model` (Claude SDK, Claude Code CLI, Codex app CLI, Pi SDK providers — see [Backends](/runtime/backends/)). Anything else — a bespoke provider, a proxy that enforces routing policy, a deterministic fake for tests — is a **code** capability: implement the runtime contract and inject it.

## The MonoRuntimeLike contract

The typed facade lives in **`@mono-agent/runtime-adapter`**:

```ts
import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";
```

A `MonoRuntimeLike` runs one request and streams events back (assistant deltas, tool activity, the final message). The built-in `createMonoRuntime` from the same package is the reference implementation that fronts `@mono-agent/agent-runtime`'s multi-backend bridges; wrapping it (delegate + intercept) is usually easier than starting from scratch.

## Injecting the runtime

Both altitudes accept a `runtime`:

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";
import { myRuntime } from "./my-runtime.js";

// Full host: every channel runs through your runtime.
const app = await startMonoAgentApp({ cwd, configPath, runtime: myRuntime });
```

```ts
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";

// Bare responder (async — see Composition): you own the transport.
const responder = await createConfiguredAgentResponder({ config, runtime: myRuntime });
```

Notes:

- **Fallback models**: the configured fallback chain (`runtime.fallbackModels`) is applied by the built-in runtime's failover router. An injected runtime bypasses that wiring — your implementation owns retry/failover.
- **Memory LLM is separate**: the bujo memory LLM never rides the channel runtime (the channel fallback chain would override its model). `createConfiguredMemory` accepts its own `memoryRuntime` seam for tests.
- **Per-trigger model overrides** (`cron`/`webhook` `model`/`effort`) are resolved by the harness through `runtimeForModel`; a custom runtime that should honor them must be paired with a `runtimeForModel` factory on `createConfiguredAgentResponder`.

## Related pages

- [Backends](/runtime/backends/) — the four config-driven runtime backends and their routing.
- [Composition](/programmatic/composition/) — the entry points and the async composition note.
- [Fallback chain](/runtime/fallback/) — what the built-in failover router does.
