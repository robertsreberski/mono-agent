# @mono-agent/agent-host

## Category

Category: `execution`

## Responsibility

Adapter-neutral host composition helpers for reusable agent hosts. This package turns a loaded `MonoAgentConfig` into a runtime-backed harness or structural responder without owning any communication adapter, operator surface, or host lifecycle.

## Install / Usage

```bash
pnpm --filter @mono-agent/agent-host run build
```

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-host";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = createConfiguredAgentResponder({ config });
```

Use the returned responder with Telegram, A2A, Slack, WhatsApp, a TUI, or any host-owned surface that speaks the shared `AgentResponder` contract.

When journal memory is configured with `memory.tools.enabled`, the host also
composes the memory MCP server into runtime options. It exposes recall tools by
default and exposes `journal_append` only when `memory.tools.allowJournalAppend`
is enabled.

## Public API

- `createConfiguredAgentRuntime`
- `createConfiguredAgentHarness`
- `createConfiguredAgentResponder`
- `ConfiguredAgentRuntimeOptions`
- `ConfiguredAgentHarnessOptions`
- `ConfiguredAgentResponderOptions`

## Dependency Boundary

This package may depend on execution, core, context, runtime, and observability packages. It must not depend on communication adapters or operator surfaces; hosts still compose those explicitly.

## What This Package Does Not Own

It does not poll chats, serve HTTP operator UI, host A2A, parse Telegram/Slack/WhatsApp settings, register trace sources, reload config, or manage deployment files.

## Verification

```bash
pnpm --filter @mono-agent/agent-host run build
pnpm --filter @mono-agent/agent-host run typecheck
pnpm --filter @mono-agent/agent-host run test
```
