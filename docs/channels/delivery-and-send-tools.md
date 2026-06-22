---
title: "Delivery, streaming & send tools"
sidebar:
  order: 8
---

# Delivery, streaming & send tools

This page explains how mono-agent delivers answers across channels (final-only vs. token streaming), which delivery and message-text knobs are config vs. code-only, how the app-owned MCP send tools (`slack_send_message`, `telegram_send_message`) let the agent push messages back through an already-configured chat adapter, and the cron/webhook-only [proactive notify tools](#proactive-notify-tools-cronwebhook-turns) (`notify_conversation`, `list_notify_destinations`) that deliver a remembered turn into another conversation.

## Delivery semantics per channel

Each channel decides how a turn's output reaches the user. The two chat adapters and the OpenAI-compatible endpoint behave differently by default:

| Channel | Default delivery | Working indicator | Coverage |
|---|---|---|---|
| Telegram | Final answer only (`stream.finalOnly: true`) | "typing…" chat action | `code` |
| Slack | Final answer only (`stream.finalOnly: true`) | 👀 "seen" reaction on the user's message | `code` |
| OpenAI-compatible (`/v1/chat/completions`) | Token-by-token SSE streaming | n/a (SSE deltas) | `config` |

Telegram and Slack default to delivering **only the final answer** — no streamed interim message edits — while showing a lightweight working indicator so the user knows a turn is in flight. This is built-in adapter behavior, not a JSON field you set in `mono-agent.config.json`.

The OpenAI-compatible endpoint always streams token-by-token (SSE), which is what clients like Open WebUI expect. See [OpenAI-compatible endpoint](/channels/openai-api/).

## Switching Telegram/Slack to live interim streaming

Restoring live, interim-edit streaming on Telegram or Slack requires a **custom channel driver** that sets `stream.finalOnly: false` on the adapter. There is no `mono-agent.config.json` key for this — it is a code-only override.

Concretely, build the driver yourself (e.g. `createTelegramChannelDriver` / `createSlackChannelDriver`) and pass `finalOnly: false` so the substrate's `ResilientMessageStream({ finalOnly })` edits an in-progress message as deltas arrive. See [Custom channels](/programmatic/custom-channels/) for the programmatic composition path.

:::caution
Live interim streaming on Telegram/Slack means frequent message edits, which can hit the platform's rate limits on busy chats. Tune the edit debounce (below) before enabling it broadly.
:::

## Stream & message-text tuning (code-only)

Status text, edit debounce, max message characters, and the welcome/help/error texts are **channel-driver overrides**, not config keys. Set them when you build a custom driver via `stream` / `messages` options:

| Knob | What it controls |
|---|---|
| `stream.finalOnly` | Final-only delivery vs. live interim edits (default `true` for Telegram/Slack) |
| Status / working-indicator text | The activity hint shown while a turn runs |
| Edit debounce | How often an in-progress message is re-edited during streaming |
| Max message chars | Where long replies are split into multiple messages |
| Welcome / help / error texts | Per-channel canned message bodies |

Because these are code-only, they live in your driver wiring rather than `mono-agent.config.json`. See [Custom channels](/programmatic/custom-channels/).

## App-owned send tools

mono-agent derives MCP **send tools** from already-enabled chat adapters so the agent can push a message back into a chat from inside a turn:

- `slack_send_message` — send through the configured Slack adapter
- `telegram_send_message` — send through the configured Telegram adapter

Coverage: `config`. Two conditions must both hold for a send tool to work:

1. The **exact tool name** must appear in `tools.allowedTools` (`slack_send_message` and/or `telegram_send_message`). The fail-closed tool policy excludes them otherwise.
2. The corresponding adapter must have **valid config** — `slack.*` for `slack_send_message`, `telegram.*` for `telegram_send_message` — which supplies the credentials and the destination bounds.

The adapter's own allowlist (`slack.allowedChannelIds` / `slack.allowAllChannels`, `telegram.allowedChatIds` / `telegram.allowAllChats`) **remains the destination boundary**: allowing the tool does not widen where the agent may send. A send to a destination outside the adapter allowlist is refused.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "slack_send_message", "telegram_send_message"]
  },
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedChannelIds": ["C0123"]
  },
  "telegram": {
    "enabled": true,
    "botToken": "...",
    "allowedChatIds": ["123456789"]
  }
}
```

The allowlist also accepts `MONO_AGENT_ALLOWED_TOOLS` (and `MONO_AGENT_DISALLOWED_TOOLS` for denials, where deny wins). See [Tool policy](/tools/policy/) for allow/deny precedence and how MCP tool names are matched.

:::note
Allowing a send tool but leaving the adapter disabled or unconfigured means the tool is present in name but has no working destination — the send fails. Enable and configure the adapter (Slack / Telegram) as well.
:::

## Proactive notify tools (cron/webhook turns)

On a **cron or webhook turn** — and only there — the agent is given two extra tools so it can proactively message a conversation it is **not currently handling**:

- **`notify_conversation(conversationId, text)`** — delivers `text` to `conversationId` by running it as a **real turn on that conversation's own live session**. The destination's agent composes the user-facing reply with its own context and history, the user sees it as a native message, and **the conversation remembers it** — this is not a side-channel post. Returns `{ delivered, reason }`.
- **`list_notify_destinations()`** — discovery: lists conversations the agent has handled (from the run artifacts) plus single-entry channel allowlists it could reach. Each entry carries the `conversationId` to pass to `notify_conversation`, an optional `lastSeen`, and a `fromAllowlist` flag for not-yet-used allowlisted destinations. WhatsApp is excluded.

`conversationId` is a channel-scoped id such as `telegram:42`, `slack:C123`, or `slack:C123:1718.99` (a Slack thread).

### How they differ from send tools

| | **Notify tools** (`notify_conversation`) | **Send tools** (`slack_send_message` / `telegram_send_message`) |
|---|---|---|
| Effect | Runs a **real, remembered turn** in the destination conversation | Posts a message into a **channel** (side-channel; not a turn) |
| Available on | **cron / webhook turns only** | any turn |
| Allowlist entry | **Not required** in `tools.allowedTools` (auto-injected) | **Required** — exact tool name in `tools.allowedTools` |
| Destination bound | The owning channel's allowlist | The owning channel's allowlist |
| Channels | Telegram + Slack (`whatsapp:` → `delivered:false`) | Telegram + Slack |

### Constraints and security

- **Auto-injected, gated by turn type.** The tools are hosted by an in-process loopback HTTP MCP server (stateless, bearer-token-authenticated) and injected only when the turn's request metadata marks it as a cron or webhook trigger. Live channel turns never see them. Because they are app-injected MCP tools, they are **not** filtered by `tools.allowedTools` / `tools.disallowedTools` (see [MCP tools](/tools/mcp/)).
- **Allowlist is the destination boundary.** Each delivery is enforced against the owning channel's allowlist (`telegram.allowedChatIds` / `slack.allowedChannelIds`, or `allowAllChats` / `allowAllChannels`). A payload-supplied id outside the allowlist is refused with `delivered:false`. There is **no** per-job or per-endpoint notify config — destinations are bounded entirely by the channels you already allow.
- **WhatsApp is not yet notify-capable** — a `whatsapp:` destination returns `delivered:false`.

### Two use cases

1. **Async webhook callback (the key one).** A live chat asks the agent to kick off a long-running external operation; the agent embeds the current `conversationId` (surfaced in the [Session context block](/context/assembly/#session)) in the callback it asks the service to make. When the service later calls the inbound [webhook](/channels/webhook/), the webhook turn reads that id from the payload and calls `notify_conversation` to deliver the result back into the original conversation — which still remembers the request.
2. **Proactive cron.** A scheduled job pings the user without the operator hardcoding a chat id: the job calls `list_notify_destinations()` to find where to reach the user, then `notify_conversation`.

:::note
This replaces the older static `notify:<id>` cron/webhook config: the destination is now chosen by the agent at turn time, so there is nothing per-job to configure beyond making sure the relevant Telegram/Slack allowlist includes the intended destination.
:::

## Related pages

- [Telegram](/channels/telegram/) and [Slack](/channels/slack/) — adapter config and allowlists.
- [OpenAI-compatible endpoint](/channels/openai-api/) — token streaming over SSE.
- [Cron](/channels/cron/) and [Webhook](/channels/webhook/) — the proactive turns that get the notify tools.
- [Tool policy](/tools/policy/) — `allowedTools` / `disallowedTools` precedence.
- [MCP tools](/tools/mcp/) — why app-injected tools sit outside the allowlist.
- [Custom channels](/programmatic/custom-channels/) — building a driver to override `stream.finalOnly`, debounce, and message texts.
