---
title: "A2A (Agent-to-Agent)"
parent: "Channels"
nav_order: 6
---

# A2A (Agent-to-Agent)

This page covers the **provider** side of the A2A channel: how mono-agent serves your agent over the [A2A protocol](https://a2a-protocol.org) so other agents can discover and call it. The channel publishes an Agent Card, accepts messages over JSON-RPC and REST, and streams responses. Calling *remote* A2A agents (the consumer side) is programmatic — see [A2A consumer](../programmatic/a2a-consumer.md).

Coverage: **config**. The provider is fully described by `a2a.provider` + `a2a.agent` + `a2a.skill` in `mono-agent.config.json`.

## What the provider serves

When `a2a.provider.enabled` is `true`, `mono-agent start` binds an HTTP server that exposes three endpoints relative to the bound host (or `publicBaseUrl` when fronted by a proxy):

| Path | Purpose |
| --- | --- |
| `/.well-known/agent-card.json` | Agent Card for discovery (name, description, version, skill, capabilities) |
| `/a2a/json-rpc` | JSON-RPC message endpoint (`message/send`, `message/stream`) |
| `/a2a/rest` | REST message endpoint |

The Agent Card advertises `capabilities.streaming: true`, so callers can stream incremental output over JSON-RPC. Each inbound message runs one agent turn against your configured runtime, memory, and tools — the same engine that backs every other channel.

## Scope

The provider is deliberately **text/task only**. It supports plain-text message exchange and task-style turns, and nothing more. The following A2A protocol features are intentionally not implemented:

- No agent registry / catalog
- No gRPC transport (HTTP/JSON only)
- No push notifications
- No signed Agent Cards
- No file exchange (text parts only)

{: .note }
If you need richer transport semantics, treat the provider as a stable text gateway and compose the missing pieces in front of it. The surface is kept small on purpose so it stays predictable for other agents to call.

## Configuration

```json
{
  "a2a": {
    "provider": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 4201,
      "publicBaseUrl": "https://agent.example.com",
      "allowNonLoopback": false,
      "requireBearer": false,
      "bearerToken": "..."
    },
    "agent": {
      "name": "My Agent",
      "description": "What it does.",
      "version": "0.1.0",
      "providerOrganization": "Acme",
      "providerUrl": "https://acme.example.com"
    },
    "skill": {
      "id": "main",
      "name": "Main",
      "description": "Primary skill.",
      "tags": ["agent"],
      "examples": ["Summarize this thread.", "Draft a reply."]
    }
  }
}
```

### `a2a.provider`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Opt-in. When off the channel reports `disabled`, not `waiting`. |
| `host` | string | `127.0.0.1` | Bind address. Non-loopback requires `allowNonLoopback: true`. |
| `port` | number | `4201` | TCP port (0–65535). |
| `publicBaseUrl` | string | — | Absolute URL written into the Agent Card endpoint URLs when fronted by a reverse proxy. |
| `allowNonLoopback` | boolean | `false` | Must be `true` to bind a non-loopback `host` or advertise a non-loopback `publicBaseUrl`. |
| `requireBearer` | boolean | `false` | Require `Authorization: Bearer <token>` on `/a2a/json-rpc` and `/a2a/rest`. |
| `bearerToken` | string | — | The expected token. Required when `requireBearer` is `true`. |

### `a2a.agent`

Populates the identity block of the Agent Card.

| Key | Required | Notes |
| --- | --- | --- |
| `name` | yes | Human-readable agent name. |
| `description` | yes | What the agent does. |
| `version` | yes | Agent version string (e.g. `0.1.0`). |
| `providerOrganization` | no | Organization that operates the agent. |
| `providerUrl` | no | URL for the operating organization. |

### `a2a.skill`

A single advertised skill on the Agent Card.

| Key | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable skill identifier (e.g. `main`). |
| `name` | yes | Display name. |
| `description` | yes | What the skill does. |
| `tags` | no | String array for categorization. |
| `examples` | no | Example prompts surfaced to callers. |

## Environment variables

Every key has a `MONO_AGENT_*` override. Strings split on commas where the value is a list.

| Env var | JSON key |
| --- | --- |
| `MONO_AGENT_A2A_PROVIDER_ENABLED` | `a2a.provider.enabled` |
| `MONO_AGENT_A2A_HOST` | `a2a.provider.host` |
| `MONO_AGENT_A2A_PORT` | `a2a.provider.port` |
| `MONO_AGENT_A2A_PUBLIC_BASE_URL` | `a2a.provider.publicBaseUrl` |
| `MONO_AGENT_A2A_ALLOW_NON_LOOPBACK` | `a2a.provider.allowNonLoopback` |
| `MONO_AGENT_A2A_REQUIRE_BEARER` | `a2a.provider.requireBearer` |
| `MONO_AGENT_A2A_BEARER_TOKEN` | `a2a.provider.bearerToken` |
| `MONO_AGENT_A2A_AGENT_NAME` | `a2a.agent.name` |
| `MONO_AGENT_A2A_AGENT_DESCRIPTION` | `a2a.agent.description` |
| `MONO_AGENT_A2A_AGENT_VERSION` | `a2a.agent.version` |
| `MONO_AGENT_A2A_PROVIDER_ORGANIZATION` | `a2a.agent.providerOrganization` |
| `MONO_AGENT_A2A_PROVIDER_URL` | `a2a.agent.providerUrl` |
| `MONO_AGENT_A2A_SKILL_ID` | `a2a.skill.id` |
| `MONO_AGENT_A2A_SKILL_NAME` | `a2a.skill.name` |
| `MONO_AGENT_A2A_SKILL_DESCRIPTION` | `a2a.skill.description` |
| `MONO_AGENT_A2A_SKILL_TAGS` | `a2a.skill.tags` (comma-separated) |

## Network security

By default the provider binds loopback (`127.0.0.1`) and runs without auth — safe for local development and same-host agent-to-agent calls.

To expose the provider publicly you must opt in on two axes:

1. Set `allowNonLoopback: true` to bind a non-loopback `host` or advertise a non-loopback `publicBaseUrl`. Without it, start fails with an explicit error rather than silently binding `0.0.0.0`.
2. Set `requireBearer: true` with a `bearerToken` so callers must present `Authorization: Bearer <token>`. When `requireBearer` is on but no token is configured, start fails.

{: .warning }
A2A speaks plaintext HTTP. Terminate **HTTPS** at a reverse proxy in front of the provider, set `publicBaseUrl` to the public `https://` URL, and always pair public exposure with `requireBearer`. Keep `bearerToken` in `.env` (`MONO_AGENT_A2A_BEARER_TOKEN`), never in committed config.

## Startup status

`mono-agent start` prints one status line for the A2A channel:

- `running` with the bound endpoint facts (Agent Card / JSON-RPC / REST URLs) when enabled and valid.
- `waiting_for_config` naming the exact missing setting (e.g. a required `a2a.agent.name`).
- `disabled` when `a2a.provider.enabled` is `false`.
- `failed` with the reason (e.g. non-loopback bind without `allowNonLoopback`).

Run `mono-agent validate` first for a per-section report. Config is JSON-first — edit `mono-agent.config.json` and run `mono-agent restart` to apply.

## Tools and behavior

Inbound A2A messages run the same turn pipeline as other channels, so [tool policy](../tools/policy.md), [MCP servers](../tools/mcp.md), [sandbox](../tools/sandbox.md), [memory](../memory/capture-and-recall.md), and [sessions/concurrency](../runtime/sessions-concurrency.md) all apply. See the [channels overview](index.md) for cross-channel concepts.

## Calling remote agents

The provider only serves *your* agent. To have your agent call *other* A2A agents, configure `a2a.consumer` and invoke them programmatically with `createA2AConsumerResponder`. This is a **code** path — see [A2A consumer](../programmatic/a2a-consumer.md).

## Related

- [A2A provider and consumer playbook](../playbooks/a2a-provider-and-consumer.md) — end-to-end two-agent setup.
- [A2A consumer (programmatic)](../programmatic/a2a-consumer.md) — calling remote agents.
- [Multi-agent orchestration](../programmatic/multi-agent.md) — composing agents that delegate over A2A.
- [Config blueprint](../config/blueprint.md) and [environment variables](../config/env-vars.md).
