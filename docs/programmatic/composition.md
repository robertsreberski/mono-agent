---
title: "Composition & custom runtimes"
sidebar:
  order: 1
---

# Composition & custom runtimes

This page covers the three programmatic entry points that the `mono-agent` CLI itself is built on — `startMonoAgentApp` (full host with channels), `createConfiguredAgentResponder` (bare responder, no transports), and the lower-level `@mono-agent/agent-harness` — plus how to inject a custom runtime, add a channel driver, and scope runtime options per request. Reach for these only when `mono-agent.config.json` cannot express your host; the config covers nearly everything (see [feature coverage](/reference/feature-matrix/)). This whole surface is **code**-coverage: it is not reachable from config or the CLI.

## Choosing an entry point

| Entry point | Package | You get | Use when |
| --- | --- | --- | --- |
| `startMonoAgentApp` | `@mono-agent/agent-app` | Config load + responder + every configured channel + traceability + exporters | You want a CLI-equivalent host, optionally with extra channel drivers or a shared runtime |
| `createConfiguredAgentResponder` | `@mono-agent/agent-app` | A bare `AgentResponder` built from `MonoAgentConfig` (no transports) | You embed the responder in your own server, test harness, or custom transport |
| `createAgentHarness` / `createAgentResponder` | `@mono-agent/agent-harness` | Full manual control of identity, skills, memory, history, recorder, runtime | Config-driven composition is not enough and you assemble every dependency yourself |

The layering is strict: `agent-app` owns config-driven composition and delegates turn execution to `agent-harness`. Drop down only one level at a time. See [package map](/programmatic/) and the [programmatic index](/programmatic/) for the broader package set.

## The full host: `startMonoAgentApp`

`startMonoAgentApp` is what the CLI's `mono-agent start` runs. It loads `mono-agent.config.json` from `cwd`, builds the responder through app-owned configured composition, and starts traceability, observability exporters, every configured channel, and memory rituals.

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({ cwd: process.cwd() });
// ... later
await app.stop();
```

`MonoAgentAppOptions` fields:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `cwd` | `string` | `process.cwd()` | Folder the config and relative paths resolve against |
| `configPath` | `string` | `<cwd>/mono-agent.config.json` | Path to the config file |
| `env` | `Record<string, string \| undefined>` | `process.env` | Source for `MONO_AGENT_*` overrides |
| `drivers` | `readonly ChannelDriver[]` | `defaultChannelDrivers()` | Which channels to run (see below) |
| `runtime` | `MonoRuntimeLike` | built from config | Inject a shared/custom runtime (see below) |
| `logger` | `MonoAgentAppLogger` | console-backed | Structured host logging |

The host runs headless: config changes take effect on the next restart, not live.

### Adding a custom channel driver

`defaultChannelDrivers()` returns every built-in channel driver (Telegram, Slack, A2A, webhook, OpenAI API, cron, WhatsApp) in startup/status order. Spread it and append your own driver — or pass per-channel overrides for message texts and stream tuning, which are driver-level, not config keys.

```ts
import { startMonoAgentApp, defaultChannelDrivers } from "@mono-agent/agent-app";
import { myCustomDriver } from "./my-driver.js";

const app = await startMonoAgentApp({
  cwd: process.cwd(),
  drivers: [...defaultChannelDrivers(), myCustomDriver],
});
```

For building the driver itself, see [custom channels](/programmatic/custom-channels/).

## The bare responder: `createConfiguredAgentResponder`

When you do not want any built-in transport — you are embedding the agent in your own HTTP server, queue worker, or test — combine `@mono-agent/config` with `@mono-agent/agent-app`. `createConfiguredAgentResponder` turns a loaded `MonoAgentConfig` into a ready `AgentResponder`. It is **async** (as is `createConfiguredAgentHarness`/`createConfiguredMemory`): memory backends are imported lazily, so a config without a `memory` section never loads the SQLite/BuJo stack and a Supermemory config never loads it either.

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = await createConfiguredAgentResponder({ config });
```

`ConfiguredAgentResponderOptions` (a superset of `ConfiguredAgentHarnessOptions`) lets you override the dependencies the config would otherwise build:

