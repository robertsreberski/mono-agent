---
title: "Fallback models & failover"
description: "Configure ordered provider fallback routes, route safety, retry behavior, and readiness checks."
sidebar:
  order: 3
---

`runtime.fallbacks` is the canonical ordered list of backup routes. Each entry
selects a model and, optionally, its exact reasoning effort. The list is not
artificially capped: the router walks it in authored order until one route
succeeds or every eligible route is exhausted. Failover and route-safety history
are reported in results and traces, and a run that leaves its configured route
says so in the transcript — see [Who sees a failover](#who-sees-a-failover).
mono-agent never silently swaps providers.

## Configure canonical routes

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [
      { "model": "claude:claude-sonnet-5", "effort": "xhigh" },
      { "model": "codex:gpt-5.6-sol", "effort": "high" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "per-route-native"
  }
}
```

The primary uses `runtime.effort`. Every canonical fallback owns its effort:

- An explicit `effort` is forwarded only to that route and must be supported by
  its known model metadata.
- Omitted `effort` means the provider/model default. It does **not** inherit the
  primary's `runtime.effort`.
- Each fallback infers its own execution mode from its model reference; it does
  not inherit `runtime.executionMode` from the primary.

The canonical environment form is JSON:

```bash
export MONO_AGENT_FALLBACKS_JSON='[
  {"model":"claude:claude-sonnet-5","effort":"xhigh"},
  {"model":"pi:ollama:gemma4:31b"}
]'
```

For non-interactive scaffolding, repeat `--fallback` and put an optional
`--fallback-effort` immediately after the route it configures:

```bash
mono-agent init \
  --model pi:openai-codex:gpt-5.6-terra --effort high \
  --fallback claude:claude-sonnet-5 --fallback-effort xhigh \
  --fallback pi:ollama:gemma4:31b --fallback-effort provider-default \
  --route-safety per-route-native
```

## Legacy compatibility

Existing `runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain
supported. Legacy entries retain their historic behavior: they inherit the
global `runtime.effort`. Do not configure canonical and legacy forms together;
choose `runtime.fallbacks` for new agents.

The CLI CSV flag `--fallback-models` was **removed**; it now errors with a
pointer to repeat `--fallback <ref>` instead. That removal covers only the CLI
flag — the JSON and environment compatibility inputs are unaffected. See the
canonical [deprecation tracker](/reference/deprecations/) for the exact scope.

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbackModels": ["pi:ollama:gemma4:31b"]
  }
}
```

## Route safety

`runtime.routeSafety` controls whether every provider must represent one common
safety contract or whether the operator accepts explicit route-local contracts.

| Mode | Contract |
| --- | --- |
| `uniform` (default) | Reuses one monotonic mono-agent tool/sandbox contract. A route that cannot represent a required capability is rejected or skipped before execution. |
| `per-route-native` | Isolates provider runtimes and applies the documented native contract for each attempt. Mixed Pi, Claude, Codex, and OpenCode chains are allowed after explicit review. |

The per-route-native matrix is deliberately concrete:

- **Pi:** mono-agent tool policy, plus managed SRT when configured.
- **Claude:** provider-native sandbox with the tool restrictions the Claude
  bridge can represent; mono-agent SRT is not projected onto the route.
- **Direct Codex:** Codex-native sandbox and an effective allow-all policy at
  the mono-agent tool-policy layer.
- **Direct OpenCode:** provider-native permissions and an effective allow-all
  policy;
  unsupported capabilities cause the route to be skipped.

Capability-bearing inputs such as MCP, skills, structured output, live input,
or native subagents are never silently removed to make a route pass. Doctor and
runtime checks fail closed or skip that route with `safety_unavailable` /
`skipped_capability_mismatch` and credential-free safety telemetry.

The route-safety telemetry token `tools: "exact-allow-all"` is retained for
compatibility. It means the effective unrestricted contract—an omitted
allowlist or any allowlist containing `"*"`, with no denied tools—not a required
literal `["*"]` array.

## Same-model retries

Before the chain advances, a route can retry itself. `runtime.retry.primaryAttempts`
sets the total attempts on `runtime.model` including the first (default `2`, so the
primary gets one retry); each `runtime.fallbacks[]` entry takes its own optional
`attempts` and stays single-shot when omitted. Set `primaryAttempts` to `1` to turn
same-model retries off entirely.

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "retry": { "primaryAttempts": 2, "backoffMs": 1000, "maxBackoffMs": 15000 },
    "fallbacks": [
      { "model": "claude:claude-sonnet-4-6", "effort": "high", "attempts": 2 },
      { "model": "pi:ollama:gemma4:31b" }
    ]
  }
}
```

A retry re-runs the whole logical turn on the same route after
`backoffMs`, doubling on each further retry and capped by `maxBackoffMs`. Only
*transient* failures retry — `overloaded`, `rate_limited`, `timeout`, `network`,
`server_error`, `retryable_request`, and terminated streams. Two retryable kinds
deliberately advance instead:

