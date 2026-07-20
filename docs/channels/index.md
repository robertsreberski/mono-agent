---
title: "Channels"
sidebar:
  order: 0
---

# Channels

Channels are how a mono-agent receives input and delivers replies. Core channels use independent JSON sections in `mono-agent.config.json`; external channel packages are declared under `channels.plugins[]` and return the same `ChannelDriver` shape. Each channel is opt-in via its own `enabled` flag and composed into the running host by `@mono-agent/agent-app`. This page explains the shared lifecycle, how to pick a channel, and links to every per-channel guide. Coverage: **config** unless a feature is noted otherwise.

## Core channels

| Channel | Transport | Section | Guide |
| --- | --- | --- | --- |
| Telegram | Bot long polling | `telegram` | [Telegram](/channels/telegram/) |
| Slack | Socket Mode bot | `slack` | [Slack](/channels/slack/) |
| Webhook | HTTP POST, sync or async | `webhook` | [Webhook](/channels/webhook/) |
| OpenAI-compatible API | `/v1/chat/completions` (SSE) | `openaiApi` | [OpenAI-compatible API](/channels/openai-api/) |
| Cron | Scheduled prompts | `cron` | [Cron](/channels/cron/) |
| Operator stream endpoint | Loopback NDJSON turns for `mono-agent tui` and `mono-agent web` | `tui` | [Operator stream endpoint](/channels/tui/) |
| Live event relay | Loopback SSE stream of run lifecycle frames (read-only run-event operator surface) | `live` | [Live event relay](/channels/tui/#live-event-relay-for-session-recorder) |

## External channel packages

| Channel | Transport | Plugin package | Guide |
| --- | --- | --- | --- |
| WhatsApp | Baileys socket (QR login) | `@mono-agent/whatsapp-adapter` | [WhatsApp](/channels/whatsapp/) |
| A2A | Agent-to-Agent provider/consumer | `@mono-agent/a2a-adapter` | [A2A](/channels/a2a/) |

Channels are fully independent: enabling one neither requires nor affects another, and a misconfigured channel never blocks the rest of the host from starting.

## Opt-in and the status lifecycle

Most channels default to **off**. The deliberate exceptions are the operator surfaces: the [`tui` operator stream endpoint](/channels/tui/) and the `live` event relay both default to **on** (loopback-only, ephemeral ports, so the TUI/web console can chat and operator tooling can observe runs without a config edit). Set `"tui": {"enabled": false}` or `"live": {"enabled": false}` to opt out. You turn other channels on with `enabled: true` and supply their required settings; external channels also need a `channels.plugins[]` entry naming the package. On `mono-agent start`, the host prints one status line per channel reflecting one of five states:

| State | Meaning |
| --- | --- |
| `disabled` | `enabled` is false (or unset). The channel is inert. |
| `waiting_for_config` | `enabled: true` but a required setting is missing — the line names the exact missing field. |
| `running` | Ready and listening; the line includes endpoint facts (host/port/path, or the bot it connected as). |
| `degraded` | Was running but the live transport connection dropped on a transient failure (e.g. a Telegram poll crash on a network switch, or a Slack Socket Mode disconnect); the responder/harness is kept alive and the adapter is reconnecting, so the channel keeps serving. Rendered `degraded: <reason>` with a warning badge. Non-fatal and self-recovering — it returns to `running` automatically once the transport stays up, unlike `failed`. |
| `failed` | The channel errored on startup; the line includes the reason. |

```json
{
  "telegram": {
    "enabled": true,
    "allowedChatIds": ["123456789"]
  }
}
```

Put `MONO_AGENT_TELEGRAM_BOT_TOKEN=...` in the agent's `.env`; source-config examples omit credentials even though inline fields remain accepted for compatibility.

:::tip
Run `mono-agent validate` for a per-section report before starting, and `mono-agent status` to read the live state. Config is JSON-first — edit `mono-agent.config.json` (agents can edit it too) and `mono-agent restart` to apply; there is no live re-apply.
:::

## Environment variables

Every field can also be set with a `MONO_AGENT_<CHANNEL>_*` environment variable, which is convenient for secrets you do not want in the JSON file. A `.env` in the agent folder is loaded automatically (exported shell variables win); use `--env-file <path>` for an alternate file. Per-channel env var names are listed in each channel's guide. See [Environment variables](/config/env-vars/) for the full mapping.

```bash
export MONO_AGENT_TELEGRAM_ENABLED=true
export MONO_AGENT_TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOT_TOKEN
```

## Which channel?

Pick by who or what is on the other end:

| You want… | Use | Why |
| --- | --- | --- |
| A human chatting interactively | [Telegram](/channels/telegram/), [Slack](/channels/slack/), or [WhatsApp](/channels/whatsapp/) | Conversational adapters with allowlists, working indicators, and final-answer delivery; WhatsApp is loaded as an external plugin |
| Programmatic / pipeline invocation | [Webhook](/channels/webhook/) or [A2A](/channels/a2a/) | Webhook for plain HTTP POST (sync or async polling); A2A for agent-to-agent calls with Agent Card discovery and is loaded as an external plugin |
| A chat UI (e.g. Open WebUI) | [OpenAI-compatible API](/channels/openai-api/) | Exposes `/v1/models` + `/v1/chat/completions` with token-by-token SSE streaming |
| Scheduled / unattended runs | [Cron](/channels/cron/) | Timezone-aware five-field jobs that invoke the responder on a schedule |

You can enable any combination — for example Telegram for your own use plus a webhook for automation and cron for a daily digest.

## Concurrency is per-channel

The app builds one runtime harness per channel, and each harness holds its own concurrency limiter. The `concurrency.*` bounds therefore apply to **each** channel independently, not as a single global cap: with N enabled channels the effective ceiling is N× the configured value. See [Sessions & concurrency](/runtime/sessions-concurrency/) for `maxConcurrentRuns` / `maxPendingRuns` and the admission model.

:::note
Conversational adapters (Slack/Telegram) do per-conversation admission and attachment downloads *before* the harness run boundary, so cross-conversation transport download IO is not covered by the harness concurrency bounds (per-file byte caps and timeouts apply instead). Adapter queues are drained/aborted on `/cancel` and stop.
:::

## Sending and proactive delivery

Replies go back over the same channel that received the request. To send *outbound* messages — proactive notifications from cron/webhook turns, or app-owned send tools like `SlackSendMessage` and `TelegramSendMessage` — see [Delivery & send tools](/channels/delivery-and-send-tools/). Note that these send tools require the target adapter to already be enabled and configured, and the adapter's own allowlist remains the delivery boundary.

## Custom transports

For a bespoke transport, implement a `ChannelDriver` from `@mono-agent/agent-contracts` and either expose it from a package loaded by `channels.plugins[]` or pass it via `startMonoAgentApp({ drivers })`. See [Write your own channel adapter](/programmatic/custom-channels/).
