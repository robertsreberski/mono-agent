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
sessions, durable message/tool history, and ACP session authorizations. The
check covers every root retained in the durable registry, not only the current
configuration. Startup and clear-sessions preflight reject equality or
containment in either direction, including lexical and canonical aliases, so
clearing conversation state cannot delete process-job records or output.

```json
{
  "processJobs": {
    "enabled": true,
    "unsafeAllowUnprotectedState": false,
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
| `unsafeAllowUnprotectedState` | `false` | — |
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

## Durable root registry and request barrier

Before mono-agent creates an enabled `stateDir`, opens its store, or writes a
store secret, `@mono-agent/agent-app` securely publishes that root to
`.mono-agent/process-jobs-roots-v1/registry.json`. Opening the service requires
the exact registration proof. The v1 manifest is absent exactly while no root
has ever been registered for the agent. It stores sorted agent-root-relative
segments and a fresh generation id, with these fixed bounds:

| Registry bound | Maximum |
| --- | ---: |
| Retained roots | 64 |
| Segments per root | 64 |
| UTF-8 bytes per segment | 255 |
| UTF-8 bytes per relative root | 2 KiB |
| Encoded manifest | 256 KiB |

The manifest is an owner-only, no-follow, regular single-link file. Updates use
an owner-only mutation lock, atomic secure replacement, directory fsync, and an
identity-and-content reread. Unsafe, malformed, or over-bound state fails closed
with the path-free `Process-job private-state protection is unavailable.` error.
The registry directory remains strict: its only permitted entry is
`registry.json`. Replacement artifacts instead use the owner-only sibling
`.mono-agent/process-jobs-roots-v1.recovery/`, which is mode `0700`, must share
the registry filesystem, and permits at most these three mode-`0600` regular
files:

- `registry.staging.json`
- `registry.previous.json`
- `registry.failed.json`

Cross-directory publication fsyncs each affected directory at the namespace
mutation, destination before source. Ordinary request loading performs only a
bounded inspection of the recovery directory and fails closed if any artifact
is present; it never repairs or removes one. Only root registration and
clear-sessions preflight may recover while holding the existing registry
mutation lock. Recovery artifacts are single-link in steady processing except
for one exact crash-transient: after a previous manifest is linked back to
`registry.json` and before `registry.previous.json` is unlinked, those two fixed
names may be the same proven inode with identical bytes and `nlink=2`. Requests
still fail closed and leave that pair untouched. Locked recovery alone may
reprove the exact pair, make the target link durable, unlink the previous name,
fsync the recovery directory, and reprove `registry.json` at `nlink=1`; every
other hard-linked shape remains untouched and fail-closed.

A valid current manifest wins and proven artifacts are removed; an absent
current manifest is restored from a valid previous manifest (recreating only a
proven-absent registry directory when necessary) before proven staging/failed
cleanup; staging alone is discarded so a fresh first registration can proceed.
Failed-only state, a corrupt or ambiguous current manifest, unknown or fourth
entries, and unsafe directories, links, ownership, modes, or artifact contents
remain fail-closed. The recovery directory is empty in steady state.

It is never auto-pruned: disabling or removing `processJobs`, changing A to B,
or restarting retains A, and an A-to-B change protects both roots. The registry
directory, recovery directory, and every retained root's lexical and canonical
aliases are native protected roots and reply-artifact private roots. A degraded
or failed store open therefore leaves all earlier roots sealed even though the
background controller itself remains optional.

Every official local request captures and re-attests the current registry
generation, then acquires its generation lease before request resource
extensions or provider invocation. A newly registered generation becomes the
current generation before its store may open; opening waits for older leases
that did not cover the new root. The bounded drain timeout fails closed and does
not create the directory, store, or secret. A request releases its lease only
from `settleCleanup`, after `runtime.run` truly settles. Earlier cleanup, abort,
or harness disposal cannot release it beneath a late provider result.

Once the registry is non-empty, every reachable primary, fallback, accepted
request override, and named `Agent` child route must be Pi-native in both
`uniform` and `per-route-native` routing. The configured app rejects the whole
incompatible route plan before provider invocation; it does not wait to discover
the unsafe fallback after another route fails. Direct configured memory LLM
and embedding-provider calls obey the same rule. An empty registry preserves
legitimate non-Pi routes.
Eligible Pi-native turns receive the real SRT policy for the registry and every
retained root independently of whether they receive the background controller.
Model `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, and `Exec` cannot read,
replace, rename, search, or use those paths as a workdir. Host filesystem tools
perform their actual file operation through the native sandbox, closing symlink
swaps after path authorization. SRT also denies a rename of any ancestor that
would move a protected leaf.

Only the registry and retained state directories are protected: workspace siblings such as
`.mono-agent/artifacts/attachments` remain readable, including when the
workspace itself is nested under `.mono-agent/`. When the configured sandbox
is absent or off, this filesystem-only protection preserves unrestricted
network behavior for commands, `WebFetch`, and `WebSearch`. A configured native
network policy remains unchanged. Provider-owned non-Pi tool loops cannot
enforce this host policy, so they are rejected while any registered private
root exists.

This agent-root-aware coverage belongs to the full app, configured
harness/responder, local TUI, the lazy-run wrapper returned by
`createConfiguredAgentRuntime`, configured named children, and direct configured
memory LLM/embedding calls. Remote TUI and ACP bridges are thin clients of an
already owned host and do not invoke a provider themselves. Lower-level
`@mono-agent/runtime-adapter` and `@mono-agent/agent-runtime` factories are
root-agnostic unless an app-owned caller supplies the protection policy and
route gate.

## Unsafe trusted-host posture

`processJobs.unsafeAllowUnprotectedState: true` is a JSON-only escape hatch for
an operator who intentionally runs trusted same-user host tools. It is accepted
only when all of these conditions hold:

