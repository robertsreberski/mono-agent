---
title: "Evals"
sidebar:
  order: 0
---

# Evals

`@mono-agent/agent-evals` runs deterministic, local-first end-to-end checks against an agent. You define scenarios (a prompt plus assertions), point them at a responder or harness, and the runner captures runtime-style events, scores them, and writes inspectable artifacts. This page covers the scenario/suite API, the assertion catalog, trajectory matching, artifact layout, and how to gate live runs in CI.

This is **dev-only / code** tooling — there are no `mono-agent.config.json` keys and no CLI subcommand. You author scenarios in TypeScript and run them from your test runner or a script. See [Programmatic Usage](/programmatic/) for the responder/harness seams these scenarios target.

Feature-registry coverage row: `evals.scenarios` -> `dev` -> `@mono-agent/agent-evals`.

## Install

```bash
pnpm add -D @mono-agent/agent-evals
```

The package depends only on `agent-contracts`, `agent-harness`, `observability`, and the external `agentevals` library. It must not (and does not) pull in channel adapters, provider SDKs, or deployment code, so it is safe as a `devDependency`.

## Define a scenario

A scenario is a prompt, a target, and a set of assertions. `defineAgentEvalScenario` validates the shape (non-empty `id`/`input`, exactly one target) and returns it unchanged.

```ts
import {
  defineAgentEvalScenario,
  runAgentEvalScenario,
} from "@mono-agent/agent-evals";

const scenario = defineAgentEvalScenario({
  id: "launch-plan",
  input: "Plan the product launch.",
  target: { responder }, // exactly one of { responder } | { harness }
  assertions: {
    finalText: { includes: ["launch"] },
    requiredTools: ["ask_collaborator"],
    forbiddenTools: ["Write"],
    maxCostUsd: 0.5,
    maxTurns: 12,
  },
});

const result = await runAgentEvalScenario(scenario, {
  artifactRoot: ".mono-agent/evals",
  suiteId: "local",
});

console.log(result.status); // "passed" | "failed" | "skipped"
```

### Target: responder vs harness

| Target | What runs | Final text source |
| --- | --- | --- |
| `{ responder }` | `responder.respond(request, stream)` | `response.text`, falling back to streamed deltas |
| `{ harness }` | `harness.run({ conversationId, userMessage, onEvent })` | `response.text` |

You must supply **exactly one**. Both surfaces feed events into the same trajectory and assertion pipeline. The responder target also injects `metadata.eval` (`scenarioId`, `suiteId`, `runId`) into the request so downstream code can detect eval traffic.

## Assertions

All assertions live under `assertions` and are optional; each present assertion becomes one named check in `result.checks`. A scenario passes only when every check passes. An "agent status" check is always added first and fails if the run threw.

| Assertion | Shape | Passes when |
| --- | --- | --- |
| `finalText.includes` | `string[]` | every substring is present in the final text |
| `finalText.matches` | `RegExp[]` | every pattern matches the final text |
| `requiredTools` | `string[]` | every named tool was called at least once |
| `forbiddenTools` | `string[]` | none of the named tools were called |
| `maxCostUsd` | `number` | observed cost <= limit (or cost unknown) |
| `maxTurns` | `number` | observed turn count <= limit (or unknown) |
| `maxDurationMs` | `number` | observed duration <= limit (or unknown) |
| `trajectory` | object | tool-call sequence matches per the chosen mode (see below) |
| `judge` | function | your custom async/sync function returns a passing check |

:::caution
`maxCostUsd`, `maxTurns`, and `maxDurationMs` read from run metadata (`runtime.cost.totalUsd`, `runtime.numTurns`, `runtime.durationMs`, with `summary.*` and top-level fallbacks). If the target does not report a metric, that check passes by default rather than failing — wire your responder/harness to surface metadata if you want hard cost/turn gates to bite.
:::

### Custom judge

`judge` receives the scenario, final text, raw events, normalized trajectory, and extracted tool calls, and returns an `AgentEvalCheck` (`{ name, passed, message?, details? }`). Use it for LLM-as-judge or any bespoke scoring the built-in assertions do not cover.

## Trajectory matching

`assertions.trajectory` checks the ordered sequence of tool calls against `expectedToolCalls` using the `agentevals` trajectory evaluator. `mode` controls how strictly the actual sequence must line up with the expected one; `toolArgsMatchMode` controls how each call's arguments are compared.

