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
There is no fallback model. `ledgerEnabled: true` permits read-only reuse without
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
- At most 64,000 estimated selected-input tokens including instructions, prior
  interpretation and span metadata, with a conservative estimate margin. Reported
  input usage including cached input is also checked before publication.
- 4,096 output tokens **including reasoning**, with lowest supported effort.
- One 60-second deadline, combined with caller cancellation.

Nine supported adapters send an inclusive request cap (Anthropic, OpenAI
completions/Responses, Azure Responses, Google, Vertex, Bedrock, Mistral and Pi):
receipts say `capEnforcement: "request"`. The installed Codex Responses adapter
omits that request field. Its default policy is `"stream_abort"`: count streamed
text/thinking conservatively and abort when the visible estimate reaches 4,096.
For Codex, the request asks for at most eight entries with values at most 96
UTF-8 bytes and at most 3,072 serialized JSON bytes. `covered: N` compactly means
the first N supplied span IDs were analyzed. Reasoning summaries are omitted from
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
whole-record and span digests, entry bounds and coverage references. Identifier
values must occur exactly in cited evidence. A confirmed action/artifact cannot
cite only an owner request. Invalid output publishes nothing. All model prose is
**derived interpretation**, never host-owner authority. Cited host-owner text is
reconstructed as whole original paragraphs with qualifications/negations intact.
Historical requests are not renewed approval; absent outcomes remain unknown.

The renderer quotes escaped JSON strings (`<` and `>` are escaped), labels each
source as `owner:sN`, `tool:<name>:sN` or neutral evidence, and explicitly labels
tool-only constraint/decision/supersession interpretations as untrusted
source-reported claims, not owner instructions. It prefixes a bounded verified
ledger and demotes a raw owner record **only when every paragraph is cited by an
active entry and quoted byte-for-byte**; it does not delete owners on the model's assertion of coverage. An
oversized/absent ledger leaves the deterministic fallback intact. Optional input
still respects the target compaction trigger and current-input/output reserves.

Storage is latest-only, additive inside schema v3. Serialized generation payloads (including the inherited input manifest) share
the retained byte budget. Auxiliary SQLite lineage rows/index/file overhead are
not separately charged; this is not a physical SQLite-file quota. The 128 KiB
payload limit bounds lineage instead of promising an unreachable input count.
Worst-case escaped payload growth is checked **before** completion; if it cannot
fit, `ledger_payload_budget` skips without buying a call; publication cannot evict source evidence to
make itself fit. Parent/source compare-and-swap prevents stale publication.
Inherited input links invalidate descendants when **any** contributing ancestor
source is deleted, tombstoned or changed, including a pre-ledger binary's normal
B1 purge. Quota-retention tombstones likewise invalidate dependent generations;
this slice introduces no checkpoint source leases. Pending purge intents suppress reuse immediately. Old binaries ignore
the additive tables; no destructive migration is required for rollback.

Identical failed/aborted selections are negatively cached in-process for the
configured completion binding and physical/logical conversation, keyed by source
manifest and prior generation. Subsequent boundaries emit
`upkeep_repeat_suppressed` without paying again until selection, prior or model
binding changes. The cache is not durable; process/configuration restart clears
it. Fully analyzed selected spans skip as `already_covered`.

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
