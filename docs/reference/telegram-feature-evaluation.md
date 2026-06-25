---
title: "Telegram feature evaluation"
sidebar:
  order: 6
---

# Telegram Bot feature evaluation

A decision record for which [Telegram Bot API](https://core.telegram.org/bots/features) features the mono-agent Telegram channel adopts, why, and the two architectural decisions behind the interactive ones. The agent uses Telegram as a 1:1 DM channel with its owner (plus optional group use); the evaluation is framed for an autonomous personal agent.

The baseline before this work: a hardened long-polling bot handling text + inbound media, MarkdownV2 outbound with plain-text fallback, streaming edits, a per-chat serial queue, proactive `notify()`, and hardcoded `/start /help /cancel`. It subscribed only to `message` updates.

## Adopted (this iteration)

All are **opt-in / default-off** and kept adapter-local (the shared text-only channel contract in `@mono-agent/agent-contracts` is untouched, exactly as Slack keeps its Block Kit interactivity local). See [Telegram channel](/channels/telegram/) for configuration.

| Feature | Value | Why |
| --- | --- | --- |
| **Inline keyboards + callback queries** (`telegram_ask`) | High | The headline: lets an autonomous agent pause and ask the owner a structured question — confirmation, approval, disambiguation — and get the choice back. Human-in-the-loop for consequential actions. |
| **Command menu** (`setMyCommands` + config `command→prompt`) | High (cheap) | Discoverable, autocompleted commands that run a configured prompt. Mirrors the Slack shortcut precedent. |
| **Status reactions** (👀/👍/👎) | Medium (cheap) | An agent-native acknowledgement of receipt and outcome on the user's own message, complementing the "typing…" indicator. |
| **Outbound files** (`telegram_send_document` / `telegram_send_photo`) | High | Many agent tasks produce artifacts (a report, a chart, a generated file) worth delivering back. |
| **Silent / quiet-hours notifications** (`disable_notification`) | Medium (cheap) | An overnight cron/webhook result lands without a 3am push. Threads through the existing verbatim notify path. |

## Considered and deferred / skipped

| Feature | Verdict | Reason |
| --- | --- | --- |
| **Mini Apps / Web Apps** | Deferred | High value but high cost — requires hosting an HTTPS web app, a separate project. Revisit if a rich settings/visualization surface is wanted. |
| **Webhooks (vs long polling)** | Skipped | The adapter deliberately hardened long polling (watchdog, IPv4 pin, backoff). Webhooks add an inbound port and TLS for marginal latency benefit on a personal agent. |
| **Inline mode** (`@bot` queries in any chat) | Skipped | Out of scope for a 1:1 personal agent; adds a separate update stream and operational surface. |
| **Polls / quizzes / dice** | Skipped | `telegram_ask` (inline keyboard) covers structured input more generally; dice is a novelty. |
| **Payments / Stars / business** | Skipped | Monetization features, irrelevant to a personal agent. |
| **Forum topics / threads** | Skipped | Only relevant to multi-topic group use, not 1:1 DMs. |
| **Stickers / custom emoji / games** | Skipped | Flavor, not core agent function. |

## Two architectural decisions (interactive features)

### 1. An agent tool, not response metadata

Inline keyboards are sent by an **agent tool** (`telegram_ask`, registered in `adapter-send-tools.ts` alongside `telegram_send_message`), not by attaching button definitions to the agent's answer metadata.

The outbound path is the shared, **text-only** `ResilientMessageStream` over `ChannelTransport.post/edit(text, {markdown})` — there is no slot for `reply_markup`. Routing buttons through answer metadata would force a separate `sendMessage` after `stream.finish`, bypassing the resilient delivery FSM, racing the final post, and firing only once at end-of-turn (the agent could never ask mid-reasoning). A tool is the project's established "mechanical primitive the LLM composes" shape, is config-first and default-off (exposed only when its name is in `tools.allowedTools`), and never widens the shared contract.

### 2. Non-blocking callbacks (synthetic turn), not a blocking await

`telegram_ask` posts the keyboard and **returns immediately**. When the owner taps, the bot's `callback_query` handler injects the choice as a **synthetic inbound turn** on the same `telegram:<chat>` conversation — identical to a typed reply on the warm session.

A blocking tool (one that parks inside `respond()` awaiting the tap) would hold the per-chat `SerialQueue` slot for the entire human-think time, stalling every other message and the shared cron/webhook `notify` for that chat, and would collide with run timeouts (`maxRunMs`, cron's 20-minute default) that reclaim a wedged run. Non-blocking reuses the existing admission queue, abort/`/cancel`, and session machinery untouched. The chosen label is reconstructed from the tapped message's own `reply_markup` (no cross-process state; survives a bot restart), and a small answered-set de-dupes double taps.

## Notes / constraints

- **Reaction emojis are constrained.** Telegram only permits a fixed set of reaction emojis for bots — ✅ and ❌ are *not* in it, so the lifecycle reactions use 👀 / 👍 / 👎 as the closest valid stand-ins.
- **`callback_data` 64-byte cap.** Buttons carry `ask:<index>` (well under the cap); the label round-trips via the message's own keyboard rather than being packed into the payload.
- **Allowlist on callbacks.** The callback handler re-checks the chat allowlist (the inbound auth gate covers a callback's chat, but the handler re-checks defensively).
- **Backward compatibility.** With every flag unset, `allowed_updates` stays `["message"]` and no new handlers register — zero behavior change for existing deployments.

## Related

- [Telegram channel](/channels/telegram/) — configuration for every feature here
- [Delivery and Send Tools](/channels/delivery-and-send-tools/)
- [Feature registry](/reference/feature-registry/) — `telegram.interactive`
