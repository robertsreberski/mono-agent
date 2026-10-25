---
title: "Gated continuity ledger"
description: "Opt-in bounded boundary upkeep, derived evidence, source validation, purge lineage and provider-cap limits."
---

The first ledger slice is **off by default**. Deterministic cold packs and retained
`ConversationHistory` remain the normal path, with no extraction call.

```json
{
  "runtime": {
    "session": {
      "continuity": {
        "upkeep": {
          "enabled": true,
          "requireRequestCap": false
        }
      }
    }
  }
}
```

`upkeep.extractionModel` optionally names an explicit provider/model reference.
Otherwise extraction uses configured `runtime.model`, not an answer-model switch.
There is no fallback model. Configured upkeep binds `providers.piAuthPath`;
explicit `runtimeOptions.resolvePiApiKey` and `resolveCustomPricing` override
configuration defaults. An injected `options.runtime` may keep different private
host resolvers: upkeep cannot introspect them. Embedders must also supply those
resolvers through `runtimeOptions` to use the same credentials/pricing for upkeep.
`ledgerEnabled: true` permits read-only reuse without
buying upkeep; upkeep also enables reading. Both switches default false. Disabling
upkeep stops extraction, not storage/purge. Disabling ledger reading restores the
deterministic renderer without changing additive storage or disabling owed purges.
`continuity.enabled: false` or `packEnabled: false` prevents paid upkeep/injection.

## Eligibility and latency

Only the primary attempt of a continuous, non-isolated session at an actual cold
native seed may buy upkeep, and only with an owned canonical-history transaction,
continuity capture and packs enabled, source evidence and usable trigger headroom.
True native resumes do not call it. Per-message sessions, isolated proactive turns,
continuations and router detached attempts cannot buy upkeep. Unavailable canonical history and unsupported/custom
stores fail closed. Continuations keep the deterministic, boundary-scoped fallback.
Content-free `continuity_upkeep` receipts expose a skipped reason rather than
silently pretending that an excluded route performed maintenance.

One promise is memoized per logical turn. Selection/completion run under the
existing exclusive conversation hold, **outside** the owner transaction;
publication reacquires that transaction and checks source visibility and parent
identity. A cold first token can therefore be delayed by **up to 60 seconds**.
Failures do not block the answer: retain the deterministic pack and report a gap.
Here “retry” means router retries and backups: they never buy upkeep. A native
`resume_error` that produces a cold seed within the primary attempt is an eligible
boundary; the same memoized promise still caps it at one completion. The selected generation
is frozen; bounded visibility/purge rechecks may remove it, never substitute a
newer generation during the turn.

## Bounds and provider enforcement

- One SSE completion, zero retries, tools, repairs or automatic model fallbacks.
- At most 128,000 estimated input tokens for the one-time bootstrap, then 64,000
  for incremental calls, including instructions, prior interpretation and span
  metadata with a conservative estimate margin. Reported
  input usage including cached input is also checked before publication.
- 4,096 output tokens **including reasoning**, with lowest supported effort.
- One 60-second deadline, combined with caller cancellation.

Nine supported adapters send an inclusive request cap (Anthropic, OpenAI
completions/Responses, Azure Responses, Google, Vertex, Bedrock, Mistral and Pi):
receipts say `capEnforcement: "request"`. The installed Codex Responses adapter
omits that request field. Its default policy is `"stream_abort"`: count streamed
text/thinking conservatively and abort when the visible estimate reaches 4,096.
For Codex, the request asks for at most eight entries with values at most 96
UTF-8 bytes and at most 3,072 serialized JSON bytes. `covered` explicitly lists the deduplicated IDs cited by entries; it is **not** a
count or numeric prefix. This matches the general JSON contract and avoids
ambiguity when fitting orders spans by age. Preserved coverage in this mode
counts **only entry-cited spans**, not a full analysis claim. Dropped spans remain
uncovered in stored/rendered diagnostics; even a citation is not proof that every
fact inside its span survived. Reasoning summaries are omitted from
the native payload; effort stays at the lowest supported level. The conservative
one-visible-byte-per-token guard remains 4,096, including any visible thinking.
Incomplete/invalid output is discarded, without advancing coverage. Reported
usage above 4,096 emits `upkeep_output_overrun` and rejects publication.

