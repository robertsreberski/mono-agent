---
title: "WhatsApp"
sidebar:
  order: 3
---

# WhatsApp

The WhatsApp channel connects your agent to a personal WhatsApp account over a [Baileys](https://github.com/WhiskeySockets/Baileys) socket, authenticated by scanning a QR code at first start. It is provided by the external `@mono-agent/whatsapp-adapter` package and loaded through `channels.plugins[]`. The plugin config gates which chats can trigger the agent and lets you choose whether group messages require an @mention. Coverage: **config** — see [feature-registry](/reference/feature-matrix/) row `whatsapp.baileys`.

## Quick start

Declare the plugin package, enable the channel, and allow one or more chats:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": {
          "enabled": true,
          "allowedChatJids": ["123@s.whatsapp.net"]
        }
      }
    ]
  }
}
```

On first `mono-agent start`, a QR code is printed to the start log. Open WhatsApp on your phone → **Linked devices** → **Link a device** → scan it. Baileys then writes its auth state to `.mono-agent/whatsapp-auth/` so subsequent starts reconnect without re-scanning.

:::caution
There is no bot token: WhatsApp links your own account as a paired device. Keep `.mono-agent/whatsapp-auth/` out of version control — it is your session, not a config value. See [folder layout](/config/folder-layout/).
:::

## Configuration

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `config.enabled` | boolean | `false` | Opt-in switch. Off means the channel reports "disabled" (not "waiting"). |
| `config.allowedChatJids` | string[] | `[]` | Allowlist of chat JIDs (e.g. `123@s.whatsapp.net` for a DM, `...@g.us` for a group) that may trigger the agent. |
| `config.allowAllChats` | boolean | `false` | When `true`, every chat is allowed; `allowedChatJids` is ignored. |
| `config.groupMode` | `"mention"` \| `"any"` | `"mention"` | Trigger rule for group messages (DMs always trigger — see below). |
| `config.botJids` | string[] | `[]` | Your linked account's JID(s), used to detect @mentions of the agent in groups. |
| `config.mentionTextAliases` | string[] | `[]` | Extra text aliases (e.g. `@agent`) that count as a mention even without a native WhatsApp mention. |
| `config.stripMentionText` | boolean | `false` | When `true`, the matched mention/alias text is removed from the message before it reaches the agent. |

Full annotated example:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": {
          "enabled": true,
          "allowedChatJids": ["123@s.whatsapp.net", "987654321@g.us"],
          "allowAllChats": false,
          "groupMode": "mention",
          "botJids": ["456@s.whatsapp.net"],
          "mentionTextAliases": ["@agent"],
          "stripMentionText": true
        }
      }
    ]
  }
}
```

To allow every chat instead of an explicit allowlist, set `allowAllChats` and drop `allowedChatJids`:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": { "enabled": true, "allowAllChats": true, "groupMode": "any" }
      }
    ]
  }
}
```

## When does the agent reply?

- **Direct messages** always trigger the agent (subject to the allowlist).
- **Group messages** trigger according to `groupMode`:
  - `mention` (default) — only when the message @mentions one of `botJids`, or contains one of `mentionTextAliases`.
  - `any` — every allowed group message triggers a run.

In both cases the chat must pass the allowlist: it must appear in `allowedChatJids`, or `allowAllChats` must be `true`. A chat that is not allowed is silently ignored.

:::tip
`groupMode: "any"` in a busy group will run the agent on every message. Pair it with a tight `allowedChatJids` and consider [concurrency limits](/runtime/sessions-concurrency/) before enabling it.
:::

## Finding JIDs

A WhatsApp JID identifies a chat. DMs use the `<number>@s.whatsapp.net` form (digits only, no `+`); groups use `<id>@g.us`. The simplest way to discover them is to temporarily set `allowAllChats: true`, send a message, and read the resolved JID from the start log, then move it into `allowedChatJids` and disable `allowAllChats`. Put your own linked-account JID into `botJids` so group mention detection works.

## Environment variables

Every key has a `MONO_AGENT_*` override (precedence: env > JSON > defaults). See the full [environment variables](/config/env-vars/) reference.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WHATSAPP_ENABLED` | plugin `config.enabled` | QR login; auth state in `.mono-agent/whatsapp-auth`. |
| `MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS` | plugin `config.allowedChatJids` | Or set `allowAllChats`. |
| `MONO_AGENT_WHATSAPP_GROUP_MODE` | plugin `config.groupMode` | `mention` / `any`. |

```bash
MONO_AGENT_WHATSAPP_ENABLED=true
MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS=123@s.whatsapp.net
MONO_AGENT_WHATSAPP_GROUP_MODE=mention
```

## Delivery behavior

Like the other chat channels, WhatsApp delivers the **final answer** of a run (interim streaming is not surfaced). What the agent is permitted to do inside a run is governed by [tool policy](/tools/policy/).

WhatsApp has **no notify path of its own**. Native cron/webhook notification (`notify: true`) targets only Telegram/Slack destinations — WhatsApp is **not a notify-capable destination**. The agent can still be granted the `slack_send_message` / `telegram_send_message` send tools (if those adapters are enabled) to push messages back through Slack or Telegram, but there is no equivalent for pushing unprompted messages into a WhatsApp chat. See [delivery and send tools](/channels/delivery-and-send-tools/).

## Related

There is no WhatsApp-specific playbook yet. The closest end-to-end recipes are the [Telegram personal-assistant playbook](/playbooks/telegram-personal-assistant-bujo/) and the [Slack team-bot playbook](/playbooks/slack-team-bot-mcp-tools/); both translate directly — add an `@mono-agent/whatsapp-adapter` entry under `channels.plugins[]` and put the WhatsApp settings under that entry's `config`. See also the [Telegram](/channels/telegram/) and [Slack](/channels/slack/) channel pages for the shared mention/allowlist model, and the [Channels overview](/channels/).
