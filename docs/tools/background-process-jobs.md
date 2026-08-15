---
title: "Background process jobs"
description: "Run Pi-native Exec and Bash calls after a turn returns, then wake the exact originating conversation with durable bounded results."
sidebar:
  order: 5
---

Background process jobs let the existing Pi-native `Exec` and `Bash` tools
return immediately while mono-agent continues to own the spawned POSIX process
group.
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
`stateDir` must be a relative child of the agent root. Its canonical path must
be disjoint from every root removed by `restart --clear-sessions`: Pi provider
sessions, durable message/tool history, and ACP session authorizations. Startup
and clear-sessions preflight reject equality or containment in either direction,
including symlink aliases, so clearing conversation state cannot delete
process-job records or output.

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

Whenever process jobs are configured and enabled, every model turn is guarded
for the exact configured `stateDir`, even if the durable store cannot open and
startup continues without a background controller. Every reachable primary,
fallback, accepted request-override, and configured `Agent` child route must be
Pi-native, and each accepted turn must have an available real sandbox engine
before any provider runs. The router independently rejects a provider-native
non-Pi route carrying protected roots before route resolution or provider
invocation, so nested model routes cannot bypass the app's early chain guard.
Eligible Pi-native turns receive host-internal, fail-closed native protection
independently of whether they receive the background controller. Model `Read`,
`Write`, `Edit`, `Glob`, `Grep`, `Bash`, and `Exec` cannot read, replace,
rename, search, or use that directory as a workdir. Host filesystem tools
perform their actual file operation through the native sandbox, closing
symlink swaps after path authorization. SRT also denies a rename of any
ancestor that would move the protected leaf.

Only the exact state directory is protected: workspace siblings such as
`.mono-agent/artifacts/attachments` remain readable, including when the
workspace itself is nested under `.mono-agent/`. When the configured sandbox
is absent or off, this filesystem-only protection preserves unrestricted
network behavior for commands, `WebFetch`, and `WebSearch`. A configured native
network policy remains unchanged. Provider-owned non-Pi tool loops cannot
enforce this host policy, so they are rejected while private process-job state
is active; a request override remains on its protected Pi route.

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

The process owns its sandbox settings until every process remaining in its
owned POSIX process group exits.
On POSIX a command-agnostic detached group leader starts first. Mono-agent
persists its PID, equal PGID, and process-incarnation evidence before releasing
the exact command and environment over an anonymous pipe. A crash before that
commit cannot spawn the target; a crash after release leaves a recoverable
owned group. Timeout, cancellation, and matched restart recovery therefore wait
for inherited-group descendants before sandbox cleanup. Commands that
deliberately daemonize into another POSIX process group or session are not
contained by this contract and must not use `background: true`.

Live timeout, cancellation, and shutdown use a bounded `SIGTERM` then `SIGKILL`
sequence. While the exact self-led `ChildProcess` leader is live and unreaped,
its negative PGID remains authoritative even if the owner's event loop stalls;
the kernel cannot recycle that live identity. The host begins bounded-frequency
group observation when the leader reports exit and signals the recorded
negative PGID only while that post-exit proof remains continuous. A post-exit
over-limit or indeterminate observation gap permanently revokes signalling
authority. If termination or final group absence cannot be proved, the job
settles with an explicit degraded error and leaves sandbox settings intact for
operator investigation instead of hanging or cleaning beneath a possibly live
descendant.

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

A Slack or Telegram conversation that is already at its pre-turn admission cap
does not spend that three-attempt budget. The wake stays durably pending and is
re-armed on a separate, longer timer; a restart can deliver it later. Busy
refusals do not themselves exhaust the wake: the durable bound is five minutes
from its first refusal, so an ordinary busy turn can clear and receive the same
delivery identity. Age exhaustion settles the wake as `failed` and immediately
runs retention. Once a turn is admitted, any ambiguous failure is nonretryable
and exactly-once wins over automatic replay.

An absent or disabled destination channel is also a proven pre-dispatch refusal,
but it has a separate durable bound of three checks. Those checks do not change
the delivery attempt count or timestamp and reuse the same stable delivery key.
If the channel returns before exhaustion, delivery continues normally; otherwise
the wake settles as `failed` so retention can reclaim its record and artifacts.
Conversation-cap busy admission remains distinct and does not spend this
absent-channel bound.

Admission counts every `pending` wake obligation, including a queued or running
job whose terminal wake is not due yet. It rejects `process_job_capacity` at
`retention.maxRecords + maxConcurrent + maxQueued` obligations (1,012 by
default; compiled maximum 10,096). This bounds the number of separate busy-wake
rearm timers without silently evicting an obligation. Recovery keeps the oldest
obligations when repairing legacy overflow and records explicit failed-wake
outcomes for the excess before ordinary retention can reclaim them.

The store also has a compiled open ceiling of 20,096 record entries: the 10,000
retained-record maximum plus the 10,096 pending-obligation maximum. Startup
streams and bounds the record directory before materializing records. A legacy
or externally modified directory above that ceiling fails closed with a stable,
path-free storage error; it does not delete pending wakes, artifacts, or active
ownership records. The same check prevents transaction replay from growing the
store past the ceiling. An operator must inspect and remediate that owner-private
state before restart can proceed.

