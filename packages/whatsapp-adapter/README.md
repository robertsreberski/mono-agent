# @mono-agent/whatsapp-adapter

## Category

Category: `communication`

## Responsibility

WhatsApp communication adapter for Mono Agent hosts using Baileys-compatible sockets. It normalizes WhatsApp messages, handles direct and group mention triggers, streams replies, supports cancellation, and enforces explicit chat allowlists or allow-all mode.

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

It does not manage QR/login persistence policy, build prompts, run models, store memory, expose UI, or define core Mono Agent settings.

## Verification

```bash
pnpm --filter @mono-agent/whatsapp-adapter run build
pnpm --filter @mono-agent/whatsapp-adapter run typecheck
pnpm --filter @mono-agent/whatsapp-adapter run test
```
