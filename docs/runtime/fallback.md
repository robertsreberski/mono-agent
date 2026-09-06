---
title: "Fallback models & failover"
description: "Configure ordered provider fallback routes, retry behavior, and readiness checks."
sidebar:
  order: 3
---

`runtime.fallbacks` is the canonical ordered list of backup routes. Each entry
selects a model and, optionally, its exact reasoning effort. The list is not
artificially capped: the router walks it in authored order until one route
succeeds or every eligible route is exhausted. Failover history is reported in
results and traces, and a run that leaves its configured route says so in the
transcript — see [Who sees a failover](#who-sees-a-failover).
mono-agent never silently swaps providers.

## Configure canonical routes

```json
{
  "runtime": {
    "model": "openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [
      { "model": "openai-codex:gpt-5.6-sol", "effort": "xhigh" },
      { "model": "ollama:gemma4:31b" }
    ]
  }
}
```

A local fallback such as `ollama:gemma4:31b` still needs its provider declared — `"providers": { "ollama": {} }` — or the route loads and then fails at turn time; see [Providers](/runtime/providers/#zero-config-local-autodiscovery).

The primary uses `runtime.effort`. Every canonical fallback owns its effort:

- An explicit `effort` is forwarded only to that route and must be supported by
  its known model metadata.
- Omitted `effort` means the provider/model default. It does **not** inherit the
  primary's `runtime.effort`.
- Each fallback infers its own execution from its model reference; it does
  not inherit settings from the primary.

The canonical environment form is JSON:

```bash
export MONO_AGENT_FALLBACKS_JSON='[
  {"model":"openai-codex:gpt-5.6-sol","effort":"xhigh"},
  {"model":"ollama:gemma4:31b"}
]'
```

For non-interactive scaffolding, repeat `--fallback` and put an optional
`--fallback-effort` immediately after the route it configures:

```bash
mono-agent init \
  --model openai-codex:gpt-5.6-terra --effort high \
  --fallback openai-codex:gpt-5.6-sol --fallback-effort xhigh \
  --fallback ollama:gemma4:31b --fallback-effort provider-default
```

## Retired: `fallbackModels`

`runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` were **retired** in
0.21.0. They are rejected at load with the replacement named for the surface each
was set on — the JSON key points at `runtime.fallbacks`, the environment variable
points at `MONO_AGENT_FALLBACKS_JSON` — so an agent still carrying one does not
start. The CLI CSV flag `--fallback-models` was removed
earlier; repeat `--fallback <ref>` instead. See the canonical
[deprecation tracker](/reference/deprecations/).

Convert by hand, with the agent stopped, then run `mono-agent validate` before
restarting it:

```json
{
  "runtime": {
    "model": "openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [{ "model": "ollama:gemma4:31b" }]
  }
}
```

## Same-model retries

Before the chain advances, a route can retry itself. `runtime.retry.primaryAttempts`
sets the total attempts on `runtime.model` including the first (default `2`, so the
primary gets one retry); each `runtime.fallbacks[]` entry takes its own optional
`attempts` and stays single-shot when omitted. Set `primaryAttempts` to `1` to turn
same-model retries off entirely.

```json
{
  "runtime": {
    "model": "openai-codex:gpt-5.6-terra",
    "retry": { "primaryAttempts": 2, "backoffMs": 1000, "maxBackoffMs": 15000 },
    "fallbacks": [
      { "model": "anthropic:claude-sonnet-4-6", "effort": "high", "attempts": 2 },
      { "model": "ollama:gemma4:31b" }
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

The runtime result includes `failoverHistory`. An
exhausted chain reports `provider_unavailable_exhausted` with per-attempt models,
failure kinds/subkinds. Run summaries and Phoenix failover
attributes preserve normalized failover details; the events JSONL preserves the
per-attempt `provider_retry_started`, `provider_failover_started`, and
`provider_failover_completed` events. There is no separate per-route safety
record: every route is Pi-native, so there is no cross-route contract to
reconcile.

## Who sees a failover

A run that answers from a fallback behaves differently from one that answers from
the primary — different schema adherence, tool-calling conventions, cost, and
sometimes capabilities. Operator surfaces show that from runtime-owned route
evidence rather than comparing their own model-selector state.

**While the run is in flight**, the transition joins the activity log:

```text
⏳ Retrying openai-codex:gpt-5.6-sol — attempt 2 (overloaded)
⚠️ Failed over: openai-codex:gpt-5.6-sol → opencode-go:kimi-k2.7-code (overloaded)
```

Chat channels (Slack, Telegram) render these alongside tool activity; the TUI shows
them as inline warning notices. Both respect the channel's activity-hint setting, so
a channel with hints turned off shows neither.

**On the answer**, a run that did not execute on its configured route appends one
line:

```text
⚠️ Answered by opencode-go:kimi-k2.7-code, not the configured openai-codex:gpt-5.6-sol (overloaded).
```

This is attached to the output it explains, so it survives on every surface the
answer reaches — including a cron or webhook `notify` payload, where nobody is
watching activity lines. A same-model retry that recovered on the configured route
produces no note: the run's identity did not change. A turn whose answer is
`NOTHING_TO_REPORT` also produces no note, so notification suppression is unaffected.

The web console additionally persists structured attribution per run. The
assistant message and conversation header distinguish the requested route, the
current or last attempt, and the route that actually answered. Known classified
transition reasons and same-route retries are available in a bounded disclosure;
a terminal model mismatch without a transition is still marked as a fallback
with “reason not reported.” An exhausted chain never claims an answering model.
Configured subagents carry the same evidence inside their own delegation card.

Pi also reports the effective thinking level used for each provider request.
That makes normalizations such as non-reasoning to `off`, unsupported `max` to
`xhigh`, and the current `ultra` compatibility mapping to `low` visible without
reimplementing Pi's rules in the browser.

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

Changing routes, effort, or provider configuration,
durable non-secret environment, secret names, Pi auth path, or timeout invalidates
the resume fingerprint. Authentication repair also invalidates every route proof,
even when the non-secret plan is unchanged, because credential bytes may have
changed. A detected credential is not enough: a route becomes verified only
after its exact live check succeeds.

## Ordering and cost

Order routes by preference because the first success wins. A common production
shape is capable cloud primary, lower-cost cloud fallback, then local fallback.
The creation review prints every selected route and effort,
the number of real readiness calls, and how many may be billed before it
asks whether to create the agent.

## Related

- [Multi-model fallback chain](/playbooks/multi-model-fallback-chain/)
- [Pi runtime & model references](/runtime/backends/)
- [Execution, effort & permissions](/runtime/execution-effort-permissions/)
- [Sandbox](/tools/sandbox/)
- [Sessions & concurrency](/runtime/sessions-concurrency/)
