---
title: "Cron Digest with Proactive Slack Notify"
parent: "Playbooks"
nav_order: 6
---

# Cron Digest with Proactive Slack Notify

This playbook wires a timezone-aware cron job to a Slack channel: on a schedule, the agent builds a daily digest using shared conversation history, then proactively posts it with the `slack_send_message` send tool. No human prompt triggers the run — the cron tick is the trigger.

## Who this is for

Data analysts (and their agents) who want a scheduled briefing pushed to the team without anyone asking for it — a "morning digest" that lands in Slack every day at a fixed local time.

## Goal

A timezone-aware cron job that builds a daily digest with shared conversation history and proactively posts it to Slack via the send tool.

## Features used

- **`cron.scheduled-prompts`** — in-app scheduled prompts; see [Cron](../channels/cron.md). *(config)*
- **`cron.jobs-dir`** — author jobs as `cron/<id>.md` frontmatter files; see [Cron](../channels/cron.md). *(config)*
- **`agent-app.adapter-send-tools`** — channel adapters expose send tools (e.g. `slack_send_message`) for proactive delivery; see [Delivery and Send Tools](../channels/delivery-and-send-tools.md). *(auto)*
- **`slack.socket-mode`** — Slack Socket Mode connection; see [Slack](../channels/slack.md). *(config)*
- **`memory.journal`** — shared run history via `conversationId`; see [Capture and Recall](../memory/capture-and-recall.md). *(config)*

## Configuration

The Slack adapter is what registers the `slack_send_message` send tool, so `slack` must be enabled (with Socket Mode tokens) even though the run is driven by cron, not an inbound Slack message. Setting `conversationId` on the job makes successive ticks share history, so the digest can reference what it reported yesterday.

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
  "tools": {
    "allowedTools": ["slack_send_message", "WebSearch"]
  },
  "cron": {
    "jobs": [
      {
        "id": "morning-digest",
        "enabled": true,
        "expression": "0 9 * * *",
        "timezone": "America/New_York",
        "prompt": "Build the morning digest and post it to #team via slack_send_message.",
        "conversationId": "daily-digest"
      }
    ]
  }
}
```

Equivalent environment variables for the secrets and model (so tokens stay out of the JSON):

```bash
export MONO_AGENT_RUNTIME_MODEL="claude:claude-sonnet-4-6"
export MONO_AGENT_SLACK_BOT_TOKEN="xoxb-..."
export MONO_AGENT_SLACK_APP_TOKEN="xapp-..."
```

The same job can instead live in `cron/morning-digest.md` as frontmatter (`expression`, `timezone`, `conversationId`) plus the prompt as the body. File jobs merge with `cron.jobs`; duplicate ids error.

`allowedChannelIds` is an allowlist: the agent can only post to listed channels. Use `"allowAllChannels": true` to lift the restriction.
{: .warning }

## Steps

1. `mono-agent init --model claude:claude-sonnet-4-6`
2. Add the `slack` config and `slack_send_message` to `tools.allowedTools`; add the cron job (or author `cron/morning-digest.md`).
3. Set `conversationId` so successive runs share history; pick the IANA `timezone` for the schedule.
4. `mono-agent validate`, then `mono-agent start`.
5. Trigger a one-off tick (or wait for 09:00) and confirm the digest posts to the allowed channel.

## Smoke test

Run a one-off cron tick; verify the agent calls `slack_send_message` and the digest appears in the allowed `#team` channel, with the `conversationId` sharing context across ticks.
{: .tip }

## Related

- [Cron](../channels/cron.md)
- [Slack](../channels/slack.md)
- [Delivery and Send Tools](../channels/delivery-and-send-tools.md)
- [Capture and Recall](../memory/capture-and-recall.md)
- [Tool Policy](../tools/policy.md)
- [mono-agent-composer skill](../../packages/agent-app/skills/mono-agent-composer/SKILL.md)
