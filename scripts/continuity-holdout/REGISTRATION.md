# Registered holdout loading and statistics

This is benchmark tooling, not a quality result or permission to execute a study.
Keep corpus, registration, statistical-spec copies and result inputs outside the
checkout. Do not add registration files to the immutable frozen directory.
Existing suites, arm configurations and scoring of legacy suites are unchanged.

## Registered design and power review

Design E is **512 conversations in 32 disjoint families of 16**, half the families
and 256 conversations in each corpus. There are **32 balanced shards of 16**,
eight conversations per corpus, each binding a **$25 ceiling**. This records a
ceiling, not spending authorization or a remotely enforced invoice cap; controller
admission/accounting belongs to the subsequent workflow.

```bash
node scripts/continuity-holdout-power.mjs --seed 572913 \
  --replications 100000 --output .worklab-tmp/holdout-power
```

The CLI writes deterministic `power.json` and `power.md`, exact safety enumeration
and at least 100,000 replications/scenario. It and the real scorer share CP count
cuts, paired-t confidence endpoints, wrong-rate and accuracy gate helpers.
Optional `--statistical-spec /external/statistical-spec.json` permits an explicitly
reviewed alternative design. Layout, corpus counts, shards and per-shard ceilings are parameterized, never
inferred from completed work; malformed layouts are rejected. All approved gate
thresholds and audit limits are pinned exactly to the checked-in specification;
a more lenient or stricter external gate specification is rejected. The v1 two-repeat, 15-probe and comparator/model policies stay fixed.
Any layout change requires fresh approval/freeze/registration; a gate change also
requires an explicitly reviewed tooling/spec update, never
an outcome-dependent extension.

Power assumptions are disclosed, including shared comparator harmful events,
repeat/family dependence, fixed ledger accuracy and passing integrity/audit.
The configured accuracy floor is evaluated. Family scenarios introduce residual
within-family dependence: these are sensitivities, **not family-cluster calibration**
of the conversation-level intervals. Power is not model-quality or audit evidence.

## Register the clean, merged tooling and frozen corpus

Use the approved `statistical-spec.json`, copied to a private external file. Exact
bytes are bound by registration; its semantic values must also equal the design
bound into the frozen manifest. All frozen content and current tooling are
verified, requiring a clean tree even for dry/offline loading.

```bash
node scripts/continuity-holdout-register.mjs \
  --corpus-manifest /external/frozen/manifest.json --manifest-sha256 <pinned-sha> \
  --statistical-spec /external/statistical-spec.json --seed 76123 \
  --reader <reader-ref> --extractor <extractor-ref> --alternate <alternate-ref> \
  --output /external/registration
node scripts/continuity-benchmark.mjs --dry-run --suite holdout \
  --corpus-manifest /external/frozen/manifest.json --manifest-sha256 <pinned-sha> \
  --registration /external/registration/registration.json \
  --registration-sha256 <registered-sha> \
  --statistical-spec /external/statistical-spec.json --shard 1 \
  --reader <reader-ref> --extraction-model <extractor-ref> \
  --alternate <alternate-ref> --no-judge
```

Pin the returned registration digest independently. Seeded no-replacement
shuffling of sorted identities binds every conversation/family and shard,
manifest/rubric/statistical-spec hashes, models, low reader effort, no judge,
code revision and per-shard ceiling. Plan confirmation binds these inputs and
the selected shard. Changing an input refuses loading or changes confirmation
before dispatch. Registration checks the exact 32 × 16 selected family layout;
author-format/schema validity alone is not corpus acceptance.

Each shard requires all four arms, two repeats and 15 probes (1,920 reader turns).
`--repeat` is refused for shards. `--trace` can select registered conversation
chunks; absent work stays missing. Paid mode requires a shard and existing
confirmation/credential/output checks. Runtime outputs must be external.