**Codex is not a hard server/billing cap.** Hidden reasoning and already-started
remote work can exceed the client guard; aborted calls may not report usage.
Reported usage stays unknown when absent; a separate conservative
`estimatedInputTokens` / `estimatedInputCostUsd` records the potentially paid input,
not a reported invoice or an estimate of hidden/output work. `upkeep.requireRequestCap: true` skips unsupported
adapters, including Codex, before dispatch. Use an explicit supported extraction
model if strict enforcement is required. Codex subscription/quota use is not
metered dollar spend; catalog cost estimates are not an invoice.

## Evidence, trust and deletion

An independent bounded source query includes retained tool interiors, rather than
reusing the owner-first deterministic shortlist or clipped result heads. Signal
ranking favors identifiers/outcomes/corrections and active owner rules; labelled
hypotheticals are lower priority. Ranking is not proof of truth or effect. Input
is capped; uncovered span/record counts are explicit, not evidence of supersession.

The host validates the whole JSON completion, exact source IDs, UTF-8 byte spans,
whole-record and span digests, entry bounds and coverage references. Values must
fit **512 raw UTF-8 bytes and 640 JSON-serialized bytes including quotes**; each
whole entry must fit **832 JSON-serialized bytes**. Ordinary 512-byte text fits;
control/quote-heavy expansion has bounded headroom. Any excess rejects the whole
completion, never partially accepts entries. Identifier
values must occur exactly in cited evidence. The extractor is explicitly told to
return the **bare identifier only**, with no entity name, label or explanatory
prefix; surrounding labels are not silently removed by validation. A confirmed action/artifact cannot
cite only an owner request. Invalid output publishes nothing. All model prose is
**derived interpretation**, never host-owner authority. Cited host-owner text is
reconstructed as whole original paragraphs with qualifications/negations intact.
Historical requests are not renewed approval; absent outcomes remain unknown.

The renderer quotes escaped JSON strings (`<` and `>` are escaped), labels each
source as `owner:sN`, `tool:<name>:sN` or neutral evidence, and explicitly labels
constraint/decision/supersession interpretations with **any non-owner source** as
untrusted source-reported claims, including mixed owner/tool citations. Merely
adding an owner citation cannot turn a tool-reported portion into an owner
instruction. It prefixes a bounded verified
ledger and demotes a raw owner record **only when every paragraph is cited by an
active entry and quoted byte-for-byte**; it does not delete owners on the model's assertion of coverage. An
oversized/absent ledger leaves the deterministic fallback intact. Optional input
still respects the target compaction trigger and current-input/output reserves.

Storage is latest-only, additive inside schema v3. Serialized generation payloads
(including inherited input metadata) share the retained byte budget. Auxiliary
SQLite lineage rows/index/file overhead are not separately charged; this is not
a physical SQLite-file quota. The 128 KiB payload limit bounds serialized metadata,
not contributing retained text: a separate **4 MiB retained-text lineage bound**
applies to the union of inherited and newly selected records.

Before completion, admission reserves the general **24 × 832-byte entry bound**
plus array commas, selected span metadata and inherited input links. This one
projection applies to both profiles; Codex's smaller output is safely below it.
It no longer reserves sixfold escaping of every raw value byte.

Within the input-bounded shortlist, fitting considers **unrepresented spans
first, oldest record ordinal then earliest byte offset**; prior-covered spans
follow in the same oldest-first order. This favors early evidence outside the
cold window while letting spans trimmed at one boundary lead the next. The input
shortlist retains its signal ranking within represented/unrepresented groups.
A span whose full contributing record or metadata cannot fit is skipped; smaller
later candidates can still fit. Selected spans, prompt and admission manifest all use the fitted set. Every removed span increments uncovered;
no trim advances coverage or drops inherited purge links.

The deduplicated retained-text union must stay within 4 MiB, and projected payload
within 128 KiB. Only if **no minimal selection fits** does admission skip
`ledger_payload_budget` or `ledger_lineage_budget`. Shared-quota headroom after
replacing the current payload remains a separate unchanged check, with
`ledger_quota_budget` refusal without buying a call. These
preflights are not reservations: publication still rechecks quota, source and
parent identity atomically, and cannot evict source evidence to make itself fit.
Inherited input links invalidate descendants when **any** contributing ancestor
source is deleted, tombstoned or changed, including a pre-ledger binary's normal
B1 purge. Quota-retention tombstones likewise invalidate dependent generations;
this slice introduces no checkpoint source leases. Pending purge intents suppress reuse immediately. Old binaries ignore
the additive tables; pending explicit-reset intents must drain before rollback.
No destructive storage downgrade is required.