```ts
assertions: {
  trajectory: {
    mode: "superset",            // strict | unordered | subset | superset
    toolArgsMatchMode: "exact",  // default "exact"; e.g. "superset" tolerates extra args
    expectedToolCalls: [
      { name: "ask_collaborator", arguments: { id: "researcher" } },
      { name: "Write" },
    ],
  },
}
```

| `mode` | Meaning |
| --- | --- |
| `strict` (default) | same tool calls, same order, no extras |
| `unordered` | same set of calls, order ignored |
| `subset` | every actual call appears in the expected set |
| `superset` | every expected call appears in the actual sequence (extras allowed) |

`toolArgsMatchMode` defaults to `"exact"`. Pass `toolArgsMatchOverrides` to vary the comparison per tool/argument. Each `expectedToolCall` needs a `name`; `arguments` and `id` are optional.

## Suites

Group scenarios with `runAgentEvalSuite`. Scenarios run sequentially; the suite status is `failed` if any scenario failed, `skipped` if all were skipped, otherwise `passed`. The suite `id` is used as `suiteId` for artifacts unless you override it in options.

```ts
import { runAgentEvalSuite } from "@mono-agent/agent-evals";

const suiteResult = await runAgentEvalSuite(
  { id: "regression", scenarios: [scenario] },
  { artifactRoot: ".mono-agent/evals" },
);

console.log(suiteResult.passed, suiteResult.failed, suiteResult.skipped);
```

## Local-first artifacts

When you pass `artifactRoot`, the runner writes per-scenario artifacts under `artifactRoot/<suiteId>/<scenarioId>/` (both segments are slugified). Omit `artifactRoot` to run in-memory with no files.

| File | Contents |
| --- | --- |
| `run-*.events.jsonl` | the captured runtime event stream (one JSON event per line) |
| `run-*.summary.json` | run summary (status, duration, cost/usage when reported) |
| `eval-result.json` | the full `AgentEvalResult` (checks, final text, tool calls, trajectory) |
| `report.md` | human-readable run report: status, checks, final text, tool calls |

Artifacts share the JSONL recorder used elsewhere in mono-agent, so they open in the same tooling. See [Artifacts and Traces](/observability/artifacts-and-traces/) and the [Observability CLI](/observability/cli-reference/).

## Live vs offline runs

By default a scenario actually invokes its target. Scenarios marked `requiresLive: true` are **skipped** unless live execution is enabled, so an offline CI default never makes real model calls for those scenarios:

- set the env var `MONO_AGENT_EVAL_LIVE=1`, or
- pass `live: true` in `AgentEvalRunOptions`.

```bash
MONO_AGENT_EVAL_LIVE=1 pnpm vitest run evals/
```

:::tip
A skipped scenario reports `status: "skipped"` with a single check explaining how to enable it. This lets you keep expensive, model-hitting scenarios in the same suite as cheap fixture-driven ones.
:::

You can also drive a scenario entirely from pre-recorded events: pass `events` on the scenario (and rely on those plus the target). This is useful for deterministic, fully offline trajectory assertions.

## Using evals as a CI quality gate

`runAgentEvalSuite` returns a structured result, so a CI step can fail the build on any regression:

```ts
const r = await runAgentEvalSuite(suite, { artifactRoot: ".mono-agent/evals" });
if (r.status === "failed") process.exit(1);
```

Keep model-hitting scenarios behind `requiresLive: true` and only set `MONO_AGENT_EVAL_LIVE=1` on the jobs (e.g. nightly) where real calls are acceptable; pull-request CI then runs the offline subset for free. Upload the `artifactRoot` directory as a build artifact to inspect `report.md` and the event stream for any failure.

For an end-to-end walkthrough covering trajectory and cost assertions, see the [eval suite playbook](/playbooks/eval-suite-trajectory-cost/).

## Public API reference

| Export | Purpose |
| --- | --- |
| `defineAgentEvalScenario(scenario)` | validate + return a scenario |
| `runAgentEvalScenario(scenario, options?)` | run one scenario -> `AgentEvalResult` |
| `runAgentEvalSuite(suite, options?)` | run scenarios sequentially -> `AgentEvalSuiteResult` |
| `runtimeEventsToTrajectoryMessages(events)` | events -> chat-completion trajectory messages |
| `toolCallsToTrajectoryMessages(toolCalls)` | expected calls -> reference trajectory |
| `extractTrajectoryToolCalls(trajectory)` | pull `{ name, arguments }` calls out of a trajectory |

`AgentEvalRunOptions` keys: `artifactRoot`, `suiteId`, `live`, `createRunId`, `clock`, `abortSignal`.