For offline proofs, omit `--shard` and use reduced `--repeats`/`--probe-limit`.
Real-mode holdout execution rejects `fixture:*`/`faux:*` reader, extractor or
alternate model references before dispatch; mechanics registration still allows
them. **All non-real/scripted analyses are forced inconclusive with `not_a_measurement`,
even when synthetic data would mathematically pass or fail.** Every per-scope
safety, benefit and wrong-rate status is `not_a_measurement`, while raw counts and
intervals remain diagnostic. The pure API also
defaults to non-measurement; only validated real records justify opting in.
Per-shard results cannot pass the study: denominators always cover the complete
registered population. The subsequent controller must validate/join shard trial
units before calling `holdoutStatistics`; completed observations in partial units
remain evidence, not discarded. Incomplete units never count as complete coverage. Exact `not_started` placeholders
are reported as `integrity.notStartedPlaceholders`, not unknown trials; their
absent planned slots remain missing. Pass/outcome mismatches invalidate a slot:
only outcome `correct` may have `pass: true`, and it must have it.

## Gate semantics and missing data

`results.json` retains descriptive per-probe results and adds `summary.holdout`:
conversation-level safety/benefit, planned denominators, audit rates and decision
reasons. Markdown/CLI guard offline output as well. Design E has **7,680 planned
answers per corpus/arm, 15,360 combined**. Both repeats/all probes stay together.
Native coverage is required although native is not a safety comparator.

**Wrong** means `!pass && outcome !== "abstained" && outcome !== "empty"`.
Stale, conflicted, violating, leaked or fabricated answers count as wrong even
when they contain an abstention phrase. Pure abstentions and empty answers are
incorrect but not wrong. Malformed/unknown outcome records are missing/invalid.

Complete safety passes with CP upper ≤5%, fails only with CP lower >5%, and is
otherwise inconclusive. Counts derive from n: E allows at most **6/256 per corpus**
and **17/512 combined** to pass. A count just above a passing cutoff is **not**
a failure unless the lower bound establishes it. Complete benefit passes when
its t lower endpoint exceeds the threshold, fails when its upper endpoint is
at or below the threshold, and otherwise is inconclusive. Bounds are one-sided
95%; intersection-union gates do not claim simultaneous 95% interval coverage.

Missing, invalid, duplicate or unknown slots can never produce acceptance. An
incomplete scope has no complete-case inferential interval. It fails only when
a conservative bound proves that **every completion fails by the same registered
semantics**, otherwise it is inconclusive:

- Wrong rate: observed ledger wrongs / planned denominator already >0.5%.
- Accuracy: even `(correct + missing ledger slots) / planned` is below 91.875%.
- Safety: CP lower bound for **known harmful** conversations on planned n >5%.
  A comparator with missing slots cannot establish that it made no wrong answers.
- Benefit: bound every conversation difference by its possible correct fractions
  in [−1,1]. A conservative upper bound on **every completion's t upper endpoint**
  must be ≤ the threshold to establish failure. The bound combines the maximal
  possible mean with an upper bound on centered squared variation, with numerical
  padding; fixed differences use the actual t upper endpoint. This relaxation can
  be loose and may conservatively leave a case inconclusive. Filling missing
  differences with +1 does **not** maximize a t lower endpoint: for 127 differences
  of 0.0201 and one missing, +1 makes the lower endpoint below 0.02, while 0.0201
  keeps it above 0.02. Neither that shortcut nor 'cannot pass means fail' is used.

Point-threshold and audit failures remain failures when missing execution data
cannot undo them. No incomplete data is presented as a confidence estimate.

## Bound audit input

Optional `--audit /external/audit.json` supplies PR3's trusted unique-entry totals:
`published`, `audited`, `labelFindings`, `contextFindings`,
`falselySupersededCurrent`, `bindingErrors`, `complete: true`, and
**`registrationSha256`** equal to the pinned registration digest. A missing or
mismatched digest is rejected. `summary.holdout.auditBinding` records the SHA-256
of the **exact file bytes** and its claimed registration digest, so whitespace
changes too are visible. This post-execution receipt is not part of the
pre-execution plan confirmation.

Counts are nonnegative integers; `audited` equals positive `published`. Unique
published-entry rates use exact cross multiplication at the configured limits
(E retains 10/363 and 5/363 and zero provenance/false-supersession findings).
The trusted `published` total must cover the entire final unique-entry population,
not just its audited subset. Known violations of that fixed denominator fail even
when auditing is incomplete. Missing/incomplete audit material never passes. Deduplication, source verification
and export collection remain the subsequent controller/audit workflow's job.
