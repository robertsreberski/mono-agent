---
title: "Webhook Automation with Sync + Async Endpoints"
parent: "Playbooks"
nav_order: 5
---

# Webhook Automation with Sync + Async Endpoints

This playbook wires the agent into an automation pipeline over HTTP: a fast **sync** endpoint that returns the answer in the response body, and a long-running **async** endpoint that returns `202` plus a status URL you poll until the job completes. It also shows how to run several named endpoints on one shared port, defined inline or as `webhook/*.md` files.

## Who this is for

Backend developers integrating the agent into a pipeline — calling it from scripts, CI jobs, or other services rather than a chat channel.

## Goal

Accept fast sync HTTP calls and long-running async jobs (202 + status polling) across multiple named endpoints, some defined as markdown files.

## Features used

- [`webhook.http-invoke`](../channels/webhook.md) — `POST` a JSON body, the agent runs a turn.
- [`webhook.sync-async-modes`](../channels/webhook.md) — `sync` returns the body inline; `async` returns `202` + a status URL to poll.
- [`webhook.endpoints-dir`](../channels/webhook.md) — multiple named endpoints inline (`webhook.endpoints[]`) or as `*.md` files under `webhook.dir`.

All three are **config** coverage (the `webhook` section plus `MONO_AGENT_WEBHOOK_*` env overrides).

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

The matching env overrides are `MONO_AGENT_WEBHOOK_HOST`, `MONO_AGENT_WEBHOOK_PORT`, `MONO_AGENT_WEBHOOK_DEFAULT_MODE`, `MONO_AGENT_WEBHOOK_RETENTION_MS`, `MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS`, and `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` (the `endpoints` array as a JSON string).

The server binds to loopback by default. A non-loopback `host` (e.g. `0.0.0.0`) without `allowNonLoopback: true` is rejected — and a public endpoint bypasses channel allowlists, so put it behind a reverse proxy or auth layer you control.
{: .warning }

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

`path` is required; `name` defaults to the filename stem, `mode` to `defaultMode`, and `enabled` to `true`. This mirrors how [cron](../channels/cron.md) jobs can be authored as `cron/*.md` files.

## Steps

1. `mono-agent init --model claude:claude-sonnet-4-6` — the webhook channel is enabled by `init` already.
2. Add multiple endpoints in `webhook.endpoints[]` and/or `webhook/*.md` files, giving each a unique `name` AND a unique `path`.
3. Run `mono-agent validate`, then `mono-agent start`.
4. `curl` the sync endpoint for an immediate response body; `curl` the async endpoint for a `202` plus a status URL.
5. Poll the async status URL until the job reports complete.
6. Confirm async retention behavior — the status entry vanishes after `retentionMs` (300000 ms / 5 minutes above).

## Smoke test

`curl -X POST /webhook/invoke` and inspect the response body; `curl -X POST /webhook/jobs`, get `202` + a status URL, then poll that URL until the result is returned.
{: .tip }

## Related

- [Webhook channel](../channels/webhook.md) — full key reference, endpoint files, prompts, and env overrides.
- [Cron](../channels/cron.md) — scheduled turns; shares the `*.md` authoring pattern and the `prompt` concept.
- [Delivery and send tools](../channels/delivery-and-send-tools.md) — how answers are returned across channels.
- [Config blueprint](../config/blueprint.md) — the annotated `mono-agent.config.json`.
- [mono-agent-composer skill](../../packages/agent-app/skills/mono-agent-composer/SKILL.md) — build this agent from one config.
