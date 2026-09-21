---
title: "Memory quality benchmark"
description: "Run and interpret mono-agent's disposable memory retrieval, capture-efficiency, graph-recall, and optional real-provider benchmark suites."
sidebar:
  order: 6
---

The repository includes a non-publishable, disposable memory benchmark. Its default suite is deterministic and offline: it creates a temporary SQLite store, uses a deterministic semantic embedding, reports quality and efficiency, then deletes the store.

```bash
pnpm run benchmark:memory
node scripts/memory-benchmark.mjs --json
```

The fast suite covers direct facts, paraphrases, updates/contradictions, temporal questions, recurring noise, alternating queries, exact duplicates, and entity-hop-shaped retrieval. Automatic injection is intentionally limited to canonical direct facts; broad paraphrases, relations, and entity hops remain available to the explicit `MemoryRecall` tool without being synthesized into background context. Unqualified current/last-message questions also abstain, because their answer belongs to active conversation history rather than durable memory. The unanswerable set separates out-of-domain questions from in-domain **missing-attribute** questions (for example, a person exists in memory but their phone number does not).

Synthetic selector-policy probes run separately from provider retrieval. Positive probes cover explicit property ownership, direct choice, event date/time, and location. Adversarial probes cover coordinated verbs, ditransitives, reported speech, subordinate wrong objects, inverse relations, and unknown values. Their fixed scores are never mixed into provider Recall/MRR, latency, context, or false-recall measurements.

A second, provider-backed calibration proves that the finite automatic-recall contract survives real indexing and retrieval. It uses the configured embedding provider, `upsertMany(..., { batchSize: 32 })`, `db.recall`, and `selectAutomaticRecallHits` in its own disposable store. At least one eligible direct-fact case must be present and 100% of eligible cases must select their relevant record. Unsupported paraphrase and relational cases are reported, but their coverage or abstention is informational and cannot fail the gate. This separation prevents synthetic scores from certifying provider behavior while keeping the broader retrieval suite free to measure cases that belong to the explicit `MemoryRecall` tool. The gate is:

- Recall@5 at least 90%
- MRR at least 0.8
- at least six canonical direct-fact probes are present, and at least 90% receive the relevant automatic-recall hit
- at least six ambiguous-binding probes are present, and 100% abstain from automatic injection
- at least 90% of unanswerable cases abstain from automatic injection
- 100% of missing-attribute and out-of-domain cases abstain in the fast suite
- stale recall at most 5%
- false recall at most 5%
- every policy-calibration probe passes
- at least one provider-backed eligible direct-fact case is present, and 100% receive their relevant automatic-recall hit

The report also includes evaluation-group count, Recall@1/8, nDCG@8, informational overall automatic Recall@5/answer coverage, direct-fact automatic coverage, ambiguous-binding abstention, both unanswerable abstention classes, context bytes, indexing/search latency, storage bytes, embedding calls/texts/input tokens/cost, LLM calls/tokens/cost, duplicate ratio, and vector coverage. Search latency uses the same bounded 50-hit backend superset as the shared app retrieval service, then measures automatic recall from its score-and-direct-fact-gated five-hit slice. Indexing is one `upsertMany` call per group with a batch size of 32; the compatibility field `efficiency.queueDrainMs` now reports aggregate group-local batch-write wall time rather than a serial per-record queue. The dataset's `efficiency` counters exclude the provider-backed and fixed memory-cleanup calibrations, which expose their own accounting under `calibrations`. The direct-fact and ambiguous-binding gates prevent either "inject nothing" or "inject adjacent topic matches" from passing on good raw search ordering alone; overall answer coverage is intentionally not a gate because unsupported or relational answers belong to `MemoryRecall`. Zero LLM cost in the fast suite is literal: the suite never invokes a chat model.

The additive `calibrations.providerAutomaticRecall` JSON object pins the provider-backed contract and its accounting:

- `eligibleDirectFact.cases` and `eligibleDirectFact.coverage` are gated at nonzero and 100%, respectively.
- `unsupported.cases` and `unsupported.abstentionRate` are informational.
- `efficiency` contains calibration-only indexing/search latency, storage, embedding, and zero-LLM counters.
- `store` contains calibration-only record, duplicate, and vector-coverage accounting.

## Memory-cleanup calibration

