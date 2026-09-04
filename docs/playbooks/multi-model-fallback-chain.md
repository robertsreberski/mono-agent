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
Any configured fallback chain is stateless across provider sessions. The harness
replays logical conversation history and the router uses a bounded transcript-tail
snapshot between attempts, but it never reuses a provider session id across routes.
`providers.piNative.piSessionsRoot` does not turn a mixed fallback chain into a
shared durable provider session.
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
