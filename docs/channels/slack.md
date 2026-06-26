---
title: "Slack"
sidebar:
  order: 2
---

# Slack

The Slack channel connects your agent to a Slack workspace over **Socket Mode** (no public inbound URL required). It is mention-triggered, shows a 👀 "seen" reaction while it works, and delivers only the final answer. Coverage: **config** (`slack.socket-mode`).

## How it works

- **Socket Mode transport.** The adapter opens a WebSocket to Slack using an app-level token, so you do not host a public endpoint. The app-level token must carry the `connections:write` scope.
- **Mention-triggered.** The agent responds when it is mentioned (a real `@bot` mention matching `botUserIds`, or a text alias from `mentionTextAliases`). Channels must be allowed via `allowedChannelIds` or `allowAllChannels`.
- **Final-only delivery.** Like Telegram, Slack delivers only the final answer rather than streaming interim edits. While the run is in flight the adapter adds a 👀 reaction to the triggering message as a working indicator. This is the default (`stream.finalOnly: true`); see [Delivery and send tools](/channels/delivery-and-send-tools/).
- **Heartbeat watchdog.** A long-lived Socket Mode connection can go *half-open* — after the host sleeps or a network blip, the WebSocket stops delivering frames but never fires `close`/`error`, so the agent silently stops responding to Slack while still looking healthy. To recover, the adapter probes an otherwise-idle socket with a ping every **30 s** and force-recycles it if no frame (message, ping, or pong) arrives within **90 s** of silence; the recycle fires `close`, which the existing reconnect/backoff loop picks up. A healthy-but-idle socket stays up because Slack's own server pings refresh the activity timer, so there are no false recycles. This is **on by default**.
- **Resilient reconnect + degraded recovery.** On a non-graceful exit (a `too_many_websockets`/unknown disconnect, a socket error, or a watchdog recycle) the adapter does a **terminate-first** teardown — it drops the TCP connection immediately rather than waiting on a close handshake a throttled or half-dead peer may never complete, which otherwise leaves an orphaned socket counting against Slack's per-app budget and triggers `too_many_websockets` churn. It then reconnects with exponential backoff (**500 ms → 30 s**, **jitter on by default**, ratio 0.2); the backoff only resets after a connection stays open past a **30 s stability window** (so a connection flapping just under that window climbs to the 30 s cap instead of resetting on each reconnect). Slack's own `warning` / `refresh_requested` reasons take a **graceful** no-backoff path. A startup-grace window quietly retries a lingering prior-process socket instead of flagging a problem. When a non-graceful loss occurs the channel reports **`degraded`** (the responder stays alive) and returns to **`running`** once a reconnect survives the stability window. This mirrors the Telegram poller's resilience.