The fast gate also runs two fixed, provider-independent calibrations in separate disposable stores. Their counters never mix with the provider retrieval metrics above:

- **Capture efficiency and fidelity:** a checked-in, provenance-pinned legacy baseline must contain at least four LLM calls, four candidates, and two reconcile-required cases. The current pipeline must use at most two calls—exactly one `capture:extract` plus, when required, one `capture:reconcile-batch`—for at least a 50% call reduction while preserving action/entity/relation parity and 100% precision/recall for exact memory/entity associations.
- **One-hop graph retrieval:** at least ten multi-hop and ten direct cases compare the same 50-hit direct retrieval with graph expansion off/on. Multi-hop Recall@5 must improve by at least 10 percentage points; direct Recall@5 must remain at least 90%; direct and overall regression may not exceed 2 points. Adversarial cases require zero leaks, required misses, duplicate additions, and orphan associations. The calibration also proves one embedding request per query and zero chat-LLM calls during recall.

This calibration answers two bounded feasibility questions: whether the richer BuJo capture can reduce model work without losing the fixture's semantics, and whether a deterministic one-hop graph adds measurable retrieval value without degrading ordinary results. It does **not** claim that the synthetic percentages transfer to every personal corpus or provider. Use the opt-in real-provider and external-dataset runs below for broader evidence, and keep production source/accounting checks in `mono-agent memory audit --json`.

Real providers and larger external suites are explicit opt-ins and are not part of normal CI:

```bash
# Real local embeddings; uses MONO_AGENT_MEMORY_EMBEDDINGS_* overrides when set
node scripts/memory-benchmark.mjs --provider ollama --json

# Download the upstream data separately, then point the adapter at that file
node scripts/memory-benchmark.mjs --suite longmemeval --dataset /path/to/longmemeval.json --provider ollama --json
node scripts/memory-benchmark.mjs --suite locomo --dataset /path/to/locomo.json --provider ollama --json
```

