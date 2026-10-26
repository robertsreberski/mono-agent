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

An independent source query pages retained evidence by **AUTOINCREMENT ordinal**,
not the deterministic pack shortlist or clipped tool result heads. Each eligible
preparation freezes its committed physical-bucket watermark. A durable cursor
records the next ordinal, UTF-8 offset and continuation source digest; its anchor
need not survive. Changed digests restart that record's enumeration. A later
eligible boundary may extend the watermark; rollover never inherits progress.
Each query materializes at most 512 records/4 MiB and each progressive selection
at most 64 spans, inside the cumulative input allowance. Tool interiors use
UTF-8-safe overlapping windows; owner paragraphs are indivisible. Bounded span
enumeration leaves unscanned evidence disclosed, never counted as preserved.
The disabled deterministic-pack query is unchanged. An indivisible owner paragraph
that cannot fit a minimal delta alongside the **actual prior** at this boundary's
headroom is recorded
as an **oversized offer**, never represented. Its cursor advances with **zero
paid calls**, so a pasted log cannot permanently stall later evidence. The gap
remains disclosed. A tool whose arguments exceed the remaining page budget ends
that page as bounded, not as a corrupt/unavailable source.

The host validates the whole delta, exact source IDs, UTF-8 byte spans,
whole-record and span digests, entry bounds and coverage references. Values must
fit **512 raw UTF-8 bytes and 640 JSON-serialized bytes including quotes**; each
model entry must fit **832 JSON-serialized bytes**, and each escaped rendered
derived line must fit **1024 UTF-8 bytes including its newline**. Any excess
rejects the whole completion. Identifier values must occur exactly in cited
evidence and contain only the bare identifier, not an explanatory prefix.
A confirmed action/artifact cannot cite only an owner request. All prose is
**derived interpretation**, never host-owner authority. Cited owner text is
reconstructed as whole paragraphs with qualifications and negations intact.
Historical requests are not renewed approval; absent outcomes remain unknown.

### Delta preservation and conservative relations

A completion proposes only new entries. Prior entries and their citations remain;
source IDs are rebased to stable host identities. Entries have host-assigned
stable IDs, with deterministic source-bound IDs for legacy entries. The aggregate
is capped at **64 entries**. Validation enforces **24 per delta** for request-cap
adapters, **8 for Codex**, and any smaller admitted rendering limit. Admission
chooses the largest usable delta cap, then a fitting prefix of at most **8 × cap**
spans. Only the admitted cap appears in the provider instructions.

Optional relations bind an existing target ID, exact target value/citations and a
distinct proposed successor ID. The host enforces bounded relations and strictly
later source ordinals, not effective-date chronology. These structural checks
**cannot establish same-fact semantic correction**. Prior state is never silently
retired: unestablished relations become conflicted, self-`superseded` proposals
become unknown, and legacy unverified retirement labels receive the same
conservative treatment. Unrelated, hypothetical, quoted and decoy correction
language grants no retirement authority. Interpretation still needs offline audit.

The renderer escapes JSON strings (including `<` and `>`), labels host-owner,
tool and neutral provenance, and labels mixed-source claims explicitly. Adding
an owner citation cannot promote a tool-reported portion into an instruction.
Raw owner evidence is demoted only when every paragraph is cited by an active
entry and quoted exactly. Missing or oversized ledgers leave deterministic
evidence available.

### Shared rendered admission

Admission and the pack renderer use the **same prefix-fit calculation**: prefix
plus 700-token reserve must fit `min(actual headroom, 4000)` tokens. Before paying,
admission reserves the prior rendering, worst-case bounded delta lines and all
potential complete owner quotations. The prior rendering and quote/lineage prefix costs are computed once; bounded
binary prefix probes measure merged metadata without rebuilding the source prompt.
It reduces the delta/selection to fit,
without dropping the prior. If even one addition cannot fit, it makes **zero
calls**, retains the prior ledger and records `ledger_render_budget` as a capacity
gap. A smaller new boundary may still have insufficient headroom to inject that
prior; the ordinary deterministic fallback and headroom diagnostic remain honest.
A full 64-entry aggregate instead reports `ledger_aggregate_capacity`.
Actual merged rendering is checked again before publication; overflow rejects
the delta, not the prior.

