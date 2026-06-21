---
title: "Slack Team Bot with MCP Tools"
parent: "Playbooks"
nav_order: 2
---

# Slack Team Bot with MCP Tools

This playbook builds a shared Slack bot that answers when mentioned in allow-listed channels, calls a custom team MCP tool plus `Read`/`Grep`, and can post proactively with `slack_send_message`.

## Who this is for

A DevOps engineer running a shared team bot.

## Goal

A Slack Socket Mode bot, mention-triggered in allowed channels, with a custom MCP tool plus `Read`/`Grep` and the `slack_send_message` tool for proactive posts.

## Features used

- `slack.socket-mode` — [Slack channel](../channels/slack.md)
- `channel.final-only-delivery` — [Delivery and send tools](../channels/delivery-and-send-tools.md)
- `tool-policy.allowlist` — [Tool policy](../tools/policy.md)
- `tool-policy.mcp-servers` — [MCP servers](../tools/mcp.md)
- `agent-app.adapter-send-tools` — [Delivery and send tools](../channels/delivery-and-send-tools.md)
- `runtime.concurrency` — [Sessions, concurrency & Pi-native tuning](../runtime/sessions-concurrency.md)

## Configuration

The Slack section runs in Socket Mode (both `botToken` and `appToken` are required); mentions are detected by `botUserIds` and `mentionTextAliases`, and the bot only responds in `allowedChannelIds`. The tool allowlist is fail-closed, so `slack_send_message` and the custom `deployTool` must be named explicitly. `concurrency` bounds in-flight work app-wide.

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
    "allowedTools": ["Read", "Grep", "slack_send_message", "deployTool"],
    "mcpConfigPath": "./mcp.json"
  },
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 8
  }
}
```

Secrets can also come from the environment: `MONO_AGENT_SLACK_BOT_TOKEN` and `MONO_AGENT_SLACK_APP_TOKEN`.

The exact MCP tool name (`deployTool` here) must match the name your server advertises, and it must appear in `tools.allowedTools` or the fail-closed policy will exclude it.
{: .warning }

## Steps

1. Create a Slack app with Socket Mode (app token `connections:write`) and a bot token (`chat:write`).
2. `mono-agent init --model claude:claude-sonnet-4-6`
3. Write `mcp.json` with the team's stdio MCP server; add `deployTool`'s exact name to `tools.allowedTools`.
4. Add the `slack` section + `slack_send_message` to `allowedTools`; set concurrency bounds (note: per-channel scope).
5. `mono-agent validate`, then `mono-agent start` (confirm Slack is running with both tokens).
6. Mention the bot in an allowed channel and confirm a 👀 reaction, then a final reply.

## Smoke test

Mention `@agent` in the allowed channel; verify the seen reaction, a final answer, the MCP tool firing in the run artifact, and that `slack_send_message` can post to the allowed channel (and is rejected for a non-allowed one).
{: .tip }

## Related

- [Slack channel](../channels/slack.md)
- [Delivery and send tools](../channels/delivery-and-send-tools.md)
- [Tool policy](../tools/policy.md)
- [MCP servers](../tools/mcp.md)
- [Sessions, concurrency & Pi-native tuning](../runtime/sessions-concurrency.md)
- [Composer skill](../../packages/agent-app/skills/mono-agent-composer/SKILL.md)
