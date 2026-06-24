---
title: "A2A Provider + Consumer Pair"
sidebar:
  order: 7
---

# A2A Provider + Consumer Pair

This playbook stands up two mono-agents that talk to each other over the Agent-to-Agent (A2A) protocol: agent A publishes an Agent Card with bearer auth (the **provider**), and agent B discovers and calls it (the **consumer**). The provider side is fully config-driven; the consumer side stores its settings in config but invokes remote agents programmatically.

## Who this is for

Platform integrators connecting two agents over A2A.

## Goal

Publish agent A as an A2A provider (Agent Card discovery, bearer) and configure agent B to discover and call it as a consumer.

## Features used

- [`a2a.provider`](/channels/a2a/) — A2A provider with Agent Card discovery, JSON-RPC + REST, streaming, optional bearer (`config`).
- [`a2a.consumer`](/programmatic/a2a-consumer/) — calling remote A2A agents (discovery + sendMessage); settings live in config, invocation is `code` via `createA2AConsumerResponder` / `sendA2AMessage`.
- [`channel.enabled-flag-opt-in`](/channels/) — every channel (including A2A) is off until you set its `enabled` flag.

## Configuration

The block below is a single `mono-agent.config.json` carrying **both** sides for illustration; in practice the provider keys go in agent A's config and the `consumer` keys go in agent B's config. All keys are from [`a2a.provider`](/channels/a2a/), [`a2a.agent`, `a2a.skill`], and [`a2a.consumer`](/programmatic/a2a-consumer/).

```json
{
  "a2a": {
    "provider": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 4201,
      "requireBearer": true,
      "bearerToken": "..."
    },
    "agent": {
      "name": "Research Agent",
      "description": "Does research.",
      "version": "0.1.0"
    },
    "skill": {
      "id": "research",
      "name": "Research",
      "description": "Web research",
      "tags": ["research"]
    },
    "consumer": {
      "remoteAgentUrls": ["http://127.0.0.1:4201"],
      "defaultRemoteAgentUrl": "http://127.0.0.1:4201",
      "bearerToken": "...",
      "timeoutMs": 30000
    }
  }
}
```

Keep the bearer token out of the file in production by supplying it via env var: `MONO_AGENT_A2A_BEARER_TOKEN=...` maps to `a2a.provider.bearerToken`, and `MONO_AGENT_A2A_PROVIDER_ENABLED=true` maps to `a2a.provider.enabled`. See [../config/env-vars.md](/config/env-vars/).

:::caution
When the provider sits behind a proxy or is reached from another host, set `a2a.provider.publicBaseUrl` so the Agent Card advertises the right URL, and `a2a.provider.allowNonLoopback: true` to bind beyond `127.0.0.1`. Always pair non-loopback exposure with `requireBearer: true`.
:::

## Steps

1. Provider: run `mono-agent init`, add `a2a.provider`, `a2a.agent`, and `a2a.skill`, set `requireBearer: true` and a `bearerToken`, then `mono-agent validate` and `mono-agent start`.
2. Confirm the Agent Card is reachable at the provider port (e.g. `http://127.0.0.1:4201`).
3. Consumer: configure `a2a.consumer.remoteAgentUrls` (and `defaultRemoteAgentUrl`/`bearerToken`/`timeoutMs`), or compose `createA2AConsumerResponder` programmatically — invoking remote agents is code-only, see [../programmatic/a2a-consumer.md](/programmatic/a2a-consumer/).
4. From the consumer, send text to the provider's Agent Card URL with the bearer token.
5. Confirm the provider responds and the consumer surfaces the result.

## Smoke test

:::tip
Send a message to the provider's Agent Card URL (with bearer) using `sendA2AMessage()` / the consumer responder; confirm a real response from the provider agent.
:::

## Related

- [A2A channel (provider)](/channels/a2a/)
- [A2A consumer (programmatic)](/programmatic/a2a-consumer/)
- [Multi-agent orchestration](/programmatic/multi-agent/)
- [Channels overview & opt-in flags](/channels/)
- [Environment variables](/config/env-vars/)
- [Config blueprint](/config/blueprint/)
- [mono-agent-composer skill](https://github.com/example/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md)
