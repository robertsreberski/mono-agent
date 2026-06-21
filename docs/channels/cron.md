---
title: "Cron"
parent: "Channels"
nav_order: 7
---

# Cron

The cron channel fires scheduled prompts at the agent's responder on a timezone-aware five-field schedule. Jobs run on an **in-app scheduler** — no system `cron`, `crontab`, or `launchd` is involved, so the agent just needs to be running. Jobs can be declared inline in config and/or as one `*.md` file per job in a folder; the two sources merge. Coverage: `config`.

## What a cron job is

Each tick invokes the responder with the job's `prompt` text, exactly as if a message arrived on a channel. The result is produced inside the agent process. If you want a tick to *deliver* output somewhere (a Telegram chat, a Slack channel), wire delivery through the proactive send tooling — see [Delivery & send tools](delivery-and-send-tools.md).

## Configuration

```json
{
  "cron": {
    "dir": "cron",
    "jobs": [
      {
        "id": "daily",
        "enabled": true,
        "expression": "0 9 * * *",
        "timezone": "UTC",
        "prompt": "Post the morning summary.",
        "conversationId": "cron-daily"
      }
    ]
  }
}
```

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `cron.dir` | string | no | `cron` | Folder of per-job `*.md` files (frontmatter metadata + prompt body). |
| `cron.jobs[]` | array | no | `[]` | Inline job definitions. Merges with `*.md` files in `cron.dir`. |
| `jobs[].id` | string | yes | — | Unique job id. Duplicate ids (across config and folder) are an error. |
| `jobs[].enabled` | boolean | no | `true` | Set `false` to keep a job defined but unscheduled. |
| `jobs[].expression` | string | yes | — | Five-field cron expression (`min hour dom month dow`). |
| `jobs[].timezone` | string | no | `UTC` | IANA timezone (e.g. `Europe/Rome`) the expression is evaluated in. |
| `jobs[].prompt` | string | yes | — | Text sent to the responder on each tick. |
| `jobs[].conversationId` | string | no | per-tick | Share memory/history across ticks (see below). |

## Environment variables

| Variable | Maps to | Notes |
| --- | --- | --- |
| `MONO_AGENT_CRON_DIR` | `cron.dir` | Folder of per-job `*.md` files; default `cron/`. |
| `MONO_AGENT_CRON_JOBS_JSON` | `cron.jobs[]` | Full JSON array of jobs. |
| `MONO_AGENT_CRON_*` | `cron.jobs[]` | Single-job field overrides (`id`, `expression`, `timezone`, `prompt`, `conversationId`). |

See [Environment variables](../config/env-vars.md) for the full precedence rules.

## Markdown job files

Instead of (or alongside) inline `jobs`, drop one Markdown file per job in `cron.dir` (default `cron/`). Frontmatter holds the metadata; the body is the prompt:

```markdown
---
id: morning-digest
enabled: true
expression: "0 7 * * *"
timezone: "Europe/Rome"
conversationId: cron-digest
---
Summarize yesterday's unread items and post the digest.
```

Folder jobs and inline `jobs[]` are **merged** into one job set. A job id that appears in both — or twice in the folder — is a configuration error, not a silent override.
{: .warning }

This mirrors how the webhook channel authors per-endpoint prompts; see [Webhook](webhook.md).

## Overlap: ticks are skipped, never queued

If a tick fires while the previous run of the **same job** is still in flight, the new tick is **skipped** — it is not queued and does not run later. The in-flight run continues uninterrupted. Different jobs run independently and never block one another.

Pick an `expression` whose interval comfortably exceeds the job's typical runtime; otherwise the agent will quietly drop overlapping firings.
{: .note }

## Sharing memory and history with `conversationId`

Each tick defaults to its own ephemeral context. Set a stable `conversationId` to make every tick of a job land in the same conversation thread, so the job accumulates history and shares memory across runs — useful for digests that should not repeat themselves or jobs that build on prior state. Two jobs that set the same `conversationId` will share that thread.

See [Sessions & concurrency](../runtime/sessions-concurrency.md) for how conversations map to provider sessions.

## Related

- [Cron digest + proactive notify](../playbooks/cron-digest-proactive-notify.md) — end-to-end scheduled-digest playbook.
- [Delivery & send tools](delivery-and-send-tools.md) — push a tick's output to a channel.
- [Channels overview](index.md).
