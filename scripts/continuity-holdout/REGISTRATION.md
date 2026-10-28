# Registered holdout loading and statistics

This is benchmark tooling, not a quality result or permission to execute a study.
Keep corpus, registration, statistical-spec copies and result inputs outside the
checkout. Do not add registration files to the immutable frozen directory.
Existing suites and arm configurations remain unchanged.

## Before registration: power review

```bash
node scripts/continuity-holdout-power.mjs --seed 572913 \
  --replications 100000 --output .worklab-tmp/holdout-power
```

The CLI writes deterministic `power.json` and `power.md`, enumerates exact safety
acceptance power and simulates at least 100,000 replications for each scenario.
The output states all assumptions, including comparator dependence, family and
repeat correlation. Accuracy/integrity/audit are assumed to pass in the joint
simulation, not estimated from models. Heterogeneous family scenarios introduce
residual dependence between conversations and are sensitivity analyses, not a
family-cluster calibration of the conversation-level gates. Poor power must be
reviewed before execution; never extend the sample or change gates after outcomes.

## Register the clean, merged tooling and frozen corpus

Use the checked-in `statistical-spec.json` unchanged, copied to a private external
file. The exact bytes of that copy are bound. Freeze verification checks current
bound tooling contents and requires a clean tree, even for dry/offline loading.

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

Pin the returned registration digest independently. Registration deterministically
shuffles sorted conversation identities, without replacement, into 16 shards of
16: eight ordinary (`holdout-hard`) and eight distractor
(`holdout-hard-distractors`) conversations per shard. It binds all memberships,
manifest/rubric/statistical-spec hashes, seed, reader/extractor/alternate models,
low reader effort, no judge, and the current code revision. The plan confirmation
also binds these inputs and the selected shard. Changing an input refuses loading
or changes confirmation before dispatch.

A shard requires all four arms, two repeats and all 15 probes (1,920 reader turns).
`--repeat` is refused for shards. `--trace` may select registered conversation
chunks; absent work stays missing, never silently shrinks the analysis population.
Paid holdout mode requires a shard plus the existing explicit confirmation and
credential/output checks. This tooling does not grant paid authorization.

For offline diagnostic proofs only, omit `--shard` and use the existing
`--repeats`/`--probe-limit` controls; such partial runs cannot pass the study.
Per-shard results alone also cannot pass: statistical denominators always cover
all 256 registered conversations, not just completed or selected ones. The pure
`holdoutStatistics` API accepts the complete registered conversation list and
merged trials; the subsequent controller must validate and combine all registered
shard units before final analysis.

## Statistical and audit output

`results.json` keeps existing per-probe descriptive results and adds
`summary.holdout`: conversation-level safety intervals, paired-t benefit intervals,
planned denominators, audit rates, integrity counts and pass/fail/inconclusive
reasons. `summary.md` and CLI output disclose the decision. Statistical confidence
bounds are one-sided 95%; the intersection-union gates do not assert simultaneous
95% interval coverage.

Missing, invalid, duplicated or unknown slots prevent acceptance. An incomplete
scope has **no complete-case inferential interval**. Ledger accuracy retains its
planned denominator with missing/invalid answers incorrect. Complete scopes and
complete audit inputs can still establish failures; unknown data cannot turn an
incomplete study into a pass. Both repeats and all probes stay in one conversation
bundle, and native-arm coverage is required even though it is not a safety comparator.

Optional `--audit /external/audit.json` supplies PR3's unique-entry totals:
`published`, `audited`, `labelFindings`, `contextFindings`,
`falselySupersededCurrent`, `bindingErrors`, and `complete: true`.
All counts are nonnegative integers; `audited` must equal positive `published`.
Rates use unique published entries and exact cross-multiplied 10/363 and 5/363
limits. Missing or incomplete audit material is inconclusive, never a pass.
Audit deduplication, source verification and export collection belong to the
subsequent audit/controller workflow, not these trusted aggregate counts.
