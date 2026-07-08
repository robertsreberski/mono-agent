---
title: "Slack Team Bot with MCP Tools"
sidebar:
  order: 2
---

# Slack Team Bot with MCP Tools

This playbook builds a shared Slack bot that answers when mentioned in allow-listed channels, calls a custom team MCP tool plus `Read`/`Grep`, and can post proactively with `SlackSendMessage`.

## Who this is for

A DevOps engineer running a shared team bot.

## Goal

A Slack Socket Mode bot, mention-triggered in allowed channels, with a custom MCP tool plus `Read`/`Grep` and the `SlackSendMessage` tool for proactive posts.

## Features used

- `slack.socket-mode` — [Slack channel](/channels/slack/)
- `channel.final-only-delivery` — [Delivery and send tools](/channels/delivery-and-send-tools/)
- `tool-policy.allowlist` — [Tool policy](/tools/policy/)
- `tool-policy.mcp-servers` — [MCP servers](/tools/mcp/)
- `agent-app.adapter-send-tools` — [Delivery and send tools](/channels/delivery-and-send-tools/)
- `runtime.concurrency` — [Sessions, concurrency & Pi-native tuning](/runtime/sessions-concurrency/)

## Configuration

The Slack section runs in Socket Mode (both `botToken` and `appToken` are required); mentions are detected by `botUserIds` and `mentionTextAliases`, and the bot only responds in `allowedChannelIds`. The tool allowlist is fail-closed, so `SlackSendMessage` and the custom `deployTool` must be named explicitly. `concurrency` bounds in-flight work app-wide.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedChannelIds": ["C012345"],
    "botUserIds": ["U012345"],
    "mentionTextAliases": ["@agent"]
  },
  "tools": {
    "allowedTools": ["Read", "Grep", "SlackSendMessage", "deployTool"],
    "mcpConfigPath": "./mcp.json"
  },
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 8
  }
}
```

Secrets can also come from the environment: `MONO_AGENT_SLACK_BOT_TOKEN` and `MONO_AGENT_SLACK_APP_TOKEN`.

:::caution
The exact MCP tool name (`deployTool` here) must match the name your server advertises, and it must appear in `tools.allowedTools` or the fail-closed policy will exclude it.
:::

## Steps

1. Create a Slack app with Socket Mode (app token `connections:write`) and a bot token (`chat:write`).
2. `mono-agent init --model claude:claude-sonnet-4-6`
3. Write `mcp.json` with the team's stdio MCP server; add `deployTool`'s exact name to `tools.allowedTools`.
4. Add the `slack` section + `SlackSendMessage` to `allowedTools`; set concurrency bounds (note: per-channel scope).
5. `mono-agent validate`, then `mono-agent start` (confirm Slack is running with both tokens).
6. Mention the bot in an allowed channel and confirm a 👀 reaction, then a final reply.

## Smoke test

:::tip
Mention `@agent` in the allowed channel; verify the seen reaction, a final answer, the MCP tool firing in the run artifact, and that `SlackSendMessage` can post to the allowed channel (and is rejected for a non-allowed one).
:::

## Related

- [Slack channel](/channels/slack/)
- [Delivery and send tools](/channels/delivery-and-send-tools/)
- [Tool policy](/tools/policy/)
- [MCP servers](/tools/mcp/)
- [Sessions, concurrency & Pi-native tuning](/runtime/sessions-concurrency/)
- [Composer skill](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md)
