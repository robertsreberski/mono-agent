---
title: "Cron"
sidebar:
  order: 7
---

# Cron

The cron channel fires scheduled prompts at the agent's responder on a timezone-aware five-field schedule. Jobs run on an **in-app scheduler** — no system `cron`, `crontab`, or `launchd` is involved, so the agent just needs to be running. Jobs can be declared inline in config and/or as one `*.md` file per job in a folder; the two sources merge. Coverage: `config`.

## What a cron job is

Each tick invokes the responder with the job's `prompt` text, exactly as if a message arrived on a channel. The result is produced inside the agent process. If you want a scheduled message to reach the user, prefer native cron notification with `notify: true`: the agent writes the final answer once, and the app delivers it to a Telegram or Slack conversation after the run succeeds.

### Proactive delivery from a cron turn

Set `notify: true` on a job to deliver its successful, non-empty final answer to a Telegram or Slack conversation. The agent's **final answer is posted verbatim** — no second LLM turn — and recorded into the destination's history, so a user's reply resumes with it in context. The operator just writes the prompt; on a notify turn the harness auto-injects guidance telling the agent that its final reply is delivered as-is and how to stay silent.

**Destination resolution.** If `notifyConversationId` is set, it is used (`telegram:42`, `slack:C123`, or `slack:C123:1718.99` for a Slack thread). If it is omitted, the app infers the destination **only when exactly one** Telegram/Slack notify-capable candidate exists (from seen conversations plus the adapter allowlist). With 0 or 2+ candidates, delivery is skipped with a warning — it never guesses. Delivery is best-effort: a failed notification does not change the cron job result.

**Staying silent.** To send nothing for this tick, have the agent produce an **empty final answer** or reply with exactly the reserved sentinel `NOTHING_TO_REPORT` (matched trimmed, case-insensitive). In either case no notification is sent.

Notifying **multiple** or **other** conversations from one trigger is not a built-in: compose it from several cron jobs, each with its own `notifyConversationId`, or from a skill.

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
        "conversationId": "cron-daily",
        "notify": true,
        "notifyConversationId": "telegram:42"
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
| `jobs[].maxRunMs` | number | no | `1200000` | Per-job watchdog in milliseconds. |
| `jobs[].notify` | boolean | no | `false` | Deliver the successful final answer via native cron notification. |
| `jobs[].notifyConversationId` | string | no | inferred if exactly one destination | Destination conversation id for native notification. |

## Environment variables

| Variable | Maps to | Notes |
| --- | --- | --- |
| `MONO_AGENT_CRON_DIR` | `cron.dir` | Folder of per-job `*.md` files; default `cron/`. |
| `MONO_AGENT_CRON_JOBS_JSON` | `cron.jobs[]` | Full JSON array of jobs. |
| `MONO_AGENT_CRON_*` | `cron.jobs[]` | Single-job field overrides (`id`, `expression`, `timezone`, `prompt`, `conversationId`, `notify`, `notifyConversationId`). |

See [Environment variables](/config/env-vars/) for the full precedence rules.

## Markdown job files

Instead of (or alongside) inline `jobs`, drop one Markdown file per job in `cron.dir` (default `cron/`). Frontmatter holds the metadata; the body is the prompt:

```markdown
---
id: morning-digest
enabled: true
expression: "0 7 * * *"
timezone: "Europe/Rome"
conversationId: cron-digest
notify: true
notifyConversationId: telegram:42
---
Summarize yesterday's unread items. Your final answer is delivered verbatim; reply NOTHING_TO_REPORT if there is nothing new.
```

:::caution
Folder jobs and inline `jobs[]` are **merged** into one job set. A job id that appears in both — or twice in the folder — is a configuration error, not a silent override.
:::

This mirrors how the webhook channel authors per-endpoint prompts; see [Webhook](/channels/webhook/).

## Overlap: ticks are skipped, never queued

If a tick fires while the previous run of the **same job** is still in flight, the new tick is **skipped** — it is not queued and does not run later. The in-flight run continues uninterrupted. Different jobs run independently and never block one another.

:::note
Pick an `expression` whose interval comfortably exceeds the job's typical runtime; otherwise the agent will quietly drop overlapping firings.
:::

## Run watchdog: a wedged run is aborted, not left to starve

Skip-on-overlap protects against a *still-running* prior tick. A separate watchdog protects against a *wedged* one. If a run never settles (a hung responder, a stuck provider call), it would otherwise hold the job's slot forever and skip **every** future firing as "a prior run is still active." To prevent that, the cron channel runs each job under a **20-minute watchdog** (`maxRunMs`, default `1200000`): a run that does not finish in time is aborted and its slot reclaimed, so the next tick can fire.

The watchdog is **per job** — a wedged job does not affect its siblings — and is comfortably above any real briefing/scan. Set `jobs[].maxRunMs` (or `maxRunMs` frontmatter) to override the default for a specific job. Programmatic callers can still set `maxRunMs` on `startCronAdapter` as the adapter-level fallback. An aborted run is recorded with an `interrupted` status — see [Run artifacts & traces](/observability/artifacts-and-traces/).

## Sharing memory and history with `conversationId`

Each tick defaults to its own ephemeral context. Set a stable `conversationId` to make every tick of a job land in the same run-history thread, so the job accumulates history and shares memory across runs — useful for digests that should not repeat themselves or jobs that build on prior state. This is not the notification destination; use `notifyConversationId` for that. Two jobs that set the same `conversationId` will share that thread.

See [Sessions & concurrency](/runtime/sessions-concurrency/) for how conversations map to provider sessions.

## Related

- [Cron digest + proactive notify](/playbooks/cron-digest-proactive-notify/) — end-to-end scheduled-digest playbook.
- [Delivery & send tools](/channels/delivery-and-send-tools/) — push a tick's output to a channel.
- [Channels overview](/channels/).
