---
title: "Sessions, concurrency & Pi-native tuning"
description: "Distinguish session boundaries, configure queueing and concurrency, and manage durable Pi transcripts."
sidebar:
  order: 5
---

This page covers how the runtime keeps provider sessions warm per conversation, how it bounds in-flight work with admission and execution limits, and the Pi-native transport knobs for transport selection, retries, and durable on-disk sessions. Every option here is `config` coverage with a matching `MONO_AGENT_*` env var unless noted.

## The five "session" meanings

Mono-agent uses "session" for five related but different boundaries:

| Meaning | What owns it | What it controls | What resets it |
| --- | --- | --- | --- |
| `runtime.session` config block | Agent config / env | Whether turns try to reuse a warm provider session and how long idle warmth lasts | Changing config, setting `mode: "per-message"`, or disabling resume support |
| Provider session | Runtime backend / provider bridge | Warm runtime continuity: provider-side context, provider session id, busy state, and idle eviction | Idle eviction, stale/busy resume retry, provider session rotation, unsafe or unsettled cancelled/failed turns, harness disposal, or process restart when only in-memory |
| Canonical logical-session history | Durable message-history files plus the separate `tool-history/tool-lifecycles.sqlite` sidecar | Cold context replay and retained, searchable managed-tool invocation/result evidence; settled failed/cancelled non-isolated turns have bounded message accounts, while tool records may still outlive isolated, never-started, or hard-crashed runs with no account | A conversation reset clears every message and tool-history bucket visible in that logical session; `mono-agent restart --clear-sessions` clears all persisted conversation state |
| Durable Pi transcript | Pi-native JSONL store plus the canonical history record's random provider epoch and transcript revision | Crash-safe cross-restart and cross-process resume for Pi-native provider sessions | `mono-agent restart --clear-sessions`, deleting either store, a dirty fence or legacy/missing history record, host-only history append, failed provider sync, or leaving `piSessionsRoot` unset |
| Web console thread | `mono-agent web` / `@mono-agent/web` | Persistent source-bound browser conversation, its messages/attachments/live follow-ups, durable submission receipts, and at most one active turn; different threads can run concurrently | Archive only hides it; `mono-agent web reset --all --yes` removes the entire stopped console store. Browser disconnect does not end its active turn; service restart marks that turn interrupted, requeues only unmarked offers, renders dispatch-marked live input uncertain without retry, and retains submission receipts for read-only recovery |

Boundary rules:

| Boundary | What ends | What survives | What is emitted |
| --- | --- | --- | --- |
| Daily rollover (`runtime.session.rollover: "daily"`) | The current day-bucket conversation id and its warm provider-session lineage, on every channel **except** the web console | Durable memory, old run artifacts, durable Pi transcripts for other ids, app process state, and every console thread | `session_boundary` with `kind: "rollover"` on the first turn of the new bucket |
| Isolated proactive turn (`runtime.session.isolateProactive: true`) | Nothing shared; the proactive turn intentionally skips the conversation's warm provider session | Existing interactive warm session, durable history, memory, and run artifacts | `session_boundary` with `kind: "isolated"` and `reason: "proactive"` |
| Default model change within a continuous conversation | The previous model-bound provider epoch; the new model starts from canonical history | Durable message and tool history, memory, and run artifacts | `session_boundary` with `kind: "resume_replay"` and `reason: "model_change"` |
| First bound turn for a legacy unbound provider record | The pre-model-binding provider epoch; the requested model starts from canonical history without guessing the previous owner | Durable message and tool history, memory, and run artifacts | One cold session event plus `session_boundary` with `kind: "resume_replay"`, both with `reason: "legacy_unbound_model"` |
| Resume replay after stale/missing provider session | The stale provider session id | Durable history, memory, run artifacts, and the run itself, which retries once | `runtime_warning` `session_resume_retry` plus `session_boundary` with `kind: "resume_replay"` |
| Host-only history append / unsynchronized provider result | The prior durable provider epoch | Canonical history, memory, and run artifacts | The next provider turn receives a fresh epoch id and replays canonical history |
| Cancelled admitted interactive turn | The unfinished run; an unsafe or unsettled provider epoch | A bounded, redacted continuity account in canonical history, retained tool-history records, and run artifacts | Eligible durable Pi turns retain their native context and emit `resume_replay` with `cancelled_turn_resume` on the next turn; unsafe tails reseed from the continuity account |
| Failed admitted non-isolated turn before success commit | The failed run; an ineligible or unproven provider epoch | A bounded, redacted continuity account in canonical history, retained tool-history records, and run artifacts; memory capture remains excluded | One eligible provider failure per epoch can retain native context and emit `failed_turn_resume`; context/auth/usage failures, invalid results and exhausted retries reseed |
| Telegram `/new` | Current chat's warm provider session plus message and tool history for its logical session across daily rollover | All unrelated conversations, durable memory, run artifacts, and the chat's model/effort override | Telegram confirmation; the next message rebuilds startup context and reloads skills |
| Idle eviction / replaced / disposed provider session | Warm runtime continuity for that conversation id | Durable Pi transcripts, durable history, memory, and run artifacts | App log line and status metadata event (`evicted`) with reason |
| Detached status read | Nothing | All runtime/session state | No runtime event; status reads the latest published config + store snapshot |
| `mono-agent restart --clear-sessions` / explicit purge | Durable Pi transcripts under `piSessionsRoot`, persistent child registries and transcripts under `subagents.instances.root`, message-history files, the tool-history sidecar, and ACP session authorizations beside `artifacts.dir` | Durable memory under `memory.path`, recorded run artifacts, and process-job records/output; nonterminal jobs are interrupted by any restart | Restart/status output reports message-history and tool-history counts/bytes plus ACP authorization counts separately |
| Browser disconnect or reload | Only that SSE/browser connection | Web service turn, source-bound thread, messages, committed attachments, provider/harness work | Reconnect receives current state and subsequent events |
| Web service restart | Any web-owned active upstream connection | Terminal messages, archived/active threads, committed attachments, queued live follow-ups, submission receipts, agent memory/history, recorded runs | Active web turn is projected as `interrupted`; unmarked live offers become queued normal turns, dispatch-marked offers become uncertain, and browsers recover a known submission with `GET` instead of repeating `POST` |
| `mono-agent web reset --all --yes` | Entire stopped web-console SQLite/settings/upload state | Agent configs, provider/harness history, memory, and recorded-run artifacts | CLI confirmation/result only |
| `mono-agent web-control reset` | Validated idle host admission, cooldown and quota metadata under `~/.mono-agent/web-control`; active requests prevent reset | Conversations, artifacts, documents and account quota; ordinary session resets and restarts preserve web-control state | CLI operational metadata only |

