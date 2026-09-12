---
title: "Multi-Agent Orchestration (AskCollaborator)"
description: "Build an orchestrator that delegates to named specialist responders through a bounded MCP tool that defaults to loopback."
sidebar:
  order: 8
---

This playbook shows how one orchestrator agent delegates subtasks to named specialist responders (a researcher and a writer) through the loopback-by-default `AskCollaborator` MCP tool. The wiring is code-only: you build collaborator responders, create a runtime extension, and attach it to the orchestrator per request.

For in-process helpers, the built-in [Agent tool](/runtime/tools-and-guards/#subagents-agent)
provides a config-first option. Configure `subagents.models` to offer model choices,
then select `model` and `effort` on each call; omitted values inherit profile pins
or the parent's effective route. The collaborator setup below remains useful for
separately composed responders.

## Who this is for

Workflow designers composing specialist agents — you want a single orchestrator that decides when to hand a subtask to a researcher, a writer, or any other named collaborator, rather than doing everything in one prompt.

## Goal

One orchestrator agent delegates subtasks to named collaborator responders (researcher, writer) via the loopback-by-default `AskCollaborator` MCP tool.

## Features used

- [`orchestrator.ask-collaborator`](/programmatic/multi-agent/) — loopback-by-default MCP tool delegating to named collaborator responders, with guarded non-loopback opt-in, call caps, and per-collaborator timeout (coverage: code).
- [`harness.request-runtime-options`](/programmatic/composition/) — per-request runtime option extensions via `createConfiguredAgentResponder({ runtimeOptionsForRequest })` (coverage: code).
- [`runtime.custom`](/runtime/backends/) — custom runtime composition that drives the orchestrator (coverage: code).

## Configuration

This capability is **code-only** — there is no `mono-agent.config.json` key for it. You construct the collaborator extension programmatically and pass its run options to the orchestrator's responder. See [programmatic composition](/programmatic/composition/) and [multi-agent](/programmatic/multi-agent/).

After importing `createConfiguredAgentResponder` and
`createCollaboratorToolRuntimeExtension`, build the config and both collaborator
responders, then attach the request-scoped extension:

```ts
// Assume config and both collaborator responders have already been created.
const orchestrator = await createConfiguredAgentResponder({
  config,
  runtimeOptionsForRequest: async (input) => {
    const extension = await createCollaboratorToolRuntimeExtension({
      collaborators: [
        { id: "researcher", label: "Researcher", responder: researcherResponder },
        { id: "writer", label: "Writer", responder: writerResponder },
      ],
      conversationId: input.request.conversationId,
      originalUserMessage: input.request.userMessage,
      abortSignal: input.request.abortSignal,
      maxCalls: 10,
    });
    return {
      runtimeOptions: extension.runtimeOptions,
      cleanup: extension.cleanup,
    };
  },
});
```

## Steps

1. Build collaborator responders (one `createConfiguredAgentResponder` per specialist, or A2A consumers).
2. Inside `runtimeOptionsForRequest`, call `createCollaboratorToolRuntimeExtension` with the required `collaborators`, `conversationId`, `originalUserMessage`, and `abortSignal` fields (plus optional `maxCalls`).
3. Return `{ runtimeOptions: extension.runtimeOptions, cleanup: extension.cleanup }` from the callback so the host attaches the loopback tool and closes the ephemeral MCP server when the turn ends.
4. Run the orchestrator with a task that requires delegation.
5. Inspect the run artifact for `AskCollaborator` calls.

## Smoke test

For command-based workers, use [background process jobs](/tools/background-process-jobs/)
to hand off Exec/Bash stages and resume from their completion turns.
`processJobs.maxChainDepth` defaults to 4 and accepts at most 64; choose a
budget for the workflow without resetting lineage. A depth-32 exhausted wake
cannot start another background stage when the configured budget is 32.
Use `wake_on_completion: false` explicitly for helpers whose terminal card
is sufficient, and treat an unknown wake receipt as non-replayable.

:::tip
Give the orchestrator a compound task ("research X then write a summary"); confirm the run artifact shows `AskCollaborator` delegating to both researcher and writer, and that the returned `cleanup` closes the MCP port at turn end.
:::

## Related

- [Programmatic: multi-agent](/programmatic/multi-agent/)
- [Programmatic: composition](/programmatic/composition/)
- [Programmatic: A2A consumer](/programmatic/a2a-consumer/)
- [Runtime backends](/runtime/backends/)
- [Observability: artifacts and traces](/observability/artifacts-and-traces/)
- Composer skill: `mono-agent-composer` (run `/mono-agent-composer` to scaffold and validate an agent from one config).
