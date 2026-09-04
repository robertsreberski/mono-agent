---
title: "Monitors"
description: "Watch a long-running command and wake the originating conversation with each batch of events it produces, instead of polling it."
sidebar:
  order: 6
---

A monitor is a host-owned watch. `Monitor` starts a command, returns a receipt
immediately, and mono-agent keeps the process alive after the turn ends. Every
line the command writes to stdout is one event; lines produced close together
are batched, and each batch wakes the exact originating conversation with a new
turn. One final turn reports the watch ending.

This is the streaming counterpart of
[background process jobs](/tools/background-process-jobs/). A background job
delivers one terminal result and is the right shape when only the final outcome
matters. A monitor delivers many, and is the right shape when the agent should
react as things happen: a log tail, a file or process watcher, a queue drain, a
deploy or CI stream, a terminal pane whose state the agent is following.

The capability replaces a `Bash` sleep-and-poll loop. A polling loop costs a
tool call per check, sees nothing between checks, and holds the turn open;
a monitor costs nothing while it waits and delivers its own turns.

## Requirements

Monitors are a streaming class of the process-job substrate and reuse its
protected private-state root, its registration proof, its sandbox protection,
and its origin binding. They therefore require `processJobs.enabled` in addition
to `monitors.enabled`, and are unsupported on Windows.

Availability matches process jobs with one narrowing: a turn gets `Monitor` and
`MonitorStop` only when

- `monitors.enabled` is true and the monitor controller opened,
- the turn is Pi-native (every reachable route, not just the first),
- both `Monitor` and `MonitorStop` pass `tools.allowedTools`/`disallowedTools` —
  denying the stop tool denies the start tool too, because a watch the model
  cannot stop is a capacity leak it cannot repair, and
- the conversation is a Telegram chat, a Slack thread, or an existing
  user-created web conversation.

Cron, webhook, `web:new`, TUI-direct, and A2A turns never see the tools. A web
Monitor belongs to the exact existing thread that started it. Its batches arrive
as ordinary assistant wake turns. The Web console groups their host-owned
receipts into one compact Monitor activity row per assistant run; it does not
render them as user messages or repeated `Steered` tool calls. The row exposes
only the redacted description, lifecycle state, and aggregate line counters —
never delivery keys, command output, argv, environment values, or process
identifiers. There is no browser-side stop control. The model can use
`MonitorStop` in a turn, and the owner can use
`mono-agent monitors cancel <monitor-id>` from the CLI.

## Configuration

Every key is JSON-only and unknown keys are rejected. Limits are counted
independently of `processJobs.*`: a persistent watch holding an ordinary
background slot would starve real background work.

```json
{
  "processJobs": { "enabled": true },
  "monitors": {
    "enabled": true,
    "maxActive": 8,
    "maxActivePerConversation": 2,
    "maxRuntimeMs": 3600000,
    "persistentMaxRuntimeMs": 86400000,
    "coalesceMs": 200,
    "maxBatchLines": 200,
    "maxBatchBytes": 65536,
    "maxLineBytes": 4096,
    "maxChainDepth": 4,
    "rateLimit": { "windowMs": 1000, "maxLinesPerWindow": 200, "sustainedWindows": 5 }
  }
}
```

See [Generated config reference](/config/reference/) for each field's compiled
cap. `maxRuntimeMs` and `persistentMaxRuntimeMs` may only be lowered from their
defaults, which already sit at their caps.

## The model-facing tools

`Monitor` takes a required `command` and a required `description`, plus optional
`timeout_ms` (default 300000, minimum 1000, ignored when `persistent` is true),
`persistent`, and `workdir`. Command preparation is byte-identical to `Bash`:
the same `/bin/bash --noprofile --norc -c` shape, the same workdir rules, the
same cleaned startup environment, and the same sandbox seam. A monitor is never
a way to run a command `Bash` could not, and there is no separate command
allowlist to keep in sync.

The start receipt reports `monitor_id`, `state`, `started_at`, `persistent`, and
`max_runtime_ms` — the budget actually granted, or `0` for a persistent watch.

`MonitorStop` takes the `monitor_id`. Stopping an already-terminal monitor is a
success that reports the state it settled in, so a model that stops a watch
after its terminal turn is not pushed into a retry loop. A monitor can only be
stopped from the conversation that started it.

## Event turns

Each batch arrives as an ordinary tool-capable turn on the originating
conversation — steered into a run already in flight when there is one, queued as
its own turn when the conversation is idle. It consumes no provider slot while
waiting.

