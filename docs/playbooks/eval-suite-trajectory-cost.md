---
title: "Eval Suite with Trajectory + Cost Budgets"
sidebar:
  order: 12
---

# Eval Suite with Trajectory + Cost Budgets

This playbook builds an end-to-end eval suite that runs scenarios against your composed responder, asserting required tool calls, an expected trajectory, and a per-run cost ceiling, then captures the resulting JSONL artifacts so you can gate quality in CI.

## Who this is for

Agent product owners gating quality in CI — you want a deterministic suite that fails the build when the agent stops calling a required tool, drifts from its expected trajectory, or blows a per-run cost budget.

## Goal

Run a suite of scenarios against the composed responder asserting required tool calls, trajectory, and per-run cost ceilings, capturing artifacts for inspection and CI gating.

## Features used

- [`evals.scenarios`](/evals/) — end-to-end scenarios/suites with trajectory + judge assertions, written via `@mono-agent/agent-evals`. Coverage: **dev** (code-only).
- [`runtime.cost-tracking`](/runtime/sessions-concurrency/) — per-run usage/cost/cache metrics, recorded into the JSONL artifacts. Coverage: **auto**.
- [`observability.jsonl-artifacts`](/observability/artifacts-and-traces/) — append-only run event JSONL + summaries (secrets redacted, strings truncated). Coverage: **config**.

## Configuration

The eval suite itself is **code-only** — it lives in `@mono-agent/agent-evals` (`defineAgentEvalScenario`, `runAgentEvalSuite`), not in `mono-agent.config.json`. Scenarios run against a responder built from the same config so what you assert in CI matches what ships. See [programmatic composition](/programmatic/composition/).

```ts
import {
  defineAgentEvalScenario,
  runAgentEvalSuite,
} from "@mono-agent/agent-evals";
import { createConfiguredAgentResponder } from "@mono-agent/agent-host";

const responder = await createConfiguredAgentResponder({ /* same config as prod */ });

const scenario = defineAgentEvalScenario({
  id: "websearch-trajectory",
  input: "What is the latest stable Node.js LTS version?",
  target: { responder },
  assertions: {
    finalText: { includes: ["LTS"] },
    requiredTools: ["WebSearch"],
    maxCostUsd: 0.05,
    maxTurns: 5,
    trajectory: {
      expectedToolCalls: [{ name: "WebSearch" }],
      mode: "superset",
    },
  },
});

await runAgentEvalSuite([scenario], { live: true });
// or set env MONO_AGENT_EVAL_LIVE=1 instead of passing live: true
```

The run artifacts the suite inspects are the same JSONL files the runtime always writes. Their location is config-driven:

```json
{
  "artifacts": { "dir": "./.mono-agent/artifacts" }
}
```

| Key | Env var | Default | Notes |
| --- | --- | --- | --- |
| `artifacts.dir` | `MONO_AGENT_ARTIFACT_DIR` | `./.mono-agent/artifacts` | Where `run-*.events.jsonl` + summaries land; cost is recorded here automatically |
| _(none — code)_ | `MONO_AGENT_EVAL_LIVE` | unset | Set to `1` to enable `requiresLive` scenarios; equivalent to `runAgentEvalSuite(..., { live: true })` |

:::caution
Live scenarios make real provider calls. Run them deliberately (a dedicated CI job or local gate), not on every unit-test invocation.
:::

## Steps

1. Build a responder from the same config you ship with `createConfiguredAgentResponder` so assertions reflect production behavior.
2. Define scenarios with `defineAgentEvalScenario`, including `trajectory` (`expectedToolCalls` + `mode`) and `maxCostUsd` assertions.
3. Run with `MONO_AGENT_EVAL_LIVE=1` (or `{ live: true }`) so `requiresLive` scenarios actually execute against the provider.
4. Inspect `artifactRoot/suiteId/scenarioId` for `run-*.events.jsonl`, the summary, `eval-result.json`, and `report.md`.
5. Wire the suite into CI as a gate — fail the build on any assertion miss.

## Smoke test

:::tip
Run `runAgentEvalSuite` with `MONO_AGENT_EVAL_LIVE=1`; confirm `eval-result.json` shows pass/fail per assertion and `report.md` is written, with cost recorded under `maxCostUsd`.
:::

## Related

- [Evals](/evals/)
- [Cost tracking and sessions](/runtime/sessions-concurrency/)
- [Artifacts and traces](/observability/artifacts-and-traces/)
- [Programmatic composition](/programmatic/composition/)
- [Tool policy](/tools/policy/)
- [mono-agent composer skill](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md)
