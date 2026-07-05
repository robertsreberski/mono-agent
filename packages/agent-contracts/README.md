# @mono-agent/agent-contracts

## Category

Category: `core`

## Responsibility

Shared structural contracts for agent request/response boundaries. It defines the adapter-neutral agent request base, response, message stream, responder, and cancellation error used by harnesses, communication adapters, and operator surfaces. It also owns the neutral channel-driver contract (`ChannelDriver`, `ChannelStartInput`, `RunningChannel`, `ChannelStatus`, config-view/notify shapes) that hosts run channels through and third-party channel authors implement without depending on a host package. Adapter-neutral settings JSON storage, JSON-to-env loader helpers, safe-bind/listen guards, and bearer-token helpers live here too so adapters can share them without depending on a separate core package.

## Install / Usage

```bash
pnpm --filter @mono-agent/agent-contracts run build
```

```ts
import { assertSafeBind, readSettingsJson } from "@mono-agent/agent-contracts";
import type { AgentResponder } from "@mono-agent/agent-contracts";
```

Adapter packages extend the base request with transport metadata while keeping the responder and stream shapes compatible across hosts.

## Public API

- `AgentRequestBase`, `AgentResponse`, `AgentMessageStream`, `AgentStreamEvent`, `AgentResponder`
- `AgentResponseCancelledError`, `isAgentResponseCancelledError`
- `AgentRequestMetadata`, `AgentResponseMetadata`, `AgentMessageStreamResult`
- Channel contract: `ChannelDriver`, `ChannelStartInput`, `RunningChannel`, `ChannelStatus`, `ChannelId`, `ChannelLogger`, `ChannelConfigInput`, `ChannelConfigViewSection`/`ChannelConfigViewField`, `NotifyDeliveryResult`, `NotifyDestination`. The driver contract is generic over the host's core-config type (`TCore`), so this package stays dependency-free while hosts bind their own config type.
- Settings helpers: `readSettingsJson`, `writeSettingsJson`, `SettingsJsonError`, JSON/env coercion helpers, `assertSafeBind`, `listen`, `close`, `generateBearerToken`, `bearerTokensEqual`, and related types.

## Dependency Boundary

This package has no workspace or provider dependency. It must remain adapter-neutral and should not mention transport-specific packages, host config semantics, or runtime implementations.

## What This Package Does Not Own

It does not normalize transport messages, run model providers, build prompts, persist memory, stream to a concrete UI, or define host configuration semantics.

## Verification

```bash
pnpm --filter @mono-agent/agent-contracts run build
pnpm --filter @mono-agent/agent-contracts run typecheck
pnpm --filter @mono-agent/agent-contracts run test
```
