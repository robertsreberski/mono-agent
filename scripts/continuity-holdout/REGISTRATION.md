# Registered holdout loading and statistics

This is benchmark tooling, not a quality result or permission to execute a study.
Keep corpus, registration, statistical-spec copies and result inputs outside the
checkout. Do not add registration files to the immutable frozen directory.
Existing suites, arm configurations and scoring of legacy suites are unchanged.

## Registered design and power review

Design E is **512 conversations in 256 disjoint families of 2**, half the families
and 128 families / 256 conversations in each corpus. There are **32 balanced shards of 16**,
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
joint acceptance and each margin's null-boundary rejection rates/Monte Carlo SE, not just
favorable marginal gates. Quality inputs are assumptions, not measurements.
The observed wrong/accuracy point thresholds are not level-5% hypothesis tests.
Optional `--scenario <exact-scenario-name>` runs one named sensitivity only;
such output is not a full-design calibration report. A target-only selection
has no null calibration claim (`calibrationPass: null`).

Optional `--statistical-spec /external/statistical-spec.json` permits an explicitly
reviewed alternative layout. Corpus counts, families, shards and per-shard ceilings
are parameterized, never inferred from completed work. Approved thresholds,
two repeats, 15 probes and audit limits are immutable. A stricter or more lenient
external threshold is rejected. Any layout change requires fresh approval,
freeze and registration, never outcome-dependent extension.

Main power scenarios draw fresh Dirichlet family arm-mixture random effects
with exact superpopulation means and target paired-difference ICC, including
0/0.1/0.2/0.35 × conditional repeat copying 0/0.5/0.9. A right-skewed effect
variant is included. Bundle-reuse stress is reported with P(no bad family),
not calibration-gated. Every non-stress **confidence-bound gate/scope** boundary pass rate must be
≤5.5%; observed-wrong and accuracy point rules are excluded.
The simulator reports maxima and realized ICC/design-effect/skew diagnostics.
Complete data, admission and passing certified audit are assumed, not measured. Inadequate power/calibration blocks a fresh
registration; it does not justify loosening margins.

## Versioned contracts

The statistical spec, registration, statistics and final report are **v2**.
New tooling rejects v1 registrations with
`incompatible_holdout_registration_version` and v1 statistical specs with
`incompatible_statistical_spec_version`, before interpreting their contents.
There is no migration or silent re-scoring. The earlier all-95% v2 semantic
spec is also rejected as `unregistered_statistical_spec`; per-gate confidence
levels are pinned and require fresh registration. Historical v1 studies remain
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
before dispatch. Registration checks the exact 256 × 2 selected family layout;
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
family-clustered safety/benefit, planned denominators, audit rates and decision
reasons. Markdown/CLI guard offline output as well. Design E has **7,680 planned
answers per corpus/arm, 15,360 combined**. Both repeats/all probes stay together.
Native is a paired safety comparator and subject to the same missing-slot cap.

**Wrong** means `!pass && !pureAbstention(answer)`, using the archived raw answer
text for every arm, not the scorer's broad `abstained`/`empty` label or flag.
Correct answers are unaffected. Empty/whitespace strings are pure abstentions.
Otherwise purity requires the **whole answer** to be one of these expressions:
`UNKNOWN`; `I don't know`, `I dont know` or `I do not know`;
`not stated/mentioned/specified/provided/known/available/applicable`;
`N/A`, `N.A.` or `NA` (optional internal spaces).
Case/whitespace, Unicode apostrophes and surrounding punctuation are normalized;
additional substantive content never qualifies. Missing/non-string answer text
is **not pure** (fail closed: a completed non-pass counts wrong).
Hedged errors and incomplete substantive answers therefore count wrong even
when the unchanged v1/v2 scorer labels them `abstained`.
Malformed/unknown outcome records are still missing/invalid, not completed misses.

For conversation i, `W_i(A) = wrong/30` and `C_i(A) = correct/30`, retaining
both repeats/all probes. Each of these gates is necessary:

| Gate | Each corpus | Combined |
| --- | --- | --- |
| Ledger − pack mean wrong-fraction upper bound | ≤ +0.005 | ≤ +0.005 |
| Ledger − native mean wrong-fraction upper bound | ≤ +0.02 | ≤ +0.02 |
| Observed ledger wrong / planned answers | ≤ 0.02 | ≤ 0.02 |
| Ledger − pack mean correct-fraction lower bound | > 0 | > 0.02 |
| Ledger correct / planned answers | descriptive | ≥ 0.91875 |

Bounds are **family-clustered (families as sampled scenario types),
conversation-paired**. Each family mean averages its registered conversation
fraction differences. G=128 per corpus; **combined pools all 256 families**, not
corpus-stratified. Let θ be the mean of family means, SE=sd(family means)/√G,
t=t(q,G−1) for that gate’s pinned confidence q, and γ their adjusted
Fisher-Pearson sample skewness:
`G/((G−1)(G−2)) * sum(((familyMean−θ)/sd)^3)` (zero when SE=0;
G=2 mechanics fixtures use zero, G<2 cannot pass an interval gate).

- Upper U = θ + SE·max(t, t + γ(1+2t²)/(6√G)).
- Lower L = θ − SE·max(t, t − γ(1+2t²)/(6√G)).

One-sided confidence is **pack 97%, native 95%, benefit 95%**, pinned in
`confidenceByGate`; there is no single global study confidence level.
The same gate-specific t enters both the base and skew terms, including the
missing-completion envelope. Pack's tiny +0.5 pp margin and lumpy errors made
95% anti-conservative in calibration; 97% was approved after exploration.
This does not change the numerical margins or claim simultaneous coverage.
Reports/Markdown identify each confidence-bound gate's level; point rules have
no confidence level.

This Johnson/Hesterberg second-order skew adjustment is **tighten-only**;
negative skew on U and positive skew on L use plain t. For balanced families
the base t bound equals the family-clustered CR2/Bell–McCaffrey bound. Reports
include G, θ, SE, γ, each applied adjustment, realized one-way ANOVA family ICC
and design effect `1+(conversationsPerFamily−1)*ICC` for each paired estimand.
These diagnostics are null for incomplete pairs; zero variance has ICC=0.

Conversation-seeded shard assignment is unchanged: a family's two conversations
**may share or cross shards**. Joining reconstructs whole registered families
before inference, so shard placement never defines the inferential clusters.

 Safety passes at an upper
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
  (ledgerWrong + ledgerMissing − comparatorWrong)/30]`. Average these bounds
  within each family, then apply the conservative family envelope below.
- Benefit: analogous feasible correct differences are averaged within families.
  A lower envelope for every possible skew-adjusted L must exceed the threshold.
- Completion proof: for family means in [lo,hi], θ lies between mean(lo) and
  mean(hi); centered SS is at most `sum(max(lo²,hi²))−min(sum(x)²)/G`.
  Standardized centered z satisfy `sum(z²)=G−1` and
  `abs(sum(z³)) ≤ (sum(z²))^(3/2)`, hence
  `abs(γ) ≤ G*sqrt(G−1)/(G−2)`. Use this maximum skew with the maximal SE
  in both radii; mean(lo) minus that radius and mean(hi) plus it enclose
  **every completion's L and U**. Fixed bounds use the actual skew procedure.
  This is deliberately coarse, never an endpoint-fill or monotonic-skew claim.
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
  The family envelope supplies this bound, not endpoint filling.
- Benefit: the family envelope's upper endpoint must be ≤ the threshold to
  establish failure. No missing completion can then undo that failure.

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
