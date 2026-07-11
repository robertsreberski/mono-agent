---
title: "Delivery, streaming & send tools"
sidebar:
  order: 8
---

# Delivery, streaming & send tools

This page explains how mono-agent delivers answers across channels (final-only vs. token streaming), which delivery and message-text knobs are config vs. code-only, how the app-owned MCP send tools (`SlackSendMessage`, `TelegramSendMessage`) let the agent push messages back through an already-configured chat adapter, and how native proactive delivery works for cron/webhook turns.

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

Concretely, build the driver yourself (e.g. `createTelegramChannelDriver` / `createSlackChannelDriver`) and pass `finalOnly: false` so the substrate's `ResilientMessageStream({ finalOnly })` edits an in-progress message as deltas arrive. See [Write your own channel adapter](/programmatic/custom-channels/) for the programmatic composition path.

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

Because these are code-only, they live in your driver wiring rather than `mono-agent.config.json`. See [Write your own channel adapter](/programmatic/custom-channels/).

Slack's built-in driver uses Slack's 40,000-character platform limit for final replies by default, so a final answer above the shared 3,800-character default but below Slack's limit is still delivered as one Slack message. Slack final replies and `SlackSendMessage` split into continuation posts only when text exceeds that platform limit. Telegram and custom channel streams keep their own defaults unless their driver overrides `stream.maxMessageChars`.

## App-owned send tools

mono-agent derives MCP **send tools** from already-enabled chat adapters so the agent can push a message back into a chat from inside a turn:

- `SlackSendMessage` — send through the configured Slack adapter
- `TelegramSendMessage` — send through the configured Telegram adapter
- `TelegramAskButtons` — post an inline-keyboard question (2–8 option labels) through the Telegram adapter
- `TelegramSendFile` — upload and send a file (`kind:"document"`) or an inline image (`kind:"photo"`) through the Telegram adapter
- `AskUser` — ask ONE free-text question on the current conversation and **block until the user replies** (channel-agnostic; see below)

Coverage: `config`. Three conditions must hold for a send tool to work:

1. The tool must be **permitted by the policy**. Under allow-all (the default) that is automatic once the channel is enabled — no allowlist entry needed. On runtimes that enforce specific lists, include the exact name or deny it normally. Direct `codex:*` rejects all restrictive normal-run policies before start; it never silently widens them.
2. The corresponding adapter must have **valid config** — `slack.*` for `SlackSendMessage`, `telegram.*` for the Telegram tools — which supplies the credentials and the destination bounds.
3. With `sandbox.mode: "native"`, the sandbox network policy must admit the tool's HTTP endpoint: `slack.com`, `api.telegram.org` (or the configured Telegram `apiRoot` host), and the configured loopback interaction-bridge host for `AskUser` / `TelegramAskButtons`. `mono-agent validate` names any missing host.

### Telegram interactive send tools

`TelegramAskButtons` and `TelegramSendFile` (added by the Telegram interactivity work) are gated exactly like the plain send tools above: permitted by the policy (automatic under allow-all, or their exact name in a specific `tools.allowedTools`) plus valid `telegram.*` config, with the adapter chat allowlist (`telegram.allowedChatIds` / `telegram.allowAllChats`) remaining the destination boundary.

- **`TelegramAskButtons`** posts an inline-keyboard question with **2–8** option labels and, by default, **waits for the user's tap**. The tapped label is returned to the same in-flight tool call, preserving the agent's mid-turn context. Set `wait: false` only when the tool must return immediately; the later tap then arrives as a separate synthetic user turn quoting the question and selected label. If a callback arrives with no pending ask, it uses that same synthetic-turn fallback. Allowing `TelegramAskButtons` is also the single switch that subscribes the bot to `callback_query` updates and wires the tap handler. See [Telegram](/channels/telegram/) for the full interactivity setup.
- **`TelegramSendFile`** uploads and sends a file (`kind:"document"`) or an inline image (`kind:"photo"`) to an allowed chat. It accepts the bytes as base64 `data` (with a `filename`) **or** a workspace `path` (filename derived from the path), plus an optional `caption`. Uploads are bounded by the adapter's attachment size cap (~20 MB).

