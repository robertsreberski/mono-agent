# @mono-agent/telegram-adapter

## Category

Category: `communication`

## Responsibility

Telegram communication adapter for agent hosts. It provides a Bot API client, long poller, update handler, streamed message edits, cancellation, allowlist enforcement, and Telegram-owned settings helpers.

The adapter is opt-in: `telegram.enabled` / `MONO_AGENT_TELEGRAM_ENABLED` defaults to `false`. While disabled the loader skips credential validation and the channel reports `disabled` rather than `waiting_for_config`. Set `enabled: true` to turn it on; a missing bot token or allowlist then surfaces as a real `waiting_for_config` reason.

Inbound Telegram document, photo, audio, video, and voice messages are routed to the responder as Telegram-owned attachment metadata. Captions remain the request text; media-only messages get a concise text summary so existing text-only responder paths can still reason about what arrived. The adapter does not download file bytes, expose Bot API file URLs, or claim model-level file/vision support.

## Install / Usage

```bash
pnpm --filter @mono-agent/telegram-adapter run build
```

```ts
import {
  createTelegramBot,
  createGrammyTelegramApi,
  loadTelegramAdapterConfig,
  startTelegramAdapter,
  telegramFieldGroup,
} from "@mono-agent/telegram-adapter";
```

Load adapter settings separately from core config, then pass a structural `AgentResponder` from the host or harness. The base responder, stream, response, and cancellation contracts come from `@mono-agent/agent-contracts`.

## Public API

- `createTelegramBot`, `startTelegramAdapter`
- `createGrammyTelegramApi`, `TelegramApiError`
- `TelegramMessageStream`, `classifyTelegramError`
- `loadTelegramAdapterConfig`, `redactTelegramAdapterConfig`, `telegramFieldGroup`
- `TelegramAttachment` and related Telegram-owned inbound attachment metadata types
- Telegram Bot API, request/response, and config types

## Dependency Boundary

This adapter depends only on shared contracts and settings primitives inside the workspace. It does not depend on the harness, operator console, core config, memory, runtime package, or other adapters. Hosts compose those pieces outside the adapter.

## What This Package Does Not Own

It does not build prompts, run models, store memory, serve UI, manage provider credentials, or decide core runtime settings.

## Verification

```bash
pnpm --filter @mono-agent/telegram-adapter run build
pnpm --filter @mono-agent/telegram-adapter run typecheck
pnpm --filter @mono-agent/telegram-adapter run test
```