## Web-only durable model-switch opt-in

Defaults retain cold model-change replay. After backing up consistent host history
and native Pi roots and stopping **every older writer**, opt in explicitly:

```json
{
  "runtime": {
    "session": {
      "mode": "continuous",
      "modelSwitch": { "enabled": true, "olderWritersStopped": true }
    }
  },
  "providers": { "piNative": { "piSessionsRoot": ".mono-agent/pi-sessions" } }
}
```

This partial config requires the usual model and identity fields. Missing
acknowledgement is a validation error, never inferred from runtime capabilities.
Absent or explicit OFF produces unchanged behavior/files. Fresh and existing roots
bootstrap authority lazily under conversation ownership, settling old turn fences
before capturing evidence. Read-only history loading does not upgrade roots.

Only Web's persisted inbound `started.userMessageId` with `source: "web"` authorizes
model switching or a new summary generation. Transport IDs, run IDs, text hashes,
TUI/ACP IDs and background wakes do not. No-ID turns on never-upgraded conversations
keep the original path, including cold-replay model changes for cron, webhook,
Slack, Telegram, TUI, ACP and Web wakes. They make only one cheap binding read to
select that path, with no switch preparation, switch claim or authority bootstrap.
On already-native/v4 conversations, a no-ID undeclared wake inherits the current
durable model; an explicit other-model no-ID request refuses without rotation.
Changing `runtime.model` changes the default for ordinary conversations but does
not move existing native conversations: they retain their durable model until a
persisted Web message selects the new model. Prose keywords do not escalate models
or effort; they are ordinary message text.
Switches retain predecessor journals and admit the incoming turn only after one
durable switch and a complete fitting projection or structured handoff. Native
reuse requires positive provider/API/account compatibility, including switch-back;
missing provenance selects a handoff, not guessed compatibility.

Each switch permits at most two billed summary calls per explicit-message generation.
An outcome-unknown call never auto-repeats. Retries/reopening with the same persisted
ID grant no new generation; the next explicit message permits one attempt per
producer. Pending messages are **not queued or replayed**. Interrupted turns are
reported; tools never rerun. Detached same-conversation work may receive retryable
`native_switch_busy` rather than waiting on its own claim. Whole-chain reset and
retention delete the conversation's retained native evidence and handoff artifacts.
For a full chain or typed pre-intent capacity refusal, a persisted-ID Web request
may select an owned cold model change: settle outgoing work, retire only the
eligible current epoch with C, preserve every frozen predecessor with P, and
keep chain length constant. The new model receives ordinary bounded canonical
and tool-history replay, **not a complete native handoff**. The streamed
`degraded_native_context` warning and response runtime warnings make that
context downgrade explicit. Native-only data in the retired current is lost;
frozen predecessors and their artifacts remain retained/charged. No paid
handoff summary runs. A restartable v2 lifecycle intent and a host cold-switch
receipt survive crashes; incoming P2 waits for physical cleanup completion.
Pending/unknown billed work cannot take this shortcut. Insufficient safe
publication space still refuses. No-ID inheritance/refusal rules are unchanged.
Conversation IDs longer than 512 characters bypass switch preparation before
native authority or intent. This preserves the original path, not a successful
cold-dispatch guarantee: the existing native host-turn contract rejects those
ownership IDs with the option OFF too. Its 512-character bound is unchanged.

### Native lifecycle boundaries

| Disposition | Allowed effect | Ownership boundary |
| --- | --- | --- |
| P — preserve/detach | Drop stale liveness/mappings without deleting or rewinding retained evidence | Native chain members and unresolved protected turns remain preserved, even with a stale model key or persistence failure |
| C — ordinary cold cleanup | Replace only the current epoch (same-model by default; explicit Web cold change may change model); delete eligible unreferenced retirement targets | Held host claim, exact authority, reference check and durable lifecycle intent; predecessors remain unchanged |
| D — whole-chain deletion | Reset/retention delete the authorized chain and switch artifacts; operator purge removes attested owned roots | Whole membership remains recoverable until deletion and directory barriers finish |
| U — uncoordinated cleanup | Existing stateless/subagent behavior within its own isolated storage | No authority to delete a guarded host-chain predecessor |

Manual compaction's advisory P for native-bound stale mappings is defence-in-depth
from a pre-claim read-only hint, not ownership proof. The generic helper modes
`preserve`, `legacy-current` and `isolated` grant no native C/D deletion authority.
Owned membership and guarded headers remain the physical backstop. Generic cleanup cannot
infer physical deletion permission from a cached runtime/model owner. Guarded
rejection means preserved evidence, **not successful cleanup**. Unsettled P2
turns stay protected/charged and reconcile storage-only, without provider or tool
replay. Ordinary durable registry disposal/TTL removes metadata, not journal bytes.
Cold model changes do not authorize whole-chain D deletion or drop predecessors.

Older binaries refuse upgraded v4 conversations and scans, but this is **not** a
universal old-writer admission barrier. Mixed binaries must not run on upgraded
roots. Rollback means stop writers and restore consistent host/native backups;
disabling the option, stripping markers or downgrading records is not rollback.

