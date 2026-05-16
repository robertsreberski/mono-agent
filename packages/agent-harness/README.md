# @worklab-ai/agent-harness

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

## Public API

- `createAgentHarness`, `MonoAgentHarness`, `AgentHarnessError`
- `createAgentResponder`, `AgentHarnessFailureError`
- `createInMemoryHistoryStore`, `InMemoryConversationHistoryStore`
- `NoopRunRecorder`
- Harness, responder, runtime, memory, and history types from `types.ts`

## Dependency Boundary

The harness may depend on core building blocks: context, memory-md, observability, runtime-adapter, skills, and tool-policy. It must not depend on Telegram, WhatsApp, the operator console, or host/demo code.

## What This Package Does Not Own

It does not poll chats, serve UI, parse host settings files, own provider credentials, or choose communication-specific message formatting.

## Verification

```bash
pnpm --filter @worklab-ai/agent-harness run build
pnpm --filter @worklab-ai/agent-harness run typecheck
pnpm --filter @worklab-ai/agent-harness run test
```