Pending-wake records and their referenced artifacts remain live and are exempt
from age, count, and artifact-byte pruning until delivery settles. Other
terminal records and artifacts are pruned oldest-first with job-id tie-breaking.
Retention runs at startup, after every terminal completion, and after each wake
settles. Every 64 retention applications also reconcile orphan artifact
directories, so long-running agents reach crash-cleanup work without restarting.

Stdout and stderr are stored separately under the configured output budget.
The model, CLI, operator API, and web card receive only bounded redacted
previews plus agent-root-relative artifact references. Treat every preview as
untrusted process output. Records retain a redacted command summary and only
environment key names; raw argv and environment values are never projected to
operator clients. Distinctive effective environment values and values from
sensitive environment names are also scrubbed from previews and artifacts,
including a retained secret prefix at the process-runner truncation boundary.
Public `lastError` values and immediate background-tool failures use one stable
generic message per error code. Ambient spawn, artifact, cleanup, and store
exception text—including absolute paths—never enters a durable public error,
operator projection, wake prompt, or model tool result. Older v1 records with
free-form error text remain readable; projection replaces that text and the
next mutation rewrites it to the stable public form.
`process_job_cleanup_incomplete` remains distinct from a safe
`process_job_agent_restarted` interruption and from an artifact-only
`process_job_store_error`; the terminal lifecycle state still records whether
the process was cancelled, timed out, or otherwise failed.
Environment-key inventories are bounded independently, and the exact serialized
record size is checked before a recovery transaction marker is published. A
legacy transaction that can never fit or validate is moved intact into the
owner-only `quarantine-v1/` directory; the store opens in degraded health and
`mono-agent validate` reports the incident for operator review. Other unsafe or
transient failures from every store read, mutation, artifact, wake, recovery,
retention, and shutdown boundary remain fail-closed. The controller closes new
admission, publishes degraded health to the live TUI and trace source, persists
a bounded secret-free health marker for `mono-agent validate`, and serves its
bounded last-known in-memory record view where that is safe. If a live process
completes but its terminal record cannot be committed, the controller exposes a
failed in-memory projection with wake delivery withheld and still releases the
process's active slot. It preserves the durable nonterminal record so the next
owner restart can reconcile it to `interrupted` and deliver the recovery wake.
A clean restart clears the marker only after recovery, retention, and durable
readback succeed.
Because process jobs are opt-in, an unavailable store disables only the
background controller instead of aborting the whole agent. The resolved
configured `stateDir` remains protected on every model turn; mixed or non-Pi
routes and unavailable native protection fail before provider invocation.

Slack and Telegram start one host-owned lifecycle message before the tool call
returns, without waiting indefinitely on chat API latency. Updates are
serialized per job, edit that same exact-origin thread/chat message when
possible, and never let a late running update overwrite a terminal state. Each
adapter retains the shared compiled maximum of 10,096 outstanding lifecycle
identities, refuses unsafe overflow, and evicts only a terminal identity whose
wake has settled. After a restart or an uneditable/missing message reference,
the adapter may publish one bounded self-contained terminal fallback in that
same origin only. Adapter identity state is deliberately instance-local rather
than durable across restart. Empty host lifecycle updates never enter the
ordinary responder/model path. The terminal wake itself still uses the
channel's normal proactive turn path. Web
wakes through the operator driver without requiring a live browser or HTTP
turn, commits one normal agent-history entry, and updates one durable job card
in the exact originating thread. Ordinary `web:<id>` notifications are rejected;
only a process-job lifecycle wake carrying that matching web origin routes to
the TUI driver.

## Restart and cancellation

At startup, mono-agent reuses process-incarnation evidence. Only a stored leader
whose PID still matches its incarnation and equals its PGID can authorize a
signal. Recovery sends `SIGTERM` to that owned process group and waits one
second. If the group remains, it re-attests the leader immediately before
`SIGKILL`; if the leader vanished or its PID changed during the grace window,
it does not signal the group again or clean settings while descendants may
remain. Recovery polls for actual group absence after an accepted signal and
only then removes the validated one-use sandbox settings directory. A queued or
pre-attestation record never crossed the target-release fence, so recovery can
remove that directory without signalling. Every path marks the job
`interrupted` and schedules one recovered wake, with conservative wording when
owned-group termination could not be proven. Process jobs never claim to
survive an agent restart.

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
only while the controller and its owner bearer are present. List responses keep
every queued, starting, and running projection and add a deterministic
newest-terminal prefix within the 16 MiB response ceiling. The web console keeps
running and terminal job cards in the transcript. Each nonterminal card polls
only its exact authenticated, source- and thread-bound
`GET /api/v1/threads/:id/jobs/:jobId` proxy with bounded backoff; it does not
clone or serialize the retained job list on every refresh.

`mono-agent validate` / `doctor` reports whether the feature is disabled or
unsupported on Windows, then inspects only bounded local record counts and
owner-only modes, including any quarantined transaction count and the bounded
runtime health marker. It does not probe or mutate the live controller and
never creates a missing store.