The adapter's own allowlist (`slack.allowedChannelIds` / `slack.allowAllChannels`, `telegram.allowedChatIds` / `telegram.allowAllChats`) **remains the destination boundary**: allowing the tool does not widen where the agent may send. A send to a destination outside the adapter allowlist is refused.

The native sandbox's network allowlist is a separate egress boundary. App-owned send tools run in a sandboxed child and use SRT's authenticated proxy automatically; no `NODE_USE_ENV_PROXY` setting is needed. A `localhost`-only policy cannot reach Slack or Telegram. In `allowlist` mode, include the exact external API hosts plus an explicit loopback host (normally `127.0.0.1`) when a blocking ask tool is enabled. Mono-agent grants SRT's coarse loopback capability only to this trusted app-owned child; it does not let Bash or project MCP servers bind arbitrary loopback ports:

```json
{
  "sandbox": {
    "mode": "native",
    "network": {
      "mode": "allowlist",
      "allowlist": ["slack.com", "api.telegram.org", "127.0.0.1"]
    }
  }
}
```

`SlackSendMessage` accepts standard Markdown by default, renders it to Slack `mrkdwn`, and preserves Slack thread/formatting options on every chunk. Set its `mrkdwn` argument to `false` only when you need plain text sent unchanged. Text below Slack's 40,000-character platform limit is one post; text above the limit is split and each posted chunk is indexed so replies in those threads can resume the producing conversation.

### `AskUser` — blocking free-text ask (interaction bridge)

`AskUser` is the free-text blocking ask: the tool call posts a question to the current conversation's chat and **waits for the user's next message**, which is returned as the tool result — so the agent keeps its full mid-turn context. It is channel-agnostic and backed by the app's **interaction bridge** (a loopback HTTP registry started automatically when `AskUser` or `TelegramAskButtons` is allowed — under the allow-all default, or listed in a specific `tools.allowedTools`; tune it via the `interaction` config block).

- While an ask is pending, the user's next **plain-text** message on that chat is consumed as the ANSWER (acknowledged with a 👍 reaction) and never runs as a turn; media and `/`-commands pass through normally, and `/cancel` fails the pending ask.
- One pending ask per conversation: consolidate everything into a single question. A second concurrent ask returns an "already pending" result.
- On timeout (default 10 min, `interaction.askUser.timeoutMs`) the tool returns without an answer and the user's late reply arrives as a normal next turn. On an app restart pending asks degrade the same way.
- The wait keeps the MCP call alive via progress notifications (see `tools.mcpCallTimeoutMs` / `tools.mcpCallMaxTotalTimeoutMs`).
- Tool children can also POST `{conversationId, key, message, state}` to the bridge's `/v1/progress` (URL/token in `MONO_AGENT_INTERACTION_BRIDGE_URL`/`_TOKEN` env) to surface long-tool progress as a channel status message edited in place.

When a blocking `AskUser` or `TelegramAskButtons` call completes, mono-agent stores its exact question, options, outcome, and answer/selection when present in the assistant history copy committed for that turn. This makes the interaction available to a later cold/stateless replay even though the transport posted the question out of band. The final outward message and long-term memory capture remain unchanged. Non-blocking `TelegramAskButtons` (`wait: false`) is not folded into that in-turn record; its later callback remains a synthetic next turn.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "SlackSendMessage", "TelegramSendMessage", "TelegramAskButtons"]
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

## Native proactive notification (cron/webhook turns)

For scheduled cron jobs and webhook endpoints, set `notify: true` (optionally `notifyConversationId`) on the job or endpoint. When the run succeeds with non-empty final text, the agent's **final answer is delivered verbatim** to the resolved Telegram/Slack conversation — posted as-is with **no second LLM turn** — and recorded into that conversation's history, so a user's reply resumes with it in context.