### Enable, verify and roll back

Scope: only the Web console's persisted messages can switch models durably. Every
other surface keeps today's behavior described above.

With the opt-in on, every Web turn that carries a persisted message ID uses the
**primary model only**. That includes the first message of a new conversation.
These turns get no configured fallback-chain backup model and no router-level
re-attempt; transport retries within the attempt are unchanged. Non-Web turns and
turns without a persisted ID keep their configured fallbacks. A cancel that
arrives after such a turn's preparation has started, but before admission, is
reported and not appended to history.

To enable:

1. Stop **every** writer for the agent root: the app service, CLI runs, managed
   workers and any older binary. Nothing verifies this for you; the
   acknowledgement is your statement that it is true.
2. While stopped, back up the canonical history directory (beside
   `artifacts.dir`) and `piSessionsRoot` together, as one consistent snapshot.
3. Set `runtime.session.modelSwitch` to
   `{ "enabled": true, "olderWritersStopped": true }` with continuous sessions
   and a durable `piSessionsRoot`, then start only upgraded binaries.

Rollback: stop all writers, then restore **both** backups from step 2.
Setting `enabled: false` afterwards does not convert upgraded conversations back.

| Acceptance | Behavior | Observable evidence | Verified by |
| --- | --- | --- | --- |
| A1 one durable switch | A persisted Web message for another model records exactly one switch before the incoming turn is admitted. Restarts and retries finish the recorded switch; they never start a second one. | Canonical `lastSwitch` receipt and one `model_change` record in the outgoing native journal | `configured-switch-kill-matrix.test.ts` (12 SIGKILL boundaries, two fresh-process recoveries each), `managed-native-switch.test.ts` |
| A2 complete fitting context | The incoming model receives a native projection or a structured handoff. The latest turn and the open-work/outcome-unknown ledger are never clipped. A request that cannot fit is refused before dispatch with `handoff_budget_exceeded`. | Immutable handoff artifact under the history directory's `.model-switches/`, referenced by the receipt | `configured-model-switch.test.ts`, `native-switch-back.test.ts`, kill-matrix incoming-context assertions |
| A3 switch-back | Returning to an earlier model retains all native evidence. Native reuse happens only when provider, API, account and window fit are all positively established on every reused segment and every content-bearing operation; otherwise it takes a structured handoff. Under the opt-in, Web turns record the account of their pinned dispatch credentials, so conversations started with the opt-in on can reuse native evidence. | Chain length grows by one per switch; predecessor journals stay byte-stable; a native switch-back artifact carries a native projection and makes no summary call | `configured-native-provenance.test.ts`, kill-matrix native return boundaries, `native-switch-back.test.ts` |
| A4 crash, upgrade, reset, retention | Crashes recover from storage alone: no provider, summary or tool replay, and no leaked reservation or fence. Reset and retention delete the whole chain and its artifacts. Upgrade settles old pending turns first. | Empty `.pending-turns`/dirty fences, no `.native-history-op.*` intent, zero reserved bytes | `configured-switch-kill-lifecycle.test.ts`, `managed-native-lifecycle.test.ts`, `managed-native-cold-change.test.ts`, `host-turn-reconciliation.test.ts` |

Billing during recovery: an admitted summary call interrupted by a crash stays
charged as outcome-unknown and is never repeated. The free checkpoint and then
the incoming producer follow. Each switch generation allows at most two billed
summary calls (outgoing, then incoming producer), plus the incoming turn itself.

Retrying the same persisted Web message after a crash finishes the recorded
switch in its original generation and never opens a new billed one. The message
ID authorizes switch work only; it does not deduplicate turns. An interrupted
turn is reported, and a redelivered message is admitted as a new turn. The Web
console never resends a dispatched message: if the agent or Web service stops
mid-turn, that turn ends failed or interrupted and you send a new message.

Warnings and refusals:

- `degraded_native_context` is the only user-facing warning. It appears once,
  on the turn that applied an owned cold change. If the process dies after
  that change became durable but before that turn streamed the warning,
  recovery finishes the change without it. The warning is then never shown,
  and the canonical `lastSwitch.kind: "cold"` receipt is the only record.
- Structured handoffs and native reuse produce no warning.
- `handoff_pending`, `handoff_budget_exceeded`,
  `native_cold_model_change_unavailable` and retryable `native_switch_busy`
  are refusals. The message was not admitted; send another message when ready.

Limits:

- Native reuse needs positive account evidence on every segment. Epochs written
  before the opt-in, or holding any content written without recorded dispatch
  provenance (for example background wakes or turns without a persisted ID),
  stay unknown and take the handoff. Accounts are never
  inferred or backfilled. Only providers whose credentials expose a stable
  account (today: Codex OAuth) can match; API-key providers stay unknown.
- Handoff summaries are model-written prose. The deterministic ledger and the
  verbatim recent turns remain the authoritative evidence.
- Older binaries are not technically blocked from an upgraded root.
- No downgrade tool exists. Native-only data in a cold-retired current epoch is
  lost, as described above.

## Provider sessions

`runtime.session` decides whether the runtime keeps a warm provider session per conversation or starts fresh on every message.

The primary's first attempt owns the provider session. Retries and failovers run
stateless with bounded transcript-tail replay. With coordinated durable Pi history,
any answer from a retry or backup retires the primary epoch. The next turn
cold-reseeds from canonical history; after a primary first-attempt success,
subsequent turns resume the new session and are eligible for provider caching.

On a warm turn whose primary attempt fails, the retry or backup attempt runs
stateless with the current message and a bounded snapshot of the failed attempt,
without the earlier conversation; the next turn reseeds from canonical history.

