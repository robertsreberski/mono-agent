---
title: "Webhook Automation with Sync + Async Endpoints"
sidebar:
  order: 5
---

# Webhook Automation with Sync + Async Endpoints

This playbook wires the agent into an automation pipeline over HTTP: a fast **sync** endpoint that returns the answer in the response body, and a long-running **async** endpoint that returns `202` plus a status URL you poll until the job completes. It also shows how to run several named endpoints on one shared port, defined inline or as `webhook/*.md` files.

## Who this is for

Backend developers integrating the agent into a pipeline — calling it from scripts, CI jobs, or other services rather than a chat channel.

## Goal

Accept fast sync HTTP calls and long-running async jobs (202 + status polling) across multiple named endpoints, some defined as markdown files.

## Features used

- [`webhook.http-invoke`](/channels/webhook/) — `POST` a JSON body, the agent runs a turn.
- [`webhook.sync-async-modes`](/channels/webhook/) — `sync` returns the body inline; `async` returns `202` + a status URL to poll.
- [`webhook.endpoints-dir`](/channels/webhook/) — multiple named endpoints inline (`webhook.endpoints[]`) or as `*.md` files under `webhook.dir`.
- [`channel.native-notify`](/channels/delivery-and-send-tools/#native-proactive-notification-cronwebhook-turns) — an endpoint with `notify: true` delivers its final answer back into a chat verbatim (no agent-facing tool involved).

The first three are **config** coverage (the `webhook` section plus `MONO_AGENT_WEBHOOK_*` env overrides); native notification is opt-in per endpoint via `notify: true`.

## Configuration

`mono-agent init` already enables the webhook channel with a single sync endpoint. The config below adds a second async endpoint and a per-endpoint `prompt`. Each endpoint needs a **unique `name` and a unique `path`**; a duplicate of either (across inline config and folder files) is a hard configuration error.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "webhook": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8080,
    "defaultMode": "sync",
    "endpoints": [
      {
        "name": "invoke",
        "path": "/webhook/invoke",
        "mode": "sync",
        "prompt": "Respond to this request:"
      },
      {
        "name": "jobs",
        "path": "/webhook/jobs",
        "mode": "async"
      }
    ],
    "retentionMs": 300000,
    "maxStoredRequests": 100
  }
}
```

The matching env overrides are `MONO_AGENT_WEBHOOK_HOST`, `MONO_AGENT_WEBHOOK_PORT`, `MONO_AGENT_WEBHOOK_DEFAULT_MODE`, `MONO_AGENT_WEBHOOK_RETENTION_MS`, `MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS`, `MONO_AGENT_WEBHOOK_NOTIFY`, `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID`, and `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` (the `endpoints` array as a JSON string).

:::caution
The server binds to loopback by default. A non-loopback `host` (e.g. `0.0.0.0`) without `allowNonLoopback: true` is rejected — and a public endpoint bypasses channel allowlists, so put it behind a reverse proxy or auth layer you control.
:::

### Endpoints as markdown files

Alongside (or instead of) `webhook.endpoints[]`, author one `*.md` file per endpoint in `webhook.dir` (default `webhook/`). YAML frontmatter holds routing metadata; the markdown body becomes the endpoint's `prompt`, which is **prepended to the incoming request `text`** before the turn runs.

```yaml
---
path: /webhook/triage
name: triage
mode: async
---
You are triaging an inbound support ticket. Classify and summarize.
```

`path` is required; `name` defaults to the filename stem, `mode` to `defaultMode`, `enabled` to `true`, and `notify` to `false`. This mirrors how [cron](/channels/cron/) jobs can be authored as `cron/*.md` files.

## Async callback: deliver a result back into a chat

Polling is fine for a script, but when the original request came from a **chat** the result can be pushed back into that conversation when the work finishes — no agent-facing tool involved. Set `notify: true` on the endpoint; its final answer is then delivered **verbatim** to a destination resolved in this order:

1. the endpoint's configured `notifyConversationId`, if set; otherwise
2. the inbound request's own `conversationId`, when the payload names a deliverable chat (`telegram:…` / `slack:…`) — this is the async-callback case; otherwise
3. the single notify-capable destination, when exactly one exists.

This makes the webhook the inbound half of an async callback:

1. In a Telegram/Slack chat, the agent starts a long-running external job and asks the service to call back, embedding the current conversation id (from the [Session context block](/context/assembly/#session)) in the callback request.
2. The service finishes and `POST`s to a `notify: true` webhook endpoint here, carrying that id in the body as `conversationId` (e.g. `"conversationId": "telegram:42"`).
3. The endpoint runs its prompt; its final answer is delivered verbatim back into the original chat and recorded to that conversation's history, so a reply resumes with it in context — no polling required.

The destination is bounded by the owning channel's allowlist, so a payload-supplied id outside `telegram.allowedChatIds` / `slack.allowedChannelIds` (or `allowAll*`) is refused. If there is nothing worth sending, the agent replies with exactly `NOTHING_TO_REPORT` and no notification is delivered. See [Native proactive notification](/channels/delivery-and-send-tools/#native-proactive-notification-cronwebhook-turns).

## Steps

1. `mono-agent init --model claude:claude-sonnet-4-6` — the webhook channel is enabled by `init` already.
2. Add multiple endpoints in `webhook.endpoints[]` and/or `webhook/*.md` files, giving each a unique `name` AND a unique `path`.
3. Run `mono-agent validate`, then `mono-agent start`.
4. `curl` the sync endpoint for an immediate response body; `curl` the async endpoint for a `202` plus a status URL.
5. Poll the async status URL until the job reports complete.
6. Confirm async retention behavior — the status entry vanishes after `retentionMs` (300000 ms / 5 minutes above).

## Smoke test

:::tip
`curl -X POST /webhook/invoke` and inspect the response body; `curl -X POST /webhook/jobs`, get `202` + a status URL, then poll that URL until the result is returned.
:::

## Related

- [Webhook channel](/channels/webhook/) — full key reference, endpoint files, prompts, and env overrides.
- [Cron](/channels/cron/) — scheduled turns; shares the `*.md` authoring pattern and the `prompt` concept.
- [Delivery and send tools](/channels/delivery-and-send-tools/) — how answers are returned across channels.
- [Config blueprint](/config/blueprint/) — the annotated `mono-agent.config.json`.
- [mono-agent-composer skill](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md) — build this agent from one config.
