# @worklab-ai/agent-harness

## Category

Category: `execution`

## Responsibility

Composition spine for a Mono Agent request. It turns a communication request into context, calls a runtime, records structured run events, updates optional memory, and returns explicit success or failure responses.

## Install / Usage

```bash
pnpm --filter @worklab-ai/agent-harness run build
```

```ts
import { createAgentHarness, createAgentResponder } from "@worklab-ai/agent-harness";
```

Hosts wire identity/context paths, runtime, model, execution mode, tool policy, history, memory, skills, and recorder factory explicitly.
Hosts that need request-scoped runtime setup can provide `runtimeOptionsForRequest`; the harness merges those options into the runtime call and runs the returned cleanup after execution.

## Public API

- `createAgentHarness`, `AgentHarnessError`
- `createAgentResponder`, `AgentHarnessFailureError`
- `createInMemoryHistoryStore`
- `NoopRunRecorder`
- Harness, shared responder, runtime, request-scoped runtime option, memory, and history types from `types.ts`

## Dependency Boundary

The harness may depend on core building blocks: agent-contracts, context, memory-md, observability, runtime-adapter, skills, and tool-policy. It must not depend on communication adapters, the operator console, or host/demo code.

## What This Package Does Not Own

It does not poll chats, serve UI, parse host settings files, own provider credentials, or choose communication-specific message formatting.

## Verification

```bash
pnpm --filter @worklab-ai/agent-harness run build
pnpm --filter @worklab-ai/agent-harness run typecheck
pnpm --filter @worklab-ai/agent-harness run test
```
