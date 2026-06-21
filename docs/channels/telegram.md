---
title: "Telegram"
parent: "Channels"
nav_order: 1
---

# Telegram

The Telegram channel connects your agent to a Telegram bot over long polling. This page covers enabling it, the chat allowlist, final-only delivery behaviour, inbound attachment download, the environment-variable overrides, and a setup + smoke-test walkthrough.

Coverage: **config** (`telegram.long-polling` in [feature-registry](../reference/feature-matrix.md)). The agent talks to a bot you create with BotFather; no inbound port is required.

## Configuration

Add a `telegram` block to your `mono-agent.config.json`. The channel is opt-in: with no block, or `enabled: false`, the channel reports as **disabled** (not "waiting").

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "123456789:AA...",
    "allowedChatIds": ["123456789"],
    "allowAllChats": false
  }
}
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Opt-in switch. Off → channel is disabled. |
| `botToken` | string | — | Bot token issued by [BotFather](https://t.me/BotFather). Required when enabled. |
| `allowedChatIds` | string[] | — | Chat IDs (as strings) permitted to talk to the agent. |
| `allowAllChats` | boolean | `false` | When `true`, accept any chat. Mutually exclusive with a populated `allowedChatIds`. |

Provide **either** an `allowedChatIds` allowlist **or** `allowAllChats: true`. Leaving both unset means no chat is authorized.

{: .warning }
`allowAllChats: true` lets anyone who finds your bot send it messages (and consume model budget). Prefer an explicit `allowedChatIds` allowlist in production.

### Environment variables

Every key has a `MONO_AGENT_TELEGRAM_*` override. Env vars win over JSON, which keeps the bot token out of the committed config — see [Environment Variables](../config/env-vars.md).

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_TELEGRAM_ENABLED` | `telegram.enabled` |
| `MONO_AGENT_TELEGRAM_BOT_TOKEN` | `telegram.botToken` |
| `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS` | `telegram.allowedChatIds` (comma-separated) |
| `MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS` | `telegram.allowAllChats` |

## Final-only delivery

Telegram delivers **only the final answer**. While the run is in flight the bot shows a `typing…` chat action; when the run completes it sends one message with the final text. There are no streamed interim edits on Telegram by default.

This is built-in behaviour, not a JSON field. Restoring live interim streaming requires a custom channel driver with `stream.finalOnly: false` (`createTelegramChannelDriver`) — coverage **code**. See [Delivery and Send Tools](./delivery-and-send-tools.md) for the streaming model across channels and [Custom Channels](../programmatic/custom-channels.md) to build a driver.

{: .note }
The OpenAI-compatible [`/v1/chat/completions` endpoint](./openai-api.md) still streams token-by-token; final-only applies to the chat adapters (Telegram and Slack).

## Attachments

Inbound Telegram media (photos, documents, voice, video) is fetched via the Bot API and inlined into `request.attachments`, so the agent receives the bytes alongside the text. A multi-photo/video album arrives as several messages sharing a media group and is aggregated into one request. A download that fails is skipped without failing the run.

Download tuning — byte cap, MIME allowlist, and timeout — is exposed on the adapter's `attachments` option and is **code-only** (`DownloadTelegramAttachmentsOptions`). See [Custom Channels](../programmatic/custom-channels.md).

## Sending without a prompt

When the Telegram adapter is enabled you can let the agent send Telegram messages on its own initiative by exposing the `telegram_send_message` app tool. Add the exact tool name to `tools.allowedTools`:

```json
{
  "tools": {
    "allowedTools": ["telegram_send_message"]
  }
}
```

The existing `telegram.*` adapter config (token + chat allowlist) remains the destination boundary — the tool can only send where the adapter is already permitted. This powers proactive/async delivery; see [Delivery and Send Tools](./delivery-and-send-tools.md) and [Tool Policy](../tools/policy.md).

## Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram and run `/newbot`. Follow the prompts to name the bot and get its token (`123456789:AA...`).
2. Put the token in your config or, preferably, in the environment:

   ```bash
   export MONO_AGENT_TELEGRAM_BOT_TOKEN="123456789:AA..."
   ```

3. Find the chat ID(s) you want to allow. Send your bot a message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[].message.chat.id`. Add it to `allowedChatIds`.
4. Set `telegram.enabled` to `true`.
5. Validate and start:

   ```bash
   mono-agent validate
   mono-agent start
   ```

## Smoke test

With the agent running, send your bot a direct message (`Hello`) from an allowed chat. You should see the `typing…` indicator, followed by a single reply containing the final answer. If nothing happens:

- Confirm the chat ID is in `allowedChatIds` (or set `allowAllChats: true` temporarily) — messages from non-allowlisted chats are ignored.
- Confirm `enabled: true` and that the start log shows the Telegram channel as active rather than disabled.
- Check that only one process is polling the bot; Telegram allows a single long-polling consumer per token.

## Related

- [Channels overview](./index.md)
- [Delivery and Send Tools](./delivery-and-send-tools.md)
- [Slack](./slack.md) · [WhatsApp](./whatsapp.md)
- [Sessions and Concurrency](../runtime/sessions-concurrency.md) — per-conversation admission and download bounds
- [Telegram personal assistant playbook](../playbooks/telegram-personal-assistant-bujo.md)
