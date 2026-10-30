# Registered holdout loading and statistics

This is benchmark tooling, not a quality result or permission to execute a study.
Keep corpus, registration, statistical-spec copies and result inputs outside the
checkout. Do not add registration files to the immutable frozen directory.
Existing suites, arm configurations and scoring of legacy suites are unchanged.

## Registered design and power review

Design E is **512 conversations in 32 disjoint families of 16**, half the families
and 256 conversations in each corpus. There are **32 balanced shards of 16**,
eight conversations per corpus, each binding a **$25 ceiling**. This records a
ceiling, not spending authorization or a remotely enforced invoice cap. Use the
[portable workflow](./README.md#portable-execution-and-validated-joining) for
controller admission/accounting.

```bash
node scripts/continuity-holdout-power.mjs --seed 572913 \
  --replications 100000 --output /external/holdout-power
```

The CLI writes deterministic `power.json` and `power.md`, with at least 100,000
replications/scenario. It calls the actual paired-t, wrong-rate and accuracy
gate evaluator. Coherent native/pack/ledger correct/wrong/abstention bundles
include concentrated errors and repeat correlations 0/0.5/0.9. Reports include
joint acceptance and each margin's null-boundary rejection rates, not just
favorable marginal gates. Quality inputs are assumptions, not measurements.
The observed wrong/accuracy point thresholds are not level-5% hypothesis tests.

Optional `--statistical-spec /external/statistical-spec.json` permits an explicitly
reviewed alternative layout. Corpus counts, families, shards and per-shard ceilings
are parameterized, never inferred from completed work. Approved thresholds,
two repeats, 15 probes and audit limits are immutable. A stricter or more lenient
external threshold is rejected. Any layout change requires fresh approval,
freeze and registration, never outcome-dependent extension.

Main power scenarios assume independently sampled conversations conditional on
the fixed family layout. Extra family/concentration sensitivities introduce
residual within-family dependence: these are **not family-cluster calibration**
of conversation-level intervals. Complete data, admission and passing certified
audit are assumed, not measured. Inadequate power/calibration blocks a fresh
registration; it does not justify loosening margins.

## Versioned contracts

The statistical spec, registration, statistics and final report are **v2**.
New tooling rejects v1 registrations with
`incompatible_holdout_registration_version` and v1 statistical specs with
`incompatible_statistical_spec_version`, before interpreting their contents.
There is no migration or silent re-scoring. Historical v1 studies remain
reproducible only from their frozen tooling revision (the last pre-v2 main
revision is `36d8b06ba4ba78539bdcec23383abf41cdc018e1`). Their decisions remain
unchanged; legacy scorer contracts are separate from this statistical version.

## Register the clean, merged tooling and frozen corpus

Use the approved `statistical-spec.json`, copied to a private external file. Exact
bytes are bound by registration; its semantic values must also equal the design
bound into the frozen manifest. All frozen content and current tooling are
verified, requiring a clean tree even for dry/offline loading. Before freezing,
copy the exact checked-in `audit-rubric.json` bytes to the external rubric input.
Run, join, audit and report must all use the same clean revision equal to
`registration.codeRevision`; register only after the complete tooling has merged.

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
registered population. The portable controller workflow must validate/join shard trial
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
Native is a paired safety comparator and subject to the same missing-slot cap.

**Wrong** means `!pass && outcome !== "abstained" && outcome !== "empty"`.
Stale, conflicted, violating, leaked or fabricated answers count as wrong even
when they contain an abstention phrase. Pure abstentions and empty answers are
incorrect but not wrong. Malformed/unknown outcome records are missing/invalid.

For conversation i, `W_i(A) = wrong/30` and `C_i(A) = correct/30`, retaining
both repeats/all probes. Each of these gates is necessary:

| Gate | Each corpus | Combined |
| --- | --- | --- |
| Ledger − pack mean wrong-fraction upper bound | ≤ +0.005 | ≤ +0.005 |
| Ledger − native mean wrong-fraction upper bound | ≤ +0.02 | ≤ +0.02 |
| Observed ledger wrong / planned answers | ≤ 0.02 | ≤ 0.02 |
| Ledger − pack mean correct-fraction lower bound | > 0 | > 0.02 |
| Ledger correct / planned answers | descriptive | ≥ 0.91875 |

Paired bounds are one-sided 95% Student-t on **conversation** fraction
differences: mean ± `t(.95,n−1) * SD / sqrt(n)`. Safety passes at an upper
endpoint exactly equal to its margin, fails when the lower endpoint is above
it, otherwise is inconclusive. Benefit passes strictly above its lower-bound
threshold, fails when its upper endpoint is at/below it, otherwise is
inconclusive. Zero-variance differences have zero radius. These necessary
gates make **no simultaneous-coverage claim**.

Cold-rebuild is **descriptive only**, not a safety gate. Reports retain every
arm's correct/wrong/abstention counts and planned-denominator rates, any-wrong
conversation risks, and both directions of any-wrong discordances. Incomplete
arms expose known counts/missingness, not completed risk estimates.

A pass establishes eligibility **only for the registered reader and extractor
model references**. A Sol-only registration gives Sol-scoped eligibility, not
blanket eligibility for other models and never automatic default enablement.
Final JSON/Markdown reports state the pinned reader/extractor scope explicitly.

Never drop missing, invalid or duplicate planned slots. Registration pins
`missingData.worstCaseCompletion.maximumMissingFractionPerArm = 0.01`: each of
all four arms may have at most 1% missing/invalid slots, combined across corpora.
For E, the integer cap is **153 of 15,360 per arm**; 154 blocks acceptance.
Any unknown/unplanned row also blocks acceptance. The integrity gate passes with
complete data, or within this cap with zero unknowns. Reports retain strict
`integrity.complete`, counts in `missingPerArm`, `withinMissingCap` and `worstCase`.

An incomplete scope has no complete-case inferential interval. It may pass only
when **every possible completion passes**, treating missing ledger answers against
the ledger and missing comparator answers in the comparator's favour:

- Paired wrong comparisons (pack and native): each conversation's feasible
  difference is `[(ledgerWrong − comparatorWrong − comparatorMissing)/30,
  (ledgerWrong + ledgerMissing − comparatorWrong)/30]`. A conservative upper
  bound on **every completion's t upper endpoint** must be ≤ its margin.
  Missing native slots participate just like pack slots.
- Benefit: `completionLowerBound` bounds every possible one-sided t lower endpoint
  conservatively by reflection of `completionUpperBound`. It must exceed the
  registered scope threshold; fixed bounds equal the ordinary paired-t lower bound.
- Wrong rate: `(wrong + ledgerMissing) / plannedAnswers ≤ 0.02` in each scope.
- Accuracy: `correct / plannedAnswers ≥ 0.91875`.

Scopes expose `worstCase` and `worstCompletionLower` without claiming complete-case
confidence intervals. A loose bound can leave the result inconclusive; the cap
alone never promises a pass. **Conservative failure semantics remain**: fail only
when a conservative best-completion bound establishes the same registered failure:

- Wrong rate: observed ledger wrongs / planned denominator already >2%.
- Accuracy: even `(correct + missing ledger slots) / planned` is below 91.875%.
- Paired wrong comparisons: a conservative lower bound on **every completion's
  t lower endpoint** must exceed the comparator's margin to establish failure.
  Reflection of `completionUpperBound` supplies this bound, not endpoint filling.
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
cannot undo them. No incomplete data is presented as a complete-case confidence
estimate. Power simulations still condition on complete data and do not model missing-slot tolerance.

## Bound audit input

Optional `--audit /external/audit.json` supplies **diagnostic, noncertifying** totals:
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
The claimed `published` total must cover the entire final unique-entry population,
not just its audited subset. Known violations of that fixed denominator fail even
when auditing is incomplete. Missing/incomplete audit material never passes.
Neither standalone aggregation nor a join can certify these claims. Only the
[mechanical and two-auditor workflow](./README.md#mechanical-audit-blinded-review-and-final-report)
reconstructs the population, validates blinded responses/adjudication and permits
a final certified report to remove the pending gate. A bare totals file never does.
