# @mono-agent/agent-harness

## Category

Category: `execution`

## Responsibility

Composition spine for a agent request. It turns a communication request into context, calls a runtime, records structured run events, updates optional memory, and returns explicit success or failure responses.

## Install / Usage

```bash
pnpm --filter @mono-agent/agent-harness run build
```

```ts
import { createAgentHarness, createAgentResponder } from "@mono-agent/agent-harness";
```

Hosts wire identity/context paths, runtime, model, execution mode, tool policy, sandbox policy, history, memory, skills, and recorder factory explicitly.
Hosts that need request-scoped runtime setup can provide `runtimeOptionsForRequest`; the harness merges those options into the runtime call, keeps configured sandbox policy monotonic, and runs the returned cleanup after execution.

## Public API

- `createAgentHarness`, `AgentHarnessError`
- `createAgentResponder`, `AgentHarnessFailureError`
- `createInMemoryHistoryStore`
- `createRuntimeSessionStore` plus the session record/store types from `sessions.ts`
- `NoopRunRecorder`
- Harness, shared responder, runtime, request-scoped runtime option, memory, history, and session types from `types.ts`

With `session: { mode: "continuous", idleTimeoutMs }` the harness keeps one live provider session per conversation: resumed runs pass `sessionId`/`sessionKeepAlive` to the runtime and omit history from the prompt, stale sessions are evicted and retried once with history, rotated provider session ids are tracked, and `dispose()` retires everything on shutdown. History is still appended after every successful turn so post-expiry runs replay it as before.

## Dependency Boundary

The harness may depend on core building blocks: agent-contracts, context, memory-md, observability, runtime-adapter, sandbox, skills, and tool-policy. It must not depend on communication adapters, the operator console, or host/demo code.

## What This Package Does Not Own

It does not poll chats, serve UI, parse host settings files, own provider credentials, or choose communication-specific message formatting.

## Verification

```bash
pnpm --filter @mono-agent/agent-harness run build
pnpm --filter @mono-agent/agent-harness run typecheck
pnpm --filter @mono-agent/agent-harness run test
```
