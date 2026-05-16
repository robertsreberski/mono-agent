# @worklab-ai/runtime-adapter

## Category

Category: `runtime`

## Responsibility

Typed Mono Agent facade over `@worklab-ai/agent-runtime`. It parses runtime model references, selects or validates execution mode, exposes the available backend matrix, creates a runtime wrapper, and exposes a small structural runtime contract to the harness.

## Install / Usage

```bash
pnpm --filter @worklab-ai/runtime-adapter run build
```

```ts
import {
  createMonoRuntime,
  listMonoRuntimeBackends,
  parseMonoRuntimeModelReference,
} from "@worklab-ai/runtime-adapter";

const backends = listMonoRuntimeBackends();
```

## Public API

- `createMonoRuntime`
- `parseMonoRuntimeModelReference`, `assertParsedRuntimeModelReference`
- `defaultExecutionModeForModel`, `assertExecutionModeCompatible`, `isRuntimeExecutionMode`
- `listMonoRuntimeBackends`, `runtimeBackendForModel`, `describeMonoRuntimeSupport`
- `RuntimeAdapterError`
- Runtime backend, model, execution mode, message, event, tool, and result types

Supported backend seams are exposed as data:

| Backend | Model refs | Execution mode | Boundary |
| --- | --- | --- | --- |
| Claude SDK | `claude:<model>` | `sdk` | Claude SDK through `@worklab-ai/agent-runtime` |
| Claude Code CLI | `claude:<model>` | `cli` | Claude Code CLI bridge through `@worklab-ai/agent-runtime` |
| Codex app CLI | `codex:<model>` | `cli` | Codex app-server bridge through `@worklab-ai/agent-runtime` |
| Pi SDK provider | `pi:<provider>:<model>` | `sdk` | Pi SDK gateway, including provider ids such as `openai-codex` or Copilot-style provider ids |

## Dependency Boundary

This is the only package that depends on `@worklab-ai/agent-runtime`. Other packages consume its small `MonoRuntimeLike` interface and backend descriptors instead of importing provider/runtime internals.

## What This Package Does Not Own

It does not build prompts, manage memory, expose UI, poll communication channels, or persist observability artifacts.

## Verification

```bash
pnpm --filter @worklab-ai/runtime-adapter run build
pnpm --filter @worklab-ai/runtime-adapter run typecheck
pnpm --filter @worklab-ai/runtime-adapter run test
```
