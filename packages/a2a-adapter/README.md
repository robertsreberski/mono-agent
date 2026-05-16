# @worklab-ai/a2a-adapter

Category: `communication`

## Category

Communication adapter.

## Responsibility

Expose a Mono Agent responder as an A2A provider and call remote A2A agents through direct Agent Card discovery.

## Install / Usage

```bash
pnpm add @worklab-ai/a2a-adapter
```

Provider usage starts a loopback HTTP server by default and serves the Agent Card at `/.well-known/agent-card.json`.

## Public API

- `startA2AProvider`
- `createA2AAgentCard`
- `createA2AConsumer`
- `discoverA2AAgent`
- `sendA2AMessage`
- `createA2AConsumerResponder`
- `a2aFieldGroup`
- `loadA2AAdapterConfig`
- `redactA2AAdapterConfig`

## Dependency Boundary

This package depends only on core Mono Agent contracts/settings plus the pinned A2A SDK and Express transport surface. It does not depend on the agent harness or other communication adapters.

## What This Package Does Not Own

It does not own runtime execution, memory, tool policy, central registries, signed cards, push notifications, file exchange, gRPC hosting, or autonomous LLM-selected remote-agent delegation.

## Verification

Run:

```bash
pnpm --filter @worklab-ai/a2a-adapter run build
pnpm --filter @worklab-ai/a2a-adapter run typecheck
pnpm --filter @worklab-ai/a2a-adapter run test
```
