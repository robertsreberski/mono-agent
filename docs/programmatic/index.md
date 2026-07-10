---
title: "Programmatic"
sidebar:
  order: 0
---

# Programmatic

This section covers the **code escape hatches** for when `mono-agent.config.json` and the `mono-agent` CLI cannot express the host you need. Everything here is **code** coverage: you import `@mono-agent/*` packages and compose a host yourself. If a behavior is already reachable through config, prefer that — see [Config](/config/) and the [Feature Matrix](/reference/feature-matrix/) for the config/cli/auto/code/dev split.

Most agents never need this section. The config-first host (`@mono-agent/agent-app`) loads your config, builds the responder, and drives every configured channel, memory consolidation, and observability exporter for you. Reach below it only when you need a custom driver set, a request-scoped runtime tweak, or a bare responder embedded in your own process.

## Three entry points, three altitudes

| Altitude | Package | Entry point | Use when |
| --- | --- | --- | --- |
| App (default) | `@mono-agent/agent-app` | `startMonoAgentApp({ cwd, configPath, drivers, runtime })` | You want the full config-first host but need to override the channel driver set, inject a runtime, or embed it in a larger process. |
| Responder | `@mono-agent/agent-app` | `createConfiguredAgentResponder({ config, memory, historyStore, runtimeOptions, runtimeOptionsForRequest })` | You want config-driven runtime/harness/memory composition but you own the transport (your own server, queue, or test harness). |
| Bare | `@mono-agent/agent-app` + `@mono-agent/config` | `loadMonoAgentConfigWithSources(...)` → `createConfiguredAgentResponder({ config })` | You want the smallest possible responder from a loaded config, with no channels, scheduler, or exporters wired up. |

All three still read the same `MonoAgentConfig`. The escape hatch is in *composition and request handling*, not in re-implementing runtime, prompt assembly, or memory.

## `startMonoAgentApp` — the full host, your way

`startMonoAgentApp` is the same host the CLI's `mono-agent start` runs. Called with no options it resolves `mono-agent.config.json` from `cwd`, starts traceability, then the core built-in channels plus any configured `channels.plugins[]` packages in parallel.

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({ cwd: process.cwd() });
// ... later
await app.stop();
```

The options that make this an escape hatch:

| Option | Type | Effect |
| --- | --- | --- |
| `cwd` | `string` | Root for resolving `configPath` and relative config paths. Defaults to `process.cwd()`. |
| `configPath` | `string` | Path to the config file; defaults to `<cwd>/mono-agent.config.json`. |
| `drivers` | `readonly ChannelDriver[]` | The channel drivers to run. Defaults to core built-ins plus configured `channels.plugins[]` packages. Pass a subset to run, say, only Telegram and Cron. |
| `runtime` | `MonoRuntimeLike` | A shared runtime override (testing or advanced composition). When omitted the host builds the runtime from `runtime.model` plus canonical `runtime.fallbacks` (or legacy `fallbackModels`). |
| `env` | `Record<string, string \| undefined>` | Environment used for `MONO_AGENT_*` resolution; defaults to `process.env`. |
| `logger` | `MonoAgentAppLogger` | Structured logger for channel/trace lifecycle. |

The returned `MonoAgentApp` exposes `channelStatus(id)`, `channelStatuses()`, `startChannelIfConfigured(id, reason)`, `traceabilityStatus`, `exporterStatus`, and `stop()`.

:::note
The host runs headless and config changes take effect on the next restart — there is no live re-apply. Restart the process (or your supervisor) to pick up edits.
:::

Channels with incomplete config report `waiting_for_config` instead of throwing, so a partial config still boots the channels that are ready. See [Channels](/channels/).

## `createConfiguredAgentResponder` — bring your own transport

When you own the transport but still want config-driven runtime, harness, and memory, build a responder directly with `@mono-agent/agent-app`. This is the layer `agent-app` itself calls internally.

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = await createConfiguredAgentResponder({ config });
const result = await responder.respond({ conversationId: "demo", text: "hello" });
```

Notable options on `createConfiguredAgentResponder`:

| Option | Type | Effect |
| --- | --- | --- |
| `config` | `MonoAgentConfig` | Required. Drives runtime model, tools, memory, artifacts, traceability. |
| `runtime` | `MonoRuntimeLike` | Shared runtime override; otherwise built from config. |
| `memory` | `MemoryStore` | Inject a pre-built memory store instead of letting the host build one from `config.memory`. See [Capture and Recall](/memory/capture-and-recall/). |
| `historyStore` | `ConversationHistoryStore` | Persist conversation history yourself (e.g. Redis) instead of the bounded default in-memory store. |
| `runtimeOptions` | static runtime options | Static per-harness runtime options merged on every turn. |
| `runtimeOptionsForRequest` | `(input) => extension \| Promise<extension>` | Compute **request-scoped** runtime options (extra tools, metadata) per turn from the request and `runId`. Configured memory adds `MemoryRecall` automatically and composes it with this callback; `agent-app` also uses the callback for adapter send-tools. |

:::tip
`runtimeOptionsForRequest` returns an *extension* that is composed onto the static options — it does not replace them. Use it for per-request decisions (which tools this caller may use, request metadata for proactive notify) rather than for static policy, which belongs in config under [Tool Policy](/tools/policy/).
:::

Session rollover (`runtime.session.rollover` / `runtime.session.rolloverTimezone`) is honored automatically by the responder. See [Sessions and Concurrency](/runtime/sessions-concurrency/).

## A bare responder — `@mono-agent/agent-app` + `@mono-agent/config`

The minimal local host is just two packages: load a config, build a responder. No channels, no scheduler, no exporters.

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

This corresponds to the **Core Join** in the package map: `agent-contracts` (request/response shape), `config` (settings), `runtime-adapter` (model refs and execution-mode validation), and `agent-app` (turns config into a responder). For finer control of runtime, memory, history, recorder, or request-scoped options, drop to `@mono-agent/agent-harness` directly — that is the **Execution Join** and is fully code-only.

:::note
`MONO_AGENT_*` environment variables still apply: the same env that overrides config for the CLI host overrides it here, because `loadMonoAgentConfigWithSources` reads `env`. See [Environment Variables](/config/env-vars/).
:::

## In this section

- [Composition](/programmatic/composition/) — package joins, the smallest set per host, and what each layer owns vs. does not own.
- [Approval and Structured Output](/programmatic/approval-and-structured-output/) — gating tool calls and returning typed results from a responder.
- [Multi-Agent](/programmatic/multi-agent/) — `@mono-agent/agent-orchestrator`: one runtime calling named collaborator responders through a bounded MCP tool.
- [A2A Consumer](/programmatic/a2a-consumer/) — calling another agent's Agent Card from your host with `@mono-agent/a2a-adapter`.
- [Write your own channel adapter](/programmatic/custom-channels/) — writing a `ChannelDriver` package or composing an edge adapter directly to feed your own transport into a responder.
