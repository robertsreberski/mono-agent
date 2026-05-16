# @worklab-ai/runtime-adapter

## Responsibility

Typed Mono Agent facade over `@worklab-ai/agent-runtime`. It parses runtime model references, selects or validates execution mode, creates a runtime wrapper, and exposes a small structural runtime contract to the harness.

## Install / Usage

```bash
pnpm --filter @worklab-ai/runtime-adapter run build
```

```ts
import {
  createMonoRuntime,
  parseMonoRuntimeModelReference,
} from "@worklab-ai/runtime-adapter";
```

## Public API

- `createMonoRuntime`
- `parseMonoRuntimeModelReference`, `assertParsedRuntimeModelReference`
- `defaultExecutionModeForModel`, `assertExecutionModeCompatible`, `isRuntimeExecutionMode`
- `RuntimeAdapterError`
- Runtime model, execution mode, message, event, tool, and result types

## Dependency Boundary

This is the only package that depends on `@worklab-ai/agent-runtime`. Other packages consume its small `MonoRuntimeLike` interface instead of importing provider/runtime internals.

## What This Package Does Not Own

It does not build prompts, manage memory, expose UI, poll communication channels, or persist observability artifacts.

## Verification

```bash
pnpm --filter @worklab-ai/runtime-adapter run build
pnpm --filter @worklab-ai/runtime-adapter run typecheck
pnpm --filter @worklab-ai/runtime-adapter run test
```
