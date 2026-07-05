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

## BuJo Memory LLM Providers

`agent-host` consumes the loaded `MonoAgentConfig` and composes memory for the harness; it does not parse channel settings, own channel lifecycle, or move BuJo internals out of `@mono-agent/memory/bujo`. For `memory.mode: "bujo"`, the optional `memory.llm` block selects how the host injects the `LlmComplete` used by BuJo capture, reflection, and migration.

Use `ollama` when BuJo memory should call a local Ollama model directly:

```json
{
  "memory": {
    "mode": "bujo",
    "path": ".mono-agent/memory",
    "llm": {
      "provider": "ollama",
      "model": "qwen3:8b",
      "endpoint": "http://localhost:11434"
    }
  }
}
```

The `endpoint` field is optional and applies only to the `ollama` provider.

Use `agent-host` when BuJo memory should run through the same configured runtime path as agent execution:

```json
{
  "memory": {
    "mode": "bujo",
    "path": ".mono-agent/memory",
    "llm": {
      "provider": "agent-host",
      "model": "pi:openai-codex:gpt-5.5",
      "executionMode": "sdk"
    }
  }
}
```

For `provider: "agent-host"`, `model` is a normal SDK runtime model reference parsed by `@mono-agent/config`, so values such as `pi:openai-codex:gpt-5.5` use the runtime adapter/provider configuration instead of an Ollama endpoint. CLI-backed refs such as `codex:gpt-5.5`, and explicit `executionMode: "cli"`, are rejected for memory LLMs until runtimes can enforce no external actions. `agent-host` turns that runtime path into the `LlmComplete` dependency that `@mono-agent/memory/bujo` needs; the BuJo subpath still owns the capture and ritual logic, and the standalone `memory-bujo` CLI remains Ollama-only.

When the host threads observability deps into `createConfiguredMemory` (the app does this automatically), `provider: "agent-host"` memory `complete()` calls are recorded through the **same** JSONL artifact + Phoenix exporter pipeline as channel runs — one run per call, with a `mem-*` run id and a per-ritual conversation id (`memory:capture:distill`, `memory:capture:reconcile`, `memory:capture:entities`, `memory:reflect`, `memory:migrate`). Set `"trace": false` on the `memory.llm` block to disable recording (default on). The `ollama` memory provider does not ride `runtime.run` and is not recorded.

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
