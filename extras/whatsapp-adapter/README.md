# @mono-agent/whatsapp-adapter

## Category

Category: `communication`

## Responsibility

WhatsApp communication adapter for agent hosts using Baileys-compatible sockets. It normalizes WhatsApp messages, handles direct and group mention triggers, streams replies, supports cancellation, and enforces explicit chat allowlists or allow-all mode.

This is a **plugin-tier** package: it publishes to npm in the mono-agent lockstep at the same version as the core packages, but it is not part of the core `@mono-agent/agent-app` dependency closure. `@mono-agent/agent-app` loads it only when a host declares it under `channels.plugins[]`.

**Upgrading from 0.4.0 (npm skew):** the standalone `0.4.0` build predates the `channels.plugins[]` seam — it has no `createChannelDriver` export, so `agent-app` refuses it with `Channel plugin @mono-agent/whatsapp-adapter must export createChannelDriver(options) returning a ChannelDriver`, and it drags the retired `@mono-agent/settings` package into your install tree. Upgrade to the current lockstep version (matching your `@mono-agent/agent-app`) to fix both.

The adapter is opt-in: plugin `config.enabled` / `MONO_AGENT_WHATSAPP_ENABLED` defaults to `false`. While disabled the loader skips allowlist validation and the channel reports `disabled` rather than `waiting_for_config`. Set `enabled: true` to turn it on; a missing allowlist (without allow-all) then surfaces as a real `waiting_for_config` reason.

## Install / Usage

```bash
pnpm --filter @mono-agent/whatsapp-adapter run build
```

```ts
import {
  WhatsAppAdapter,
  WhatsAppEventRunner,
  createBaileysWhatsAppSocket,
  loadWhatsAppAdapterConfig,
  WHATSAPP_CONFIG_FIELDS,
} from "@mono-agent/whatsapp-adapter";
```

Config-loaded channel usage:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": {
          "enabled": true,
          "allowedChatJids": ["123@s.whatsapp.net"]
        }
      }
    ]
  }
}
```

Hosts provide a Baileys socket, adapter options, and a structural `AgentResponder`. The base responder, stream, response, and cancellation contracts come from `@mono-agent/agent-contracts`.

## Public API

- `WhatsAppAdapter`, `WhatsAppAdapterOptions`
- `WhatsAppEventRunner`
- `createBaileysWhatsAppSocket`
- `createWhatsAppChannelDriver`, `createChannelDriver`
- `normalizeWhatsAppMessage`, `isGroupJid`
- `WhatsAppMessageStream`
- `loadWhatsAppAdapterConfig`, `redactWhatsAppAdapterConfig`, `WHATSAPP_CONFIG_FIELDS`
- WhatsApp socket, message, trigger, config, channel-driver, and event-runner types

## Dependency Boundary

This adapter depends on Baileys plus shared `@mono-agent/agent-contracts` primitives, but must not depend on the harness, core config, another communication adapter, memory, or runtime package. It communicates through structural responder and socket interfaces.

## What This Package Does Not Own

It does not manage QR/login persistence policy, build prompts, run models, store memory, expose UI, or define core core agent settings.

## Verification

```bash
pnpm --filter @mono-agent/whatsapp-adapter run build
pnpm --filter @mono-agent/whatsapp-adapter run typecheck
pnpm --filter @mono-agent/whatsapp-adapter run test
```
