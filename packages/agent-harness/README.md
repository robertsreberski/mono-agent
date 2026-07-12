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
import {
  createAgentHarness,
  createAgentResponder,
  createToolPolicy,
  loadSelectedSkills,
} from "@mono-agent/agent-harness";
```

Hosts wire identity/context paths, runtime, model, execution mode, tool policy, sandbox policy, history, memory, skills, and recorder factory explicitly.
Hosts that need request-scoped runtime setup can provide `runtimeOptionsForRequest`; the harness merges those options into the runtime call, keeps configured sandbox policy monotonic, and runs the returned cleanup after execution.

For `append-host-summary` and `capture` write modes, a memory store that implements
`persistCompletedTurn` receives one awaited, run-idempotent admission before the successful turn
returns. The provider answer remains successful if admission rejects; the harness emits
`memory_persistence_degraded` and invokes the configured warning sink. Stores without the strong
method keep the legacy awaited `appendHostSummary` plus optional best-effort `scheduleCapture` path.

## Public API

- `createAgentHarness`, `AgentHarnessError`
- `createAgentResponder`, `AgentHarnessFailureError`
- `createInMemoryHistoryStore`
- `createRuntimeSessionStore` plus the session record/store types from `sessions.ts`
- `NoopRunRecorder`
- `ExternalRunSummary`, the channel-safe run summary type; it omits the recorder-only `systemPrompt` field that the runtime response projection also strips
- Context assembly helpers: `buildAgentContext`, `loadContextFromFiles`, `buildSkillIndex`, `loadSkillIndexFromDirectory`
- Selected skill helpers: `loadSelectedSkills`, `createSkillsCache`, `SkillActivationError`
- Tool policy helpers: `createToolPolicy`, `failClosedToolPolicy`, `loadToolPolicyFromJsonFile`, `loadToolPolicyFromJsonFileSync`, `toolPolicyToRuntimeOptions`, `ToolPolicyError`
- Harness, shared responder, runtime, request-scoped runtime option, memory, history, and session types from `types.ts`
- `AgentHarnessTurnHistoryEnricher`, an optional app-owned hook that enriches only the replayed assistant history copy and releases run-scoped state after every outcome; delivered text and memory capture remain unchanged

With `session: { mode: "continuous", idleTimeoutMs }` the harness keeps one live provider session per conversation: resumed runs pass `sessionId`/`sessionKeepAlive` to the runtime and omit history from the prompt, stale sessions are evicted and retried once with history, rotated provider session ids are tracked, and `dispose()` retires everything on shutdown. History is still appended after every successful turn so post-expiry runs replay it as before.

## Dependency Boundary

The harness may depend on core building blocks: agent-contracts, observability, and runtime-adapter. It owns prompt context assembly, selected skill loading, and fail-closed tool/MCP policy normalization. Sandbox policy/types are owned by runtime-adapter. It accepts the `MemoryStore` contract from `@mono-agent/agent-contracts` without depending on a concrete memory backend. It must not depend on communication adapters or host/demo code.

## What This Package Does Not Own

It does not poll chats, serve UI, parse host settings files, own provider credentials, or choose communication-specific message formatting.

## Verification

```bash
pnpm --filter @mono-agent/agent-harness run build
pnpm --filter @mono-agent/agent-harness run typecheck
pnpm --filter @mono-agent/agent-harness run test
```