- `context_limit` is deterministic against the same window, so a second identical
  request is a guaranteed second failure. It needs a route with a larger window.
- `provider_auth` cannot change mid-turn, but a different provider's credentials
  may work.

Cancellation and mid-turn sandbox/safety failures never retry, and a failed
attempt resolver advances immediately rather than burning the route's budget.

A same-model retry drops the provider session (the failed attempt already
appended to it), emits `provider_retry_started` rather than a failover event, and
appends its own `failoverHistory` entry carrying `retryIndex` — each retry keeps
its own request id and failure subkind.

Retries compose with, and multiply against, the provider-level retry inside a
single attempt. With defaults on a `pi` primary, `runtime.retry.primaryAttempts: 2`
and pi's own `maxRetries` of 2 mean up to **six** provider stream starts before the
chain advances. Lower `providers.piNative.piMaxRetries` when raising
`primaryAttempts`. The harness's one-shot session-resume retry is disjoint: it
fires on `session_not_found` / `session_busy`, which never retry at the router.

## What failover does

The router advances after a route exhausts its attempts on retryable provider errors (transport failures, rate
limits, transient server failures), provider-auth failures, and a classified
`context_limit` after the active bridge's compaction recovery is exhausted. A
fallback may have a larger usable window even when the primary cannot reduce its
request further. Quota, output-token, and max-turn failures remain
`usage_limit` and do not become context failover. Successful but undesired output
does not trigger failover. Mid-turn sandbox/safety failures are terminal because
retrying them on another provider could weaken the established contract.

Any configured fallback chain is stateless across provider sessions. The harness
keeps the logical conversation replayable, strips route-owned session ids, and
uses a bounded transcript-tail snapshot when moving between attempts. This avoids
attaching one provider's session token to another provider or accumulating nested
resume blocks across a long chain.

The runtime result includes `failoverHistory` and `routeSafetyHistory`. An
exhausted chain reports `provider_unavailable_exhausted` with per-attempt models,
failure kinds/subkinds, and route safety. Run summaries and Phoenix failover
attributes preserve normalized failover details; the events JSONL preserves the
separate bounded `provider_route_safety` records.

## Who sees a failover

A run that answers from a fallback behaves differently from one that answers from
the primary — different schema adherence, tool-calling conventions, cost, and
sometimes capabilities. Two operator-visible signals cover that, and both appear
only when a transition actually happened.

**While the run is in flight**, the transition joins the activity log:

```text
⏳ Retrying pi:openai-codex:gpt-5.6-sol — attempt 2 (overloaded)
⚠️ Failed over: pi:openai-codex:gpt-5.6-sol → pi:opencode-go:kimi-k2.7-code (overloaded)
```

Chat channels (Slack, Telegram) render these alongside tool activity; the TUI shows
them as inline warning notices. Both respect the channel's activity-hint setting, so
a channel with hints turned off shows neither.

**On the answer**, a run that did not execute on its configured route appends one
line:

```text
⚠️ Answered by pi:opencode-go:kimi-k2.7-code, not the configured pi:openai-codex:gpt-5.6-sol (overloaded).
```

This is attached to the output it explains, so it survives on every surface the
answer reaches — including a cron or webhook `notify` payload, where nobody is
watching activity lines. A same-model retry that recovered on the configured route
produces no note: the run's identity did not change. A turn whose answer is
`NOTHING_TO_REPORT` also produces no note, so notification suppression is unaffected.

## Guided readiness

Bare interactive `mono-agent init` makes one real, sequential no-tool call for
every selected route. Each route receives its exact configured effort (or provider
default) and its own 90-second cloud / 240-second local deadline. Escape or
Ctrl-C interrupts safely. The recovery menu can:

- resume only routes already verified under the exact non-secret plan
  fingerprint;
- restart all route checks while retaining successful auth and managed SRT;
- edit model choices; or
- cancel without writing.

Changing routes, effort, execution/safety settings, provider configuration,
durable non-secret environment, secret names, Pi auth path, or timeout invalidates
the resume fingerprint. Authentication repair also invalidates every route proof,
even when the non-secret plan is unchanged, because credential bytes may have
changed. A detected credential is not enough: a route becomes verified only
after its exact live check succeeds.

## Ordering and cost

Order routes by preference because the first success wins. A common production
shape is capable cloud primary, lower-cost cloud fallback, then local fallback.
The creation review prints every selected route and effort, the route-safety
matrix, the number of real readiness calls, and how many may be billed before it
asks whether to create the agent.

## Related

- [Multi-model fallback chain](/playbooks/multi-model-fallback-chain/)
- [Backends & execution modes](/runtime/backends/)
- [Execution, effort & permissions](/runtime/execution-effort-permissions/)
- [Sandbox](/tools/sandbox/)
- [Sessions & concurrency](/runtime/sessions-concurrency/)