A continuous conversation binds its provider session to the requested primary model, including a thread or channel model override. Repeating that model stays warm; changing it (including returning to the default) retires the old session on its owning runtime and starts a fresh epoch. The cold turn is seeded from canonical user/assistant text and the existing bounded tool-history projection; subsequent warm turns retain the native transcript, including tool results and signed reasoning. Effort-only and same-model overrides do not rotate the session. Continuations and opt-in proactive isolation keep their existing one-shot behavior. Configured retry/fallback behavior follows the [fallback session policy](/runtime/fallback/).

With `providers.piNative.piSessionsRoot`, the durable history record and its recovery fence persist the model binding alongside the epoch. A restarted process resolves the session's owning runtime from that binding. Existing histories without a binding load normally but take one cold reseed before becoming bound. Older binaries reject the new bound history shape; downgrade does not automatically rotate or migrate those records.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `runtime.session.mode` | `"continuous"` \| `"per-message"` | `continuous` | `continuous` keeps a warm provider session per conversation; `per-message` rebuilds context each turn |
| `runtime.session.idleTimeoutMs` | number (ms) | `1800000` (30 min) | How long a warm session lingers before idle eviction |
| `runtime.session.rollover` | `"none"` \| `"daily"` | `none` | Whether the responder buckets conversation ids by local day |
| `runtime.session.rolloverTimezone` | IANA timezone string | system local timezone | Timezone used to compute the daily rollover bucket |
| `runtime.session.rolloverNotice` | boolean | unset / off | When true, the first turn of a new daily bucket gets a one-line adapter-visible notice before the model answer |

In `continuous` mode the runtime holds one warm provider session per conversation. Same-conversation follow-ups **queue and resume warm** rather than rebuilding the provider session from scratch. A queued warm-session follow-up holds **no concurrency slot** while it waits (see below). After `idleTimeoutMs` with no activity, the session is evicted and the next message starts cold.

```json
{
  "runtime": {
    "model": "anthropic:claude-sonnet-4-6",
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000, "rollover": "daily", "rolloverTimezone": "UTC", "rolloverNotice": false }
  }
}
```


