---
title: "Sessions, concurrency & engine-turn tuning"
description: "Distinguish session boundaries, configure queueing and concurrency, and manage durable session transcripts."
sidebar:
  order: 5
---

This page covers how the runtime keeps provider sessions warm per conversation, how it bounds in-flight work with admission and execution limits, and the engine-turn transport knobs for transport selection, retries, and durable on-disk sessions. Every option here is `config` coverage with a matching `MONO_AGENT_*` env var unless noted.

## The five "session" meanings

Mono-agent uses "session" for five related but different boundaries:

| Meaning | What owns it | What it controls | What resets it |
| --- | --- | --- | --- |
| `runtime.session` config block | Agent config / env | Whether turns try to reuse a warm provider session and how long idle warmth lasts | Changing config, setting `mode: "per-message"`, or disabling resume support |
| Provider session | Runtime backend / provider bridge | Warm runtime continuity: provider-side context, provider session id, busy state, and idle eviction | Idle eviction, stale/busy resume retry, provider session rotation, unsafe or unsettled cancelled/failed turns, harness disposal, or process restart when only in-memory |
| Canonical logical-session history | Durable message-history files plus the separate `tool-history/tool-lifecycles.sqlite` sidecar | Cold context replay and retained, searchable managed-tool invocation/result evidence; settled failed/cancelled non-isolated turns have bounded message accounts, while tool records may still outlive isolated, never-started, or hard-crashed runs with no account | A conversation reset clears every message and tool-history bucket visible in that logical session; `mono-agent restart --clear-sessions` clears all persisted conversation state |
| Durable session transcript | engine-turn JSONL store plus the canonical history record's random provider epoch and transcript revision | Crash-safe cross-restart and cross-process resume for engine-turn provider sessions | `mono-agent restart --clear-sessions`, deleting either store, a dirty fence or legacy/missing history record, host-only history append, failed provider sync, or leaving `runtime.session.root` unset |
| Web console thread | `mono-agent web` / `@mono-agent/web` | Persistent source-bound browser conversation, its messages/attachments/live follow-ups, durable submission receipts, and at most one active turn; different threads can run concurrently | Archive only hides it; `mono-agent web reset --all --yes` removes the entire stopped console store. Browser disconnect does not end its active turn; service restart marks that turn interrupted, requeues only unmarked offers, renders dispatch-marked live input uncertain without retry, and retains submission receipts for read-only recovery |

Boundary rules:

| Boundary | What ends | What survives | What is emitted |
| --- | --- | --- | --- |
| Daily rollover (`runtime.session.rollover: "daily"`) | The current day-bucket conversation id and its warm provider-session lineage, on every channel **except** the web console | Durable memory, old run artifacts, durable session transcripts for other ids, app process state, and every console thread | `session_boundary` with `kind: "rollover"` on the first turn of the new bucket |
| Isolated proactive turn (`runtime.session.isolateProactive: true`) | Nothing shared; the proactive turn intentionally skips the conversation's warm provider session | Existing interactive warm session, durable history, memory, and run artifacts | `session_boundary` with `kind: "isolated"` and `reason: "proactive"` |
| Default model change within a continuous conversation | The previous model-bound provider epoch; the new model starts from canonical history | Durable message and tool history, memory, and run artifacts | `session_boundary` with `kind: "resume_replay"` and `reason: "model_change"` |
| First bound turn for a legacy unbound provider record | The pre-model-binding provider epoch; the requested model starts from canonical history without guessing the previous owner | Durable message and tool history, memory, and run artifacts | One cold session event plus `session_boundary` with `kind: "resume_replay"`, both with `reason: "legacy_unbound_model"` |
| Resume replay after stale/missing provider session | The stale provider session id | Durable history, memory, run artifacts, and the run itself, which retries once | `runtime_warning` `session_resume_retry` plus `session_boundary` with `kind: "resume_replay"` |
| Host-only history append / unsynchronized provider result | The prior durable provider epoch | Canonical history, memory, and run artifacts | The next provider turn receives a fresh epoch id and replays canonical history |
| Cancelled admitted interactive turn | The unfinished run; an unsafe or unsettled provider epoch | A bounded, redacted continuity account in canonical history, retained tool-history records, and run artifacts | Eligible durable session turns retain their native context and emit `resume_replay` with `cancelled_turn_resume` on the next turn; unsafe tails reseed from the continuity account |
| Failed admitted non-isolated turn before success commit | The failed run; an ineligible or unproven provider epoch | A bounded, redacted continuity account in canonical history, retained tool-history records, and run artifacts; memory capture remains excluded | One eligible provider failure per epoch can retain native context and emit `failed_turn_resume`; context/auth/usage failures, invalid results and exhausted retries reseed |
| Telegram `/new` | Current chat's warm provider session plus message and tool history for its logical session across daily rollover | All unrelated conversations, durable memory, run artifacts, and the chat's model/effort override | Telegram confirmation; the next message rebuilds startup context and reloads skills |
| Idle eviction / replaced / disposed provider session | Warm runtime continuity for that conversation id | Durable session transcripts, durable history, memory, and run artifacts | App log line and status metadata event (`evicted`) with reason |
| Detached status read | Nothing | All runtime/session state | No runtime event; status reads the latest published config + store snapshot |
| `mono-agent restart --clear-sessions` / explicit purge | Durable session transcripts under `runtime.session.root`, persistent child registries and transcripts under `subagents.instances.root`, message-history files, the tool-history sidecar, and ACP session authorizations beside `artifacts.dir` | Durable memory under `memory.path`, recorded run artifacts, and process-job records/output; nonterminal jobs are interrupted by any restart | Restart/status output reports message-history and tool-history counts/bytes, v3 continuity record/pin/generation counts, and ACP authorization counts separately |
| Browser disconnect or reload | Only that SSE/browser connection | Web service turn, source-bound thread, messages, committed attachments, provider/harness work | Reconnect receives current state and subsequent events |
| Web service restart | Any web-owned active upstream connection | Terminal messages, archived/active threads, committed attachments, queued live follow-ups, submission receipts, agent memory/history, recorded runs | Active web turn is projected as `interrupted`; unmarked live offers become queued normal turns, dispatch-marked offers become uncertain, and browsers recover a known submission with `GET` instead of repeating `POST` |
| `mono-agent web reset --all --yes` | Entire stopped web-console SQLite/settings/upload state | Agent configs, provider/harness history, memory, and recorded-run artifacts | CLI confirmation/result only |
| `mono-agent web-control reset` | Validated idle host admission, cooldown and quota metadata under `~/.mono-agent/web-control`; active requests prevent reset | Conversations, artifacts, documents and account quota; ordinary session resets and restarts preserve web-control state | CLI operational metadata only |