Paid-failure suppression is durable, keyed by source/parent manifest within the
scope incarnation, independent of model changes. `upkeep_repeat_suppressed`
avoids repeat purchase. Unresolved dispatch conservatively stops further
purchases in that scope, including a smaller incremental selection of an
uncertain bootstrap, until explicit reset or durable non-invocation proof.
Restart and quota pressure never evict this evidence. See durable admission below.

Represented selected spans skip as `already_covered`. An identical valid selection
still skips as `unchanged`, preserving its prior uncovered count. Unrepresented
spans (including prior trims) get priority at a later eligible boundary, not an
extra completion in the current turn. Coverage describes the **current latest
generation**, not a permanent all-history coverage index; replacement can leave
older facts uncovered again. The benchmark
still buys just one upkeep per trace/repeat: compact output may leave many spans
uncovered, which must remain visible when interpreting measured answer quality.

Digest/integrity failure emits a content-free `ledger_integrity` warning whenever
the ledger is skipped. There is no auto-repair or paid attempt against corrupt
state. Use the normal session/continuity reset (`ClearSessions`) to remove the
affected state before rebuilding, after preserving any needed diagnostics.

## Measurement boundary

See the [ledger benchmark arm](/runtime/continuity-benchmark/#ledger-first-slice).
This slice provides host receipts and benchmark upkeep accounting, **not** merged
answer/upkeep billing reconciliation, cancellation/restart-complete accounting,
coverage-hole/incremental scheduling, default-on upkeep, or a claim of paid
quality improvement. Those require subsequent evaluation and implementation.

Validation and publication failures carry an allowlisted, content-free `failure`
code in the upkeep receipt and warning `error_code`: JSON/schema/coverage,
source/citation, value/entry bounds, owner/outcome integrity, publication
CAS/quota/bounds/source/cancellation/unavailability. Raw text, values, IDs and
exception messages are never included in that discriminator. Production has no
completion capture path.

## Durable admission and recovery

Enabled upkeep uses separate additive v3 scope, admission and operation tables,
not the latest ledger row. The scope binds the canonical history root and database
identity, logical and physical conversation, and explicit-reset incarnation.
Model changes and native-session epochs do not create a new bootstrap allowance.

The first dispatched extraction has a cumulative input allowance of **128k**;
later extractions have **64k**. Both include selected evidence, prior ledger,
prompt and conservative overhead. There is still one completion, a 4096 inclusive
output budget, 60-second deadline, no tools, retries, repair or fallback. Codex's
visible-stream abort remains a client guard, not a hard remote/hidden-reasoning cap.

A canonical owner installs an acknowledged fence before recovery. The worker
conditionally reserves an operation, commits `dispatch_started`, and acknowledges
it before the caller completes the canonical owner post-check and invokes the
provider. A timeout is not cancellation of a queued write and never grants retry
permission. Old fences cannot dispatch, record outcomes or publish after recovery
or reset. Identical transitions replay idempotently; conflicting payloads fail.
Recovery never fences a live canonical owner merely because a waiter expired.

Reserved work without a committed dispatch barrier can be released only after
installing a new fence. A barrier without terminal evidence remains uncertain,
consumes bootstrap and is not automatically repurchased. Only durable allowlisted
pre-invocation proof (model identity, input/headroom or unsupported-cap refusal)
can release a committed barrier. Generic errors and cancellation are not proof.

Provider outcome and available usage, including separate cache counters, commit
before ledger publication and before the result receipt. The journal retains the
originating run, recorder namespace, extraction model, source/parent manifest and
budget kind. Missing terminal evidence means unknown usage/cost, never zero;
accounting export/reconciliation is a separate follow-up capability.

**Bootstrap marker lifetime:** quota pressure, source retention, ledger eviction,
restart and model changes do not clear it. Only explicit user reset/delete of the
conversation scope rotates its incarnation and clears its operations/marker. This
can authorize one more bootstrap. Retention purge intents preserve admission state;
explicit reset intents are distinguished durably. No source is pinned indefinitely.
Bounded admission metadata stops further purchases when full rather than evicting
anti-repurchase evidence. Disabling upkeep stops new purchases without downgrading
or deleting the additive tables. Existing deterministic fallback remains available.