Warm in-memory sessions are lost on restart. To resume across restarts, use the default durable history store together with `providers.piNative.piSessionsRoot` (see [Pi-native tuning](#pi-native-tuning) below). The history store, not a conversation-id hash, owns the resumable provider epoch.

`rolloverNotice` is adapter-local and default-off. It does not enable rollover by itself and does not add a new IPC channel or change provider resume behavior. When daily rollover is already enabled and a base conversation crosses into a new day bucket, the responder streams `New session bucket started: <bucket>.` before the model answer and includes the same prelude in the returned final text for final-only transports.

Daily rollover partitions active conversation/provider history, but it does not
partition retained exploration: the app-owned `RunHistory` and `SessionHistory`
tools strip the daily bucket only for their request-scoped authorization match,
so completed runs and tool records from earlier buckets of the same logical
conversation remain searchable. Reset clears both message history and tool
records across every daily bucket exposed as that logical session. Custom
history stores must implement logical-session reset for daily rollover or the
operation fails closed before either store is cleared. Other conversations and
threads remain inaccessible.

The default durable history store makes that reset atomic across processes: a
logical-session owner row covers bucket discovery and every matching append or
reset, while a date-shaped exact bucket has a separate exact-id row. The rows
contain namespaced digests rather than conversation ids, and the shared SQLite
transactions are short, so unrelated logical sessions remain concurrent even
when they map to the same one of 16 fixed registry files. Normal settlement
deletes each row; crash recovery replaces it only after its owner PID is no
longer live. A bounded capacity pass applies the same proof to distinct crashed
owners; the store never age-deletes a claim. Full-synchronous DELETE journals
make interrupted row changes recoverable, while fixed file, row-count, and byte
ceilings prevent per-conversation lock-file growth.

Rollover never applies to the console channel (the `gui` operator channel used
by the web console; its stable protocol/source id remains `tui`). A console thread already carries an
explicit, reader-owned session boundary: it has a permanent conversation id and
a visible "new thread" action. Bucketing it by day on top of that severed a live
conversation at midnight, so the next morning's follow-up in the same visible
thread woke with no transcript and had to reconstruct it through `RunHistory`.
Every other channel — Telegram, Slack, cron, webhook, OpenAI-API — takes the
configured policy unchanged. Both history tools still use the *configured*
policy for their scope match, so runs and tool records a console thread already
recorded under a dated id stay searchable from the same thread's undated id.

:::caution
Enabling this on an agent that has been running with `rollover: "daily"` means
each existing console thread starts cold exactly once: its durable history lives
under the old dated id, and the thread now runs under the undated one. Every
turn after that resumes normally.
:::

## Concurrency: admission and execution bounds

`concurrency` bounds how much work is in flight. There are two separate limits, applied at different points in a run:

| Key | Default-bearing | Caps | Applied |
| --- | --- | --- | --- |
| `concurrency.maxConcurrentRuns` | yes | How many runs **execute** against the provider at once (execution width) | At the provider step |
| `concurrency.maxPendingRuns` | yes | How many runs may be **admitted** and wait before the provider step | Before the expensive provider step |

`maxConcurrentRuns` is the execution width — the number of runs that may be calling the provider simultaneously. `maxPendingRuns` is the admission bound — it caps how many runs can be queued waiting for an execution slot before new work is rejected, protecting you from unbounded backlog ahead of the expensive provider call. Queued follow-ups on a warm session hold no slot against either limit.

```json
{
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16
  }
}
```


These bounds cover the harness run path (which begins at `responder.respond`). Channel adapters (Slack/Telegram) do per-conversation admission and attachment downloads *before* that boundary, so cross-conversation transport download IO is not covered here — per-file byte caps and timeouts apply to that instead. A plain-text same-conversation follow-up can be applied inside the active provider run; its reserved adapter queue slot is released after acknowledgement or becomes the next normal turn on an unsupported/failed/end-of-turn race. Adapter queues are drained and aborted on `/cancel` and stop.

The web console separately admits only one active turn per thread. Its one
**Send** path carries a client-generated submission UUID, while the service
chooses a normal turn or targets the exact active Web operation through
harness-owned live-input ownership. A targeting-capable operator waits only for
that operation's run id; a closed, disconnected, timed-out, or mismatched wait
cannot drift into its successor. An older operator produces the visible,
durable `unsupported_targeting` next-turn queue instead of guessing. Replaying
the same UUID and immutable payload returns the durable receipt without another
dispatch, and browser reload recovery reads that receipt without automatically
posting authored content again. These submissions never create parallel
responses in the same thread. Because each thread has its own permanent
conversation id, distinct web threads and distinct agents can execute
concurrently subject to the selected agent's ordinary harness limits. Closing
the browser does not free a harness slot or cancel that turn; use the visible
cancel action when cancellation is intended.

Once an admitted, non-isolated run settles as cancelled or failed before success
commit, the harness seals the accepted partial assistant/tool prefix, releases
the conversation lane, and runs one bounded continuity finalizer. A
per-conversation barrier prevents the next turn from assembling context until
that finalizer publishes the 48 KiB account and either recovers or retires the provider epoch.
The wait lasts until the publication settles and is cancellable: aborting the
waiting turn returns the standard cancelled response and leaves the barrier
installed for the next waiter. Recorder/exporter finalization runs after the
publication and never delays the next turn.
Cancellation closes the mailbox and rejects the live caller immediately; the
publication still allows up to 1,000 ms by default for the provider to settle before
choosing retirement. Recovery itself completes its persistence transaction
before the barrier opens. Late text and tool
events from that call are quarantined. Cancellation retains its typed host abort
reason. Failure records trusted host settlement fields and keeps raw
runtime/provider code and detail only as bounded, redacted untrusted evidence.
Isolated proactive/continuation runs remain outside shared history, and a queued
request cancelled before admission publishes no account. If publication fails,
the next turn (or reset) republishes the already-built account once through a
fresh transaction that never re-begins a provider turn or re-attempts recovery;
a still-failing store reports the outcome-specific continuity error carrying a
redacted cause, and the following message retries again. A waiter parked longer
than 5,000 ms emits one `turn_continuity_publication_slow` runtime warning with
the conversation id, the previous outcome, and the elapsed milliseconds; the
warning never changes the wait. Resetting the conversation after a failed
publication discards the unpublished account and clears the barrier once the
reset itself succeeds. Hosts may override the window with
`AgentHarnessOptions.session.terminalRecoverySettlementMs`, a positive safe integer,
or the top-level `terminalRecoverySettlementMs` option of
`createConfiguredAgentHarness`. Tests may use a longer window; this is not a
configuration-file setting.

The ordinary successful-turn boundary remains atomic. Once success claims that
boundary, a later abort or exception does not replace it with a continuity
account. A process signal that unwinds through the harness is covered by the
ordinary cancellation/failure paths. Without coordinated native reconciliation,
a hard process death can only mark run artifacts/web projections `interrupted`,
not reconstruct canonical history from lost process state. Opted-in durable
turns instead use the owner-held recovery contract below.

### Per-channel scope gotcha

These values are **not a single global cap.** The app builds one harness — and therefore one limiter — per enabled channel. Each channel's limiter bounds *that channel independently*. With N enabled channels, the effective ceiling is **N × the configured value**.

:::caution
For example, `maxConcurrentRuns: 4` with three enabled channels (Telegram, Slack, webhook) allows up to **12** simultaneous provider runs across the app, not 4.
:::

Size the value as a *per-channel* budget. If you need a hard app-wide ceiling, divide your target by the number of enabled channels. See [Channels](/channels/) for which channels are active.

## Pi-native tuning

`providers.piNative` tunes the Pi-native provider path: transport selection, retry behavior on transient provider failures, and optional durable session storage. These apply to every provider route. All fields are optional.

| Key | Range / Default | Meaning |
| --- | --- | --- |
| `providers.piNative.transport` | `auto` (default), `sse`, `websocket`, `websocket-cached` | Preferred provider transport; providers without multiple transports ignore it |
| `providers.piNative.promptCacheDiagnostics` | boolean; default `false` | Metadata-only request fingerprints in run artifacts |
| `providers.piNative.piMaxRetries` | `0`–`8`, default `2` | Transient provider-transport retries |
| `providers.piNative.maxRetryDelayMs` | default `60000` | Backoff cap between retries (ms) |
| `providers.piNative.piSessionsRoot` | path; unset = in-memory | Durable JSONL session store enabling resume across restarts |

```json
{
  "providers": {
    "piNative": {
      "transport": "sse",
      "piMaxRetries": 2,
      "maxRetryDelayMs": 60000,
      "piSessionsRoot": ".mono-agent/sessions"
    }
  }
}
```


`auto` preserves Pi's provider-specific default and fallback behavior. An explicit mode is host-authoritative for configured agents: request-scoped runtime extensions cannot replace it. Every Pi result records the normalized choice as `diagnostics.pi_transport_requested`; this is the requested mode, not a claim that a provider with only one transport changed its wire protocol.

### Durable sessions and restart

With the configured app's default history store, setting `piSessionsRoot` persists Pi sessions to JSONL and enables history-coordinated resume after restart. Before provider execution, the store publishes and fsyncs a separate owner-only dirty fence while holding cross-process logical/exact owner rows in the fixed 16-file claim registry. Physical shard collisions do not serialize unrelated provider turns or their cancellation publication; existing legacy per-conversation lock files are still honored in place. The fence does not replace, count as, or prune canonical history. A successful provider result is eligible for reuse only when it returns the exact epoch-derived id and the runtime affirmatively fsyncs both its JSONL file and parent directory. The history messages, clean provider epoch, and incremented transcript revision then publish in one atomic replacement before the fence is cleared.

Concurrent writers sharing a history directory must use v0.20.0 or later and
participate in the logical/exact claim protocol. Stop all pre-v0.20.0 writers
before sharing that directory with an upgraded writer. This is a supported
co-owner boundary, **not** a technical fence that rejects old binaries. Claim-aware
older writers may still hold physical shard transactions; upgraded writers share
their exact-key claims without waiting on unrelated shard transactions. Existing
model-binding schema restrictions still apply independently.

The root SQLite lock still serializes retention accounting, active-marker and
dirty-fence maintenance, and history publication; it is not held across provider
execution. Fail-closed provider retirement during root maintenance can still delay
other mutations. Claim rows are deleted on settlement or reclaimed only after
owner death, never stolen on a timer. The bounded registry and existing 16
conversation-shard files remain in place; no per-conversation lock files are
created, and no possibly-open lock inode is unlinked. Storage growth and claim
capacity limits are unchanged.

If the process dies after provider mutation but before that clean commit, the fence remains. The next same-conversation run retires the exact fenced JSONL, rotates to a new random epoch, and replays canonical history. An unrelated mutation also reclaims inactive fences as retirement journals: provider deletion and directory fsync complete before the fence is removed. If canonical epoch/revision proves that history commit succeeded and only fence cleanup crashed, maintenance preserves the valid transcript and removes only the stale fence. Beginning and aborting a fresh conversation cannot evict an older successful conversation because fences are bounded separately. Missing/v1 records, failed sync, retention that removes a record, and `appendVerbatimTurn` host-only deliveries retire and rotate provider state for the same reason.

Cancelled and failed turns can retain the same durable Pi epoch when the primary
first attempt provides a receipt for a closed operation. Recovery reserves and
reopens the exact record, checks model, revision, tip, ancestry, settled operation
and applied input identities, validates the effective provider projection, and
fsyncs the transcript and directory before canonical history advances one revision.
Receipt settlement itself appends nothing. Native reopen separately writes
idempotent, per-operation interruption accounts and seals interrupted work without
running a model or tool. The next request projects a prompt-only interruption
notice; completed native tool turns and the cancelled input remain. Non-executable
aborted/error/deferred assistant drafts never supply tool-call repair pairs.
Missing results for executable admitted calls are explicit prompt-only accounts,
not successful native receipts; crashed started work says to check whether it
took effect. Provider suspension is accounted as suspended, not resumed, without
a deferred continuation. For legacy callers, a live suspension on a resumed
session is an unreceipted failure: the native branch rolls back to its baseline, and no retained
recovery-pending tail or successful receipt is created. This native repair is not
P2 adoption of dirty host turns. Canonical history keeps
the existing continuity account, including bounded partial prose and error detail;
SessionHistory retains the same tool evidence. No cancelled/failed memory capture occurs.

### Explicit native reconciliation contracts

Protected `sessionTurn.reconciliation` is a separate opt-in from the legacy
receipt path above. It requires a durable kept-alive host turn, version1,
execution or compaction purpose, fence digest and original input identity (null
for compaction). The first fsynced native start contains its binding; final seals
carry exact pre-presentation reply text and terminal classification. Failed,
usage-limited, context-limited, cancelled or suspended execution preserves native
bytes instead of rolling back/deleting them. Poisoned storage remains terminal
and offers no resumability proof.

`reconcileSessionTurn` acquires ownership nonblockingly, validates the exact
binding/model/turn/fence/input evidence before any account or torn-tail repair,
fsyncs and closes. Matching returns ordered operation/tip references and only a
validated completed execution result can become a commit candidate. Absence and
mismatch are explicit; busy ownership, corruption and I/O uncertainty reject.
Recovery invokes no model, tool, summary or deferred continuation. Interrupted
manual checkpoints replay exact persisted envelopes, not new summaries.

For execution reconciliation, `expectedInputs` must contain exactly one
`initial` entry for the descriptor's original input, even when it was never
consumed. Include **every native live admission** for this turn: queued,
cancelled (including end-of-turn cancellation), and consumed. Omitting a
cancelled/unconsumed native admission is an `admitted_inputs` mismatch. A host
may also list durably fenced offers not yet admitted by native storage; those
extra expectations do not prove native consumption, dispatch or completion.
Digests cover the exact serialized native content: original prompt content and,
for live input, `formatLiveInputGuidance(body, prompts)` content, not the raw
follow-up body. Expected placement for the original input remains `initial`
even when its first durable consumption is in a native `replay` operation;
matching still requires the bound original ID and exact content digest. Live
inputs must match `live` placement exactly. `endTurn` durably cancels remaining
unconsumed native offers before sealing; none carries into the next turn.

P2b history roots are not safe for in-place downgrade. Older binaries must not
run against their new pending/fence/canonical formats; writes fail closed rather
than stripping reconciliation evidence. To roll back, stop writers and restore
a consistent pre-P2b backup (later turns are lost). No strip/conversion tool is
provided. Canonical writes use v3 and preserve bounded last-commit receipts
across message retention and epoch rotation; reads accept v1/v2 without migration.

Routers await protected detached-attempt acknowledgement before stateless retries
or backups, removing that authority and the descriptor from those attempts.
Configured raw runtime reconciliation and legacy recovery hold attested
root-generation request leases through settlement. The raw runtime does not
write canonical history: the configured harness wires its matcher into the
durable store's `reconcileProviderSessionTurn` option and opts coordinated host
turns/compaction in through `providerSessionReconciliation: "v1"` only when the
selected runtime owner explicitly declares `sessionTurnReconciliation: "v1"`
and implements the matcher. Method presence alone never grants this capability;
custom routed owners are uncertified unless explicitly attested.

`recoverProviderSessionTurn()` is explicit and owner-held; admission, plain
append (including verbatim delivery), exclusive capture and context import also
settle dirty execution before mutation. `load()` remains read-only. Matching
adopts the whole ordered operation set; native fsync precedes canonical rename,
directory sync, then fence/payload cleanup. Rename commits a bounded receipt, so
repeated recovery recognizes the commit before inspecting native storage again,
even when retained messages have been evicted. New requests use new turn IDs.
Live commits preserve host enrichment, silent-completion annotations and capture
timestamps in a durable candidate; recovery never reruns enrichment. Host
cancellation/failure overriding a native completed seal forces a cold epoch.
A positively absent native turn with a host failure claim retains the failure
category instead of inventing unknown effects. A detached attempt without a
final host candidate is interrupted, never inferred successful from its primary
seal. Otherwise unknown/absent/unbound evidence establishes an interrupted gap and cold
epoch. An advanced protected native revision never silently creates a missing
empty warm transcript. Interrupted work waits for a new message; compaction
recovery changes metadata/receipt, not canonical answers or new summaries.

Logical reset clears torn entries at its known base/validated rollover-child
keys. Unattributable remnants at unknown hashed coordinates remain preserved;
their count is reported in store maintenance diagnostics at reset completion.
Use exact physical reset to clear a never-bound child whose bucket ID is known.

Immutable private pending generations publish through temp write, file fsync,
rename and directory fsync before fence replacement. They are capped at 16 MiB,
with 1 KiB fences;
old/new/orphan generations count toward staged bytes and physical-owner limits.
`drainPendingProviderSessionTurns()` tries at most 32 inactive owners per pass,
oldest first, and returns a continuation cursor. Poisoned owners count as
unresolved without blocking later healthy owners; root/lock identity changes
remain fatal to the pass. It does not wait for foreign
logical/exact owners. Busy/unresolved evidence stays charged and protected;
insufficient capacity rejects, never quota-deletes execution. Reset and
post-settlement authorized retention remove matching generations. Unattributable
malformed orphan content fails closed during logical reset/discovery.

No durable queue, continuation or effect-exactly-once promise is added. Recovery
never calls a provider/tool or resumes suspended work. Older native writers must
not share opted-in journals: they cannot provide or validate the binding/seal/input
proofs.

For the legacy receipt-only path, user cancellation does not spend the failure budget. One `provider_unavailable`
failure, including single-primary exhaustion with matching proof, may recover per
epoch in the current process. Success does not reset that budget. A second failure,
context termination, auth/usage limits, invalid/empty results, session errors,
ambiguous throws, extra attempts, late contradictory evidence, failed tool-history
finalization or uncertain persistence selects cold reseed. The budget and one-shot
boundary marker live only in the in-memory session record and clear on rotation;
reconstructing the harness can allow one additional failed-turn recovery.
Legacy receipt recovery itself does not widen its v4 fence. The v3/P2 storage
upgrade has the downgrade consequences described above.

Recovery is opt-in through the built-in coordinator's `providerSessionRecovery:
"v1"` capability and the owning runtime's `recoverSession` method. Custom stores
without the capability retain retirement. Clear-sessions, retention removal,
host-only appends, model changes and unreconciled dirty fences still reseed.
If retirement races an abort-ignoring provider, the late result cleans only its
captured old id. Owned journals reject late append admission and retain the writer
lock through unwind; retirement removes validated publication/staging and matching
legacy archives without recreating headerless files. Retirement uncertainty
keeps the publication barrier closed until a later turn republishes the lost
retirement (or a reset discards it).

Each clean record also carries the durable provider transcript revision. A process saves that revision with its warm handle. If another process commits the same epoch first, the revision mismatch forces the stale process-local handle to close and reopen the current JSONL (or rebuild from canonical history) before it can omit history. The same strict refresh runs for an unconfirmed durable resume when a newly constructed harness has no local mapping, preventing a module-global provider registry from reviving older process memory. Cross-process serialization therefore protects both disk writes and in-memory provider state.

On every cold durable Pi reopen, the harness loads canonical history and passes it as structured leading runtime messages, with the current user message last; it does not duplicate those turns inside the system prompt. Pi appends the leading messages only when the requested durable epoch has no JSONL and must be created on miss. When the JSONL exists, Pi resumes it and skips the supplied leading history, so a true resume also sees each prior turn exactly once. Confirmed warm turns send only the current user message. Stateless/non-resumable turns and the one explicit resume-retry continue to replay history through the ordinary prompt path.

When `piSessionsRoot` is unset, sessions are in-memory only. A programmatic custom `historyStore` also stays process-local unless it both implements `beginProviderSessionTurn` and advertises `providerSessionRetirement: "fail-closed"`; the harness withholds the durable path because fencing alone cannot reclaim cold JSONL after rotation or retention. Advertise that capability only when the store can durably fence before the provider, serialize the conversation across processes, expose a monotonic provider transcript revision, atomically publish the next revision or rotate the epoch with history commit, and prove exact-id provider transcript retirement before making an epoch unreachable.

Canonical context import is a separate optional v1 contract; `append` or
`deliverVerbatim` does not imply it. A store may advertise import only when a
two-message provenance/assistant batch fits every retention and staging quota,
and when durable provider state is explicitly absent or exact retirement is
fail-closed. The default store serializes import with Send in continuous,
per-message, and sessions-disabled modes. Both non-provider and durable-provider
turns retain logical/exact keyed claims during runtime execution, without holding
a physical shard transaction. Non-provider commits verify an opaque history
version under those claims; publication uses the root lock. Unrelated physical
shard collisions do not serialize turns, though root-locked maintenance and
fail-closed retirement can still delay publication.

An exact retained provenance/assistant pair is the bounded retry receipt. A
same-key/same-text retry returns `duplicate`, including after a later Send while
the pair remains retained; a changed payload conflicts. Retention never keeps
half the pair. Explicit reset, corruption, or deletion of the whole canonical
record also removes the receipt, so idempotency is not permanent across those
boundaries. An empty replacement conversation can be seeded again; a nonempty
conversation whose pair was evicted fails closed as `conversation_not_empty`.
Warm process-local handles carry the canonical history version and are retired
before the next Send when a reset/import advanced it.

:::caution
`mono-agent restart --clear-sessions` purges `piSessionsRoot`, canonical message-history files, the separate canonical tool-history sidecar, and ACP session authorizations, so the agent neither resumes a provider transcript nor replays or searches an earlier chat turn — a fresh start. Previously issued ACP session ids are revoked. Output reports message-history files/bytes separately from tool-history calls/records/bytes and ACP authorization counts. Durable memory under `memory.path`, recorded run artifacts, and process-job records/output remain untouched. Any nonterminal process job is interrupted by restart independently of the flag. A missing store is a no-op.
:::

For retry behavior across *different* models (provider failover, not transport retries), see [Fallback & failover](/runtime/fallback/). Transport retries here are within a single model; fallback moves to the next model in the chain.

## Administrative native history chains

The durable-history storage API can explicitly opt into canonical v4 epoch-journal
chains through `nativeJournalStorage`. This is not configured model switching or
incoming dispatch. Root authority requires drained owner claims and stopped older
writers; managed roots strictly preserve unreadable canonical evidence.

Accepted switch content permits ready-only native/canonical roll-forward. Pending
switch production stays host-only and blocks ordinary admission. Cold boundaries
persist the exact replacement epoch before creating it, preserve predecessor
journals, and delete only a reference-checked current retirement target. Reset and
retention retain complete membership through restartable whole-chain native,
handoff and crash-storage cleanup. Recovery does not call a model, tool or summary.
Whole-root operator purge retains its existing stopped-writer quarantine protocol.

Do not run older binaries against an upgraded root. The marker is not a universal
old-binary admission barrier. Rollback means stopping writers and restoring
consistent host/native backups; there is no downgrade or strip tool, and these
APIs grant no authority to migrate a real root.

## Related

- [Pi runtime & model references](/runtime/backends/) — choosing `runtime.model`
- [Local providers](/runtime/local-providers/) — `<provider>:<model>` for Ollama / LM Studio / OpenAI-compatible
- [Fallback & failover](/runtime/fallback/) — ordered backups on retryable provider failure
- [Tool scheduling](/runtime/tools-and-guards/#tool-scheduling-code-only) — safe parallel or forced-sequential tool calls within a model step (code-only)

## Prompt-cache diagnostics

`providers.piNative.promptCacheDiagnostics` (default `false`) enables metadata-only request fingerprints in existing run artifacts. It never emits prompt text, tool arguments, raw cache keys, endpoints or credentials. See [Prompt-cache measurement](/runtime/prompt-cache-measurement/) for the artifact reader.


## Persistent child sessions

`Agent({persist: true})` creates a conversation-scoped child, and `AgentManage`
resumes that child's own Pi-native durable session. Its registry lives at
`<subagents root>/<sha256(conversationId)>/instances.json`; provider transcripts
live in the sibling `sessions/` directory. The default root is
`<artifacts.dir>/../subagents`, independent of the main `piSessionsRoot`.

Registry mutations and active turns are file-locked across processes. A busy
instance rejects another turn or a close; Pi's own `session_busy` result is also
reported as busy. A process crash releases its locks, so a stale running record
recovers with an interrupted outcome on the next access: `awaiting_reply` if a
pending question exists, otherwise idle. Session context
is retained on disk, while an in-flight task is not automatically restarted.
`AskParent` persists a pending question under the turn lock before its terminating
tool result returns. `Agent`/`AgentManage` expose it as successful `awaiting_reply`;
the parent answers through ordinary `AgentManage` in the same durable transcript.
Failed replies preserve the pending question and a minimal recovery fence;
they are not permission to retry the same transcript. Successful replies clear
the question, and another question replaces it. Idle expiry includes clean
awaiting children but never interrupts a running or recovery-fenced child. `restart --clear-sessions` purges
this configured root with other conversation state and reports removed registry
and child-session file counts, even when no other store existed. See
[persistent subagent configuration](./tools-and-guards.md#persistent-subagents)
for limits and lifecycle controls.

Detached persistent child turns hold their own runtime generation lease after the
parent returns. Their queued reservation prevents duplicate admission. After an
unresolved timeout/cancellation, the reporting job may be terminal with
`childStillBusy:true` while the child still owns its lock and lease. Only actual
settlement can release the provider lease; process death alone does not prove
command-group cleanup. A late result cannot emit a second wake or make unknown
continuity resumable. Registry incarnations and turn intents prevent abandoned
locks from silently authorizing a successor. Unresolved linked owners require
their registered service; disabled, failed or missing owners fail closed. See [detached persistent children](/tools/background-process-jobs/#detached-persistent-children).

### Anthropic cache retention

`providers.piNative.cacheRetention` defaults to `"long"` (one hour); set `"short"`
(five minutes) to opt out. JSON wins over the `"long"` default, and the resolved value overrides Pi's ambient `PI_CACHE_RETENTION`.
The runtime forwards retention only to Anthropic Messages, including child
routes. Pi's `supportsLongCacheRetention` model check remains authoritative;
unsupported models receive no one-hour TTL.

One-hour writes cost **2× normal input**, reads **0.1×**, versus **1.25×** for
short-cache writes. Model support is required, and no cache hit is guaranteed.
Metadata-only diagnostics record the requested setting and observed cache TTL;
an ephemeral Anthropic cache control without an explicit TTL denotes five
minutes. Evaluate the measurement gates before separately authorizing spending.

The default benefits agents whose turns arrive 5–60 minutes apart. In a measured
maintainer-console workload, 72% of Anthropic cache writes were 5–60-minute
re-writes, with an estimated 27% reduction in Anthropic input-equivalent cost.
This is workload-specific evidence, not a billing guarantee. Agents that only
chain turns within five minutes pay slightly more with long retention and can
set `"short"` instead.