## Boundary context telemetry

Every built-in `session_boundary` includes `context`: `retained` means the
provider kept its context; `reconstructed` means the next attempt builds context
from canonical history rather than keeping the warm transcript. `handoff` denotes
a structured native model handoff, not ordinary replay. Existing `kind` and
`reason` values are unchanged; older/custom producers may omit `context`.

- `cancelled_turn_resume` and `failed_turn_resume` are **retained**, despite the
  historical `kind: "resume_replay"` name.
- Default cold `model_change`, `legacy_unbound_model`, `cancelled_turn_reseed`,
  `failed_turn_reseed`, `resume_error` and `runtime_result` are **reconstructed**.
- Rollover and isolated proactive/continuation turns are **reconstructed**; they
  do not claim to retain the interactive context. Router fallback/detached
  context construction reports `resume_replay` / `detached_context` as
  **reconstructed** when the host supplies that reconstruction. Native model
  changes reported through this boundary use **handoff**, not reconstruction.

Where available, reconstruction events include `replayedMessageCount`,
`toolProjectionBytes`, `toolProjectionRecords` and `coverageStartTimestamp`
(the first timestamped canonical message). These describe supplied evidence,
not provider token occupancy, complete historical coverage, or proof of delivery.
They contain no message or tool content. An ordinary cold durable reopen may
supply canonical history which the runtime skips when its native journal exists;
this is not proof of reconstruction and does not emit a new boundary merely
because history was supplied. No rotation or replay policy changes here.

## Durable-history upgrade and rollback

Every durable-history user upgrades one way, with or without `runtime.session.root`
or model switching. The first durable turn rewrites canonical conversation
history as version 3; read-only loading does not. Before upgrading, stop all
writers and back up the canonical history directory and any sessions root as a
consistent snapshot. Older binaries cannot read version 3. Rollback requires
stopping writers and restoring the backup, not disabling model switching.

## Retained conversation evidence (default on)

`runtime.session.continuity.enabled` defaults to `true`. Continuity retains
sanitized user and assistant text, permitted tool text and the latest portable
compaction summary in the existing conversation tool-history sidecar. It does
not require a memory backend or a durable provider-session root. This is
retrievable evidence, not an active-state ledger, automatic recall or permission
to repeat an old action.

```json
{ "runtime": { "session": { "continuity": { "enabled": false } } } }
```

This partial configuration opts out; keep the usual model and identity settings.
Explicit false preserves legacy paths: no participant, sidecar probe or v3
upgrade for continuity. Under normal tool policy every default-enabled agent
gets `ConversationHistory`: `"*"` allows it, a restrictive allowlist must include
its name, and an explicit deny wins. The tool is constructed for standalone
configured harnesses as well as channel controllers. Denying retrieval alone
does not turn capture off. Unlike SessionHistory's prior-run tool evidence,
positively finalized/fsynced current-run conversation records are eligible;
partial streams and prepared publications remain unavailable.
Stop older writers and back up canonical history and the sidecar together before
the first enabled start: the first capable writer upgrades the sidecar from SQLite v2 to v3 in place; older binaries refuse the upgraded store.
Disabled operation does not perform that upgrade. Existing v3 evidence stays on disk for doctor, stats and purge;
ConversationHistory is not registered while capture is disabled. Binary rollback requires stopped writers
and a consistent backup; disabling a flag does not downgrade storage.

`ConversationHistory`, when allowed by tool policy, searches and retrieves only
the current logical conversation (including configured rollover buckets).
Chunks are at most 8192 UTF-8 bytes and identify the retained text's digest,
redaction and truncation. Retained records are bounded at 1 MiB; oversized text
is explicitly omitted, never presented as lossless original text. Continuity and
tool-lifecycle payloads share the existing 256 MiB retention budget. Live pins
never silently expire: exhausted pinned capacity reports degraded continuity
rather than invalidating references. Conversation reset and
`restart --clear-sessions` remove this evidence with the existing sidecar.

The latest portable summary is generated evidence, not a user instruction.
Recording is awaited across manual, pre-turn, reactive and mid-run compaction.
Storage reservation is attempted before reduction, but sidecar outages, full
capacity or an oversized summary never block compaction or the run. They warn
and degrade retained evidence coverage, with content-free gaps when storage is
reachable again. A prepared summary is invisible until the owner verifies
the actual synced native checkpoint and its covered-source/retained-text digests.
An interrupted acknowledgement can recover without another summary call.
Canonical hashes alone cannot prove a native reduction occurred.
`SessionHistory` keeps its prior-run tool-lifecycle contract.

Moving or forking an agent root with an existing sidecar preserves its pinned
artifact root. Tool-history and continuity writes degrade if that root differs;
compaction and canonical history continue. Use a fresh store for the moved root;
this release does not rebind stored artifact paths.

Custom preparer/recorder callbacks must be bounded local operations. They are
awaited under the owner; cancellation cannot forcibly interrupt a callback that
does not settle. Initial exclusive-mode input has no native input identity and
remains `user`/unknown rather than inventing host-owner attestation.

## Web-only durable model-switch opt-in

Defaults retain cold model-change replay. After backing up consistent host history
and sessions roots and stopping **every older writer**, opt in explicitly:

