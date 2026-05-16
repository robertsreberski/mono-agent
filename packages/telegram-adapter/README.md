# @worklab-ai/telegram-adapter

## Category

Category: `communication`

## Responsibility

Telegram communication adapter for Mono Agent hosts. It provides a Bot API client, long poller, update handler, streamed message edits, cancellation, allowlist enforcement, and Telegram-owned settings helpers.

## Install / Usage

```bash
pnpm --filter @worklab-ai/telegram-adapter run build
```

```ts
import {
  TelegramAdapter,
  TelegramBotApiClient,
  TelegramLongPoller,
  loadTelegramAdapterConfig,
  telegramFieldGroup,
} from "@worklab-ai/telegram-adapter";
```

Load adapter settings separately from core config, then pass a structural `AgentResponder` from the host or harness. The base responder, stream, response, and cancellation contracts come from `@worklab-ai/agent-contracts`.

## Public API

- `TelegramAdapter`, `TelegramAdapterOptions`
- `TelegramBotApiClient`, `TelegramApiError`
- `TelegramLongPoller`
- `TelegramMessageStream`, `splitTelegramText`
- `createRuntimeResponder`
- `loadTelegramAdapterConfig`, `redactTelegramAdapterConfig`, `telegramFieldGroup`
- Telegram Bot API, request/response, runtime-responder, and config types

## Dependency Boundary

This adapter depends only on shared contracts and settings primitives inside the workspace. It does not depend on the harness, operator console, core config, memory, runtime package, or other adapters. Hosts compose those pieces outside the adapter.

## What This Package Does Not Own

It does not build prompts, run models, store memory, serve UI, manage provider credentials, or decide core Mono Agent runtime settings.

## Verification

```bash
pnpm --filter @worklab-ai/telegram-adapter run build
pnpm --filter @worklab-ai/telegram-adapter run typecheck
pnpm --filter @worklab-ai/telegram-adapter run test
```
