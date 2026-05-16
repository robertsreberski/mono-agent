# @worklab-ai/whatsapp-adapter

## Category

Category: `communication`

## Responsibility

WhatsApp communication adapter for Mono Agent hosts using Baileys-compatible sockets. It normalizes WhatsApp messages, handles direct and group mention triggers, streams replies, supports cancellation, and enforces explicit chat allowlists or allow-all mode.

## Install / Usage

```bash
pnpm --filter @worklab-ai/whatsapp-adapter run build
```

```ts
import {
  WhatsAppAdapter,
  WhatsAppEventRunner,
  createBaileysWhatsAppSocket,
} from "@worklab-ai/whatsapp-adapter";
```

Hosts provide a Baileys socket, adapter options, and a structural `AgentResponder`.

## Public API

- `WhatsAppAdapter`, `WhatsAppAdapterOptions`
- `WhatsAppEventRunner`
- `createBaileysWhatsAppSocket`
- `normalizeWhatsAppMessage`, `isGroupJid`
- `WhatsAppMessageStream`, `splitWhatsAppText`
- `createRuntimeResponder`
- WhatsApp socket, message, trigger, runtime-responder, and event-runner types

## Dependency Boundary

This adapter can depend on Baileys but must not depend on the harness, operator console, core config, Telegram adapter, memory, or runtime package. It communicates through structural responder and socket interfaces.

## What This Package Does Not Own

It does not manage QR/login persistence policy, build prompts, run models, store memory, expose UI, or define core Mono Agent settings.

## Verification

```bash
pnpm --filter @worklab-ai/whatsapp-adapter run build
pnpm --filter @worklab-ai/whatsapp-adapter run typecheck
pnpm --filter @worklab-ai/whatsapp-adapter run test
```