```json
{
  "runtime": {
    "session": {
      "mode": "continuous",
      "root": ".mono-agent/sessions",
      "modelSwitch": { "enabled": true }
    }
  }
}
```

This partial config requires the usual model and identity fields. Absent or
explicit OFF leaves model-switch behavior disabled, but does not prevent the
one-way durable-history upgrade described below. Fresh and existing roots
bootstrap authority lazily under conversation ownership, settling old turn fences
before capturing evidence. Read-only history loading does not upgrade roots.

Only Web's persisted inbound `started.userMessageId` with `source: "web"` authorizes
model switching or a new summary generation. Transport IDs, run IDs, text hashes,
TUI/ACP IDs and background wakes do not. No-ID turns on never-upgraded conversations
keep the original path, including cold-replay model changes for cron, webhook,
Slack, Telegram, TUI, ACP and Web wakes. They make only one cheap binding read to
select that path, with no switch preparation, switch claim or authority bootstrap.
On already-native conversations, every no-ID turn inherits the current durable
model without rotation, even if sticky metadata declares a different model.
That model's effort and context-window flags do not carry into the native turn;
the thread's 1M choice applies to the current model only where it supports 1M.
Changing `runtime.model` changes the default for ordinary conversations but does
not move existing native conversations: they retain their durable model until a
persisted Web message selects the new model. Prose keywords do not escalate models
or effort; they are ordinary message text.

A native conversation keeps **one current native journal**, one durable handoff
and the latest switch receipt; it keeps no epoch ancestry. A switch creates the
target journal, durably publishes the binding, handoff and receipt, then retires
the outgoing journal and clears the intent. The incoming turn is admitted only
after that. Every model change, including a return to an earlier model, takes
the same approved order: outgoing summary, then the exact previously validated
structured summary from the last switch plus every later turn, then incoming
summary, then `handoff_pending`. A later-turn suffix without a validated prior
summary is text-only replay and never counts as a handoff, and no model change
happens without a summary. Native session state (raw envelopes, signed
reasoning) is never reused across models, even with matching provenance.
Prepared requests resolve ordinary provider authentication on each actual call,
including OAuth refresh and credential persistence. Credentials are not pinned to
leases, and account metadata is neither recorded nor used to match transfers.
Canonical history uses a single version 3, with native metadata selecting the
guarded shape.


Each switch permits at most two billed summary calls per explicit-message generation.
An outcome-unknown call never auto-repeats. Retries/reopening with the same persisted
ID grant no new generation; the next explicit message permits one attempt per
producer, without a lifetime cap on such messages. While a switch is pending, an
explicit message for the source model cancels it storage-only: the turn runs on
the current journal with no summary call, and the intent's billing record stays
charged. Requesting the target again with a new message starts a new switch; a
redelivery of a message that the cancelled switch already used is refused
without a summary call. A different
third model is refused as `handoff_pending`.
Pending messages are **not queued or replayed**. Interrupted turns are
reported; tools never rerun. Detached same-conversation work may receive retryable
`native_switch_busy` rather than waiting on its own claim. Reset and retention
delete the conversation's native journal and handoff artifacts. A capacity or
size refusal before the switch intent exists returns `handoff_budget_exceeded`;
it never falls back to a summary-less model change.
Conversation IDs longer than 512 characters bypass switch preparation before
native authority or intent. This preserves the original path, not a successful
cold-dispatch guarantee: the existing native host-turn contract rejects those
ownership IDs with the option OFF too. Its 512-character bound is unchanged.

### Native lifecycle boundaries

| Disposition | Allowed effect | Ownership boundary |
| --- | --- | --- |
| P — preserve/detach | Drop stale liveness/mappings without deleting or rewinding retained evidence | The current journal and unresolved protected turns remain preserved, even with a stale model key or persistence failure |
| C — ordinary cold cleanup | Replace only the current epoch with a fresh one of the same model; a switch retires its outgoing journal only after the receipt is durable | Held host claim, exact authority, reference check and durable lifecycle intent or receipt |
| D — conversation deletion | Reset/retention delete the current journal and switch artifacts; operator purge removes attested owned roots | Recoverable until deletion and directory barriers finish |
| U — uncoordinated cleanup | Existing stateless/subagent behavior within its own isolated storage | No authority to delete a guarded host journal |

Manual compaction's advisory P for native-bound stale mappings is defence-in-depth
from a pre-claim read-only hint, not ownership proof. The generic helper modes
`preserve`, `legacy-current` and `isolated` grant no native C/D deletion authority.
Owned membership and guarded headers remain the physical backstop. Generic cleanup cannot
infer physical deletion permission from a cached runtime/model owner. Guarded
rejection means preserved evidence, **not successful cleanup**. Unsettled P2
turns stay protected/charged and reconcile storage-only, without provider or tool
replay. Ordinary durable registry disposal/TTL removes metadata, not journal bytes.

Older binaries must not run against upgraded roots. Rollback means stop writers and restore consistent host/native backups;
disabling the option, stripping markers or downgrading records is not rollback.

### Enable, verify and roll back

Scope: only the Web console's persisted messages can switch models durably. Every
other surface keeps today's behavior described above.