This is AI-native: the operator just writes the cron/webhook prompt, and its final answer reaches the user. On a notify turn the harness **auto-injects guidance** telling the agent that its final reply is delivered verbatim and how to stay silent. The operator and the agent never configure or call an internal notify tool — there is no agent-facing notify tool.

Cron has one failure-side notification path as well: if a `notify: true` cron job fails because **all configured models failed** (`provider_unavailable_exhausted`), the app can send a short one-line error notice to the job's explicit `notifyConversationId`. This notice is verbatim, never starts another model turn, never infers a destination, and is rate-limited per job by `notifyFailureCooldownHours` (default `6` hours).

`conversationId` / `notifyConversationId` is a channel-scoped id such as `telegram:42`, `slack:C123`, or `slack:C123:1718.99` (a Slack thread).

### Destination resolution

- If `notifyConversationId` is set, it is the destination.
- Otherwise the app infers it **only when exactly one** notify-capable (Telegram/Slack) candidate exists — drawn from seen conversations plus the adapter allowlist.
- With **0 or 2+** candidates the app skips delivery with a warning rather than guessing.
- Cron model-exhaustion failure notices are stricter: they require explicit `notifyConversationId` and never use inference.

The owning channel's allowlist is the destination boundary: a delivery to a Telegram/Slack id outside `telegram.allowedChatIds` / `slack.allowedChannelIds` (or `allowAllChats` / `allowAllChannels`) is refused. WhatsApp is not notify-capable. Delivery is best-effort — a skipped or failed notification does not change the cron job result or the webhook's HTTP response / async stored status.

### Staying silent ("nothing to report")

To send nothing for a tick or request, the agent either produces an **empty final answer** or replies with exactly the reserved sentinel `NOTHING_TO_REPORT` (matched trimmed, case-insensitive). In either case no notification is posted.

### How native notification differs from send tools

| | **Native notify** (`notify: true`) | **Send tools** (`SlackSendMessage` / `TelegramSendMessage`) |
|---|---|---|
| Effect | Posts the final answer **verbatim** and records it as a remembered turn | Posts a message into a **channel** (side-channel; not a turn) |
| Available on | **cron / webhook turns** (opt-in per job/endpoint) | any turn |
| Agent involvement | None — the app delivers the final answer; no tool call | Agent calls the tool explicitly |
| Allowlist entry | **Not** a `tools.allowedTools` entry (config-level toggle) | Available under allow-all (the default); a specific `tools.allowedTools` needs the exact tool name |
| Destination bound | The owning channel's allowlist | The owning channel's allowlist |
| Channels | Telegram + Slack | Telegram + Slack |

### Fan-out and multi-destination

Notifying **multiple** or **other** conversations from one trigger is not a built-in. Compose it from several cron jobs (each with its own `notifyConversationId`) or from a skill that calls the send tools explicitly. The async-callback pattern — a live chat kicks off a long-running operation and a later webhook delivers the result back into the original conversation — is built by setting that endpoint's `notifyConversationId` (or passing it through to a single-candidate inference) so the final answer lands in the right place.

## Related pages

- [Telegram](/channels/telegram/) and [Slack](/channels/slack/) — adapter config and allowlists.
- [OpenAI-compatible endpoint](/channels/openai-api/) — token streaming over SSE.
- [Cron](/channels/cron/) and [Webhook](/channels/webhook/) — the proactive turns that support native `notify: true` delivery.
- [Tool policy](/tools/policy/) — `allowedTools` / `disallowedTools` precedence.
- [MCP tools](/tools/mcp/) — external MCP policy and the app-owned tool exceptions.
- [Write your own channel adapter](/programmatic/custom-channels/) — building a driver to override `stream.finalOnly`, debounce, and message texts.
