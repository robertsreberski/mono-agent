# @mono-agent/a2a-adapter

Category: `communication`

## Category

Communication adapter.

## Responsibility

Expose a agent responder as an A2A provider and call remote A2A agents through direct Agent Card discovery.

This is a **plugin-tier** package: it publishes to npm in the mono-agent lockstep at the same version as the core packages, but it is not part of the core `@mono-agent/agent-app` dependency closure. `@mono-agent/agent-app` loads its provider channel only when a host declares it under `channels.plugins[]`.

**Upgrading from 0.4.0 (npm skew):** the standalone `0.4.0` build predates the `channels.plugins[]` seam — it has no `createChannelDriver` export, so `agent-app` refuses it with `Channel plugin @mono-agent/a2a-adapter must export createChannelDriver(options) returning a ChannelDriver`, and it drags the retired `@mono-agent/settings` package into your install tree. Upgrade to the current lockstep version (matching your `@mono-agent/agent-app`) to fix both.

## Install / Usage

```bash
pnpm --filter @mono-agent/a2a-adapter run build
```

Provider usage starts a loopback HTTP server by default and serves the Agent Card at `/.well-known/agent-card.json`. Message/task endpoints are available under `/a2a/json-rpc` and `/a2a/rest`.

```ts
import { startA2AProvider } from "@mono-agent/a2a-adapter";

const provider = await startA2AProvider({
  host: "127.0.0.1",
  port: 4300,
  responder,
  agent: {
    name: "Agent A",
    description: "Local A2A provider.",
    version: "0.1.0",
  },
  skill: {
    id: "agent-a",
    name: "Agent A",
    description: "Answers text prompts.",
    tags: ["mono-agent", "a2a"],
  },
});

console.log(provider.agentCardUrl);
```

Consumer usage discovers a direct Agent Card URL and sends text:

```ts
import { sendA2AMessage } from "@mono-agent/a2a-adapter";

const response = await sendA2AMessage({
  agentUrl: "http://127.0.0.1:4300/.well-known/agent-card.json",
  text: "Hello from Agent B.",
});
```

## Public API

- `startA2AProvider`
- `createA2AChannelDriver`
- `createChannelDriver`
- `createA2AAgentCard`
- `createA2AConsumer`
- `discoverA2AAgent`
- `sendA2AMessage`
- `createA2AConsumerResponder`
- `A2A_CONFIG_FIELDS`
- `loadA2AAdapterConfig`
- `redactA2AAdapterConfig`

Config can be loaded from a `channels.plugins[]` entry or explicit environment variables:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/a2a-adapter",
        "id": "a2a",
        "config": {
          "enabled": true,
          "provider": {
            "host": "127.0.0.1",
            "port": 4300,
            "requireBearer": true,
            "bearerToken": "redacted-value"
          },
          "agent": {
            "name": "Agent A",
            "description": "Local A2A provider.",
            "version": "0.1.0"
          },
          "skill": {
            "id": "agent-a",
            "name": "Agent A",
            "description": "Answers text prompts.",
            "tags": ["mono-agent", "a2a"]
          },
          "consumer": {
            "remoteAgentUrls": ["http://127.0.0.1:4300/.well-known/agent-card.json"],
            "timeoutMs": 30000
          }
        }
      }
    ]
  }
}
```

Important env names:

- `MONO_AGENT_A2A_ENABLED`
- `MONO_AGENT_A2A_PROVIDER_ENABLED`
- `MONO_AGENT_A2A_HOST`
- `MONO_AGENT_A2A_PORT`
- `MONO_AGENT_A2A_PUBLIC_BASE_URL`
- `MONO_AGENT_A2A_ALLOW_NON_LOOPBACK`
- `MONO_AGENT_A2A_REQUIRE_BEARER`
- `MONO_AGENT_A2A_BEARER_TOKEN`
- `MONO_AGENT_A2A_AGENT_NAME`
- `MONO_AGENT_A2A_AGENT_DESCRIPTION`
- `MONO_AGENT_A2A_AGENT_VERSION`
- `MONO_AGENT_A2A_SKILL_ID`
- `MONO_AGENT_A2A_SKILL_NAME`
- `MONO_AGENT_A2A_SKILL_DESCRIPTION`
- `MONO_AGENT_A2A_SKILL_TAGS`
- `MONO_AGENT_A2A_REMOTE_AGENT_URLS`
- `MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL`
- `MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN`
- `MONO_AGENT_A2A_TIMEOUT_MS`

## Dependency Boundary

This package depends only on `@mono-agent/agent-contracts` plus the pinned A2A SDK and Express transport surface. It does not depend on the agent harness, config package, operator surfaces, or other communication adapters.

## What This Package Does Not Own

It does not own runtime execution, memory, tool policy, central registries, signed cards, push notifications, file exchange, gRPC hosting, or autonomous LLM-selected remote-agent delegation. This pass supports direct discovery and text/task communication only.

## Verification

Run:

```bash
pnpm --filter @mono-agent/a2a-adapter run build
pnpm --filter @mono-agent/a2a-adapter run typecheck
pnpm --filter @mono-agent/a2a-adapter run test
```
