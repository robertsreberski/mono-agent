# @mono-agent/runtime-adapter

## Category

Category: `runtime`

## Responsibility

Typed Mono Agent facade over `@mono-agent/agent-runtime`. It parses runtime model references, selects or validates execution mode, exposes the available backend matrix, creates a runtime wrapper, and exposes a small structural runtime contract to the harness.

## Install / Usage

```bash
pnpm --filter @mono-agent/runtime-adapter run build
```

```ts
import {
  createMonoRuntime,
  listMonoRuntimeBackends,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";

const backends = listMonoRuntimeBackends();
```

## Public API

- `createMonoRuntime`
- `parseMonoRuntimeModelReference`, `assertParsedRuntimeModelReference`
- `defaultExecutionModeForModel`, `assertExecutionModeCompatible`, `isRuntimeExecutionMode`
- `listMonoRuntimeBackends`, `runtimeBackendForModel`, `describeMonoRuntimeSupport`
- `runtimeOptionsForLocalProvider`, `validateLocalProviderDefinition`, `isPrivateBaseUrl`
- `RuntimeAdapterError`
- Runtime backend, model, execution mode, message, event, tool, and result types
- Local provider types for Ollama, LM Studio, and OpenAI-compatible gateways

Supported backend seams are exposed as data:

| Backend | Model refs | Execution mode | Boundary |
| --- | --- | --- | --- |
| Claude SDK | `claude:<model>` | `sdk` | Claude SDK through `@mono-agent/agent-runtime` |
| Claude Code CLI | `claude:<model>` | `cli` | Claude Code CLI bridge through `@mono-agent/agent-runtime` |
| Codex app CLI | `codex:<model>` | `cli` | Codex app-server bridge through `@mono-agent/agent-runtime` |
| Pi SDK provider | `pi:<provider>:<model>` | `sdk` | Pi SDK gateway, including provider ids such as `openai-codex` or Copilot-style provider ids |

## Local Pi Providers

`runtimeOptionsForLocalProvider()` converts host config into the custom-provider context expected by `@mono-agent/agent-runtime`'s Pi adapter. It only returns options when the parsed model is `pi:<provider>:<model>` and `<provider>` matches a configured local provider. Built-in Pi providers such as `pi:openai-codex:gpt-5.5` return `{}`.

Ollama example:

```ts
import {
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
} from "@mono-agent/runtime-adapter";

const model = parseMonoRuntimeModelReference("pi:ollama:qwen3:8b");
const runtimeOptions = runtimeOptionsForLocalProvider(model, [
  {
    id: "ollama",
    type: "ollama",
    baseUrl: "http://localhost:11434",
    enabled: true,
    models: [
      { name: "qwen3:8b", capabilities: { context_window: 32768 } },
    ],
  },
]);
```

Private HTTP(S) URLs such as `localhost`, RFC1918 addresses, and Tailscale CGNAT addresses are allowed. Public hosts require `https://` plus `trustPublicUrl: true`; invalid local-provider config throws `RuntimeAdapterError` instead of falling back to a hosted provider.

## Dependency Boundary

This is the only package that depends on `@mono-agent/agent-runtime`. Other packages consume its small `MonoRuntimeLike` interface and backend descriptors instead of importing provider/runtime internals.

## What This Package Does Not Own

It does not build prompts, manage memory, expose UI, poll communication channels, or persist observability artifacts.

## Verification

```bash
pnpm --filter @mono-agent/runtime-adapter run build
pnpm --filter @mono-agent/runtime-adapter run typecheck
pnpm --filter @mono-agent/runtime-adapter run test
```