:::note
The heartbeat and reconnect behavior are **on by default and need no configuration** — the defaults apply automatically. They are also **operator-tunable** via optional `slack.*` keys (or `MONO_AGENT_SLACK_*` env vars); see [Resilience tuning](#resilience-tuning) below.
:::

## Configuration

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedChannelIds": ["C0123"],
    "allowAllChannels": false,
    "botUserIds": ["U0BOT"],
    "mentionTextAliases": ["@agent"],
    "stripMentionText": true
  }
}
```

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Opt-in flag. While `false` the channel reports `disabled` (not `waiting_for_config`) and token validation is skipped. |
| `botToken` | string (`xoxb-...`) | — | Bot user OAuth token. **Required** when enabled. |
| `appToken` | string (`xapp-...`) | — | App-level token for Socket Mode (`connections:write`). **Required** when enabled. |
| `allowedChannelIds` | string[] | — | Channel IDs the agent may respond in. Required unless `allowAllChannels` is `true`. |
| `allowAllChannels` | boolean | `false` | Respond in any channel the bot is in. Alternative to `allowedChannelIds`. |
| `botUserIds` | string[] | — | The bot's Slack user ID(s), used to detect real `@bot` mentions. |
| `mentionTextAliases` | string[] | — | Plain-text aliases (e.g. `@agent`) that also trigger a response. |
| `stripMentionText` | boolean | `true` | Strip the mention/alias text from the prompt before the agent sees it. |

:::caution
Both `botToken` and `appToken` are required when `enabled: true`. If either is missing, or if neither `allowedChannelIds` nor `allowAllChannels` is set, the channel reports `waiting_for_config` instead of starting.
:::

### Environment variables

Every key has an env override (env precedence: process env > `mono-agent.config.json` > defaults).

| Key | Env var |
| --- | --- |
| `slack.enabled` | `MONO_AGENT_SLACK_ENABLED` |
| `slack.botToken` | `MONO_AGENT_SLACK_BOT_TOKEN` |
| `slack.appToken` | `MONO_AGENT_SLACK_APP_TOKEN` |
| `slack.allowedChannelIds` | `MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS` (CSV) |
| `slack.allowAllChannels` | `MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS` |
| `slack.botUserIds` | `MONO_AGENT_SLACK_BOT_USER_IDS` (CSV) |
| `slack.mentionTextAliases` | `MONO_AGENT_SLACK_MENTION_TEXT_ALIASES` (CSV) |
| `slack.stripMentionText` | `MONO_AGENT_SLACK_STRIP_MENTION_TEXT` |

:::tip
Keep tokens out of `mono-agent.config.json` in shared repos — set `MONO_AGENT_SLACK_BOT_TOKEN` / `MONO_AGENT_SLACK_APP_TOKEN` from your secret store or `.env` instead.
:::

### Resilience tuning

The heartbeat watchdog and reconnect loop work out of the box, but every threshold is an optional `slack.*` key (with a matching `MONO_AGENT_SLACK_*` env override). All are integers in milliseconds and accept `0`–`3600000`; **omit a key to use its default** — setting it to `0` does not mean "default" (and for `heartbeatTimeoutMs`, `0` disables the watchdog entirely).

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `heartbeatIntervalMs` | integer (ms) | `30000` | How often an otherwise-idle Socket Mode connection is probed with a ping. |
| `heartbeatTimeoutMs` | integer (ms) | `90000` | Silence budget before a half-open socket is force-recycled. `0` disables the watchdog. |
| `reconnectInitialBackoffMs` | integer (ms) | `500` | First reconnect backoff delay; doubles up to `reconnectMaxBackoffMs`. |
| `reconnectMaxBackoffMs` | integer (ms) | `30000` | Maximum reconnect backoff delay (raised from 10 s to give a `too_many_websockets` orphan time to clear server-side). |
| `reconnectStabilityMs` | integer (ms) | `30000` | A connection must stay open this long before the backoff resets and `degraded` returns to `running`. |
| `reconnectStartupGraceMs` | integer (ms) | `10000` | Window in which a lingering prior-process socket is quietly retried instead of flagged `degraded`. |
| `drainDeadlineMs` | integer (ms) | `5000` | Backstop after a watchdog terminate: forces the connection to settle and reconnect if no `close` arrives. |

```json
{
  "slack": {
    "enabled": true,
    "heartbeatTimeoutMs": 120000,
    "reconnectMaxBackoffMs": 45000,
    "reconnectStabilityMs": 20000
  }
}
```

| Key | Env var |
| --- | --- |
| `slack.heartbeatIntervalMs` | `MONO_AGENT_SLACK_HEARTBEAT_INTERVAL_MS` |
| `slack.heartbeatTimeoutMs` | `MONO_AGENT_SLACK_HEARTBEAT_TIMEOUT_MS` |
| `slack.reconnectInitialBackoffMs` | `MONO_AGENT_SLACK_RECONNECT_INITIAL_BACKOFF_MS` |
| `slack.reconnectMaxBackoffMs` | `MONO_AGENT_SLACK_RECONNECT_MAX_BACKOFF_MS` |
| `slack.reconnectStabilityMs` | `MONO_AGENT_SLACK_RECONNECT_STABILITY_MS` |
| `slack.reconnectStartupGraceMs` | `MONO_AGENT_SLACK_RECONNECT_STARTUP_GRACE_MS` |
| `slack.drainDeadlineMs` | `MONO_AGENT_SLACK_DRAIN_DEADLINE_MS` |

## Slack app setup

1. Create a Slack app at <https://api.slack.com/apps> (from scratch, in your target workspace).
2. **Socket Mode** → enable it. This generates an **app-level token** (`xapp-...`) with the `connections:write` scope → this is your `appToken`.
3. **OAuth & Permissions** → add bot token scopes, then install the app to the workspace. The install yields the **bot token** (`xoxb-...`) → this is your `botToken`. Typical scopes: `app_mentions:read`, `chat:write`, `reactions:write` (for the 👀 indicator), and `channels:history` / `groups:history` to read messages in the channels you allow.
4. **Event Subscriptions** → subscribe to the `app_mention` (and, if you want non-mention messages handled in allowed channels, `message.channels`) bot events.
5. Invite the bot into each channel you list in `allowedChannelIds` (`/invite @your-bot`).
6. Find the bot's user ID for `botUserIds` (Slack user profile → "Copy member ID", starts with `U`) and the channel IDs for `allowedChannelIds` (channel details → bottom of the About tab, starts with `C`).

After configuring, validate and start:

```bash
mono-agent validate
mono-agent start
```

A misconfigured channel surfaces a `waiting_for_config` reason in `mono-agent validate`/startup logs naming the missing field.

## Sending into Slack from the agent

When the Slack adapter is enabled, the app can expose an MCP send tool, `slack_send_message`, that lets the agent post into the same workspace from any run (including cron and webhook turns). It is **off by default** — add the exact tool name to `tools.allowedTools`:

```json
{
  "tools": {
    "allowedTools": ["slack_send_message"]
  }
}
```

The existing Slack adapter config (tokens + channel allowlist) provides the credentials and remains the destination boundary — the tool cannot post outside your allowed channels. See [Delivery and send tools](/channels/delivery-and-send-tools/) and [Tool policy](/tools/policy/).

## Related

- [Channels overview](/channels/)
- [Telegram](/channels/telegram/) — the other mention-triggered, final-only chat channel
- [Delivery and send tools](/channels/delivery-and-send-tools/) — final-only delivery, working indicators, send tools
- [Cron](/channels/cron/) and [Webhook](/channels/webhook/) — proactive turns that can call `slack_send_message`
- [Tool policy](/tools/policy/) — gating `allowedTools`
- [Environment variables](/config/env-vars/)
- Playbook: [Slack team bot with MCP tools](/playbooks/slack-team-bot-mcp-tools/)