Storage is latest-only, additive inside schema v3. Aggregate payload metadata
must fit **128 KiB**, and the union of inherited/new retained source text must fit
**4 MiB**. Quota is also preflighted and rechecked atomically at publication.
There are no retention pins. Selection/admission manifests are separate from the
merged payload manifest; publication checks both, the owner fence, parent CAS,
prior-entry preservation and inherited input links. The payload reservation
serializes the actual merged shape at validator maxima, including inherited
coverage, stable remapped citations, host IDs and the separate selection manifest.
Host IDs remain available in the model's prior metadata, not in rendered lines,
so upgrading a nearly-full legacy ledger does not add per-entry rendering cost.
A failed validation or
publication never advances representation.

### Offered is not represented

The fenced dispatch transaction durably records offers and advances the cursor.
A pending or unacknowledged result is not representation. Invalid operations keep
failed offers suppressed. Valid uncited spans become terminal **analyzed**: they
remain disclosed but are neither represented nor purchased at idle boundaries.
Only a response that **saturates the admitted entry cap** may leave uncited spans
re-offerable, **once**. Transient `publish_cas`/`publish_cancelled` failures also
allow at most one re-offer; quota/bounds failures become failed immediately.
Fresh evidence takes priority over that single deferred opportunity. Successful publication alone
associates entry-cited spans with the latest ledger. Analysis-only `covered`
claims do not establish representation in either profile. Unknown batches are
not resubmitted; unresolved dispatch conservatively blocks the scope.

Deleting, tombstoning or changing **any** contributing source invalidates the
latest ledger and its representation associations in the same transaction.
Surviving successful sources become unrepresented and eligible for bounded
reconstruction. Failed/uncertain offers remain suppressed. Deleted cursor
anchors do not block keyset progress. A retention tombstone never rewinds the
cursor: only its own continuation digest/offset can be reset. Explicit reset/delete
clears scoped progress and rotates admission; retention does not renew bootstrap.

Local safety limits remain 65536 offers, 16384 operations and a 32MiB journal
reservation per logical/physical scope. In addition, **operations, offers and
progress bytes count against the shared retention `maxBytes`**, including UTF-8
metadata and row overhead. Normal cleanup keeps the recent 64-operation tail;
quota pressure retires inactive terminal working sets in **least-recently-used
scope order** before evicting source text. Active/pending and uncertain work is
not reclaimed. A content-free ordinal floor keeps retired evidence from being
purchased again even if representation is later invalidated; retired coverage is
reported as a gap, not as representation. Partial-record retirement can leave an
unscanned remainder disclosed. This is not an indefinite accounting archive.

Bootstrap/identity rows are never reclaimed (UUID operation IDs in normal use,
4096-code-unit scope identifiers and the bounded reservation ID at the hard limit).
A native scope has at most one unresolved purchase: at most a 128KiB reservation,
16KiB receipt and 256 offer rows (64 in the production selection path). All such
unknown rows remain protected and charged. Compact retirement floors are also
charged. If protected state alone fills the quota, admission stops without buying
more work. Lineage/render/payload/aggregate saturation likewise reports a gap;
future checkpoint work owns that limitation.

In scopes with P3b2 progress, purge/tombstone transactions erase source digests
and span fingerprints. They scrub **only reservations citing the erased ordinal**,
not unrelated in-flight work. Unknown offers keep opaque identity/state/ordinal
information; bootstrap is not refunded. Source tombstones in those scopes also
lose retained-text digests and attestation copies. P3b1 disabled scopes do not
install progress triggers or alter checkpoint metadata. On first enabled progress
creation, an idempotent migration strips legacy content fingerprints without
blocking terminal scopes; legacy uncertainty remains uncertain. A definite
dispatch rollback reports skipped/non-invoked; lost acknowledgements and owner
post-check failures remain uncertain.

Pending purge intents suppress reuse immediately. No destructive downgrade is
needed, but **older binaries reject merged ledgers above their 24-entry/256-span
read limits** (this version accepts 64/1024). Disable upkeep/ledger reading before
rollback and expect deterministic fallback, not backward-compatible injection of
those aggregates. Pending explicit-reset intents must drain before rollback.

The existing benchmark still buys **one** preparation per trace/repeat. This
production slice does not claim the later multi-child A→R→A preparation proof or
new paid quality results.

Digest/integrity failure emits a content-free `ledger_integrity` warning whenever
the ledger is skipped. There is no auto-repair or paid attempt against corrupt
state. Use the normal session/continuity reset (`ClearSessions`) to remove the
affected state before rebuilding, after preserving any needed diagnostics.

## Measurement boundary

See the [ledger benchmark arm](/runtime/continuity-benchmark/#ledger-first-slice).
This slice provides host receipts and benchmark upkeep accounting, **not** merged
answer/upkeep billing reconciliation, cancellation/restart-complete accounting,
the multi-boundary benchmark protocol, default-on upkeep, or a claim of paid
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
