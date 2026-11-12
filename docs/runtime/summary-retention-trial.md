---
title: "Fictional summary-retention qualification"
description: "Separate offline compaction carriage checks from an explicitly funded, one-shot fictional summary trial."
---

The trial in `scripts/summary-retention-trial.mjs` tests summary-specific retention,
not retrieval quality. It never loads E2 questions, answer keys, registrations or
private conversations, and does not change the E2 protocol. The SHA-256 digest in
`scripts/fixtures/summary-retention/manifest.json` freezes only the bytes of
`conversations.json` in that directory. The manifest's v1 assertion text is
descriptive, not covered by that digest; the v2 assertion policy lives in
`scripts/lib/summary-retention-trial.mjs`. V2 leaves the fixture bytes unchanged.

## Native historical preservation boundary

Native incremental compaction parses historical tuple line blocks, including
indented/fenced continuations and split sections. Heading matching is
case-insensitive, with optional bold/colon formatting. Comparison trims trailing
whitespace per line, but performs no fuzzy semantic matching. Ordinary horizontal
rules are content; only the existing split separator ends a section at a rule.
File metadata and headings inside fenced code do not introduce sections.
Placeholders such as `- (none)` are not protected. Unclosed fences and headings
with no admissible tuples produce `protectionUnavailable` plus a content-free
reason, then use ordinary unprotected compaction.

Prior tuple bytes are JSON-escaped in `<protected-historical-tuples>`, after the
previous-summary frame and before task instructions. Protected tuples are immutable;
resolutions and state changes must be NEW top-level historical events, not edits
or indented additions to old tuples. **Sticky injection risk:** preserving an
admitted mistake or malicious instruction also re-exposes it on later requests,
including raw previous-summary prose. Named framing and escaping do not establish
trust or remove this risk. Historical evidence never grants authority.

When protected tuples exist, `B = effectivePolicy.summaryMaxTokens` bounds the
shipping `estimateTokens` of the provider-projected complete summary (wrapper,
reused history, split separator and file metadata included), plus the 1-MiB text
bound. Known composition is reserved before allocating the history:prefix targets;
provider caps use `floor(target * 0.85)` to leave estimate margin. Provider
reasoning/headroom policy stays separate. The first split output is checked before
the second call, then the complete candidate is checked. With zero protected
tuples, legacy caps/output acceptance and savings guards remain unchanged.

Liveness takes precedence over preservation. If protected history plus
`min(256, floor(B/4))` cannot fit, compaction bypasses protection before dispatch
on every trigger; the request contains no protected frame and uses legacy caps.
If that frame alone exhausts input headroom, it is removed before any provider
call and legacy policy is rechecked (`protected_input_unfits`). For missing tuples
or an oversized protected result after dispatch, proactive/mid-run threshold cuts
return `summary_refused` and keep history unchanged; the next trigger may retry
without a failure cooldown. Manual and reactive-overflow recovery bypass the guard
and reuse the generated output through legacy composition. No replacement summary
is purchased: ordinary compaction still uses one request, split compaction at most
two; refusal after the first split output uses only one. A bypass does not override
legacy provider failures, truncation or savings checks.

`historical_preservation_bypassed` is a content-free warning with reason and
remediation: raise `summaryMaxTokens` or start a new session to restore protection.
Manual compaction can recover a refused automatic cut. `accounting.preservation`
appears only for protected or unavailable history and records sizes/counts,
missing counts, refusal/bypass reason and complete final-summary bytes/estimate
(null before a complete candidate). No host repair, eviction, carrier or extra
completion is added. Provider usage/cost and `generatedSummaryTokens` retain their
existing meanings. Accepted text and existing E2 lineage/archive schemas are
unchanged. Frozen projection accounting without historical tuples gains no new
key; reviewed immutable-event prompt text is pinned separately.

This guard cannot protect initial extraction, first cold re-extraction without
native `previousSummary`, sanitization omissions or a separately generated handoff.
Inherited-prefix admission follows legacy producer viability: any infeasible
native protection at the actual cut bypasses rather than creating a dead end.
Retained digests may differ from native digests; cold input contains only sanitized
retained text and cannot restore removed values.

## Offline preparation

Build the shipping implementation, then size it without credentials or network:

```sh
pnpm --filter '@mono-agent/conversation...' run build
node scripts/summary-retention-trial.mjs --dry-run
node scripts/summary-retention-trial.mjs --dry-run --models sol,luna
```

