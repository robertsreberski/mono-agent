---
title: "Cron Digest with Native Notify"
sidebar:
  order: 6
---

# Cron Digest with Native Notify

This playbook wires a timezone-aware cron job to a Telegram or Slack destination. On a schedule, the agent builds a daily digest using shared conversation history, returns the digest as its final answer, and `mono-agent` delivers that final answer through native notification.

:::note
Use `notify: true` for scheduled one-message digests. The same native notification model is available to webhook endpoints. The lower-level `notify_conversation` tool remains available on ordinary cron/webhook turns for dynamic callbacks and multi-destination workflows, but native notification keeps the simple path simpler: the agent writes the message once, and the runtime handles delivery.
:::

## Who this is for

Data analysts and operators who want a scheduled briefing pushed to a chat without anyone asking for it — a morning digest that lands every day at a fixed local time.

## Goal

A timezone-aware cron job that builds a daily digest with shared run history and delivers the final answer through native notification.

## Features used

- **`cron.scheduled-prompts`** — in-app scheduled prompts; see [Cron](/channels/cron/). *(config)*
- **`cron.jobs-dir`** — author jobs as `cron/<id>.md` frontmatter files; see [Cron](/channels/cron/). *(config)*
- **`cron.native-notify`** — `notify: true` delivers the cron final answer to Telegram or Slack after a successful run. *(config)*
- **`channel.proactive-notify`** — the same allowlisted Telegram/Slack routing used by the low-level notify tools; see [Delivery and Send Tools](/channels/delivery-and-send-tools/). *(config)*
- **`slack.socket-mode`** or **`telegram.bot`** — the destination adapter that owns the allowlist. *(config)*
- **`memory.journal`** — shared run history via `conversationId`; see [Capture and Recall](/memory/capture-and-recall/). *(config)*

## Configuration

Enable the destination adapter and add the cron job. `conversationId` is the cron run-history thread; `notifyConversationId` is the delivery destination. If `notifyConversationId` is omitted, `mono-agent` only infers a destination when exactly one Telegram/Slack notify destination is available.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedChannelIds": ["C012345"]
  },
  "cron": {
    "jobs": [
      {
        "id": "morning-digest",
        "enabled": true,
        "expression": "0 9 * * *",
        "timezone": "America/New_York",
        "prompt": "Build the morning digest. Your final answer is the digest to notify.",
        "conversationId": "daily-digest",
        "notify": true,
        "notifyConversationId": "slack:C012345"
      }
    ]
  }
}
```

Equivalent environment variables for the secrets and model:

```bash
export MONO_AGENT_RUNTIME_MODEL="claude:claude-sonnet-4-6"
export MONO_AGENT_SLACK_BOT_TOKEN="xoxb-..."
export MONO_AGENT_SLACK_APP_TOKEN="xapp-..."
```

The same job can instead live in `cron/morning-digest.md`:

```md
---
id: morning-digest
enabled: true
expression: "0 9 * * *"
timezone: America/New_York
conversationId: daily-digest
notify: true
notifyConversationId: slack:C012345
---

Build the morning digest. Your final answer is the digest to notify.
```

File jobs merge with `cron.jobs`; duplicate ids error.

:::caution
Channel allowlists still apply. A Slack destination must be in `allowedChannelIds` unless `allowAllChannels` is enabled; a Telegram destination must be in `allowedChatIds` unless `allowAllChats` is enabled.
:::

## Steps

1. `mono-agent init --model claude:claude-sonnet-4-6`
2. Add the Telegram or Slack destination config and allowlist.
3. Add the cron job with `expression`, `conversationId`, `notify: true`, and optionally `notifyConversationId`.
4. `mono-agent validate`, then `mono-agent start`.
5. Trigger a one-off tick or wait for the schedule and confirm the digest appears in the configured destination.

## Smoke test

:::tip
Run a one-off cron tick; verify the agent's final answer is the digest and no notify tool call is needed. Delivery is best-effort: skipped or failed notification attempts are logged without changing the cron job result.
:::

## Related

- [Cron](/channels/cron/)
- [Telegram](/channels/telegram/)
- [Slack](/channels/slack/)
- [Delivery and Send Tools](/channels/delivery-and-send-tools/)
- [Capture and Recall](/memory/capture-and-recall/)
- [mono-agent-composer skill](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md)
