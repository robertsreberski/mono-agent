---
title: "Slack"
sidebar:
  order: 2
---

# Slack

The Slack channel connects your agent to a Slack workspace over **Socket Mode** (no public inbound URL required). It is mention-triggered, shows a 👀 "seen" reaction while it works, and delivers only the final answer. Coverage: **config** (`slack.socket-mode`, `slack.shortcuts`, and `slack.app-home`).

## How it works

- **Socket Mode transport.** The adapter opens a WebSocket to Slack using an app-level token, so you do not host a public endpoint. The app-level token must carry the `connections:write` scope.
- **Mention-triggered.** The agent responds when it is mentioned (a real `@bot` mention matching `botUserIds`, or a text alias from `mentionTextAliases`). Channels must be allowed via `allowedChannelIds` or `allowAllChannels`.
- **Final-only delivery.** Like Telegram, Slack delivers only the final answer rather than streaming interim edits. While the run is in flight the adapter adds a 👀 reaction to the triggering message as a working indicator. This is the default (`stream.finalOnly: true`); see [Delivery and send tools](/channels/delivery-and-send-tools/).
- **Markdown boundary.** mono-agent treats agent-visible Slack text as standard Markdown. Inbound Slack `mrkdwn` links/lists are normalized before they reach the agent, and outbound final replies plus `SlackSendMessage` text are rendered to Slack `mrkdwn` at delivery time.
- **Slack message length.** Slack final replies and `SlackSendMessage` keep text under Slack's 40,000-character platform limit. Replies below that limit are delivered as one Slack message; longer text is split into continuation posts without changing the configured destination or thread. This Slack default is separate from the shared 3,800-character default used by other chat stream implementations.
- **Heartbeat watchdog.** A long-lived Socket Mode connection can go *half-open* — after the host sleeps or a network blip, the WebSocket stops delivering frames but never fires `close`/`error`, so the agent silently stops responding to Slack while still looking healthy. To recover, the adapter probes an otherwise-idle socket with a ping every **30 s** and force-recycles it if no frame (message, ping, or pong) arrives within **90 s** of silence; the recycle fires `close`, which the existing reconnect/backoff loop picks up. A healthy-but-idle socket stays up because Slack's own server pings refresh the activity timer, so there are no false recycles. This is **on by default**.
- **Resilient reconnect + degraded recovery.** On a non-graceful exit (a `too_many_websockets`/unknown disconnect, a socket error, or a watchdog recycle) the adapter does a **terminate-first** teardown — it drops the TCP connection immediately rather than waiting on a close handshake a throttled or half-dead peer may never complete, which otherwise leaves an orphaned socket counting against Slack's per-app budget and triggers `too_many_websockets` churn. It then reconnects with exponential backoff (**500 ms → 30 s**, **jitter on by default**, ratio 0.2); the backoff only resets after a connection stays open past a **30 s stability window** (so a connection flapping just under that window climbs to the 30 s cap instead of resetting on each reconnect). Slack's own `warning` / `refresh_requested` reasons take a **graceful** no-backoff path. A startup-grace window quietly retries a lingering prior-process socket instead of flagging a problem. When a non-graceful loss occurs the channel reports **`degraded`** (the responder stays alive) and returns to **`running`** once a reconnect survives the stability window. This mirrors the Telegram poller's resilience.