The default is the E2 Sol checkpoint model (`openai-codex:gpt-6.1-sol`) and the
shipping real-summary policy at low effort. `--model provider:id` or
`--models sol,luna` overrides the selection; `--effort` overrides summary effort.
Resolved catalog identity, identity digest, rates (including tiers) and effective
effort are frozen in the output. Each model gets the complete independent matrix;
a list shares one spend cap, not one budget per model.

The observatory, theatre and coastal-survey conversations each have 12 required
tuples: four historical events, two reported decisions, three correction chains,
two pending items and one resolved obligation. Their compact reference inventories
are each at most 2,400 UTF-8 bytes. Quoted/hypothetical corrections, proposals and
repetitive progress are distractors, not authorization.

Per model the matrix is three fixtures × two text caps (2,000/4,000 tokens) × two
repetitions: 12 chains, four successive compactions each, one split turn, three
cold reseeds, 60 summary requests and 48 checkpoints. The shipping compaction kit
chooses cuts; the runtime's preparation, split reserve division and summary policy
add focus, evidence and reasoning allowance. Summaries are read back unchanged
from durable native checkpoints. A shipping continuity-pack renderer carries only
that checkpoint's summary into the next cold journal; it never backfills original
facts. This isolates summary carriage, not full sidecar publication/recovery.
No source/answer completions are purchased.

The focused offline integration lane (`runTrialChain` with `coldReseeds: "host"`)
additionally takes each generated checkpoint through real owned native checkpoint
preparation/publication, the durable history store and continuity participant,
the harness pack supplier and `runtime-execution.ts` cold hook, a faux-provider
runtime seed, and host/runtime restart. It inspects persisted native seed messages
and separate raw/retained identities, including fictional redaction. Its publication
fixture injects the already generated summary at the engine's compaction hook;
it does not purchase another summary. Direct rendered-pack text reseeds and
no-cold native chains remain isolation/negative controls, not host-path proof.
The default sizing/paid matrix remains the text-only lane above; frozen facts,
scorer assertions, tuple inventories and spending policy are unchanged.

The dry run uses retaining controls derived only from each actual request. It
reports per-model/combined request counts, measured serialized-context bytes,
requested output allowance and cache-free catalog estimates. It also reports the
64-KiB-per-request matrix bound. Real summaries will change later input sizes:
the measured estimate is not a fixed quote. Every actual request is checked against
the same 64-KiB serialized-context limit before dispatch.

## Separately authorized model trial

Do not treat building or sizing this script as permission to run it. After separate
funding approval, use a new output path (an existing file is refused):

```sh
node scripts/summary-retention-trial.mjs --confirm --spend-cap-usd 12 \
  --models sol --effort low --output NEW-trial.json \
  --credential-file /path/to/authorized-auth.json
```

Other built-in providers can use their normal environment credentials. The
optional credential file is read only in confirmed paid mode; refreshes stay in an
in-memory credential store and do not rewrite that file. Never publish credentials
or provider exception text. Output contains only frozen fictional requests/results
and accounting. Keep trial outputs out of source control.

Before each dispatch, the script durably writes a conservative reservation at the
maximum frozen catalog rates: one input token per serialized UTF-8 byte, no cache
credit, plus the shipping policy's full `providerMaxTokens` output allowance
(including legacy-adapter thinking added at dispatch). Reported output allowances
and matrix bounds use this provider ceiling; dispatch options stay unchanged so
thinking is not added twice. A dispatch is refused if reservations plus accounted
spend would exceed the shared cap. Completed usage is accounted conservatively afterwards;
unknown outcomes retain their reservation and stop. Returned error/abort responses
with zero-filled or absent usage are published as `unknown_outcome`, never settled
as free requests. There are no retries, resume, fallback routes or attempts to
rerun failures to green.

**Codex does not enforce the requested output ceiling.** This is explicitly
recorded in the output. The cap stops further dispatches; it cannot interrupt an
already sent request or guarantee that request's bill. Missing usage, provider
failure, truncation, oversize input or accounting beyond the cap stops the trial.
The script does not weaken the separate E2 controller's stricter route/funding
rules.

## Scoring and limits