With the opt-in on, persisted-ID Web turns (including the first message) and
no-ID wakes on native-bound conversations use prepared native dispatch with the
**primary model only**. These turns get no configured fallback-chain backup model
and no router-level re-attempt. Within the attempt, pre-response transport
retries are bounded by `providers.piNative.piMaxRetries`, and the driver re-sends
a request whose started response failed transiently (such as a Codex websocket
drop) up to three times, never re-running a tool (see
[Fallback](/runtime/fallback/#same-model-retries)). A primary failure is returned
for that message; send another message to try again. Other turns keep their configured fallbacks. A cancel that
arrives after such a turn's preparation has started, but before admission, is
reported and not appended to history.

If the current native journal is gone for an outside reason (deleted, the agent
moved to another machine, a partial restore), the prepared turn no longer fails
with `session_not_found`. Before admission, while it holds the conversation, the
host checks that journal. It counts as **missing** only when no published or
staged file exists for the recorded journal (or, before the first switch, no
published, staged or archived journal for the current handle; the check never
reclaims a stage). A same-model turn then replaces only the current epoch through
the same durable cold boundary that ordinary cold turns use, with the switch
receipt untouched. The model answers from the canonical conversation history,
seeded once into the fresh epoch, and the turn streams and returns
`degraded_native_context` once. Following turns are warm on the new epoch. A
persisted-ID request for a different model with a missing journal feeds the
canonical history through the same summary order as any switch; it is never a
summary-less change. No lease, tool or summary call is repeated, and a crash at
any step recovers from storage or redelivery without rebilling.

Damage is never treated as loss. An unreadable header, a malformed or invalid
complete record, staged-only bytes or a catalogue that cannot be read refuse the
message with `native_journal_unreadable` and leave every file unchanged. An
incomplete final line still goes to the existing open/repair path.

With or without the opt-in, unrelated entries in the native journals directory
(for example `.DS_Store`, editor temp files or subdirectories) are ignored. A
damaged journal-named file whose owner cannot be read is skipped and kept: it
never blocks another conversation's journal, and retention never charges or
deletes it. Damage named for the current handle refuses that conversation with
`native_journal_unreadable`; unknown-owner legacy damage is preserved but does
not block missing-current-journal recovery. Losing the whole native root, for example after moving to another
machine, recovers on the next message without a reset.

The same rule covers the canonical history root, its `.locks`, `.pending-turns`
and `.model-switches` folders and legacy session folders. Unrelated names are
ignored. A damaged entry of one conversation (empty, malformed, not exactly
owner-only `0600`, or hard-linked) stays on disk, still counts toward storage
limits and is never deleted or evicted. This applies to pending-turn
generations, model-switch states and handoffs (fenced or not), canonical
records and stages, per-conversation lock files, active markers, dirty fences
and fence temps in `.locks`, and `.native-history-op.<hash>.json` lifecycle
intents. Insecure, oversized and unreadable owner artifacts are preserved too;
damaged lifecycle contents are never executed. Only their owning conversation
is refused until offline repair. An owned, bounded marker or fence temp torn by
a killed writer has no recoverable payload: it is reclaimed once its filename
PID is dead. Torn or schema-invalid markers and unchanged fence temps are
always PID-only; only valid markers supply incarnation proof. Linux and macOS
use stable v2 boot/process identity; other platforms, v1/unknown schemas and
unavailable reads use PID-only liveness, treating a live PID as live. Stop every
older binary before the upgraded writer runs: its incarnation-bearing markers
are not readable by pre-upgrade binaries, just like the one-way history upgrade. Resource/device errors
such as EMFILE or EIO propagate; they are not classified as owner damage. The diagnostic names the unavailable artifact;
canonical records and legacy SQLite locks may report their underlying error.
Existing cold-history handling on ordinary admission can set aside unreadable
JSON unchanged as `<record>.damaged-<n>`, when the other recovery gates permit,
with a one-time `conversation_history_set_aside` warning. This is not a general
repair mechanism: explicit reset refuses damaged canonical records, including
truncated JSON. Set-aside files are not charged and are never read or deleted by
mono-agent. New writers no longer create or validate redundant
`conversation-shard-*.sqlite` files; existing inodes stay untouched, including
those left by stopped claim-aware older writers (0.20 or later).

Damage to `.locks/root.sqlite`, logical-session shard databases and their claim
journals, `.native-history-root.json`, or pinned root/subdirectory identities
still stops the whole root. Native-session lock waits and host history-acquisition
waits are cancellable. Admission, model-switch preparation, exclusive host-only
turns and manual compaction pass cancellation through in-process queues and
SQLite root, logical/exact and legacy conversation-lock polling. A cancelled
waiter never bypasses a live owner; raced acquisitions release their ownership
before rejecting. Harness capacity admission is not history admission. Cancellation
during binding/attachment preflight or history acquisition returns `cancelled`
without a history input/account or acquiring history to publish one; the caller
can resend. Already-admitted history turns keep cancellation/interruption
reporting, as do provider-started turns using custom uncoordinated stores.
Started publication and storage-only
recovery finish or roll back without interruption. Reset, drain (including an
admission-triggered drain) and ownership cleanup remain non-cancellable.

Use a conventional umask such as `0022` or `0077` that preserves owner read/write
permissions at creation. A writer killed before permission normalization under
an exotic owner-masking umask can leave an unverifiable marker/temp; its dead
filename PID alone does not authorize deletion. This remains protected damage
requiring stopped-writer repair.

First native-root bootstrap is an exception to owner-local refusal: it cannot
prove that earlier recovery owners are drained when another owner's marker,
fence or pending-turn evidence is damaged. Bootstrap then refuses non-retryably
until that evidence is repaired; ordinary unrelated history operations remain
available, and an already-issued root authority does not repeat this check.

Admission avoids a root-wide history inventory, but preparation, commit and
retention may scan all recognized history and recovery artifacts while holding
the shared root lock. Managed roots also inspect retained canonical records and
native inventory. Retention may repeat planning after native-I/O windows.
Configured quotas do not impose a fixed scan-time bound: large or heavily
damaged roots can delay other conversations' publication.
A local macOS arm64/Node 24 measurement with minimal records and real native
epochs found managed commit lock-held time rising from 21 ms at one conversation
to 8.0 s at 10,000 (13.6 s with one retention victim); these single warm-filesystem
samples are not latency guarantees (`scripts/measure-history-accounting.mjs`).

### Offline repair of damaged conversations

Explicit `reset` and logical reset are not online repair commands. Known damaged
canonical records, coordination/recovery files, enrolled native journals and
model-switch billing state refuse with `ERR_HISTORY_RESET_DAMAGED`,
`retryable: false`, basenames and this repair reference. No damaged evidence is
moved or cleared. An unrelated conversation remains available unless the damage
is in shared coordination. Resource/device errors such as EIO and EMFILE still
propagate as operational failures, not instructions to discard evidence.

**Known limits:** a damaged conversation needs the offline procedure before
reset. Removing its last damaged liveness marker could admit old history before
reset finishes. An unreadable canonical can hide native journal enrollment;
an unreadable native header cannot establish its owner or retained quota charge.
Damaged billing cannot establish whether a summary was already paid for. Reset
does not invent progress records, recover lost enrollment, or waive these guards.
Do not repeatedly reset or redeliver input to try to bypass a refusal.

A healthy logical fence can identify a damaged rollover child and refuse its
logical reset. If **both the child's canonical and fence are damaged**, the
child cannot be attributed to the logical session without guessing IDs. Logical
reset may complete for the identifiable members while leaving that child's
history and fence untouched. This residual case requires offline repair.

For every procedure below, first **stop every writer** sharing either root,
including older binaries and workers, and **back up canonical and native roots
together**, preserving permissions and all evidence. Prefer restoring a
consistent backup. Never follow symlinks, edit a hard-linked target, or recursively
change permissions to force acceptance. Keep all set-asides until recovery is
verified; they are outside managed accounting/retention, so offline review and
removal are the operator's responsibility.

- **Canonical history:** to intentionally discard a conversation after backup,
  identify its exact physical bucket key from the diagnostic. Before restarting,
  set aside its `<key>.history.json` and that bucket's `.locks/<key>.dirty.json`,
  matching dirty temps/active markers, `.pending-turns/<key>.*` and
  `.native-history-op.<key>.json`, using collision-free `.damaged-<n>` suffixes.
  Do not leave an execution fence/payload that could recover old input into an
  absent canonical. Do not guess unreadable rollover children's ownership.
  Guarded native membership must be established from trusted backup before
  discarding its journals; if it cannot be established, restore both roots from
  a consistent backup instead. Billing evidence is a separate guard: apply the
  billing procedure below before discarding any of it.
- **Conversation coordination/recovery:** set aside the identified damaged
  marker, fence/temp, pending payload or lifecycle intent, preserving its bytes.
  If discarding canonical history as well, finish the whole canonical procedure
  before restarting. For a damaged legacy `<key>.sqlite`, move its
  `<key>.sqlite-journal` too, if present, with the same suffix. Shared databases,
  root markers and directory identity failures require the shared-coordination
  procedure below; never remove `.locks` wholesale.
- **Native journals:** identify the exact enrolled journal ID from the diagnostic
  or trusted backup, then set aside the damaged
  `<root>/journals/<id>.jsonl` with a collision-free suffix.
  Preserve the canonical and root authority when they are readable. An absent
  current journal can then take the existing cold-recovery/reset path; a damaged
  one cannot. Do not fabricate headers, adopt an orphan, delete unrelated
  journals, or regenerate `.native-history-root.json`. If canonical membership
  is also unreadable, restore a consistent backup rather than guessing it.
- **Billing/model-switch state:** after stopping every writer and backing up the
  folder, set aside that conversation's `.model-switches/<key>*` files with
  collision-free suffixes. **This removes the consumed-message/double-billing
  guard. Do this only after excluding outstanding or unknown paid summaries:
  redelivery could otherwise pay again.** Until then both reset and ordinary
  turns remain refused, including a new message ID. Do not silently clear billing
  as part of canonical, coordination or native-journal repair.

Only after the selected offline procedure is complete should upgraded writers
restart. Retry reset, verify empty/fresh history and an ordinary turn, and keep
the backup. If another named blocker remains, stop writers again and inspect it;
do not expand a rename into an indiscriminate directory cleanup.

### Stopped-writer recovery of shared coordination

1. Stop **every** process sharing the canonical history and native roots,
   including services, CLI runs, workers and older binaries. Never replace a
   lock inode while any writer can still hold it.
2. Back up both roots together, preserving modes and all recovery evidence.
   Identify the exact failed artifact from the diagnostic; do not guess from
   another conversation's symptoms.
3. Rename only that identified file to a collision-free `<name>.damaged-<n>`
   beside it. Rename `<name>.sqlite-journal`, if present, together with the
   identified `<name>.sqlite` (using the same `.damaged-<n>` suffix). Never leave
   an old journal beside a recreated database. Do **not** remove `.locks`
   wholesale, or move fences, payloads or lifecycle intents
   as part of shared-lock recovery.
4. An empty shared coordination database can be recreated at restart. A damaged
   `.native-history-root.json` cannot: restore that exact authority marker from
   the consistent backup before restarting. Never generate new authority over
   existing guarded native journals. Likewise, do not rebuild the native
   `locks/catalog.sqlite` or journal locks while any native writer lives.
5. Restart upgraded writers and verify ordinary storage-only interruption
   recovery. Recovery reports interrupted turns and waits; it does not rerun
   providers, tools or paid summary calls. Keep the backed-up/damaged files until
   recovery is verified. A replaced or insecure directory needs its original
   identity/permissions restored with all writers stopped, not a live workaround.

To enable:

1. Stop **every** writer for the agent root: the app service, CLI runs, managed
   workers and any older binary. Nothing verifies this for you.
2. While stopped, back up the canonical history directory (beside
   `artifacts.dir`) and `runtime.session.root` together, as one consistent snapshot.
3. Set `runtime.session.modelSwitch` to
   `{ "enabled": true }` with continuous sessions
   and a durable `runtime.session.root`, then start only upgraded binaries.

Rollback: stop all writers, then restore **both** backups from step 2.
Setting `enabled: false` afterwards does not convert native conversations back.

| Acceptance | Behavior | Observable evidence | Verified by |
| --- | --- | --- | --- |
| A1 one durable switch | A persisted Web message for another model records exactly one switch before the incoming turn is admitted. Restarts and retries finish the recorded switch; they never start a second one. | Canonical version 3 `lastSwitch` receipt; exactly one current native journal | `configured-switch-kill-matrix.test.ts` (SIGKILL boundaries, two fresh-process redeliveries and one new delivery each), `managed-native-switch.test.ts` |
| A2 complete fitting context | The incoming model receives a structured handoff. The latest turn and the open-work/outcome-unknown ledger are never clipped. A request that cannot fit is refused before dispatch with `handoff_budget_exceeded`. | One immutable handoff artifact under the history directory's `.model-switches/`, referenced by the receipt | `configured-model-switch.test.ts`, `model-switch-return.test.ts`, kill-matrix incoming-context assertions |
| A3 return to an earlier model | Returning to an earlier model is an ordinary structured transfer that includes the intervening work. It never reuses the earlier model's native session state. | The outgoing journal is retired; the return's artifact comes from the approved producer order | `configured-native-switch.test.ts`, `configured-native-provenance.test.ts`, kill-matrix return boundaries, `model-switch-return.test.ts` |
| A4 crash, reset, retention | Crashes recover without provider, summary or tool replay beyond the redelivered message, and without leaked reservation or fence. Reset and retention delete the journal and its artifacts. Enabling settles old pending turns first. | Empty `.pending-turns`/dirty fences, no `.native-history-op.*` intent, zero reserved bytes | `configured-switch-kill-lifecycle.test.ts`, `configured-missing-journal-kill.test.ts`, `managed-native-lifecycle.test.ts`, `host-turn-reconciliation.test.ts` |

Billing during recovery: an admitted summary call interrupted by a crash stays
charged as outcome-unknown and is never repeated. The checkpoint (when a
validated prior summary exists) and then the incoming producer follow. Each
switch generation allows at most two billed summary calls (outgoing, then
incoming producer), plus the incoming turn itself.

Retrying the same persisted Web message after a crash finishes the recorded
switch in its original generation and never opens a new billed one. The message
ID authorizes switch work only; it does not deduplicate turns. An interrupted
turn is reported, and a redelivered message is admitted as a new turn. The Web
console never resends a dispatched message: if the agent or Web service stops
mid-turn, that turn ends failed or interrupted and you send a new message.

Warnings and refusals:

- `degraded_native_context` is the only model-switch warning. It appears once,
  on the turn that recovered a missing current journal. If the process dies
  after that recovery became durable but before that turn streamed the warning,
  recovery finishes it without the warning; the rotated current epoch is the
  only record.
- Structured handoffs produce no warning.
- `conversation_history_set_aside` (any durable history, opt-in or not) appears
  once, on the turn that set an unreadable history record aside.
- `handoff_pending`, `handoff_budget_exceeded`,
  `native_cold_model_change_unavailable` (a native conversation cannot be
  served by an unprepared or no-ID model change), `native_journal_unreadable`,
  non-retryable `native_switch_damaged`
  (another conversation's recovery data needs repair or restore) and retryable
  `native_switch_busy` are refusals. The message was not admitted; send another
  message when ready.

Limits:

- Every model change, including a quick return, runs the handoff producers:
  normally one billed outgoing summary call, at most two per generation. Signed
  reasoning and provider caches do not carry across models.
- Opt-in prepared turns have no same-message fallback model. A primary failure
  waits for the next message.
- Handoff summaries are model-written prose. The deterministic ledger and the
  verbatim recent turns remain the authoritative evidence.
- Older binaries are not technically blocked from an opted-in root.
- No downgrade tool exists. Native-only data in a retired epoch is lost.

## Provider sessions

`runtime.session` decides whether the runtime keeps a warm provider session per conversation or starts fresh on every message.

The primary's first attempt owns the provider session. Retries and failovers run
stateless with canonical replay and bounded transcript-tail context. With coordinated durable session history,
any answer from a retry or backup retires the primary epoch. The next turn
cold-reseeds from canonical history; after a primary first-attempt success,
subsequent turns resume the new session and are eligible for provider caching.

On an ordinary warm turn whose primary fails, an eligible retry or backup gets
canonical earlier conversation messages, the bounded tool-history projection,
and the current input, just as on a cold turn. A bounded failed-attempt snapshot
may accompany that replay. The host loads history lazily under conversation
ownership, only after any required durable detach acknowledgement; it reuses one
frozen replay across detached attempts and never doubles a cold-turn prefix.
Durable, custom and in-memory history stores are supported. If warm canonical
history is absent or cannot be loaded, no retry or backup starts: the primary
failure returns with `detached_context_unavailable`. A tool-projection failure
alone keeps canonical replay and emits `tool_history_projection_degraded`.
The next turn still reseeds from canonical history.

Configuring any fallback route counts as consent for that route to receive the
conversation history, including when a local primary falls back to a cloud
provider. Replay neutralises instruction markup but is not secret redaction.
The replay loader and its output are not returned in results, failover history
or router telemetry. Persistent subagents remain excluded: they have no host
canonical replay loader, and detached answers still lose session continuity.
Direct router callers without a loader retain their existing behaviour; private
memory completion-only runtimes ignore the loader. Prepared native dispatch
remains primary-only, with no routed retry or backup.

A continuous conversation binds its provider session to the requested primary model, including a thread or channel model override. Repeating that model stays warm; changing it (including returning to the default) retires the old session on its owning runtime and starts a fresh epoch. The cold turn is seeded from canonical user/assistant text and the existing bounded tool-history projection; subsequent warm turns retain the native transcript, including tool results and signed reasoning. Effort-only and same-model overrides do not rotate the session. Continuations and opt-in proactive isolation keep their existing one-shot behavior. Configured retry/fallback behavior follows the [fallback session policy](/runtime/fallback/).

With `runtime.session.root`, the durable history record and its recovery fence persist the model binding alongside the epoch. A restarted process resolves the session's owning runtime from that binding. Existing histories without a binding load normally but take one cold reseed before becoming bound. Older binaries reject the new bound history shape; downgrade does not automatically rotate or migrate those records.

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


Warm in-memory sessions are lost on restart. To resume across restarts, use the default durable history store together with `runtime.session.root` (see [engine-turn tuning](#pi-native-tuning) below). The history store, not a conversation-id hash, owns the resumable provider epoch.

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
deletes each row; crash recovery replaces it only when the PID is dead or its
recorded v2 incarnation no longer matches. A nullable incarnation column preserves
legacy rows written with named-column INSERTs; v1 and unknown identity schemas
remain PID-only too. Linux and macOS use stable v2 identity; other platforms and
unavailable reads use PID-only liveness, treating a live PID as live.
A bounded capacity pass applies the same proof; the store never age-deletes a claim. This is legacy
read compatibility, not concurrent old-binary support: stop every older writer
before the upgraded version runs. Full-synchronous DELETE journals
make interrupted row changes recoverable, while fixed file, row-count, and byte
ceilings prevent per-conversation lock-file growth.

History captures its own process incarnation once per process. Each claim wait
or marker scan resolves a foreign owner once, then polls only `kill(0)`; Darwin's
`sysctl`/`ps` are not spawned on every poll. Darwin uses `kern.bootsessionuuid`
and UTC-formatted process start time, not calendar-clock-adjusted `kern.boottime`
or local time; each history probe has a five-second kill deadline. Linux uses
boot UUID and process start ticks. App's persisted v1 identity API is unchanged.
If a matched PID dies and is reused
during that same wait, the cached proof conservatively leaves it busy until a
fresh acquisition. Legacy or unavailable identity evidence cannot distinguish
PID reuse. Doctor's PID-only observation is diagnostic, not ownership proof.

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
`ConversationHarnessOptions.session.terminalRecoverySettlementMs`, a positive safe integer,
or the top-level `terminalRecoverySettlementMs` option of
`createConfiguredConversationHarness`. Tests may use a longer window; this is not a
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

`providers.piNative` tunes the engine-turn provider path: transport selection, retry behavior on transient provider failures, and optional durable session storage. These apply to every provider route. All fields are optional.

| Key | Range / Default | Meaning |
| --- | --- | --- |
| `providers.piNative.transport` | `auto` (default), `sse`, `websocket`, `websocket-cached` | Preferred provider transport; providers without multiple transports ignore it |
| `providers.piNative.promptCacheDiagnostics` | boolean; default `false` | Metadata-only request fingerprints in run artifacts |
| `providers.piNative.piMaxRetries` | `0`–`8`, default `2` | Provider SDK-policy retries before a response starts; a nonzero value also enables up to three re-sends of a request whose started response failed transiently (see [Fallback](/runtime/fallback/)) |
| `providers.piNative.maxRetryDelayMs` | default `60000` | Ceiling for provider-requested Retry-After delays (ms); longer requested delays fail |
| `runtime.session.root` | path; unset = in-memory | Durable JSONL session store enabling resume across restarts |

```json
{
  "runtime": { "session": { "root": ".mono-agent/sessions" } },
  "providers": {
    "piNative": {
      "transport": "sse",
      "piMaxRetries": 2,
      "maxRetryDelayMs": 60000
    }
  }
}
```


`auto` preserves Pi's provider-specific default and fallback behavior. An explicit mode is host-authoritative for configured agents: request-scoped runtime extensions cannot replace it. Every Pi result records the normalized choice as `diagnostics.pi_transport_requested`; this is the requested mode, not a claim that a provider with only one transport changed its wire protocol.

### Durable sessions and restart

With the configured app's default history store, setting `runtime.session.root` persists sessions to JSONL and enables history-coordinated resume after restart. Before provider execution, the store publishes and fsyncs a separate owner-only dirty fence while holding cross-process logical/exact owner rows in the fixed 16-file claim registry. Physical shard collisions do not serialize unrelated provider turns or their cancellation publication; existing legacy per-conversation lock files are still honored in place. The fence does not replace, count as, or prune canonical history. A successful provider result is eligible for reuse only when it returns the exact epoch-derived id and the runtime affirmatively fsyncs both its JSONL file and parent directory. The history messages, clean provider epoch, and incremented transcript revision then publish in one atomic replacement before the fence is cleared.

Stop **every older writer** before running the upgraded version against a
history directory. Concurrent pre-upgrade binaries, including claim-aware
v0.20–v0.25 writers, are unsupported: their strict readers cannot parse new
incarnation-bearing markers or the upgraded history formats. This is the existing
one-way upgrade boundary, **not** a universal technical admission barrier.
Upgraded readers still tolerate legacy PID-only rows/markers and lock files left
by stopped older writers. Claim transactions remain exact-keyed, so physical
shard collisions do not serialize unrelated upgraded owners.

The root SQLite lock still serializes retention accounting, active-marker and
dirty-fence maintenance, and history publication; it is not held across provider
execution. Fail-closed provider retirement during root maintenance can still delay
other mutations. Claim rows are deleted on settlement or reclaimed only after
owner death/incarnation mismatch, never stolen on a timer. The fixed 16-file logical-session registry
remains; redundant conversation-shard files are no longer created or validated,
but stopped older writers' existing files stay in place. No per-conversation lock files are
created, and no possibly-open lock inode is unlinked. Storage growth and claim
capacity limits are unchanged.

If the process dies after provider mutation but before that clean commit, the fence remains. The next same-conversation run retires the exact fenced JSONL, rotates to a new random epoch, and replays canonical history. An unrelated mutation also reclaims inactive fences as retirement journals: provider deletion and directory fsync complete before the fence is removed. If canonical epoch/revision proves that history commit succeeded and only fence cleanup crashed, maintenance preserves the valid transcript and removes only the stale fence. Beginning and aborting a fresh conversation cannot evict an older successful conversation because fences are bounded separately. Missing/v1 records, failed sync, retention that removes a record, and `appendVerbatimTurn` host-only deliveries retire and rotate provider state for the same reason.

Cancelled and failed turns can retain the same durable session epoch when the primary
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

Operations are listed in start order, but the final operation is the last one
to close. Nested compaction closes before its enclosing prompt; a failed child
does not invalidate that prompt's completed seal. Pending publication recovers
through the same validation while preserving any recorded host failure.
Legacy manual no-ops with a completed seal over one failed or aborted manual
compaction can settle as failed only when all tips equal the baseline, no input
was admitted or consumed, and no interruption or nested work exists. Other
contradictions remain errors.

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
Settlement (commit/recovery/drain) and terminal live `claim` candidate replacement
reuse already-admitted inputs and bypass the staging quota, not the 16 MiB
payload format limit. New input and canonical commit quotas still apply.
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
Legacy receipt recovery itself does not widen its fence. The v3/P2 storage
upgrade has the downgrade consequences described above.

Recovery is selected by the presence of the coordinator's
`readProviderSessionBinding` method and the owning runtime's `recoverSession`
method. Custom stores without these methods retain retirement. Clear-sessions, retention removal,
host-only appends, model changes and unreconciled dirty fences still reseed.
If retirement races an abort-ignoring provider, the late result cleans only its
captured old id. Owned journals reject late append admission and retain the writer
lock through unwind; retirement removes validated publication/staging and matching
legacy archives without recreating headerless files. Retirement uncertainty
keeps the publication barrier closed until a later turn republishes the lost
retirement (or a reset discards it).

Each clean record also carries the durable provider transcript revision. A process saves that revision with its warm handle. If another process commits the same epoch first, the revision mismatch forces the stale process-local handle to close and reopen the current JSONL (or rebuild from canonical history) before it can omit history. The same strict refresh runs for an unconfirmed durable resume when a newly constructed harness has no local mapping, preventing a module-global provider registry from reviving older process memory. Cross-process serialization therefore protects both disk writes and in-memory provider state.

On every cold durable session reopen, the harness loads canonical history and passes it as structured leading runtime messages, with the current user message last; it does not duplicate those turns inside the system prompt. Pi appends the leading messages only when the requested durable epoch has no JSONL and must be created on miss. When the JSONL exists, Pi resumes it and skips the supplied leading history, so a true resume also sees each prior turn exactly once. Confirmed warm turns send only the current user message. Stateless/non-resumable turns and the one explicit resume-retry continue to replay history through the ordinary prompt path.

When `runtime.session.root` is unset, sessions are in-memory only. A programmatic custom `historyStore` also stays process-local unless it both implements `beginProviderSessionTurn` and advertises `providerSessionRetirement: "fail-closed"`; the harness withholds the durable path because fencing alone cannot reclaim cold JSONL after rotation or retention. Advertise that capability only when the store can durably fence before the provider, serialize the conversation across processes, expose a monotonic provider transcript revision, atomically publish the next revision or rotate the epoch with history commit, and prove exact-id provider transcript retirement before making an epoch unreachable.

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
`mono-agent restart --clear-sessions` purges `runtime.session.root`, canonical message-history files, the separate canonical tool-history sidecar, and ACP session authorizations, so the agent neither resumes a provider transcript nor replays or searches an earlier chat turn — a fresh start. Previously issued ACP session ids are revoked. Output reports message-history files/bytes separately from tool-history calls/records/bytes, v3 continuity records/pins/retained text bytes/generations, and ACP authorization counts. Durable memory under `memory.path`, recorded run artifacts, and process-job records/output remain untouched. Any nonterminal process job is interrupted by restart independently of the flag. A missing store is a no-op.
:::

For retry behavior across *different* models (provider failover, not transport retries), see [Fallback & failover](/runtime/fallback/). Transport retries here follow provider SDK policy before a response starts within a single model. A failed started stream is not automatically repeated by that layer; router fallback moves to the next model under its separate rules.

## Administrative native history

The durable-history storage API can explicitly opt into canonical version 3
single-journal records through `nativeJournalStorage`. This is not configured
model switching or incoming dispatch. Root authority requires drained owner
claims and stopped older writers only for bootstrap; later switches may run
alongside unrelated conversations. Managed roots strictly preserve unreadable
canonical evidence.

Accepted switch content permits ready-only native/canonical roll-forward. Pending
switch production stays host-only and blocks ordinary admission. Cold boundaries
persist the exact replacement epoch before creating it and delete only a
reference-checked retirement target. Reset and retention run restartable native,
handoff and crash-storage cleanup. Recovery does not call a model, tool or summary.
Whole-root operator purge retains its existing stopped-writer quarantine protocol.

Do not run older binaries against an opted-in root. The marker is not a universal
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
resumes that child's own engine-turn durable session. Its registry lives at
`<subagents root>/<sha256(conversationId)>/instances.json`; provider transcripts
live in the sibling `sessions/` directory. The default root is
`<artifacts.dir>/../subagents`, independent of the main `runtime.session.root`.

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
they are not permission to retry the same transcript without certified recovery. Successful replies clear
the question, and another question replaces it. Idle expiry includes clean
awaiting children but never interrupts a running or recovery-fenced child. `restart --clear-sessions` purges
this configured root with other conversation state and reports removed registry
and child-session file counts, even when no other store existed. See
[persistent subagent configuration](./tools-and-guards.md#persistent-subagents)
for limits and lifecycle controls.

Ordinary `failed` child turns, foreground or detached, retain native context only
when native recovery certifies the exact closed operation and true ownership has
settled. Inspection returns `ready` with a retained-only ack; verify partial work
and acknowledge one explicit continuation of the same instance/session. Detached
recovery additionally requires `background:true` and command/publication release.
No automatic replay or ordinary-message failure resume is allowed. Lost/unknown
continuity remains close/create only; the certified timeout shortcut is unchanged.

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

Abandoned switch billing states reject redelivered messages both when starting
a switch and when authorizing an existing pending switch. This guard lasts only
while those states are retained: a later completed switch garbage-collects old
billing states. Pending messages are never queued or replayed.
