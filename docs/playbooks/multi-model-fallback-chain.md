---
title: "Multi-Model Fallback Chain"
description: "Configure ordered model fallbacks and verify how mono-agent advances across unavailable routes."
sidebar:
  order: 13
---

This playbook builds an ordered cloud-to-local fallback chain with exact effort
and explicit provider safety. Failover is visible in results and traces; no model
substitution or safety projection happens silently.

## Who this is for

Reliability-minded builders who want multiple provider families without giving
up an auditable safety contract.

## Features used

- [runtime.multi-backend](/runtime/backends/)
- [runtime.fallback-models](/runtime/fallback/)
- [runtime.effort](/runtime/execution-effort-permissions/)
- [runtime.local-providers](/runtime/local-providers/)

## Configuration

```json
{
  "agent": { "name": "Resilient Research Agent" },
  "runtime": {
    "model": "anthropic:claude-sonnet-5",
    "effort": "high",
    "fallbacks": [
      { "model": "openai-codex:gpt-5.6-sol", "effort": "xhigh" },
      { "model": "ollama:gemma4:31b" }
    ]
  },
  "providers": {
    "ollama": {
      "type": "ollama",
      "baseUrl": "http://localhost:11434",
      "enabled": true,
      "models": [{ "name": "gemma4:31b" }]
    },
    "piNative": {
      "transport": "auto",
      "piMaxRetries": 2,
      "maxRetryDelayMs": 60000
    }
  }
}
```

The primary uses `runtime.effort`. The first fallback explicitly uses `xhigh`;
the local route omits effort and therefore uses its provider default. The fallback
list is ordered and has no product-imposed count limit.

:::caution
The primary's first attempt owns the provider session. Retries and failovers run
stateless with bounded transcript-tail replay. With coordinated durable session history,
any answer from a retry or backup retires the primary epoch. The next turn
cold-reseeds from canonical history; after a primary first-attempt success,
subsequent turns resume the new session and are eligible for provider caching.

On a warm turn whose primary attempt fails, the retry or backup attempt runs
stateless with the current message and a bounded snapshot of the failed attempt,
without the earlier conversation; the next turn reseeds from canonical history.
:::

## Steps

1. Pull the local last resort: `ollama pull gemma4:31b`.
2. Run guided `mono-agent init`, search for each route, and choose the exact
   supported effort per model.
3. Read the **Creation review**: it lists all routes, efforts, provider actions,
   route contracts, and the number of real/potentially billed readiness calls.
4. Let readiness verify each route sequentially. If interrupted, choose resume to
   reuse only successful checks under the unchanged plan fingerprint.
5. Run `mono-agent validate`, then start the agent.
6. Force a retryable provider/auth failure. Confirm the run summary's
   `failoverHistory` identifies failed routes.

Non-retryable application errors and mid-turn safety failures are not masked by
failover.

## Related

- [Runtime backends](/runtime/backends/)
- [Fallback chain](/runtime/fallback/)
- [Local providers](/runtime/local-providers/)
- [Sessions and concurrency](/runtime/sessions-concurrency/)
- [Config blueprint](/config/blueprint/)

## Web model changes are not fallback retries

`runtime.session.modelSwitch.enabled` is OFF by default. Web-only durable model
changes require continuous sessions and `runtime.session.root`.
Stop all older writers and back up consistent host/native roots first;
rollback restores those backups. Only persisted Web inbound message IDs authorize
switch/summary work; pending messages are not replayed. This does not enable native
switching on fallback routes, TUI/ACP requests or subagents. See the session-switch
section in the runtime sessions documentation for limits and billing behavior.

After a context overflow, known too-small backups are skipped with estimated
window/size evidence. Unknown windows retain normal admission. Provider-local
tool-schema dialect rejection can advance to the next provider, but generic
invalid requests and tool/live-input side-effect fences stay terminal.

For long conversations, leave `runtime.compaction.effort` at `auto` to avoid
inheriting expensive conversation reasoning for summaries. The combined
`summaryMaxTokens` text target has bounded extra adaptive-thinking headroom.
Repeated unchanged failures are suppressed for `failureCooldownMs` (900000 by
default); meaningful growth, model/summary-policy changes or a manual action
permit another attempt. Check the console’s Compaction cost line for summary
spend, including rejected requests; it is already included in the total.

If accounting reports `insufficient_summary_headroom`, no summary provider call
was made: the context/model cap could not preserve the useful answer minimum
after reasoning reserves. Raising a genuinely supported model/output ceiling or
reducing the request can help; do not repeatedly retry the same doomed summary.

## Optional retained evidence

Keep `runtime.session.continuity.enabled` off unless explicitly opting into
retained conversation evidence. It gives `ConversationHistory` scoped access to
sanitized text and portable summaries without a memory backend, but does not
change fallback reconstruction or prove improved semantic continuity. Back up
canonical history and the sidecar and stop older writers before the one-way v3
migration. See [retained evidence](/runtime/sessions-concurrency/#retained-conversation-evidence-default-off).