Reports and checkpoints carry `scorerVersion: 2`. This assertion revision was
written from the frozen public fixtures and the shipping historical-summary
contract before any rerun, without inspecting private trial outputs. V1 required
whole semicolon-delimited fields, rejecting the shipping contract's equivalent
`subject; mN; value; correction; current interpretation; state` format. It also
mistook qualified warnings and supplied cold-pack references for inventions.
V2 changes the assertions, not the fixture facts, request focus, product prompts,
token caps or spending policy. The original manifest digest remains unchanged;
`assertionPolicy` in new/rescored reports describes v2 rather than the manifest's
historical v1 policy.

Each checkpoint reports every introduced tuple separately. Values match as whole
tokens (`16` is not `160`, `C9` is not `C90`), with case/whitespace and inline
Markdown normalization. A subject and its values/relationships must occur on one
line or in its immediately indented continuation block, never in an unrelated bag
of lines. `tupleAssertion` derives declarative roles from the frozen `kind` and
`fields` metadata:

| Kind | Required roles and relationships |
| --- | --- |
| Historical | Subject, supplied date and positive event outcome |
| Decision | Subject, reported decision, selected option and rejected alternative when supplied |
| Correction | Subject, predecessor marked previous/earlier, and a correction/replacement to the current value; explicit current slots must agree |
| Pending | Subject, named actor assigned the action, pending/unresolved state, and no approval or not-done constraint |
| Resolved | Subject, named payer, supplied date, resolved state and no-repeat-payment constraint |

Literal fixture lines, shipping tuples with `mN` positions and prose such as
`crate count, previously 18, now 16` are equivalent. A missing correction, swapped
predecessor/current, contradictory current value or missing/contradictory state
still fails. The grammar is bounded and fixture-specific, not unrestricted
natural-language equivalence.

Promotion checks consider positive claims clause by clause. Negations and
qualifications such as unestablished, unresolved, absent, only proposed, quoted
and hypothetical do not confer authority. A warning in a different clause cannot
hide `approval granted for PHANTOM-77` or a claim that `Z0` is current.
`chr1_` IDs, SHA-256 digests and explicit `record id:`/`record reference:` values
are accepted only if supplied in that chain's actual request contexts up through
that checkpoint, including cold-pack text. References from another chain or a
future checkpoint do not count. Record IDs retain case-sensitive identity; hex
digests are case-insensitive. `attested by` and `verified owner` claims remain
failures even when a referenced identifier was supplied. This is an input-membership
check, not cryptographic attestation of model statements.

The pre-declared test controls cover all three fixtures in literal, shipping and
prose forms at every checkpoint. Negative controls cover swapped values, missing
corrections, value extensions, predecessor-as-current, dropped pending states,
resolved-as-pending, selected/rejected reversal, invented provenance and positive
authority/hypothetical promotions. Supplied-provenance controls exercise both
isolated scoring and the real cold-pack request path.

## Offline rescore

Rescore an existing report without loading models, built runtime modules,
credentials or network:

```sh
node scripts/lib/summary-retention-trial.mjs --rescore trial.json > NEW-rescored.json
```

The source file is not modified. The command validates the frozen fixture digest
and requires each checkpoint's saved request inputs. It writes the updated report
to stdout, preserving summaries, requests and spending/accounting, and records
`rescoredFromVersion` (v1 when absent). Completed `pass`/`fail` statuses are
recomputed; `dry-run` and `stopped` labels remain unchanged, including partial
progress. Any failed chain or checkpoint exits nonzero after writing the report,
including failures under a `dry-run` label. Stopped or incomplete statuses and
partial progress also exit nonzero, even when completed checkpoints pass. Empty
chain/checkpoint lists and malformed or missing inputs are refused with an offline
diagnostic reason. Rescoring never dispatches or resumes a trial.

**Pass:** all 48 checkpoints per model retain every introduced tuple and all
fixture-specific authority/provenance checks pass. A pack or retrieval match never
substitutes for a summary assertion. Nonzero exit status means failure or a stopped
trial; partial checkpoints remain in the output. An offline dry run is labelled
`dry-run`, never a semantic pass.

These deterministic checks qualify only this frozen fictional inventory and
policy, not arbitrary models or histories. The offline tests include retaining
and lossy controls through initial, update, split, persistence and cold-pack paths.
Once a controlled summary and retained tail omit a fact, the next request is
checked to lack it; no fixture oracle repairs loss. Ledger defaults,
privacy/redaction, token ceilings and archive-lineage verification remain unchanged.
