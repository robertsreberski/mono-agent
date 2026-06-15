# @mono-agent/whatsapp-adapter

## Category

Category: `communication`

## Responsibility

WhatsApp communication adapter for agent hosts using Baileys-compatible sockets. It normalizes WhatsApp messages, handles direct and group mention triggers, streams replies, supports cancellation, and enforces explicit chat allowlists or allow-all mode.

The adapter is opt-in: `whatsapp.enabled` / `MONO_AGENT_WHATSAPP_ENABLED` defaults to `false`. While disabled the loader skips allowlist validation and the channel reports `disabled` rather than `waiting_for_config`. Set `enabled: true` to turn it on; a missing allowlist (without allow-all) then surfaces as a real `waiting_for_config` reason.

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
  whatsappFieldGroup,
} from "@mono-agent/whatsapp-adapter";
```

Hosts provide a Baileys socket, adapter options, and a structural `AgentResponder`. The base responder, stream, response, and cancellation contracts come from `@mono-agent/agent-contracts`.

## Public API

- `WhatsAppAdapter`, `WhatsAppAdapterOptions`
- `WhatsAppEventRunner`
- `createBaileysWhatsAppSocket`
- `normalizeWhatsAppMessage`, `isGroupJid`
- `WhatsAppMessageStream`, `splitWhatsAppText`
- `loadWhatsAppAdapterConfig`, `redactWhatsAppAdapterConfig`, `whatsappFieldGroup`
- WhatsApp socket, message, trigger, config, and event-runner types

## Dependency Boundary

This adapter depends on Baileys plus shared contracts/settings primitives, but must not depend on the harness, operator console, core config, another communication adapter, memory, or runtime package. It communicates through structural responder and socket interfaces.

## What This Package Does Not Own

It does not manage QR/login persistence policy, build prompts, run models, store memory, expose UI, or define core core agent settings.

## Verification

```bash
pnpm --filter @mono-agent/whatsapp-adapter run build
pnpm --filter @mono-agent/whatsapp-adapter run typecheck
pnpm --filter @mono-agent/whatsapp-adapter run test
```
