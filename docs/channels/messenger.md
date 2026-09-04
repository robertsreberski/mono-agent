---
title: "Facebook Messenger"
description: "Talk to the agent from Facebook Messenger through a signed Meta webhook and the Send API, loaded as an external channel plugin."
sidebar:
  order: 9
---

The Messenger channel connects your agent to a Facebook Page's Messenger inbox. Meta POSTs each message to a webhook the adapter serves, and replies go out through the Send API. It is provided by the external `@mono-agent/messenger-adapter` package and loaded through `channels.plugins[]`. Coverage: **config** — see [feature-registry](/reference/feature-matrix/) row `messenger.graph`.

## Quick start

1. In the Meta developer console create an app with the Messenger product, connect your Page, and generate a **Page access token**. Copy the **App secret** from the app's basic settings. Choose any string as the **verify token**.
2. Put the three values in the agent's `.env`:

```bash
MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN=...
MONO_AGENT_MESSENGER_APP_SECRET=...
MONO_AGENT_MESSENGER_VERIFY_TOKEN=...
```

3. Declare the plugin and allow one or more users:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/messenger-adapter",
        "id": "messenger",
        "config": {
          "enabled": true,
          "allowedUserIds": ["1234567890123456"],
          "host": "0.0.0.0",
          "port": 8650,
          "allowNonLoopback": true
        }
      }
    ]
  }
}
```

4. Expose `http://<host>:8650/messenger/webhook` over HTTPS (a reverse proxy or a tunnel such as cloudflared) and register that public URL in the app's Messenger **Webhooks** settings with the same verify token, subscribed to `messages` and `messaging_postbacks`. Meta calls `GET` with `hub.challenge` during registration; the adapter answers it once the agent is running.

:::caution
The Page access token can send messages as your Page. Keep it in `.env`, never in the JSON config. The adapter refuses to bind a non-loopback host unless `allowNonLoopback` is set, so an accidental public listener without TLS termination fails validation.
:::

## Configuration

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `config.enabled` | boolean | `false` | Opt-in switch. Off means the channel reports "disabled" (not "waiting"). |
| `config.allowedUserIds` | string[] | `[]` | Page-scoped user ids (PSIDs) allowed to talk to the agent. |
| `config.allowAllUsers` | boolean | `false` | When `true`, every user is allowed; the allowlist is ignored. |
| `config.host` | string | `127.0.0.1` | Bind address for the webhook server. |
| `config.port` | integer | `8650` | Bind port. |
| `config.webhookPath` | string | `/messenger/webhook` | Webhook route. `<path>/health` answers liveness checks. |
| `config.apiVersion` | string | `v21.0` | Graph API version used for sends. |
| `config.allowNonLoopback` | boolean | `false` | Required to bind anything other than loopback. |
| `config.proactiveMessagingType` | `RESPONSE` \| `UPDATE` \| `MESSAGE_TAG` | `RESPONSE` | Send API `messaging_type` for proactive cron/webhook deliveries. |
| `config.proactiveTag` | string | — | Policy tag required with `MESSAGE_TAG`, e.g. `CONFIRMED_EVENT_UPDATE`. |

Secrets are read from `MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN`, `MONO_AGENT_MESSENGER_APP_SECRET`, and `MONO_AGENT_MESSENGER_VERIFY_TOKEN`; every other field also has a `MONO_AGENT_MESSENGER_*` env override (see [Environment variables](/config/env-vars/)).

## Finding a PSID

A PSID is specific to your Page. Temporarily set `allowAllUsers: true`, send the Page a message, read the id from the start log's unauthorized/handled lines or the run artifacts, then move it into `allowedUserIds` and turn `allowAllUsers` off. An unlisted sender receives a one-line denial; their text never reaches the agent.

## Conversation ids and proactive delivery

Conversations are keyed `messenger:<psid>`. Cron jobs and webhook endpoints deliver to one with `notifyConversationId: "messenger:<psid>"`: the final answer is posted verbatim as plain text, split into 2,000-character messages, and recorded to that conversation's history so a later reply resumes with it in context. See [Delivery & send tools](/channels/delivery-and-send-tools/).

Meta only delivers ordinary messages within 24 hours of the user's last message. A reminder that may fire outside that window needs `proactiveMessagingType: "MESSAGE_TAG"` and a policy-compliant `proactiveTag`.

## Behaviour

- Webhook POSTs are verified with `X-Hub-Signature-256` over the raw body, acknowledged immediately, and processed afterwards; duplicate deliveries are dropped by message id.
- Messages from one user run in order; up to four queue behind an active turn, then the user gets a short busy reply. `/cancel` aborts the active turn; `/help` and `/start` answer without a model call.
- Images and PDF/text files are downloaded from Meta's CDN (https only, 20 MiB cap) and passed as attachments. Audio, video, locations, and other files are described in the request text.
- Replies are plain text: Markdown is flattened before sending.

## Related

The [Telegram personal-assistant playbook](/playbooks/telegram-personal-assistant-bujo/) translates directly: add the `@mono-agent/messenger-adapter` entry under `channels.plugins[]` and point cron `notifyConversationId` values at `messenger:<psid>`. See the [Channels overview](/channels/) for the shared allowlist and status model.