:::note
The heartbeat and reconnect behavior are **on by default and need no configuration** — the defaults apply automatically. They are also **operator-tunable** via optional `slack.*` keys (or `MONO_AGENT_SLACK_*` env vars); see [Resilience tuning](#resilience-tuning) below.
:::

## Configuration

Put the Socket Mode credentials in `.env` as `MONO_AGENT_SLACK_BOT_TOKEN` and `MONO_AGENT_SLACK_APP_TOKEN`. The source-config examples intentionally omit both fields.

```json
{
  "slack": {
    "enabled": true,
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
| `botToken` | string (`xoxb-...`) | — | Bot user OAuth token. An effective value is **required** when enabled. Inline config remains compatible; new source configs should use `MONO_AGENT_SLACK_BOT_TOKEN` in `.env`. |
| `appToken` | string (`xapp-...`) | — | App-level token for Socket Mode (`connections:write`). An effective value is **required** when enabled. Inline config remains compatible; new source configs should use `MONO_AGENT_SLACK_APP_TOKEN` in `.env`. |
| `allowedChannelIds` | string[] | — | Channel IDs the agent may respond in. Required unless `allowAllChannels` is `true`. |
| `allowAllChannels` | boolean | `false` | Respond in any channel the bot is in. Alternative to `allowedChannelIds`. |
| `botUserIds` | string[] | — | The bot's Slack user ID(s), used to detect real `@bot` mentions. |
| `mentionTextAliases` | string[] | — | Plain-text aliases (e.g. `@agent`) that also trigger a response. |
| `stripMentionText` | boolean | `true` | Strip the mention/alias text from the prompt before the agent sees it. |
| `shortcuts` | object[] | `[]` | JSON-only global/message shortcut bindings that run configured prompts. See [Shortcuts](#shortcuts). |
| `homeTab` | object | `{ "enabled": false, "buttons": [] }` | JSON-only App Home header/buttons. See [App Home](#app-home). |

:::caution
Both `botToken` and `appToken` are required when `enabled: true`. If either is missing, or if neither `allowedChannelIds` nor `allowAllChannels` is set, the channel reports `waiting_for_config` instead of starting.
:::

### Environment variables

Every key above except `slack.shortcuts` and `slack.homeTab` has an env override
(env precedence: process env > `mono-agent.config.json` > defaults). Those two
interaction fields are structured and JSON-only: configure them in
`mono-agent.config.json`; they have no environment-variable form.

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
Keep tokens out of every source `mono-agent.config.json`, including ignored or untracked development configs. Set `MONO_AGENT_SLACK_BOT_TOKEN` / `MONO_AGENT_SLACK_APP_TOKEN` from your secret store or `.env` instead.
:::

### Silent delivery and quiet hours

Slack does not expose a bot-controlled notification-suppression field on
`chat.postMessage`. Programmatic adapter callers may pass `silent: true` through
`SlackNotifyOptions` / `SlackMessageStreamOptions` for cross-channel option
parity, but the post still uses normal Slack notification behavior and the
adapter emits an explicit warning when a logger is configured
(`silentRequested: true`, `silentApplied: false`). It deliberately does not send
an invented `silent` or `disable_notification` field.

There is no `slack.quietHours` config key because mono-agent cannot honestly
enforce that promise at the Slack transport boundary. Slack client/workspace
notification settings remain authoritative. If guaranteed quiet hours are a
hard requirement, the programmatic caller must skip or defer the Slack delivery
instead of relying on `silent: true`.

### Shortcuts

`slack.shortcuts` binds Slack **global** or **message** shortcut callback IDs to
prompts. Register the shortcut in your Slack app with a callback ID that exactly
matches `callbackId`; invoking it runs `prompt` as a proactive agent turn.

```json
{
  "slack": {
    "enabled": true,
    "allowedChannelIds": ["C0123"],
    "shortcuts": [
      {
        "callbackId": "triage_request",
        "prompt": "Prepare the daily support triage checklist.",
        "channelId": "C0123",
        "ackText": "Triage started…",
        "threadReply": true
      }
    ]
  }
}
```

| Field | Required | Purpose |
| --- | --- | --- |
| `callbackId` | yes | Exact Slack shortcut `callback_id`; values must be unique (case-insensitive). |
| `prompt` | yes | Static prompt run when the shortcut is invoked. Selected-message text and invoking-user identity are not appended. |
| `channelId` | no | Pins delivery to this allowed channel. Without it, a message shortcut uses its source channel and thread; a global shortcut falls back to the first `allowedChannelIds` entry. With `allowAllChannels: true` and no explicit allowlist, a global shortcut needs `channelId` or it is ignored because no default destination exists. |
| `ackText` | no | Best-effort message posted immediately before the run. The turn still runs if this post fails. |
| `threadReply` | no | Default `false`. With `ackText`, threads the final result under that acknowledgement when there is no source thread. Setting it to `true` without `ackText` is invalid. |

Every resolved destination still passes `allowedChannelIds` / `allowAllChannels`.
If `channelId` redirects a message shortcut to a different channel, the result is
top-level there rather than reusing the source channel's thread timestamp.
A message shortcut reuses its source channel and thread only as delivery
coordinates; the selected message itself is not added to the configured
`prompt`. The channel allowlist authorizes only where output may be delivered:
shortcut and Home-button interactions are not authorized per invoking user, and
the invoking user's identity is not added to the proactive prompt.

### App Home

`slack.homeTab` publishes a persistent App Home view when Slack sends an
`app_home_opened` event. An optional Markdown header is followed by one button
per configured entry; clicking a button runs its prompt through the same
allowlisted proactive-delivery path as a shortcut.

```json
{
  "slack": {
    "enabled": true,
    "allowedChannelIds": ["C0123"],
    "homeTab": {
      "enabled": true,
      "headerText": "*Quick actions*",
      "buttons": [
        {
          "actionId": "build_digest",
          "label": "Build digest",
          "prompt": "Build today's team digest.",
          "channelId": "C0123",
          "ackText": "Building the digest…",
          "threadReply": true
        }
      ]
    }
  }
}
```

| Field | Required | Purpose |
| --- | --- | --- |
| `enabled` | no | Default `false`, including when omitted from a present `homeTab` object. Publishes the view on open only when `true`. |
| `headerText` | no | Markdown header rendered above the buttons. |
| `buttons` | no | Default `[]`. Button bindings; an enabled Home tab must contain at least a header or one button, so a header-only tab is valid. |
| `buttons[].actionId` | yes | Button routing ID; values must be unique (case-insensitive). |
| `buttons[].label` | yes | Plain-text button label. |
| `buttons[].prompt` | yes | Prompt run when the button is clicked. |
| `buttons[].channelId` | no | Pins delivery to this allowed channel. A Home click has no source channel, so omission falls back to the first `allowedChannelIds` entry; with allow-all and no explicit allowlist, set it explicitly. |
| `buttons[].ackText` | no | Best-effort immediate acknowledgement before the run. |
| `buttons[].threadReply` | no | Default `false`; requires `ackText` and threads the result under it. |

App Home publishing is best-effort: a `views.publish` failure is logged and does
not fail the responder. Enable **Interactivity & Shortcuts** for shortcut/button
payloads, enable the app's **Home Tab**, and subscribe to the `app_home_opened`
bot event. Socket Mode carries those payloads, so no public request URL is needed.

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
4. **Event Subscriptions** → subscribe to the `app_mention` (and, if you want non-mention messages handled in allowed channels, `message.channels`) bot events. Add `app_home_opened` when using `slack.homeTab`.
5. **Interactivity & Shortcuts** → enable interactivity when using `slack.shortcuts` or App Home buttons. Create each global/message shortcut with a callback ID matching its configured `callbackId`. Socket Mode carries the interaction payloads; no request URL is needed.
6. **App Home** → enable the Home Tab when using `slack.homeTab`.
7. Invite the bot into each channel you list in `allowedChannelIds` (`/invite @your-bot`).
8. Find the bot's user ID for `botUserIds` (Slack user profile → "Copy member ID", starts with `U`) and the channel IDs for `allowedChannelIds` (channel details → bottom of the About tab, starts with `C`).

After configuring, validate and start:

```bash
mono-agent validate
mono-agent start
```

A misconfigured channel surfaces a `waiting_for_config` reason in `mono-agent validate`/startup logs naming the missing field.

## Sending into Slack from the agent

When the Slack adapter is enabled, the app can expose an MCP send tool, `SlackSendMessage`, that lets the agent post into the same workspace from any run (including cron and webhook turns). Under the **allow-all** tool default it is available automatically once the channel is enabled — no allowlist entry needed. If you narrow to a **specific** `tools.allowedTools`, add the exact tool name; a `disallowedTools` entry removes it:

```json
{
  "tools": {
    "allowedTools": ["SlackSendMessage"]
  }
}
```

The existing Slack adapter config (tokens + channel allowlist) provides the credentials and remains the destination boundary — the tool cannot post outside your allowed channels. `SlackSendMessage` text is standard Markdown by default and is converted to Slack `mrkdwn` before posting; set the tool's `mrkdwn` argument to `false` only when you need to send plain text unchanged. Long tool output is split only when it exceeds Slack's 40,000-character platform limit, and every posted chunk preserves the requested `thread_ts` when you send into a thread. See [Delivery and send tools](/channels/delivery-and-send-tools/) and [Tool policy](/tools/policy/).

## Related

- [Channels overview](/channels/)
- [Telegram](/channels/telegram/) — the other mention-triggered, final-only chat channel
- [Delivery and send tools](/channels/delivery-and-send-tools/) — final-only delivery, working indicators, send tools
- [Cron](/channels/cron/) and [Webhook](/channels/webhook/) — proactive turns that can call `SlackSendMessage`
- [Tool policy](/tools/policy/) — gating `allowedTools`
- [Environment variables](/config/env-vars/)
- Playbook: [Slack team bot with MCP tools](/playbooks/slack-team-bot-mcp-tools/)
