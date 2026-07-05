# @mono-agent/agent-orchestrator

## Category

Category: `execution`

## Responsibility

Reusable orchestration helpers for exposing named collaborator responders to an orchestrator runtime. The first surface is a loopback MCP tool named `ask_collaborator` that lets the orchestrator model decide which collaborator to ask, and how many times, before producing its final answer.

This is a private extras package, not part of the publishable app closure.

## Install / Usage

```bash
pnpm --filter @mono-agent/agent-orchestrator run build
```

```ts
import { createCollaboratorToolRuntimeExtension } from "@mono-agent/agent-orchestrator";
```

Hosts create one request-scoped extension, merge `extension.runtimeOptions` into the orchestrator runtime call, and call `extension.cleanup()` after the request. Collaborators are plain `AgentResponder` instances, so hosts can wrap local agents, A2A consumers, or other adapter-owned responders without this package depending on those adapters.

## Public API

- `createCollaboratorToolRuntimeExtension`
- `DEFAULT_COLLABORATOR_TOOL_NAME`, `DEFAULT_COLLABORATOR_MCP_SERVER_NAME`, `DEFAULT_COLLABORATOR_MAX_CALLS`
- `OrchestratorCollaborator`
- `CollaboratorToolRuntimeExtension`, `CollaboratorToolRuntimeOptions`, `CollaboratorToolMcpServerConfig`

## Dependency Boundary

This package may depend on core agent contracts and the MCP TypeScript SDK. It must not depend on communication adapters, the agent harness, operator surfaces, host demos, or concrete runtime packages.

## What This Package Does Not Own

It does not start Telegram, WhatsApp, or A2A transports, discover remote agents, persist memory, record run artifacts, or decide which collaborator to ask. It only exposes host-provided collaborators as a bounded MCP tool for a runtime to call.

## Verification

```bash
pnpm --filter @mono-agent/agent-orchestrator run build
pnpm --filter @mono-agent/agent-orchestrator run typecheck
pnpm --filter @mono-agent/agent-orchestrator run test
```