| Option | Type | Purpose |
| --- | --- | --- |
| `config` | `MonoAgentConfig` | **Required.** The loaded config |
| `runtime` | `MonoRuntimeLike` | Inject a custom or shared runtime instead of building one from `runtime.model` |
| `model` / `executionMode` | `RuntimeModelReference` / `string` | Override the config's primary model / execution mode |
| `memory` | `MemoryStore` | Supply a memory store instead of provisioning from `config.memory` |
| `historyStore` | `ConversationHistoryStore` | Plug in durable conversation history (default is an in-memory store sized from `runtime.maxTurns`) |
| `runtimeOptions` | static run options | Extra runtime options merged for every run (no `model`/`messages`/`abortSignal`/`executionMode`/`onEvent`) |
| `runtimeOptionsForRequest` | `(input) => extension` | Per-request run options (see below) |

`createConfiguredAgentRuntime(config)` and `createConfiguredAgentHarness(options)` are also exported if you want the runtime or harness without the responder wrapper.

## Injecting a custom runtime (`MonoRuntimeLike`)

Both `startMonoAgentApp` and the configured responder factories accept a `runtime?: MonoRuntimeLike` from `@mono-agent/runtime-adapter`. Pass one to share a single runtime across hosts, point at an unsupported backend, or stub the provider in tests. When omitted, the runtime is built from `config.runtime.model` (plus any `runtime.fallbackModels`).

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";
import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";

const myRuntime: MonoRuntimeLike = createMyRuntime();

const app = await startMonoAgentApp({ cwd: process.cwd(), runtime: myRuntime });
```

:::caution
A custom runtime fully replaces model selection, so config keys like `runtime.model`, `runtime.executionMode`, and `runtime.fallbackModels` no longer drive provider behavior — your runtime owns that. For the built-in runtime's model refs, execution modes, and fallback chain, see [backends](/runtime/backends/) and [fallback](/runtime/fallback/).
:::

## Per-request runtime options (`runtimeOptionsForRequest`)

`runtimeOptionsForRequest` is a callback invoked once per turn to compute run options scoped to that request. The app uses it internally to attach the per-turn `memory_recall` and adapter send tools; you can supply your own to vary tools, system context, or other run options per request.

```ts
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";
import type {
  AgentHarnessRuntimeOptionsInput,
  AgentHarnessRuntimeOptionsExtension,
} from "@mono-agent/agent-harness";

const responder = await createConfiguredAgentResponder({
  config,
  runtimeOptionsForRequest: async (
    input: AgentHarnessRuntimeOptionsInput,
  ): Promise<AgentHarnessRuntimeOptionsExtension> => {
    // input: { request, runId, context }
    return {
      runtimeOptions: { /* per-run options, e.g. extra MCP servers */ },
      cleanup: async () => { /* release per-request resources */ },
    };
  },
});
```

The callback receives `{ request, runId, context }` (the inbound request, the run id, and the already-built `BuiltAgentContext`). It returns a `runtimeOptions` object — the same shape as static `runtimeOptions`, so it cannot set `model`, `messages`, `abortSignal`, `executionMode`, or `onEvent` — plus an optional `cleanup` hook.

:::note
Request-scoped options apply at the harness **run boundary**: they are resolved after context assembly and merged just before the provider call, then `cleanup` runs when the turn finishes. They cannot change model or execution mode (those are fixed per harness); use a custom runtime or separate harnesses for that.
:::

## Dropping to the harness

`createConfiguredAgentResponder` will not cover hosts that need a custom recorder, a non-config identity/skill loading scheme, or hand-assembled memory and history. In those cases call `@mono-agent/agent-harness` directly. The harness owns loading identity/SOUL and selected skill bodies, reading memory blocks, invoking the runtime, recording run events, appending conversation history, and returning explicit failure objects instead of fake success.

Selected skills are never auto-selected by description — the host passes `selectedSkills` (or `config.context.selectedSkills`) and the harness loads exactly those bodies. For tool/MCP policy, build a fail-closed policy with `@mono-agent/agent-harness` (`createToolPolicy`) rather than granting broad access; see [tool policy](/tools/policy/) and [MCP](/tools/mcp/).

For multi-agent orchestration on top of these primitives, see [multi-agent](/programmatic/multi-agent/); for consuming a remote agent over A2A, see [A2A consumer](/programmatic/a2a-consumer/).
