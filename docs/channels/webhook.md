---
title: "Webhook"
sidebar:
  order: 4
---

# Webhook

The webhook channel turns your agent into an HTTP endpoint: `POST` a JSON body with `text`, and the agent runs a turn. It is the zero-credential channel `mono-agent init` enables by default — a loopback smoke test you can `curl` immediately, and the integration point for automations, scripts, and other services. Coverage: **config** (`webhook` section), plus env overrides.

## Quick start

`init` writes a `webhook` block bound to loopback on a free port. Start the agent, then `POST` to the path:

```json
{
  "webhook": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 0,
    "path": "/webhook/invoke",
    "defaultMode": "sync"
  }
}
```

```bash
curl -s http://127.0.0.1:<port>/webhook/invoke \
  -H 'content-type: application/json' \
  -d '{"text": "Summarize today’s standup notes."}'
```

The actual bound host/port (when `port: 0`) is printed in the start log. In **sync** mode the agent's answer is returned in the response body.

## Configuration

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `true` | Channel on/off. Enabled by `init`. |
| `host` | string | `127.0.0.1` | Bind address. Loopback-only unless `allowNonLoopback` is `true`. |
| `port` | integer | `0` | `0` picks a free port (printed at startup). `1`–`65535` to pin one. |
| `path` | string | `/webhook/invoke` | POST path for the default (single) endpoint. |
| `defaultMode` | `sync` \| `async` | `sync` | Response mode when a request does not override it. |
| `allowNonLoopback` | boolean | `false` | Required to bind a non-loopback `host`. See warning below. |
| `retentionMs` | integer | `300000` | How long async run statuses are retained (min 1, max 86_400_000). |
| `maxStoredRequests` | integer | `100` | Max async statuses kept before pruning (min 1, max 10_000). Async only. |
| `prompt` | string | — | Pre-instructions prepended to the request text (see [Prompts](#endpoint-prompts)). |
| `notify` | boolean | `false` | Deliver the successful final answer via native notification. |
| `notifyConversationId` | string | inferred if exactly one destination | Destination conversation id for native notification. |
| `endpoints` | array | — | Multiple named endpoints — see [Multiple endpoints](#multiple-endpoints). |
| `dir` | string | `webhook` | Folder of `*.md` endpoint files, resolved against the app working directory. |

:::caution
The webhook server binds to loopback by default. Setting a non-loopback `host` (e.g. `0.0.0.0`) without `allowNonLoopback: true` is rejected — and exposing the endpoint publicly bypasses channel allowlists, so put it behind a reverse proxy or auth layer you control.
:::

## Request and response

The request body is a JSON object. `text` is required; everything else is optional.

| Field | Required | Notes |
|-------|----------|-------|
| `text` | yes | The user message for this turn. Non-empty. |
| `mode` | no | `sync` or `async`, overriding the endpoint's mode for this request. |
| `conversationId` | no | Reuse to continue a thread. Defaults to a per-request id (`webhook:<requestId>`). |
| `metadata` | no | Arbitrary JSON passed through to the turn. |

### Sync mode

The request blocks until the turn finishes and returns the answer text in the body. Use it for short, interactive automations where you want the result inline.

### Async mode

The request returns immediately with **HTTP 202** and a `statusUrl`. Poll that URL until `status` is `succeeded` (text included), `failed`, or `cancelled`. Use it for long-running turns that would otherwise exceed an HTTP timeout.

```bash
# kick off
curl -s http://127.0.0.1:<port>/webhook/invoke \
  -H 'content-type: application/json' \
  -d '{"text": "Research and draft the weekly report.", "mode": "async"}'
# → 202 { "status": "accepted", "requestId": "...", "statusUrl": "/webhook/invoke/status/..." }

# poll
curl -s http://127.0.0.1:<port>/webhook/invoke/status/<requestId>
# → { "status": "succeeded", "text": "..." }
```

Async statuses are kept in memory subject to `retentionMs` and `maxStoredRequests`; a status URL polled after expiry returns `not_found`. If a turn is already running and the runtime cannot accept another, a request returns **HTTP 409** (`status: "busy"`) — that transient state is not stored or replayed via the status URL.

## Proactive delivery and the async-callback pattern

For a webhook endpoint that always produces one user-facing result, prefer native notification: set `notify: true` on the endpoint, optionally set `notifyConversationId`, and make the agent's final answer the notification body. Native-notify webhook turns do not expose `notify_conversation` or `list_notify_destinations`, which prevents double delivery. Delivery is best-effort and does not change the sync HTTP response or async stored status if it is skipped or fails.

If `notifyConversationId` is omitted, the app auto-selects a destination only when exactly one Telegram/Slack notify destination is available; otherwise it skips delivery and logs why. The destination id uses the same shape as the notify tools: `telegram:42`, `slack:C123`, or `slack:C123:1718.99` for a Slack thread.

Webhook turns without native notification automatically get the proactive `notify_conversation(conversationId, text)` and `list_notify_destinations()` tools — injected only on webhook turns and ordinary cron turns without native notification, and not gated by `tools.allowedTools`. This makes the webhook the inbound half of an **async callback**:

1. In a live chat (Telegram/Slack), the agent kicks off a long-running external operation and asks the service to call back later. It embeds the current conversation's id — surfaced in the [Session context block](/context/assembly/#session) — in the callback request.
2. When the service finishes, it `POST`s to this webhook with that id carried in the body (e.g. `"conversationId"` or inside `metadata`).
3. The webhook turn reads the id from the payload and calls `notify_conversation(conversationId, …)` to deliver the result **back into the original conversation** as a real, remembered turn — not a side-channel post.

Because the destination id comes from the request payload, the security boundary is the **owning channel's allowlist**: a delivery to a Telegram/Slack id outside `telegram.allowedChatIds` / `slack.allowedChannelIds` (or `allowAll*`) is refused. See [Proactive notify tools](/channels/delivery-and-send-tools/#proactive-notify-tools-cronwebhook-turns).

## Multiple endpoints

You can serve several named endpoints on the **one** shared host/port, each with its own path, mode, and optional prompt. Define them inline under `webhook.endpoints[]`:

```json
{
  "webhook": {
    "enabled": true,
    "port": 8787,
    "defaultMode": "sync",
    "endpoints": [
      {
        "name": "triage",
        "path": "/hooks/triage",
        "mode": "async",
        "prompt": "You are triaging an inbound support ticket. Classify and summarize.",
        "notify": true,
        "notifyConversationId": "slack:C012345"
      },
      {
        "name": "echo",
        "path": "/hooks/echo",
        "enabled": true
      }
    ]
  }
}
```

Each endpoint needs a **unique `name` and a unique `path`**; a duplicate of either (across inline config and folder files) is a hard configuration error. `mode` defaults to `defaultMode`, and `enabled` defaults to `true`.

### Endpoint files (`*.md`)

Instead of (or alongside) inline config, author one `*.md` file per endpoint in `webhook.dir` (default `webhook/`). The YAML frontmatter holds routing metadata and the markdown body becomes the endpoint's `prompt`:

```markdown
---
name: triage
path: /hooks/triage
mode: async
enabled: true
notify: true
notifyConversationId: slack:C012345
---
You are triaging an inbound support ticket. Classify it and summarize the next action.
```

`path` is required in frontmatter; `name` defaults to the filename stem, `mode` to `defaultMode`, `enabled` to `true`, and `notify` to `false`. Unlike [cron](/channels/cron/) jobs, the body may be empty (an endpoint with no prompt). Files are loaded in sorted filename order. This mirrors how cron jobs can be authored as `cron/*.md` files.

## Endpoint prompts

A per-endpoint `prompt` (inline, or the body of an `*.md` file) is **prepended to the incoming request `text`** before the turn runs — the same role a cron job's prompt plays. This lets one HTTP caller send only data while the endpoint supplies the standing instructions. Callers cannot see or override the prompt.

## Environment variables

Every key has a `MONO_AGENT_WEBHOOK_*` override, which takes precedence over the JSON config:

| Env var | Maps to |
|---------|---------|
| `MONO_AGENT_WEBHOOK_ENABLED` | `webhook.enabled` |
| `MONO_AGENT_WEBHOOK_HOST` | `webhook.host` |
| `MONO_AGENT_WEBHOOK_PORT` | `webhook.port` |
| `MONO_AGENT_WEBHOOK_PATH` | `webhook.path` |
| `MONO_AGENT_WEBHOOK_DEFAULT_MODE` | `webhook.defaultMode` |
| `MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK` | `webhook.allowNonLoopback` |
| `MONO_AGENT_WEBHOOK_RETENTION_MS` | `webhook.retentionMs` |
| `MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS` | `webhook.maxStoredRequests` |
| `MONO_AGENT_WEBHOOK_PROMPT` | `webhook.prompt` |
| `MONO_AGENT_WEBHOOK_NOTIFY` | `webhook.notify` |
| `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID` | `webhook.notifyConversationId` |
| `MONO_AGENT_WEBHOOK_DIR` | `webhook.dir` |
| `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` | `webhook.endpoints` (JSON array string) |

See [Environment variables](/config/env-vars/) for precedence rules.

## Related

- [Webhook automation: sync and async](/playbooks/webhook-automation-sync-async/) — end-to-end recipe.
- [Cron](/channels/cron/) — scheduled turns; shares the `*.md` authoring pattern and the `prompt` concept.
- [Delivery and send tools](/channels/delivery-and-send-tools/) — how answers are returned and proactively delivered.
- [Channels overview](/channels/) — all channels and the allowlist model.
- [Custom channels](/programmatic/custom-channels/) — build your own transport (code-only).
