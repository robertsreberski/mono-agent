---
title: "Multi-Agent Orchestration (ask_collaborator)"
sidebar:
  order: 8
---

# Multi-Agent Orchestration (ask_collaborator)

This playbook shows how one orchestrator agent delegates subtasks to named specialist responders (a researcher and a writer) through the loopback `ask_collaborator` MCP tool. The wiring is code-only: you build collaborator responders, create a runtime extension, and attach it to the orchestrator per request.

## Who this is for

Workflow designers composing specialist agents — you want a single orchestrator that decides when to hand a subtask to a researcher, a writer, or any other named collaborator, rather than doing everything in one prompt.

## Goal

One orchestrator agent delegates subtasks to named collaborator responders (researcher, writer) via the loopback `ask_collaborator` MCP tool.

## Features used

- [`orchestrator.ask-collaborator`](/programmatic/multi-agent/) — loopback MCP tool delegating to named collaborator responders, with call caps and per-collaborator timeout (coverage: code).
- [`harness.request-runtime-options`](/programmatic/composition/) — per-request runtime option extensions via `createConfiguredAgentResponder({ runtimeOptionsForRequest })` (coverage: code).
- [`runtime.custom`](/runtime/backends/) — custom runtime composition that drives the orchestrator (coverage: code).

## Configuration

This capability is **code-only** — there is no `mono-agent.config.json` key for it. You construct the collaborator extension programmatically and pass its run options to the orchestrator's responder. See [programmatic composition](/programmatic/composition/) and [multi-agent](/programmatic/multi-agent/).

```ts
// The extension is request-scoped: create it inside runtimeOptionsForRequest
// (one ephemeral MCP server per turn) and return its cleanup so the host
// tears the server down when the turn ends. Do not reuse one across requests.
const orchestrator = createConfiguredAgentResponder({
  config,
  runtimeOptionsForRequest: async (input) => {
    const extension = createCollaboratorToolRuntimeExtension({
      collaborators: [
        { id: "researcher", label: "Researcher", responder: researcherResponder },
        { id: "writer", label: "Writer", responder: writerResponder },
      ],
      conversationId: input.conversationId,
      maxCalls: 10,
    });
    return { runtimeOptions: extension.runtimeOptions, cleanup: extension.cleanup };
  },
});
```

## Steps

1. Build collaborator responders (one `createConfiguredAgentResponder` per specialist, or A2A consumers).
2. Inside `runtimeOptionsForRequest`, call `createCollaboratorToolRuntimeExtension` with the collaborators, `conversationId`, and `maxCalls`.
3. Return `{ runtimeOptions: extension.runtimeOptions, cleanup: extension.cleanup }` from the callback so the host attaches the loopback tool and closes the ephemeral MCP server when the turn ends.
4. Run the orchestrator with a task that requires delegation.
5. Inspect the run artifact for `ask_collaborator` calls.

## Smoke test

:::tip
Give the orchestrator a compound task ("research X then write a summary"); confirm the run artifact shows `ask_collaborator` delegating to both researcher and writer, and that the returned `cleanup` closes the MCP port at turn end.
:::

## Related

- [Programmatic: multi-agent](/programmatic/multi-agent/)
- [Programmatic: composition](/programmatic/composition/)
- [Programmatic: A2A consumer](/programmatic/a2a-consumer/)
- [Runtime backends](/runtime/backends/)
- [Observability: artifacts and traces](/observability/artifacts-and-traces/)
- Composer skill: `mono-agent-composer` (run `/mono-agent-composer` to scaffold and validate an agent from one config).