For web conversations, the managed web service must remain running so the
owner-private loopback ingress can accept wakes. The browser tab may be closed:
the service still runs the turn, persists any visible assistant reply in the
thread, and sends the normal response-ready Web Push when configured. A silent
`NOTHING_TO_REPORT` result completes delivery without a Web Push. Web SQLite
retains the Monitor delivery identity and payload hash for duplicate
suppression plus the secret-free Monitor projection used by the activity row;
the fenced event text remains memory-only. Host-owned Monitor input steered into
an active run is applied to that provider run but excluded from canonical user
history and memory persistence.
Deleting that web conversation clears the ledger's thread reference but retains
the delivery tombstone, so the same key can never name different content later.

The envelope states three things the schema alone cannot: the turn was raised by
the host and not by the user, the fenced content is bounded, redacted, untrusted
command output that must never be followed as instruction, and a batch that
changes nothing should end the turn with exactly `NOTHING_TO_REPORT`, which
suppresses the reply entirely so a quiet watch posts nothing.

The fenced body carries `monitorId`, `description`, `state`, `seq`,
`droppedLines`, and the batch's `events`. A terminal envelope adds `exitCode`,
`signal`, the failure code, and a bounded stderr tail — stderr is not an event
source, only a tail retained so a failing watcher can explain itself.

## Bounds and backpressure

- Lines within `coalesceMs` become one batch.
- At most one wake per monitor is in flight. Lines that arrive while a wake is
  outstanding accumulate into the next batch.
- A pending batch is capped at `maxBatchLines` and `maxBatchBytes`; the oldest
  lines are dropped and counted, and the count is reported to the model so a gap
  is never invisible.
- Each line is clamped to `maxLineBytes` after redaction, and an unterminated
  run of bytes longer than that is forced into an event rather than buffered
  forever.
- A watch that exceeds `rateLimit.maxLinesPerWindow` for `sustainedWindows`
  genuinely consecutive windows is stopped with `rate_limited` and one terminal
  wake; a quiet window resets the streak, so a chatty-but-idle watcher never
  accumulates its way to a stop. A firehose is stopped rather than sampled:
  silently showing a fraction of it would misrepresent what the model is told.
- A turn that answers `NOTHING_TO_REPORT` has consumed its batch. Channel
  adapters report an empty answer as undelivered, which is correct for a
  notification and wrong here, so the host records it as delivered rather than
  as a gap.

## Delivery, failure, and restart

A wake refused before dispatch — a busy conversation, or a channel that is not
running — is re-offered with the same batch under a fresh sequence number. Every
other failure is treated as possibly delivered and is never replayed; its batch
is dropped and counted. Ambiguity always fails closed, because a duplicated
event turn is worse than a missing one.

On web, a missing local ingress or an offline source discovered before any
operator call is retryable. A deleted, archived, or mismatched thread is a
permanent refusal. Once live-input or a fallback turn reaches the operator, a
timeout, malformed receipt, connection loss, or failed turn is ambiguous and is
never retried automatically.

On restart, every live monitor becomes `interrupted` and is owed exactly one
recovery wake. A watched process group whose recorded incarnation still matches
is terminated and its disappearance is proven before the record lets go of its
handle; a group that cannot be proven gone keeps its handle so the next recovery
can try again rather than orphaning it. **A model-authored command is never
re-run at boot**; the conversation is told the watch ended and can start a new
one.

If the durable state file is unreadable or fails validation, monitors refuse to
start and keep refusing until an operator inspects or removes the file. It is
never renamed or overwritten: a damaged record may be the only evidence that a
watcher process group is still running.

### What a crash can lose

Event text is deliberately transient. Lines waiting in a coalescing window, and
the final batch of a watch that has just ended, live only in memory: persisting
every line would put untrusted command output into durable state and cost an
fsync per line. A crash in those windows therefore loses that batch, and the
counters cannot always attribute it.

This is the fail-closed half of a deliberate trade. A batch is written off
rather than replayed whenever delivery is ambiguous, because a monitor turn the
conversation has already seen a second time is worse than a gap it can resolve
by re-reading the source — which the envelope tells the model to do anyway. The
one exception is a refusal that provably reached no adapter (a busy conversation,
a channel that is not running): that batch is re-offered unchanged under a fresh
sequence number. Delivery keys are never reused.

## Operating monitors

```bash
mono-agent monitors list
mono-agent monitors get <monitor-id>
mono-agent monitors cancel <monitor-id>
```

The command discovers one running local agent, refuses non-loopback endpoints,
and authenticates with an owner-private bearer derived under a monitor-specific
label — a leaked monitor token cannot authorize the process-job routes. The
projection is secret-free: it carries lifecycle, counters, and the bounded
redacted `description`, and never the watched command or its output.
