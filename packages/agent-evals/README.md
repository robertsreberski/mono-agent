# @mono-agent/agent-evals

## Category

Category: `evaluation`

## Responsibility

Local-first end-to-end eval scenarios for agent responders and harnesses. The package runs a prompt against the shared `AgentResponder` or `AgentHarness` seam, captures runtime-style events, writes local artifacts, and scores deterministic expectations before optional judge checks.

## Install / Usage

```bash
pnpm --filter @mono-agent/agent-evals run build
```

```ts
import {
  defineAgentEvalScenario,
  runAgentEvalScenario,
} from "@mono-agent/agent-evals";

const scenario = defineAgentEvalScenario({
  id: "collaborator-routing",
  input: "Plan the launch.",
  target: { responder },
  assertions: {
    requiredTools: ["ask_collaborator"],
    forbiddenTools: ["Write"],
    finalText: { includes: ["launch"] },
    trajectory: {
      mode: "superset",
      expectedToolCalls: [
        { name: "ask_collaborator", arguments: { id: "researcher" } },
      ],
      toolArgsMatchMode: "superset",
    },
  },
});

const result = await runAgentEvalScenario(scenario, {
  artifactRoot: ".mono-agent/evals",
  suiteId: "local",
});
```

Scenarios marked `requiresLive: true` are skipped unless `MONO_AGENT_EVAL_LIVE=1` is set or `live: true` is passed.

## Public API

- `defineAgentEvalScenario`
- `runAgentEvalScenario`
- `runAgentEvalSuite`
- `runtimeEventsToTrajectoryMessages`
- `toolCallsToTrajectoryMessages`
- `extractTrajectoryToolCalls`
- Scenario, assertion, result, check, artifact, and trajectory types

## Dependency Boundary

This package may depend on `agent-contracts`, `agent-harness`, `observability`, and external eval libraries such as `agentevals`. It must not depend on communication adapters, operator surfaces, host demos, provider SDKs, or local deployment code.

## What This Package Does Not Own

It does not start Telegram, Slack, WhatsApp, or A2A providers. It does not choose production models, manage secrets, publish hosted dashboards, or replace package unit tests.

## Verification

```bash
pnpm --filter @mono-agent/agent-evals run build
pnpm --filter @mono-agent/agent-evals run typecheck
pnpm --filter @mono-agent/agent-evals run test
```
