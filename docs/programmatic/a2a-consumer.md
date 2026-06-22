---
title: "A2A consumer"
sidebar:
  order: 4
---

# A2A consumer

This page covers calling a remote [A2A](https://a2a-protocol.org/) agent from your own mono-agent: discovering its Agent Card, sending messages, and wiring a remote agent in as a responder. The settings live under `a2a.consumer` in config, but **invocation is code-only** — there is no channel that auto-dials remote agents for you. For the inbound (provider) side that exposes *your* agent over A2A, see [A2A channel](/channels/a2a/).

Coverage: **config + code**. Config holds the connection settings; you call `createA2AConsumerResponder` (or the lower-level helpers) yourself, typically from a multi-agent host. See [Multi-agent](/programmatic/multi-agent/) and [Composition](/programmatic/composition/).

## When to use this

Use the consumer when your agent needs to delegate to another A2A-speaking agent — for example a multi-agent host that routes some requests to a specialized remote agent. The remote agent can be another mono-agent running the A2A provider, or any third-party A2A server.

## Config: `a2a.consumer`

The `a2a.consumer` block stores the remote endpoint(s), auth, and timeout. It does not start anything on its own; your code reads it and constructs a responder.

```json
{
  "a2a": {
    "consumer": {
      "remoteAgentUrls": ["http://127.0.0.1:4202"],
      "defaultRemoteAgentUrl": "http://127.0.0.1:4202",
      "bearerToken": "...",
      "timeoutMs": 30000
    }
  }
}
```

| Key | Type | Purpose |
| --- | --- | --- |
| `remoteAgentUrls` | `string[]` | Allowed/known remote agent base URLs. Use this set to drive per-request selection. |
| `defaultRemoteAgentUrl` | `string` | The remote URL to dial when a request does not name one. |
| `bearerToken` | `string` | Bearer token sent on discovery and `sendMessage` calls when the remote requires auth. Keep this as a placeholder in committed config (`sk-...`) and inject the real value via env. |
| `timeoutMs` | `number` | Per-request timeout in milliseconds. |

Keep tokens out of committed config — reference them through environment variables and your config loader. See [Environment variables](/config/env-vars/) for the `MONO_AGENT_*` conventions.

:::caution
:::
There is no auto-wired A2A consumer channel. If you set `a2a.consumer` but never call `createA2AConsumerResponder` (or `sendA2AMessage`), nothing connects to the remote agent.

## `createA2AConsumerResponder`

`createA2AConsumerResponder` returns a standard `AgentResponder`, so a remote A2A agent plugs into the same composition machinery as any local agent. It is **lazy**: the Agent Card discovery and client creation happen on the first `respond()` call, then the connected client is reused for subsequent calls.

```ts
import { createA2AConsumerResponder } from "@mono-agent/a2a-adapter";

const responder = createA2AConsumerResponder({
  agentUrl: "http://127.0.0.1:4202",
  bearerToken: process.env.MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN,
  timeoutMs: 30_000,
});

// Later, on a turn:
const response = await responder.respond(request, stream);
```

Options:

| Option | Type | Notes |
| --- | --- | --- |
| `agentUrl` | `string` | Required. Base URL of the remote agent; its Agent Card is fetched from the well-known card path. |
| `bearerToken` | `string?` | Optional bearer token attached to all outbound requests. |
| `timeoutMs` | `number?` | Optional per-request timeout. |
| `streamRemote` | `boolean?` | When `true` *and* the remote Agent Card advertises streaming, the response is streamed; otherwise a single message is sent and the text appended once. |

On each `respond()`, the responder maps the incoming request onto the remote `sendMessage` call: `request.text` becomes the message text, `request.conversationId` becomes the remote `contextId`, and `request.abortSignal` is forwarded so cancellation propagates to the remote agent.

## Dynamic remote-agent selection

The responder you create from `createA2AConsumerResponder` is bound to a single `agentUrl`. To pick a remote agent **per request**, read `a2a.consumer.remoteAgentUrls` / `defaultRemoteAgentUrl` from config and construct (or look up a cached) responder for the chosen URL at routing time. A simple pattern is a small map keyed by URL:

```ts
import { createA2AConsumerResponder } from "@mono-agent/a2a-adapter";

const responders = new Map<string, ReturnType<typeof createA2AConsumerResponder>>();

function responderFor(agentUrl: string) {
  let r = responders.get(agentUrl);
  if (!r) {
    r = createA2AConsumerResponder({
      agentUrl,
      bearerToken: process.env.MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN,
      timeoutMs: 30_000,
    });
    responders.set(agentUrl, r);
  }
  return r;
}

// Route: use the per-request URL if allowed, else the default.
const target = chosenUrl && allowed.has(chosenUrl) ? chosenUrl : defaultRemoteAgentUrl;
const response = await responderFor(target).respond(request, stream);
```

Validate any caller-supplied URL against `remoteAgentUrls` before dialing it, so a request cannot redirect your agent to an arbitrary endpoint.

:::tip
:::
Because each responder discovers the Agent Card lazily and caches the client, keeping responders in a map (rather than creating one per turn) avoids re-fetching the card on every request.

## Discovery and one-shot send

For lower-level use, the adapter also exposes discovery and a fire-and-forget send:

- `discoverA2AAgent({ agentUrl })` — fetches and validates the remote Agent Card (name, supported interfaces, capabilities such as `streaming`). Useful to confirm reachability and feature support before routing to a remote agent.
- `sendA2AMessage({ agentUrl, text, ... })` — discovers the card and sends a single message, returning the response and its A2A metadata (`remoteAgentUrl`, `protocolVersion`, `taskId`, `contextId`, `state`). Convenient for scripts and one-off calls where you do not need a persistent responder.

## Related

- [A2A channel](/channels/a2a/) — the provider side: exposing your agent over A2A (`a2a.provider`, `a2a.agent`, `a2a.skill`).
- [A2A provider and consumer playbook](/playbooks/a2a-provider-and-consumer/) — end-to-end walkthrough wiring both halves together.
- [Multi-agent](/programmatic/multi-agent/) — composing remote responders into a routing host.
- [Composition](/programmatic/composition/) — how responders are assembled programmatically.