- `sandbox.mode` is present and exactly `"off"`;
- ProcessJobs is enabled, or the attested durable registry still retains at
  least one root; and
- every configured primary, fallback, named `Agent` child, and agent-host
  memory route is Pi-native. Accepted request overrides are checked again
  before any provider is invoked.

:::danger[ProcessJobs state and operator secret are model-accessible]
In this posture mono-agent does not synthesize the ProcessJobs or
clear-sessions SRT policy, does not create or require an SRT engine for the
app-owned run, and lets Pi host commands and external MCP commands use the
configured unsandboxed authority. ProcessJobs state, including its operator
secret, is therefore accessible to the model and its tools. Use this only for
trusted models, trusted prompts, and trusted same-user host tooling.
:::

The escape hatch changes only SRT policy injection. Registry load and
attestation, including the second request-boundary attestation, owner and
generation leases through true settlement, root disjointness, retention,
store/service/controller lifecycle, and reply-artifact `privateRoots` remain in
force. A failed or unavailable registry always wins and remains provider-zero.
The Pi-only gates are independent from `sandbox.protectedRoots`, so mixed
primary/fallback chains, non-Pi request overrides, non-Pi named children, and
non-Pi agent-host memory remain rejected before provider work.

Tool-less direct Ollama memory LLM and embedding calls may run in this posture;
they still hold the canonical owner and registry-generation lease until the
provider promise truly settles. Agent-host memory remains tool-less and
Pi-native. Public package-root runtime, harness, responder, and memory factories
do not accept this authority and keep their safe behavior.

Changing this posture takes effect only when the app rebuilds its owned
runtime surfaces: a managed configuration apply performs that teardown/rebuild,
and a process restart does the same. Existing in-flight runs are not mutated.
No state migration or reset occurs, and retained registry roots remain
registered when the flag is enabled, disabled, or removed. `validate`,
foreground/background `status`, trace metadata, and the local TUI summary show
the path-free warning `UNSAFE: ProcessJobs state and operator secret are
model-accessible.`

## Cooperative ownership and threat boundary

Official local hosts also take one cooperative lifetime lease keyed by the
canonical realpath of the agent root and stored under the effective account
home. In one process, repeated configured app/harness/responder/local-TUI owners
share a reentrant reference count. Physical release waits for all owner
references and all true-settlement request leases; a release failure makes every
later in-process acquisition fail deterministically. A stale official-process
lease is recoverable after a crash. The lease path and random owner token are
host-only coordination data, but their permissions and hash-derived pathname
are not a secrecy or tamper-resistance claim.

This is cooperative serialization, not a security boundary against actively
hostile code running as the same OS user. Such code can signal or `SIGKILL` the
host, rewrite same-UID control state, and attack another registered agent root
under the same account. Alternate same-UID coordination mechanisms do not
change that fact. The local persistence guarantee covers exactly the roots
durably registered for this agent; it is not an account-global provider-zero
rule. If a provider is in that threat model, run it under a distinct UID or
another real privilege-separation boundary.

## Availability and origins

The host injects the controller only when all of these are true at call time:

- `processJobs.enabled` is `true` and the owner-private store lock is ready;
- the platform is POSIX; Windows is unsupported;
- the selected request route is Pi-native;
- the ordinary tool policy permits `Exec` or `Bash`; and
- the turn originated in an exact addressable conversation whose channel driver
  opts into the ProcessJobs capability. The built-ins are Slack, Telegram, the
  web console, and the WhatsApp plugin; future plugins may claim one unique
  conversation-id scheme and publish the same running capability.

Direct TUI turns, cron, webhook, OpenAI API, A2A, and plugins without the
explicit capability do not get background schemas. Duplicate or malformed
scheme claims fail during app startup. A controller also rejects an invalid origin as
`background_unsupported_channel`. Foreground calls continue to use their normal
route and policy.

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

The agent is told when to reach for this and what not to do afterwards in three
places, all gated on the same availability check as the schema itself: the
`background` field description steers it toward work that outlives a reply and
away from anything whose output is needed to answer now; the start result leads
with a line saying the conversation is woken on completion, so the agent must
not poll, sleep, or re-run the command to check; and the session block of the
system prompt repeats both alongside the daemonize prohibition and the fact that
job output arrives as untrusted evidence. The same availability check also
relaxes the prompt's continuation rule, which otherwise has the agent announce
that background delivery was not scheduled for a job it just started. No
operator command is named in any model-facing copy — the agent has a shell, and
naming a status command invites the polling this is meant to prevent.

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

For an active turn in the exact originating conversation, the adapter first
offers the completion as live input targeted to that run id. It reserves the
normal follow-up position before making the offer. A confirmed provider
acknowledgement keeps the completion in that turn; an explicit unavailable,
discarded, or requeued settlement runs the reserved normal follow-up turn. An
unknown settlement is ambiguous and never triggers an automatic duplicate.
Slack, Telegram, and WhatsApp use their ordinary visible thinking/tool/final
stream for the fallback. The web console creates an assistant-only turn, emits
the same NDJSON activity/tool frames, and never invents a user message.

Every steer or fallback carries the stable delivery key out of band. The web
console durably records accepted and completed claims: after restart a completed
claim returns its prior `steered` or `follow_up` receipt, while an accepted but
unsettled claim fails closed as ambiguous. A wake is a genuine tool-capable
turn, not continuation synthesis. The host raises the active controller to the
parent job's chain depth plus one before any steered tool call can start; a
non-applied offer rolls that provisional depth back, and the configured maximum
remains authoritative.

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
background controller instead of aborting the whole agent. The registry and
every retained `stateDir` remain protected on every model turn; mixed or non-Pi
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
