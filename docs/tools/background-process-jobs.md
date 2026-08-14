---
title: "Background process jobs"
description: "Run Pi-native Exec and Bash calls after a turn returns, then wake the exact originating conversation with durable bounded results."
sidebar:
  order: 5
---

Background process jobs let the existing Pi-native `Exec` and `Bash` tools
return immediately while mono-agent continues to own the spawned process tree.
There is no separate job tool. When the host has an available process-job
controller, both schemas gain the optional `background: true` field. Without
that controller, the schemas and foreground execution path are unchanged.

Use this for a command that should outlive the current model turn but still
report back to the exact Slack thread, Telegram chat, or web-console thread that
started it. It is independent from [durable continuations](/tools/durable-continuations/):
a process job owns a local `Exec` or `Bash` child, while a continuation accepts a
later result from a selected external MCP service.

## Configuration

The feature is opt-in and every key is JSON-only. Unknown keys are rejected.
`stateDir` must be a relative child of the agent root.

```json
{
  "processJobs": {
    "enabled": true,
    "stateDir": ".mono-agent/process-jobs",
    "maxConcurrent": 4,
    "maxActivePerConversation": 2,
    "maxQueued": 8,
    "maxRuntimeMs": 1800000,
    "maxQueueAgeMs": 300000,
    "maxOutputBytes": 1048576,
    "previewChars": 2000,
    "maxChainDepth": 4,
    "retention": {
      "maxRecords": 1000,
      "maxAgeMs": 604800000,
      "artifactMaxBytes": 268435456
    }
  }
}
```

| Setting | Default | Compiled maximum |
| --- | ---: | ---: |
| `maxConcurrent` | 4 | 32 |
| `maxActivePerConversation` | 2 | 8 |
| `maxQueued` | 8 | 64 |
| `maxRuntimeMs` | 30 minutes | 24 hours |
| `maxQueueAgeMs` | 5 minutes | 1 hour |
| `maxOutputBytes` | 1 MiB | 8 MiB |
| `previewChars` | 2,000 | 8,000 |
| `maxChainDepth` | 4 | 8 |
| `retention.maxRecords` | 1,000 | 10,000 |
| `retention.maxAgeMs` | 7 days | 30 days |
| `retention.artifactMaxBytes` | 256 MiB | 1 GiB |

The compiled maximum bounds configuration, configuration bounds each job, and
a tool call may narrow only `timeout_ms` and `max_output_chars`. Queue age starts
at admission. The runtime deadline starts when the detached launch gate is
spawned immediately before ownership is persisted, so waiting in a busy queue
does not consume the runtime budget.

## Availability and origins

The host injects the controller only when all of these are true at call time:

- `processJobs.enabled` is `true` and the owner-private store lock is ready;
- the platform is POSIX; Windows is unsupported;
- the selected request route is Pi-native;
- the ordinary tool policy permits `Exec` or `Bash`; and
- the turn originated in an exact Slack, Telegram, or web-console conversation
  that the host can wake later.

Direct TUI turns, cron, webhook, OpenAI API, A2A, and plugin channels do not get
background schemas. A controller also rejects an invalid origin as
`background_unsupported_channel`. Foreground calls continue to use their normal
route and policy. A wake is a genuine normal-tool turn with ordinary history,
not continuation synthesis, so the host increments an unforgeable chain depth
and stops injecting background capability at the configured limit.

## Starting a job

Use the existing tool exactly as before and add `background: true`:

```json
{
  "executable": "pnpm",
  "args": ["test"],
  "workdir": ".",
  "timeout_ms": 900000,
  "max_output_chars": 4000,
  "background": true
}
```

`Bash` preserves its clean non-interactive shell semantics; `Exec` preserves
literal argv semantics. Both reuse the exact sandbox-prepared command that a
foreground call would launch. The immediate result contains only an opaque
`job_id`, `state`, and `started_at`; it does not expose argv, environment,
process ids, paths, or secrets.

The process owns its sandbox settings until the complete process tree exits.
On POSIX a command-agnostic detached group leader starts first. Mono-agent
persists its PID, equal PGID, and process-incarnation evidence before releasing
the exact command and environment over an anonymous pipe. A crash before that
commit cannot spawn the target; a crash after release leaves a recoverable
owned group. Timeout, cancellation, and matched restart recovery can therefore
terminate descendants before sandbox cleanup.

## Lifecycle, output, and wake delivery

Jobs move through this durable state machine:

```text
queued -> starting -> running -> succeeded | failed | timed_out | cancelled
   |          |
   |          +----------------> spawn_failed | cancelled
   +---------------------------> queue_expired | cancelled
any nonterminal at restart -> interrupted
```

Wake delivery is orthogonal: `pending`, `delivered`, or `failed`, with a stable
delivery key and attempt count. A terminal transition is lock-idempotent and
schedules one wake. An adapter result that explicitly proves retry is safe gets
at most three attempts with the same delivery key, including across restart.
Ambiguous wake attempts are not replayed automatically, because a second post
could duplicate a real first delivery.

Stdout and stderr are stored separately under the configured output budget.
The model, CLI, operator API, and web card receive only bounded redacted
previews plus agent-root-relative artifact references. Treat every preview as
untrusted process output. Records retain a redacted command summary and only
environment key names; raw argv and environment values are never projected to
operator clients. Distinctive effective environment values and values from
sensitive environment names are also scrubbed from previews and artifacts.

Slack and Telegram wake the original thread/chat through their normal proactive
turn path and settle the existing in-thread running indicator once, without an
extra completion post. Web wakes through the operator driver without requiring
a live browser or HTTP turn, commits one normal agent-history entry, and updates
one durable job card in the originating thread.

## Restart and cancellation

At startup, mono-agent reuses process-incarnation evidence. Only a stored leader
whose PID still matches its incarnation and equals its PGID can authorize a
signal. Recovery sends `SIGTERM` to that owned process group and waits one
second. It re-attests the leader immediately before `SIGKILL`; if the leader
vanished or its PID changed during the grace window, it does not signal the
group again or clean settings while descendants may remain. Only a still-matched
group is killed and cleaned. Every path marks the job `interrupted` and
schedules one recovered wake, with conservative wording when complete tree
termination could not be proven. Process jobs never claim to survive an agent
restart.

`mono-agent restart --clear-sessions` does not delete process-job records or
artifacts. Stop the agent and remove the configured `stateDir` only when you
explicitly intend to discard that audit/output state; there is no process-job
purge command.

## Operator surfaces

Use the local discovered-agent CLI:

```bash
mono-agent jobs list
mono-agent jobs get JOB_ID
mono-agent jobs cancel JOB_ID
mono-agent jobs list --agent AGENT_LABEL --json
```

The command refuses remote endpoints, derives an independent owner capability
from the selected agent's private store, and exits `1` with
`agent_unreachable` when the agent cannot be reached. Misuse exits `2`.

An enabled local operator endpoint exposes bearer-protected
`GET /gui/v1/jobs`, `GET /gui/v1/jobs/:jobId`, and
`POST /gui/v1/jobs/:jobId/cancel`. Its info response advertises `jobs: true`
only while the controller and its owner bearer are present. The web console
proxies `GET /api/v1/threads/:id/jobs` for the exact source-bound thread and
keeps running and terminal job cards in the transcript.

`mono-agent validate` / `doctor` reports whether the feature is disabled or
unsupported on Windows, then inspects only bounded local record counts and
owner-only modes. It does not probe or mutate the live controller and never
creates a missing store.
