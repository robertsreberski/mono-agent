---
title: "Slack"
parent: "Channels"
nav_order: 2
---

# Slack

The Slack channel connects your agent to a Slack workspace over **Socket Mode** (no public inbound URL required). It is mention-triggered, shows a 👀 "seen" reaction while it works, and delivers only the final answer. Coverage: **config** (`slack.socket-mode`).

## How it works

- **Socket Mode transport.** The adapter opens a WebSocket to Slack using an app-level token, so you do not host a public endpoint. The app-level token must carry the `connections:write` scope.
- **Mention-triggered.** The agent responds when it is mentioned (a real `@bot` mention matching `botUserIds`, or a text alias from `mentionTextAliases`). Channels must be allowed via `allowedChannelIds` or `allowAllChannels`.
- **Final-only delivery.** Like Telegram, Slack delivers only the final answer rather than streaming interim edits. While the run is in flight the adapter adds a 👀 reaction to the triggering message as a working indicator. This is the default (`stream.finalOnly: true`); see [Delivery and send tools](delivery-and-send-tools.md).

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

Both `botToken` and `appToken` are required when `enabled: true`. If either is missing, or if neither `allowedChannelIds` nor `allowAllChannels` is set, the channel reports `waiting_for_config` instead of starting.
{: .warning }

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

Keep tokens out of `mono-agent.config.json` in shared repos — set `MONO_AGENT_SLACK_BOT_TOKEN` / `MONO_AGENT_SLACK_APP_TOKEN` from your secret store or `.env` instead.
{: .tip }

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

The existing Slack adapter config (tokens + channel allowlist) provides the credentials and remains the destination boundary — the tool cannot post outside your allowed channels. See [Delivery and send tools](delivery-and-send-tools.md) and [Tool policy](../tools/policy.md).

## Related

- [Channels overview](index.md)
- [Telegram](telegram.md) — the other mention-triggered, final-only chat channel
- [Delivery and send tools](delivery-and-send-tools.md) — final-only delivery, working indicators, send tools
- [Cron](cron.md) and [Webhook](webhook.md) — proactive turns that can call `slack_send_message`
- [Tool policy](../tools/policy.md) — gating `allowedTools`
- [Environment variables](../config/env-vars.md)
- Playbook: [Slack team bot with MCP tools](../playbooks/slack-team-bot-mcp-tools.md)
