---
title: "Telegram"
sidebar:
  order: 1
---

# Telegram

The Telegram channel connects your agent to a Telegram bot over long polling. This page covers enabling it, the chat allowlist, final-only delivery behaviour, inbound attachment download, the environment-variable overrides, and a setup + smoke-test walkthrough.

Coverage: **config** (`telegram.long-polling` in [feature-registry](/reference/feature-matrix/)). The agent talks to a bot you create with BotFather; no inbound port is required.

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
| `pollWatchdogMs` | number | `120000` | Poll-liveness watchdog window. Force-restarts the long-poll runner when no `getUpdates` resolves within the window. On by default; `0` disables. Min `0`, max `3600000`. See [Polling resilience](#polling-resilience-auto-recovery). |
| `transport.ipFamily` | `4` \| `6` | — | Opt-in: pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`). Omit for dual-stack. Workaround for a broken IPv6 route to `api.telegram.org`. |

Provide **either** an `allowedChatIds` allowlist **or** `allowAllChats: true`. Leaving both unset means no chat is authorized.

:::caution
:::
`allowAllChats: true` lets anyone who finds your bot send it messages (and consume model budget). Prefer an explicit `allowedChatIds` allowlist in production.

### Environment variables

Every key has a `MONO_AGENT_TELEGRAM_*` override. Env vars win over JSON, which keeps the bot token out of the committed config — see [Environment Variables](/config/env-vars/).

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_TELEGRAM_ENABLED` | `telegram.enabled` |
| `MONO_AGENT_TELEGRAM_BOT_TOKEN` | `telegram.botToken` |
| `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS` | `telegram.allowedChatIds` (comma-separated) |
| `MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS` | `telegram.allowAllChats` |
| `MONO_AGENT_TELEGRAM_REACTIONS` | `telegram.reactions` |
| `MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS` | `telegram.pollWatchdogMs` (top-level) |
| `MONO_AGENT_TELEGRAM_IP_FAMILY` | `telegram.transport.ipFamily` (nested under `telegram.transport`) |

## Interactive features

All of the features below are **opt-in and default off**. With none configured the bot behaves exactly as before (long-poll `message` updates only).

### Command menu

Register custom slash commands that appear in Telegram's command menu (autocomplete) and run a configured prompt as a turn. Built-in `/start`, `/help`, and `/cancel` are always present and cannot be overridden.

```json
{
  "telegram": {
    "commands": [
      { "command": "brief", "description": "Compose my morning brief", "prompt": "Compose my morning brief." },
      { "command": "about", "description": "What this agent does" }
    ]
  }
}
```

Each entry needs a `command` (1–32 lowercase letters/digits/underscores) and a `description`. With a `prompt`, tapping the command runs it on that chat through the normal per-chat queue; without a `prompt` it is a menu-only entry that echoes its description. The command list is registered via `setMyCommands` at startup (scoped to private chats); it is skipped entirely when no custom commands are configured.

### Status reactions

Set `telegram.reactions: true` to have the bot react to your message with a lifecycle emoji: **👀** while the agent works, **👍** on success, **👎** on failure (and the reaction is cleared when you `/cancel`). Telegram constrains bot reactions to a fixed emoji set, so these stand in for ✅/❌. Best-effort — a missing reaction permission never affects the run.

```json
{ "telegram": { "reactions": true } }
```

Each state can be toggled independently with an object — every key defaults to `true`, so you set the ones you *don't* want to `false`. For example, to keep the working and error reactions but drop the success 👍 (which can feel cluttered):

```json
{ "telegram": { "reactions": { "done": false } } }
```

When a terminal state's reaction is disabled, the working **👀** is **cleared** on completion rather than left lingering — so a turn that only reacts while working ends with a clean, reaction-free message. The `MONO_AGENT_TELEGRAM_REACTIONS` env var is a simple all-on/all-off override; granular per-state control is JSON-only.

### Quiet hours (silent notifications)

Deliver proactive notifications (cron/webhook `notify`) silently during a daily window, so an overnight result lands without a push sound. `start`/`end` are 24-hour `HH:MM` clock times in `timezone` (an IANA zone); an `end` earlier than `start` wraps midnight.

```json
{
  "telegram": {
    "quietHours": { "start": "22:00", "end": "07:00", "timezone": "Europe/Rome" }
  }
}
```

Only the push notification is suppressed (`disable_notification`); the message still arrives. Live replies to your messages are never silenced.

### Asking you a question (inline keyboards)

Expose the `TelegramAskButtons` app tool to let the agent ask you a structured question with tappable buttons — a confirmation, an approval, or a multiple choice — instead of waiting for free-text. Add it to `tools.allowedTools`:

```json
{ "tools": { "allowedTools": ["TelegramAskButtons"] } }
```

The tool takes a `question` and 2–8 option labels and posts an inline keyboard, then **returns immediately** (it does not block the turn). When you tap a button, your choice arrives as a **new message on the same conversation**, so the agent continues on the next turn — exactly like a typed reply, on the warm session. Allowing `TelegramAskButtons` is the single switch that also subscribes the bot to `callback_query` updates and wires the tap handler; the chat allowlist still bounds where questions can be sent, and the tap handler re-checks it.

### Sending files

Expose `TelegramSendFile` to let the agent send a generated file or image back to an allowed chat. A required `kind` selects `"document"` (any file, downloadable) or `"photo"` (an image shown inline). It accepts the bytes as base64 `data` (with a `filename`) **or** a workspace `path`, plus an optional `caption`; uploads are bounded by the adapter's attachment size cap.

```json
{ "tools": { "allowedTools": ["TelegramSendFile"] } }
```

## Final-only delivery

Telegram delivers **only the final answer**. While the run is in flight the bot shows a `typing…` chat action; when the run completes it sends one message with the final text. There are no streamed interim edits on Telegram by default.

This is built-in behaviour, not a JSON field. Restoring live interim streaming requires a custom channel driver with `stream.finalOnly: false` (`createTelegramChannelDriver`) — coverage **code**. See [Delivery and Send Tools](/channels/delivery-and-send-tools/) for the streaming model across channels and [Custom Channels](/programmatic/custom-channels/) to build a driver.

:::note
:::
The OpenAI-compatible [`/v1/chat/completions` endpoint](/channels/openai-api/) still streams token-by-token; final-only applies to the chat adapters (Telegram and Slack).

## Polling resilience (auto-recovery)

The long-poll runner self-heals across transient network failures — a network blip, a host sleep, or a wifi switch — so the bot no longer goes silent until a full process restart. This is on by default and mirrors the Slack [heartbeat watchdog](/channels/slack/).

**Fast failure detection.** The Bot API client HTTP timeout is capped at **50s** (down from grammY's 500s default) and the `getUpdates` long-poll is bounded at **30s**, so a half-open or stalled socket fails fast instead of hanging for minutes. The runner self-retries transient `getUpdates` errors (e.g. `ETIMEDOUT`, `EADDRNOTAVAIL`) with exponential backoff for ~15s before giving up.

**Auto-restart on crash.** On a genuine runner crash (e.g. `ENETUNREACH` after a network switch) an auto-restart monitor recreates the runner with exponential backoff — **500ms** doubling up to a **30s** cap. A runner that stays up for a 30s stability window resets the backoff. A clean, deliberate stop is never auto-restarted.

**Poll-liveness watchdog.** grammY's runner self-retries `getUpdates` internally, so a degraded connection can stop delivering updates *without the task ever rejecting* — the crash monitor can't see it. The `pollWatchdogMs` watchdog (default `120000`; `0` disables) stamps each `getUpdates` resolution and force-restarts a silently-deaf runner that stops delivering updates inside the window. The 120s window sits comfortably above the 30s long-poll, so a normal idle poll never trips it.

**Degraded, not dead.** When a poll crash happens, the channel is marked **`degraded`** (shown via the start log / `mono-agent status` as `degraded: <reason>`) rather than going mute — the responder and harness are kept alive, and the adapter restarts its own runner. Once the restarted runner survives the 30s stability window the channel returns to **`running`** automatically. This is non-fatal and distinct from `failed`. See [the channel status lifecycle](/channels/#opt-in-and-the-status-lifecycle).

**IPv4/IPv6 pin.** The original incident was a broken IPv6 route to `api.telegram.org` (`curl` succeeded on both families in ~50ms, but Node's long-poll `getUpdates` timed out over IPv6). Set `telegram.transport.ipFamily` to `4` or `6` (via `MONO_AGENT_TELEGRAM_IP_FAMILY`) to pin the Bot API HTTP client to a single family; omit it for dual-stack. The family-pinned client uses non-keep-alive sockets so a network switch can't strand a pooled socket bound to the dead interface.

**Bounded startup.** `start()` clears any leftover webhook (`deleteWebhook`) on a best-effort 5s `AbortSignal.timeout`, so a flaky network no longer hangs startup past the launcher's readiness deadline (the cause of a `mono-agent restart` "did not report ready" failure).

## Attachments

Inbound Telegram media (photos, documents, voice, video) is fetched via the Bot API and inlined into `request.attachments`, so the agent receives the bytes alongside the text. A multi-photo/video album arrives as several messages sharing a media group and is aggregated into one request. A download that fails is skipped without failing the run.

Download tuning — byte cap and timeout — is configurable via `telegram.attachments.{maxBytes,downloadTimeoutMs}` (defaults: 20 MiB / 30 s); the MIME allowlist remains **code-only** (`DownloadTelegramAttachmentsOptions`). See [Custom Channels](/programmatic/custom-channels/).

## Self-hosted Bot API server (large files)

The hosted `api.telegram.org` caps bot downloads at 20 MB. Telegram's official self-hosted server ([tdlib/telegram-bot-api](https://github.com/tdlib/telegram-bot-api)) lifts that to 2 GB. Point the adapter at it:

```json
{
  "telegram": {
    "apiRoot": "http://127.0.0.1:8081",
    "attachments": { "maxBytes": 268435456, "maxUploadBytes": 268435456 }
  }
}
```

`apiRoot` is applied to every Bot API call, to file downloads, and to the app send tools (`TelegramSendMessage`/`TelegramAskButtons`/`TelegramSendFile`).

How it behaves with a `--local` server:

- `getFile` downloads the file into the daemon's `--dir` and returns an **absolute local path**; the adapter detects that shape and reads the bytes from disk (stat-checked against `attachments.maxBytes`), then deletes the daemon's copy — the harness has already persisted its own copy into the attachments dir. A missing file (the daemon expires downloads after ~1–25 h) is a clean skip, never a failed run. A non-`--local` self-hosted server (relative paths) is fetched from `<apiRoot>/file/bot<token>/…` instead.
- `TelegramSendFile` (`kind:"document"`) with a `path` input uploads by **`file://` URI** — the daemon reads the file from disk itself, so there is no size buffering in the agent process (the configured `maxUploadBytes` is enforced via stat). If the server rejects the URI, the tool falls back once to a buffered upload. The presented filename is the path's basename.
- **Memory ceiling for inbound files**: attachment bytes still travel as base64 through the request, so keep `attachments.maxBytes` at or below ~256 MiB (peak transient memory is roughly 3.4× the file size; V8's max string length caps the mechanism near 384 MiB decoded).

Operational notes for the daemon: it binds `0.0.0.0` **by default** — always pass `--http-ip-address=127.0.0.1` (it has no TLS/auth beyond the bot token in the path); it needs `api_id`/`api_hash` from [my.telegram.org](https://my.telegram.org); a bot must `logOut` of the hosted API before its first local login, and cannot log back into the hosted API for **10 minutes** after; long polling works unchanged, so no webhook or inbound exposure is needed.

## Sending without a prompt

When the Telegram adapter is enabled you can let the agent send Telegram messages on its own initiative by exposing the `TelegramSendMessage` app tool. Add the exact tool name to `tools.allowedTools`:

```json
{
  "tools": {
    "allowedTools": ["TelegramSendMessage"]
  }
}
```

The existing `telegram.*` adapter config (token + chat allowlist) remains the destination boundary — the tool can only send where the adapter is already permitted. This powers proactive/async delivery; see [Delivery and Send Tools](/channels/delivery-and-send-tools/) and [Tool Policy](/tools/policy/).

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

- [Channels overview](/channels/)
- [Delivery and Send Tools](/channels/delivery-and-send-tools/)
- [Slack](/channels/slack/) · [WhatsApp](/channels/whatsapp/)
- [Sessions and Concurrency](/runtime/sessions-concurrency/) — per-conversation admission and download bounds
- [Telegram personal assistant playbook](/playbooks/telegram-personal-assistant-bujo/)