The optional adapters target the upstream [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and [LoCoMo](https://github.com/snap-research/locomo) datasets. Every LongMemEval row and every LoCoMo conversation is an independent evaluation group with its own disposable database/index; records from unrelated examples are never searchable together. Recall, MRR, nDCG, automatic metrics, and query latency are then aggregated case-by-case across groups. Storage is summed, indexing latency is aggregated across group batches, and duplicate/vector audit ratios are computed from summed group-local counts. This avoids cross-example retrieval leakage while preserving case-weighted quality metrics.

LongMemEval abstention is recognized only from a `question_id` ending in `_abs`; answer-session ids that cannot map to the supplied haystack are rejected. LoCoMo rows with ordinary missing evidence are left unevaluated, while numeric category `5` is deliberately treated as the adversarial/unanswerable class for the retrieval abstention metric. That category-5 treatment differs from standard LoCoMo QA reporting, which commonly excludes those rows. The adapters never download data or contact a provider unless the operator supplies the dataset/provider flags.

Do not point this benchmark at an agent's configured memory path. It intentionally owns and removes only the temporary store it creates.

## Conversational end-to-end benchmark

The separate `memory-e2e-benchmark` measures the **pipeline**, not just preinserted
retrieval. It replays frozen fictional user/assistant turns through the real
harness's `persistCompletedTurn` boundary, waits for strict capture/indexing,
then asks a fresh reader to answer using production automatic recall and the
actual `MemoryRecall` and `MemoryJournal` MCP tools. It does not change the
production memory algorithm or the fast gate above.

```bash
# Provider-free manifest: no build, provider construction, credentials or downloads
pnpm run benchmark:memory:e2e:dry-run

# Build the dependency closure and run the scripted offline contract smoke
pnpm run benchmark:memory:e2e

# Once built, the direct entrypoint also defaults to the offline contract
node scripts/memory-e2e-benchmark.mjs
node scripts/memory-e2e-benchmark.mjs --split evaluation
```

**Offline results are not model quality.** Historical assistant messages are
frozen source data; offline extraction, embeddings and final responses are
additionally scripted. The contract smoke exercises real disposable SQLite,
strict capture parsing, durable intake, shared retrieval and loopback MCP. It
never reports scripted correctness as a real quality score. The default
historical replay avoids reader calls and automatic recall during ingestion;
it is not a live-channel or whole configured-app lifecycle benchmark.

### Corpus and arms

`fictional-v1` has two development and six frozen evaluation histories. Each has
four completed turns across three dated sessions and one later question. The
six evaluation categories are named-speaker direct recall, correction/current
truth, historical/relative time, missing-attribute abstention, contextual dietary
preference, and multi-session entity binding. The corpus is wholly fictional;
the evaluation split is checked in and therefore is **not a secret holdout**.
Source and evaluator objects are separated before provider calls. Expected
answers, categories, evidence labels and rubrics never enter capture or reader
prompts. Every report pins the fixture SHA-256 and code revision.

Select a corpus with `--corpus` (default `fictional-v1`). A corpus may declare
its own per-group turn bounds and a narrower arm list; both are validated
against the same closed arm set, recorded in the plan, and bound into the
confirmation digest, so a plan confirmed for one corpus cannot execute another.
`bujo-learning-v1` and `capture-fidelity-v1` contain evaluation groups only, so
select either with `--split evaluation`. Omitting the split keeps the
`development` default and fails with `empty_corpus_split` before provider setup,
build, or benchmark execution.

`bujo-learning-v1` is a second fictional corpus for baseline diagnosis of
working-style preferences and agent lessons. It runs eight one-question
scenarios on two arms — unchanged production `bujo` capture, and `full-history`
as a same-information reference — for sixteen trials. It adds **no intervention
arm**: every scenario uses the current capture path unmodified. Its evidence
turn is never the last turn, so the recent-only context cannot supply the answer
and the `bujo` arm must recover it from memory. Quoted material inside a user
message is quoted text, not real tool output and not a real assistant turn, and
no scenario asserts a host-verified check. Like `fictional-v1`, it is checked in
and is **not a secret holdout**.

`capture-fidelity-v1` is a six-scenario diagnostic corpus for speaker
attribution, corrections versus renames, scoped preferences, and separating
observed outcomes from causal claims. It uses the same `bujo` and `full-history`
arms. Its controls are checked in and author-visible, not a blind holdout or a
general memory-quality score.

### Private LoCoMo BuJo diagnostic

The optional `locomo-v1` adapter is a closed, non-publishable diagnostic. It
accepts only the pinned 2,805,274-byte upstream `locomo10.json` file and never
downloads or vendors it. Keep the CC BY-NC 4.0 corpus in an owner-only ignored
directory. The adapter sends neither references, evidence annotations, images,
summaries, observations, nor unselected conversations to a provider.

Protocol `locomo-adjacent-exchanges-v6-source-clock-native-capture-failure-recovery`
projects each session into ordered, non-overlapping adjacent pairs of source
utterances; a final odd utterance stands alone. Each projected turn is admitted
at its source timestamp after the prior admission has fully resolved; virtual
retry-clock advances stay within that prior admission and cannot shift a later
turn's observation anchor. Pairing uses only source order, never questions or
answers. Speaker and
text bytes are preserved without trimming, both participants remain quoted
humans, and a claim-free synthetic acknowledgement completes each harness turn.
The same exchange projection feeds full history and BuJo capture. No exchange is
truncated; an oversized exchange fails preflight.

Two samples are frozen before inference:

- `locomo-bujo-eval-v1-rank5-development-30`: six pre-outcome-hash questions per
  category from partition rank 5.
- `locomo-bujo-eval-v1-rank6-confirmation-20`: four per category from previously
  unexecuted partition rank 6. Do not tune after reading confirmation results.

Both arms use reader prompt `locomo-evidence-reader-v2`, including the explicit
`No information available.` abstention accepted by the pinned official category-5
phrase check. The original lexical evaluator stays unchanged and secondary.
`officialLexicalMetricMeasured` reports only whether that diagnostic completed.
The runner leaves `qualityMeasured` and `semanticQualityMeasured` false; only a
separately completed human review can establish semantic quality. `review.json`
supplies blinded arm labels and a human `correct`, `partial`, `incorrect`, or
`abstained` rubric, while preserving separate category-5 answerability
and image-association/dependency-unknown fields. There is no automatic semantic
judge.

```bash
node scripts/memory-e2e-benchmark.mjs --dry-run --corpus locomo-v1 \
  --dataset /OWNER-ONLY/PATH/locomo10.json \
  --locomo-experiment locomo-bujo-eval-v1-rank5-development-30 \
  --locomo-arm bujo \
  --reader openai-codex:gpt-5.6-luna \
  --extractor openai-codex:gpt-5.6-luna \
  --embedding-provider ollama --embedding-model bge-m3:latest \
  --dimension 1024 --pi-auth-path /PATH/TO/EXISTING/pi-auth.json \
  --allow-hosted-locomo-transfer
```

Providers known not to enforce `providerCheckMaxTokens` remain refused by default.
For a separately authorized evaluation that accepts measured rather than wire-capped
output, add `--allow-measured-output` to both the dry run and its confirmed real
command. The flag is bound into the plan identity, retains wall-clock cancellation,
input and model-step admission, and records observed usage; it does **not** turn the
provider hint or output-token reservation into an enforced output cap.

The dry plan binds source/question projection digests, code revision, arm,
models/profile, prompt, metric and per-invocation capture/reader/embedding/token/time
limits into one confirmation. Its 30-second embedding deadline matches the native
memory provider default and is passed from the confirmed plan to both the provider
and evaluator meter; expiration, caller cancellation, and global cancellation stay
terminal, with no embedding retry or acceptance of unknown settlement. Within one
successful BuJo invocation, capture runs
once and questions then use fresh reader histories over that store, so prior
answers cannot contaminate later questions. A completed artifact contains
`checkpoint.json`; `--reuse-artifact` accepts it only when all checksums and the
complete expanded identity match. This is complete-result reuse, **not** a capture
checkpoint: an invocation that fails after capture remains retained evidence but
cannot resume readers, and restarting it would capture again. Do not claim
capture-once across failed invocations or automatically rerun an expensive plan.

`plannedComparisonAggregateMaximum` is arithmetic planning metadata for exactly
three separate invocations: baseline BuJo, candidate BuJo and one full-history
reader. It is not a cross-process admission controller or provider-quota promise.
Each command enforces only its own `limits`; the parent must control the finite
sequence and account for completed artifacts. Capture reservations include all 16
native production intake attempts for every admission, even though a successful
first attempt consumes only one. The plan records those deliberately conservative
chat, embedding, input, output and runtime ceilings. A dry-plan confirmation is
not execution authorization.

Private artifacts record extraction candidates, reconciliation actions,
committed snapshots, raw backend retrieval outcomes where supported, automatic
blocks and explicit tool results actually delivered, and reader answers. A
missing stage is marked unavailable. The diagnostic funnel and official lexical
metric remain unmeasured unless capture, recall instrumentation and every
scheduled answer complete. Semantic quality remains unmeasured even then until
actual human review. Dry runs and synthetic tests prove contracts, not memory
quality; real inference is always an explicit separately authorized action.

All five arms use the same reader, question, identity, output budget and
controlled-text context estimate:

| Arm | Context and memory |
| --- | --- |
| `recent-only` | No durable memory/tools; last completed pair (at most 2 KiB) |
| `full-history` | All historical pairs; explicitly not applicable if too large |
| `lite` | Same recent pair; production compact summaries and lexical recall |
| `journal` | Same recent pair; compact summaries and real embeddings in real mode |
| `bujo` | Same recent pair; real strict model capture/reconciliation in real mode |

No gold-selected history, forced real-reader tool invocation, or silent
full-history truncation is allowed. Automatic recall retains its production
five-hit/8 KB policy and shared 50-hit lookup. Explicit recall retains its
schema/defaults and graph expansion; Journal retains its UTC chronological read.
There are no Remember, filesystem, web, shell, execution-history or delegation
tools. Answer turns never write back into memory. Each group/arm has a fresh
store, history and provider-session root. The first protocol uses one repeat
and fixed listed arm order: provider warmth/order effects are uncontrolled.

The source clock sets admission/journal timestamps and the question date;
monotonic wall clocks measure latency. Speaker labels traverse the real harness.
Production limitations remain visible: Lite/Journal host summaries truncate each
speaker's text to 240 characters, and source timestamps stamp stored records but
are not automatically inserted into the extractor prompt. Fictional relative-date
dialogue explicitly states its reference date. This benchmark does not repair
those limitations or future-validity filtering.

Admission is not readiness. After `flush`, the runner checks pending, dead,
retrying and transitioning intake; index queues/backlog, failures and dropped
work; and strict health/vector/canonical/outbox state. Empty valid extraction can
be ready without capturing a useful fact. For LoCoMo only, `model_output` follows
the existing durable intake's 16-attempt policy: the evaluator advances its virtual
clock to each record's actual persisted `nextAttemptAt`, while every provider call
keeps its real timeout and cancellation. A capture call that reaches its local
180-second deadline can enter that same native schedule only after the abort reaches
the actual runtime and the original promise settles within a separate 30-second
ceiling. Any late payload is discarded and usage remains unknown. A settled capture
result that explicitly reports the configured finite `maxTurns` guard follows its
unchanged durable `provider` pending record too, but only when the current attempt
records `max_turns_hit`, normalized local `budget_exceeded`, and Pi's `usage_limit`.
A fulfilled current capture call that omits its required structured result, misses
its required reconciliation projection key, or produces an unserializable selected
projection follows that same durable `provider` record only when the exact current
attempt records the known settled structured-contract boundary. Free-form text is
never substituted, and strict schema/content validation remains unchanged. This does
not add an SDK/model loop or increase the one-turn call limit. Unknown settlement,
global or caller cancellation, reader timeout, real auth/quota, unfinished tool loops,
generic provider, context, compaction, embedding, processing and output-limit
failures remain terminal; calls never overlap. First-attempt and recovered successes,
recovery causes, scheduled attempts and exhaustion are separate artifact events.
Persistent malformed output is `capture_not_ready`, never successful empty memory. Fresh semantic stores
initialize an **empty** managed generation before replay so strict health can
verify them; captured data is never rebuilt to conceal capture/index loss.

### Explicit real-provider execution

Real runs require a clean checkout, an explicit profile, and confirmation of the
same dry-run digest. No real mode is part of CI or the default command. This PR
establishes the runner and offline contracts; **real-provider quality is
unmeasured** until a separately selected workload is run and graded.

```bash
# Substitute already authorized exact model references; this command makes no calls.
node scripts/memory-e2e-benchmark.mjs --dry-run --split development \
  --reader openai:YOUR_READER --extractor openai:YOUR_EXTRACTOR \
  --embedding-provider ollama --embedding-model YOUR_EMBEDDING --dimension 768 \
  --pi-auth-path /PATH/TO/SELECTED/pi-auth.json

# Only after checking the printed workload and provider/data authorization:
node scripts/memory-e2e-benchmark.mjs --real --split development \
  --reader openai:YOUR_READER --extractor openai:YOUR_EXTRACTOR \
  --embedding-provider ollama --embedding-model YOUR_EMBEDDING --dimension 768 \
  --pi-auth-path /PATH/TO/SELECTED/pi-auth.json \
  --confirm-plan DIGEST_FROM_DRY_RUN
```

OAuth chat routes need the explicit `--pi-auth-path` file selection: the
benchmark wires it into the framework's existing Pi credential resolver for
both the reader and the extractor, and reads nothing until after real-run
confirmation. The standard Pi auth file is one possible value; consumers may
keep credentials at different paths, so no default file is assumed. Without
the flag the runtimes keep ambient environment auth. The dry-run confirmation
binds only a fingerprint of the selected path, never the path itself; changing
the selection invalidates the confirmation. Reports never contain the raw path,
credential bytes or file metadata.

The direct `--real` command requires a clean, unchanged HEAD and always removes
and rebuilds only the app dependency closure's generated `dist`/`types` directories
before importing production modules. The confirmation digest pins that build
policy and source revision; the resulting manifest records the build command,
package closure, source HEAD, Node version and SHA-256 of generated closure bytes. The runtime package ships
tracked JavaScript, pinned by the source HEAD, plus generated declarations.
HEAD/dirt and output identity are checked again before provider construction for
each trial. A failed build or changed source/output refuses admission. Building
does not itself authorize provider calls. Existing offline `dist` remains
explicitly **unverified**, even when the offline manifest reports a clean HEAD.

The reader and extractor use separate fallback-free `MonoRuntimeLike` runtimes.
The capture `LlmComplete` wrapper forwards the strict production prompt unchanged
with the existing maintenance system prompt, one model step and ordinary tool/MCP
access disabled. When production capture selects a schema, the runtime still
exposes its reserved terminal `StructuredOutput` tool. The wrapper accepts only
the authoritative structured result after successful runtime settlement,
serializes the extraction object or projected reconciliation `decisions` into the
capture trace and strict parser, and fails closed rather than falling back to
plausible prose. Reader memory-tool behavior is unchanged.

The built-in embedding factory supports Ollama, LM Studio and OpenAI at their
default endpoints. OpenAI embeddings use the existing `OPENAI_API_KEY`
environment convention; runtime providers use existing supported authentication.
No credentials/config file is copied, printed or created by the benchmark. There
is no custom endpoint, consumer memory path or arbitrary provider-module flag.
The only supported external dataset is the explicitly selected,
provenance-pinned LoCoMo corpus described above.

Compaction is explicitly disabled for **both** models. Requests select explicit
SSE with Pi retries set to zero, avoiding the selected Codex route's automatic
WebSocket attempts and SSE fallback outside that retry count; no fallback route
is installed. Unexpected compaction fails the trial. The repository-internal
`providerCheckMaxTokens` option supplies an output-token hint and reservation,
not a universal wire-enforced cap. A faux-provider contract test verifies model
clamping inside the real Pi harness, but the selected Codex request body omits the
cap. Dry plans therefore report that limitation, and a confirmed Codex `--real`
run fails with `strict_output_budget_unsupported` before build, credential access
or provider construction. Exact completed-artifact reuse remains available
because it performs no provider request and is checked before this preflight.
Resolving cap support requires a newly reviewed implementation/profile and fresh
authorization; a confirmation digest alone is not authority to bypass the check.
Actual transport attempts and native usage stay unknown unless observable.

### Pilot limits and accounting

There is no automatic escalation from development to evaluation, stochastic
repeats or external suites. Concurrency is one. The initial workload ceilings are:

| Limit | Development | Evaluation |
| --- | ---: | ---: |
| Histories / answer trials | 2 / 10 | 6 / 30 |
| Configured model steps reserved | 46 | 138 |
| Embedding facade calls | 100 | 300 |
| Estimated cumulative input-token reservations | 250,000 | 750,000 |
| Output-token reservations | 50,000 | 150,000 |
| Runtime including cleanup reserve | 15 min | 40 min |

Each reader reserves at most three model steps with a 512-token output hint per
step; each extraction/reconciliation step reserves 2,048 output tokens. These
are reservation/accounting values and provider hints, not wire-output guarantees.
Model calls have a 60-second full-promise deadline, embeddings a 10-second
full-promise deadline (including response bodies), each readiness barrier 120 seconds, and
cleanup one overall 10-second deadline. Global cancellation also bounds these
awaits; the original raw promises remain tracked independently of the wrappers.
Cleanup first quiesces harnesses and the store, rejects a timed-out/discarded
store shutdown even when `close()` resolves, then closes providers and proves
stable raw-promise settlement. Any uncertainty retains the owned store and
stops further trials; unstarted trial count and the safe failure stage remain
in the report. After writing a failed report the standalone CLI exits even if
an uncooperative transport retains sockets; that is not proof of remote request
cancellation or billing termination.

Budget exhaustion or cancellation is visible and does not become abstention.
Reservations are charged before dispatch and are not released as zero when
usage is missing. Configured model-step and embedding-call bounds do **not**
pretend to count unobservable provider HTTP attempts. A non-cooperative provider
can outlive an abort; unsettled resources prevent deletion and further admission,
and the report must not imply that upstream billing stopped.

Structured provider-failure categories use a fixed vocabulary (`provider_auth`,
`usage_limit`, `provider_unavailable`, …) on meter events, trials and summary
failures. Unknown values stay generic; raw error text, error details, paths and
credentials are never written to artifacts. A fatal `provider_auth` or
`usage_limit` stops further provider admission for the rest of the invocation:
remaining trials report as unstarted (`trialsNotStarted`), never as successes
or attempted failures, while owned stores still complete cleanup and settlement.
Other provider errors stay visible per trial without stopping the run. A retained
category is routing evidence for a later bounded diagnostic, not proof of
invalid credentials, exhausted quota, or zero billable work.

Reader input admission uses an estimated 16,384-token ceiling (extractor 8,192):
UTF-8 controlled-text bytes divided by three plus a fixed 4,096-token
framing/tool-schema allowance. These are **estimates, not exact native payload
caps**. Dynamic tool results, schemas, tokenizer differences and provider framing
can change actual context. The provider's own context limit remains authoritative;
reported usage/context events are separate from estimates. A selected profile
must be checked for its actual model/context capabilities before a real pilot.

Reports separate admission, replay, capture extraction/reconciliation, embeddings,
readiness, automatic/backend recall, explicit tools, answer latency, setup,
audit and cleanup. Nested durations overlap and must not be summed as wall time.
Each latency distribution includes nearest-rank p50/p95, sample size and failures;
N<20 is marked exploratory (with six samples p95 is the maximum). No p99 or
statistical superiority claim is supported by this pilot.

Usage, cost and model attribution are allowlisted from actual results when
available. Missing input/output/cache/reasoning tokens, prices or transport counts
are `null`, never zero. No price table or local-compute cost is invented. An empty
quality denominator is not 100%. Failures remain in scheduled/completion counts.
Scripted counters are contract workload observations, not production economics.

### Grading and reproducibility

Real answers receive only a clearly labelled **lexical diagnostic** initially:
expected aliases with conservative negation/forbidden-value checks. This is not
semantic QA accuracy. Semantic correctness, claim support, capture proposition
precision/recall, stale-fact rate, temporal correctness, preference usefulness,
irrelevant intrusion and abstention require source-supported annotation and stay
unknown/pending until performed. Failed/no-response trials are not abstentions.

The review bundle contains source evidence, required/forbidden claims and rubrics.
A small stratified sample spanning categories and arms suffices for an initial
pilot; all-answer/double review is optional. Identify reviewer type and coverage;
AI or maintainer review is not automatically human annotation. No LLM judge is
called by this runner. Later judge calls require their own pinned model/prompt,
separate accounting and explicit budget. Three fresh capture+answer repeats and
paired group-level analysis are a later, separately budgeted workload, not a
claim from this single run.

Artifacts live only under an owned `.worklab-tmp/memory-e2e/run-*` directory:
`manifest.json`, `events.jsonl`, `trials.jsonl`, `capture.jsonl`, `review.json`,
`summary.json`, and `checksums.json`. They retain fictional model text and indexed
snapshots for diagnosis, not raw runtime/config/error objects. Known credential,
endpoint and personal-path patterns are redacted; reports contain only relative
output paths. Inspect artifacts before public sharing. Do not substitute private
history for the checked-in fixture. Stores are removed only after cleanup and
provider settlement; unsuccessful cleanup retains the owned store and is visible.

The script deliberately composes the public harness/store APIs with the app's
unchanged shared retrieval, Journal and `composeRuntimeOptionExtensions` modules.
It does not instantiate the configured app (which would acquire account-wide
ownership state). Those repository-relative app imports and the private output
cap are benchmark-only version coupling, not new public APIs.

### External protocol follow-up

The E2E runner accepts only the checked-in fictional corpora
(`fictional-v1`, `bujo-learning-v1`, `capture-fidelity-v1`). The older external
adapters above remain retrieval-only.
`scripts/fixtures/memory-e2e/sources.json` pins the follow-up sources; it does not
download or implement them:

- [Cleaned LongMemEval data](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f)
  at `98d7416c24c778c2fee6e6f3006e7a073259d48f`, paired with
  [upstream evaluator code](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc).
  Official QA consumes `{question_id,hypothesis}` and task-specific model judging;
  lexical diagnostics are not that protocol. Temporal off-by-one tolerance and
  acceptance of old information alongside a correct update differ from stricter
  groundedness/staleness annotations.
- [LoCoMo code/data](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376)
  at `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`. Its pinned scorer has category-specific
  stemmed F1 and an adversarial category-5 phrase check; report 1–4 and 5 separately
  and state the selected convention rather than claiming a universal QA protocol.

A follow-up must preserve original session dates, roles, speakers and source IDs,
strip `has_answer`/evidence/generated summaries from model inputs, and split by
independent histories/conversations. LoCoMo's two human speakers must not be
misrepresented as user versus assistant; an observed-dialogue replay needs an
explicitly labelled adaptation. Public data still requires license/data-handling
review. Do not silently select oracle evidence sessions, fetch image URLs or
launch all 500 LongMemEval examples.
