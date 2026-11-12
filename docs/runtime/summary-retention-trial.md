---
title: "Fictional summary-retention qualification"
description: "Separate offline compaction carriage checks from an explicitly funded, one-shot fictional summary trial."
---

The trial in `scripts/summary-retention-trial.mjs` tests summary-specific retention,
not retrieval quality. It never loads E2 questions, answer keys, registrations or
private conversations, and does not change the E2 protocol. Fixtures and assertions
are frozen together by `scripts/fixtures/summary-retention/manifest.json`.

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
credit, plus the shipping policy's bounded requested output allowance (including
reasoning). A dispatch is refused if reservations plus accounted spend would
exceed the shared cap. Completed usage is accounted conservatively afterwards;
unknown outcomes retain their reservation and stop. There are no retries, resume,
fallback routes or attempts to rerun failures to green.

**Codex does not enforce the requested output ceiling.** This is explicitly
recorded in the output. The cap stops further dispatches; it cannot interrupt an
already sent request or guarantee that request's bill. Missing usage, provider
failure, truncation, oversize input or accounting beyond the cap stops the trial.
The script does not weaken the separate E2 controller's stricter route/funding
rules.

## Scoring and limits

Each checkpoint reports every introduced tuple separately. All semicolon-separated
reference fields must appear together on one summary line, with case/whitespace
normalization. The trial asks the model to retain these compact tuple lines for
objective, conservative scoring. Wrong predecessor/current values, missing pending
states and missing tuples fail. Fixture-specific checks reject introduced dates,
invented record/owner-attestation claims and promotion of the planted hypothetical
correction/approval. Quoted or negated warnings are not permission.

**Pass:** all 48 checkpoints per model retain every introduced tuple and all
fixture-specific authority/provenance checks pass. A pack or retrieval match never
substitutes for a summary assertion. Nonzero exit status means failure or a stopped
trial; partial checkpoints remain in the output. An offline dry run is labelled
`dry-run`, never a semantic pass.

These deterministic literal checks are intentionally stricter than paraphrase and
are not a general natural-language semantic/provenance verifier: passing qualifies
only this frozen fictional inventory and policy, not arbitrary models or histories.
The offline tests include retaining and lossy controls through initial, update,
split, persistence and cold-pack paths. Once a controlled summary and retained tail
omit a fact, the next request is checked to lack it; no fixture oracle repairs loss.
Ledger defaults, privacy/redaction, token ceilings and archive-lineage verification
remain unchanged.
