---
title: "Conversation-continuity benchmark"
description: "Measure whether an agent still knows what was said and decided after the context-reducing boundaries of a long conversation, using fictional traces and production session paths."
---

The repository includes a non-publishable benchmark that asks one question:
after a long conversation crosses a context-reducing boundary, does the agent
still know what was discussed and decided? It replays fictional multi-session
conversations through the production configured harness, stops at a
checkpoint, and asks each probe in a fresh continuation turn. Scores are
deterministic first; an optional judge grades only free-form next-action probes.

```bash
# Workload plan, confirmation digest and list-price estimate; no build, credentials or network
pnpm run benchmark:continuity:dry-run
node scripts/continuity-benchmark.mjs --dry-run --suite hard --repeats 2

# Build the app closure, then run the offline contract (scripted providers)
pnpm run benchmark:continuity

# Once built, the direct entrypoint defaults to the offline contract too
node scripts/continuity-benchmark.mjs --trace brightline-return --probe-limit 2
node scripts/continuity-benchmark.mjs --suite hard --trace gen-rowing-103 --probe-limit 1
```

**Offline results are not model quality.** The offline contract uses the real
harness, durable history, tool-history sidecar, Pi sessions and compaction
driver, but the reader and summarizer are scripted. It proves that every arm
crosses its boundary and that scoring and accounting run; its accuracy numbers
mean nothing. CI runs the offline unit and contract tests only.

## Suites

There are two suites. `--suite` is bound into the plan digest.

### Original suite (default)

`scripts/fixtures/continuity/` holds four hand-written invented traces
(`fictional: true`). Each one is a single conversation over five days, with:

- 36–38 owner turns;
- about 28 tool results (email, chat, web page, document, calendar and parcel tracking);
- one mid-turn steer;
- early owner constraints, superseding corrections, tool-only identifiers,
  sent versus drafted commitments, artifacts with a status and open items.

Each trace has 13 probes in seven categories. These traces fit inside the
cold-rebuild bounds, so they show little except the loss of early
constraints. Keep them for comparability with the first pilot.

### Hard suite (generated)

`scripts/lib/continuity-generator.mjs` builds long traces deterministically
from seeds; nothing large is checked in. The default seeds `101-108` cover
eight invented scenarios: a studio kiln, a cider co-op, a lighting rig, an app
localisation, a grant, an oven repair, a boat trailer and a print run. `--seeds 101-124`
gives 24 traces; seeds cycle through the scenarios with fresh names, values,
sizes and layout. A small PRNG drives every value, so a seed always yields
byte-identical text, and the plan binds a digest of the generated traces.

Each generated trace has:

- 84–116 owner turns over 7–10 sessions, and 64–96 tool records;
- tool results of 8–64 KiB each: long email threads, documents, search
  results, chat transcripts and web pages. Two to three results exceed the
  16 KiB tool-history result bound, including the booking pack.
- three mid-turn steers and three superseding corrections: a date that moves
  twice, and an amount that is revised once;
- three owner rules in turn 1: never mention a named confidential topic to the
  counterparties; never send the personal phone number or postcode; never paste
  passwords back into chat.
- an early account reference, validated to sit outside both the canonical last-64
  window and the tool-projection bound (32 records or 64 KiB of newer
  retained results). There is also an identifier in the middle of a long
  result (the summary serializer keeps only result heads and tails), and one
  at the head of an oversized result, with a superseded decoy. Tool history keeps
  the first 16 KiB of an oversized result, so this late identifier is a control:
  it should survive cold rebuild while its record is among the newest projected ones.
- a secret-looking temporary password in a tool result, which must never be
  repeated verbatim (the `redaction` category);
- a size target that puts Pi's own context estimate at the probe at about
  212k–232k tokens. That is above the 200k default ceiling and below the
  reader's 244.8k native trigger.

The vocabulary is deliberately neutral (equipment, logistics, vendors) and
avoids relationship and other sensitive terms.

| Category | Scoring | Example |
| --- | --- | --- |
| `tool_identifier` | Normalised exact match; superseded decoys count as stale | Account or booking reference seen only in a tool result |
| `active_constraint` | Recall: required terms. Task: forbidden-pattern violation detection | Draft a message without the confidential topic or phone number |
| `superseded_current` | Current value present and superseded value absent | Event date after two moves |
| `commitment_status` | First status token (`SENT`, `DRAFTED`, …) | Escalation drafted after a steer, never sent |
| `artifact_status` | First status token (`DRAFT`, `FINAL`, `SHARED`, …) | Checklist shared |
| `next_action` | Deterministic keyword proxy; optional judge reported separately | The owner's stated next task and deadline |
| `abstention` | `UNKNOWN` or an explicit "never came up" | A serial number that was never mentioned |
| `redaction` (hard only) | Fails if any 8-character run of the secret appears | Paste the portal sign-in details |

Validation runs before any replay. It rejects traces that are not marked fictional,
have the wrong size or shape for their family, lack steers or a category, or
whose identifiers or secret appear anywhere outside tool output. The replay
projection contains no probes, expected answers, rubrics or categories; the
reader sees only the probe text. Probe wording explicitly counts tool results
as part of the conversation. Without that, readers answered `UNKNOWN` for
values they had only seen in a tool result.

## Replay and arms

Every turn goes through `resolveJsonMonoAgentConfig` →
`createConfiguredAgentRuntime` → `createConfiguredConversationHarness`, with
continuous durable sessions, the durable canonical history store and the
tool-history sidecar. Scripted history turns are served by Pi's faux provider
posing as the bound model through the runtime's existing `piResolvedModel`
seam. Their tool calls are real MCP calls to a loopback fixture server that
returns the frozen output, so production code writes the native transcript and
the tool-history records. Steers are delivered with `offerLiveInput` while a
scripted tool call is in flight, and each must reach the next model request.
Scripted turns never compact, because a faux model cannot produce a real summary.

After the checkpoint, the workspace is copied once per probe. A new tool-free
harness asks the probe on the reader model. Forks of one checkpoint share a
provider-session identity, so they never run concurrently.

| Arm | Boundary at the probe turn | Production path exercised |
| --- | --- | --- |
| `native` (a) | None: resume the reader's own native Pi transcript, tool calls and results included | Durable session resume; `runtime.compaction.maxInputTokens: 0` disables the 200k ceiling |
| `cold-rebuild` (b) | History is bound to `--alternate`; the probe runs on the reader | Default configured model change: `resume_replay`/`model_change`, canonical last-64 text messages plus the bounded tool-history projection |
| `compaction-1` (c) | One proactive compaction before answering | `runtime.compaction` with the smallest allowed trigger: window 32,000, ratio 0.2, 4,000-token recent tail, cooldown 0 |
| `compaction-2` (d) | A promptless manual compaction before the mid-trace turn, then a proactive one at the probe | `compactConversation()` on the same guarded summary driver, no live reply; same policy at the probe |
| `ceiling` (e, hard only) | The merged default 200k `maxInputTokens` ceiling, reached by the long trace | Production default compaction policy |
| `restart-switch-compact` (f) | Fresh process, then model-change reseed, then compaction, in that order | The probe runs in a child Node process over the forked durable roots, on the reader (reseed) with the smallest trigger (compaction of the reseeded context) |
| `continuity-store` (g) | As (b): model-change reseed | `runtime.session.continuity: { enabled: true, packEnabled: false }` for replay and probe; the reader is offered only `ConversationHistory` (`tools.allowedTools: ["ConversationHistory"]`) |
| `continuity-store-compaction` (h) | As (c): one proactive compaction | Recording on, packs off throughout, `ConversationHistory` offered |
| `continuity-pack-cold` (i) / `continuity-pack-boundary` (alias) | As (b) and (g): cold `model_change`, no compaction | `runtime.session.continuity: { enabled: true, packEnabled: true }` throughout; deterministic bounded pack and `ConversationHistory`, no paid upkeep |

Retained conversation evidence (`runtime.session.continuity`) defaults to on.
Every arm from (a) to (f) pins `runtime.session.continuity.enabled: false` in its
replay, mid-trace and probe configs. Those arms therefore stay comparable with
baselines recorded before the feature existed. The B1 arms (g) and (h) turn
recording on but explicitly pin `packEnabled: false`; any gain there depends on
the reader choosing to call `ConversationHistory`. The deterministic pack arm
pins `packEnabled: true` and uses the same cold boundary and tool offer as (g).
Replay inputs are explicitly host-classified human turns, so provenance is captured
by production code rather than guessed from a speaker name. The projection hint
now names `ConversationHistory` when offered, so rerun the store-only control
rather than attributing that hint correction to pack quality.

The tool-history sidecar pins its absolute artifact root, and production correctly
degrades continuity in a copy at another root (`history_artifact_root_mismatch`).
The store and pack arms therefore fork in place:

1. After replay, a pristine snapshot of the checkpoint is kept.
2. Each probe restores that snapshot at the checkpoint's own path.
3. The probe then runs in a fresh process, so the pinned root matches.

Forks of one checkpoint never overlap. The artifact-root guard is not bypassed.

Remaining planned arms are declared with intended evidence but are not runnable:
`continuity-pack-per-turn` reserves later opt-in per-turn **maintenance** (not
injection), and `pack+stubs` waits for tool-result clearing. Selecting one fails plan creation
with `arm_not_available_at_revision:<id>`. To enable one, set `available: true`
once the production feature lands, and confirm its patch keys and evidence event
names against the implementation. Unknown config keys still fail in production
config resolution.

### Evidence checked per sample

Each sample records the boundary actually observed: `session_boundary` events,
terminal `context_compaction` events, and the child process for the restart
arm. A probe that did not cross its arm's boundary is `boundary_unverified`.

On long traces, each sample must also show the pressure its arm is designed to test:

| Arm | Pressure threshold |
| --- | --- |
| `native` | Provider-reported probe input ≥ 150,000 tokens |
| `cold-rebuild`, `restart-switch-compact` | 64 replayed messages, and at least 32 tool records dropped from the projection |
| `compaction-1` | Compaction `tokensBefore` ≥ 150,000 |
| `compaction-2` | Mid-trace `tokensBefore` ≥ 80,000; probe `tokensBefore` ≥ 40,000 (the summary plus the rest of the trace) |
| `ceiling` | Compaction `tokensBefore` ≥ 200,000 (Pi's estimate, the trigger's own input) |

A sample below its threshold is `pressure_unverified`.

The store arms also record:

- the checkpoint's retained-record statistics, as content-free counts;
- whether `ConversationHistory` was offered;
- every `ConversationHistory` call: search or get, and whether it succeeded, was unavailable or was invalid;
- any tool-history warnings the harness reported.

A sample whose store is degraded is `store_degraded`: no retained records, a
degraded sidecar, history warnings, or an unavailable retrieval. It is an
invalid trial, never a scored miss.

Unverified samples of every kind are excluded from accuracy and counted separately.

Compaction counts refer to pre-turn compaction. In store arms with the smallest
trigger, retrieved `ConversationHistory` text can push the context over 6,400
tokens again between tool rounds. The resulting mid-run compactions are
reported but not counted as the arm's boundary. Read (h) as "store plus an
aggressive trigger", not as the production default. A mid-trace
compaction that did not happen fails that checkpoint. `results.json` reports
the observed pressure range per arm.

### Confound controls

- **No live mid-trace reply.** The mid-trace compaction in (d) is promptless
  (`compactConversation()`), so the history between the two summaries stays
  scripted and identical to the other arms.
- **Same summary sharing for the final compaction.** (c), (d), (e) and (f) all
  compact the final context once per probe. Only (d)'s mid-trace summary is
  shared by one repeat's probes, by construction; its variance shows up across
  repeats.

## Paid runs

Paid mode is explicit and never part of CI. It refuses whenever `CI` exists in
the environment, even when empty, and requires a clean checkout. It also
requires the confirmation digest from an identical dry run, an explicit Pi
auth file and an output directory outside the checkout. The dry run prints
`estimate`: an upper bound with no prompt cache and an expected value with
forks reusing the cached prefix, both at Pi catalog list prices.

```bash
node scripts/continuity-benchmark.mjs --dry-run --suite hard --repeats 2 \
  --pi-auth-path /ABSOLUTE/PATH/TO/pi-auth.json

node scripts/continuity-benchmark.mjs --real --suite hard --repeats 2 \
  --pi-auth-path /ABSOLUTE/PATH/TO/pi-auth.json \
  --output /ABSOLUTE/PATH/OUTSIDE/CHECKOUT/run-1 \
  --confirm-plan DIGEST_FROM_DRY_RUN --trace gen-grant-101 --trace gen-oven-102 --concurrency 6
```

The defaults are:

- reader `openai-codex:gpt-6-luna` at low effort;
- alternate binding `openai-codex:gpt-6.1-sol`, used for scripted history only and never called;
- judge `openai-codex:gpt-6.1-sol` at low effort, or `--no-judge`.

Suite, seeds, models, efforts, repeats, arms and `--probe-limit` are bound into
the digest. `--trace`, `--repeat`, `--concurrency` and `--output` are
execution-only, and they select a subset of the confirmed plan. Completed units
in the output directory are skipped, so a long plan can be run in chunks and
re-aggregated with `--aggregate-only`. Chunk by trace so that scripted
checkpoints are reused by both repeats. The auth file is read lazily by the
existing Pi credential resolver; only a fingerprint of its path enters the plan.

Each invocation stops admitting new live turns after an auth or quota failure,
after the planned live-turn count, or once its observed input tokens cross
`limits.maxObservedInputTokensPerInvocation`. These are observed, not
reserved, limits: one in-flight request can exceed them.

## Reading results

The output directory contains `plan.json`, one `units/r<repeat>-<trace>-<arm>.json`
per completed unit (answers, scores, observed boundary and pressure evidence,
usage), and the aggregate `results.json` and `summary.md`:

- **Accuracy** per arm and category is the mean of per-repeat accuracies, with
  `n`, the per-repeat split, the SD across repeats, and the delta versus
  `native` in percentage points.
- **Flip rate** is the share of probes whose pass/fail changed between repeats.
- **Outcomes** separate `stale` (the superseded value), `conflicted`,
  `abstained` (including false abstentions), `violation`, `fabricated` and
  `leaked`.
- **Tool use** (store arms) reports how often the reader called
  `ConversationHistory`, and accuracy with and without a call, overall and by
  category. This is observational: the reader chooses when to call.
- **Excluded** counts boundary-unverified, pressure-unverified, store-degraded and failed samples;
  they are never scored as passes or failures.
- **Judge** agreement compares the next-action judge with the deterministic
  proxy. The main category table always uses the proxy.
- **Spend** reports:
  - live turns, and input, cache-read, cache-write and output tokens per arm, including mid-trace compactions;
  - compaction summary requests as an "of which" subtotal;
  - the judge separately.

  Cost is the Pi catalog list-price estimate when the runtime reports one.
  Subscription routes are not billed per token, and missing values stay unknown.

## Limitations

- Both suites are author-visible. They are not a secret holdout and do not
  represent every conversation shape. Generated filler is repetitive
  business prose, not natural correspondence. Its token density per character
  differs from real mail, so the provider counted about 182k tokens where Pi
  estimated about 222k.
- History before the checkpoint is scripted, including the steers.
- Constraint-violation and redaction probes pass when the reader has simply
  lost the source material. Read them alongside recall probes.
- (d)'s mid-trace compaction is the manual (operator) trigger, not the
  proactive one. The summary driver is the same.
- The restart arm restarts the process over durable state. It does not cover
  `--clear-sessions` or a crash mid-turn.
- Two repeats give a variance signal, not a confidence interval. The
  deterministic scorer can miss correct paraphrases or accept lucky
  substrings. Inspect the stored answers before drawing conclusions from small
  deltas.
- The benchmark measures retention at the probe turn. It does not measure
  memory capture, recall tools or long-term memory.

### Deterministic cold-pack comparison

Pair the real cold treatments explicitly:

```bash
pnpm benchmark:continuity --dry-run --suite hard --arms native,cold-rebuild,continuity-store,continuity-pack-cold
```

The offline contract test exercises all three through built configured harnesses,
checks the cold `model_change` boundary, and inspects actual scripted-provider
contexts: no packs for either control, exactly one pack on both requests when
the pack arm calls `ConversationHistory`. Content-free pack receipts retain
section counts, omissions, token estimates and uncertain overlap for inspection.
Source or headroom failures invalidate the pack sample; expected budget overflow
is recorded, not treated as a missing treatment. Ordinary request usage includes
pack input tokens. The planning estimate allows the full 8k pack on each reader
request, with the same retrieval allowance as store-only and no upkeep call. No quality improvement is claimed from offline runs, and the
paid paired comparison is a separate operator action.

## Progressive ledger boundaries

`continuity-ledger-cold` plans **three extractions per trace/repeat**, never per
probe. Source history replays on reader R. Tagged `preparation` child requests
recreate scripted providers in three distinct processes, answering through
**A → R → A** while the configured extractor remains R. Every preparation must
prove a production model-change boundary, a new selection and preserved earlier
entries. All processes use the same absolute durable roots and normal ownership;
no native journal is deleted to manufacture eligibility.

Tagged `probe` children switch back to the real reader R, cold relative to final
A. They require the committed final ledger in the provider request and have
upkeep explicitly disabled. Native, cold-rebuild and deterministic-pack controls
are unchanged and buy no upkeep.

```sh
pnpm benchmark:continuity:dry-run -- --suite hard-distractors --repeats 2 --arms native,cold-rebuild,continuity-pack-cold,continuity-ledger-cold --no-judge
```

The `hard-distractors` suite replaces only neutral filler paragraphs with labelled
hypothetical corrections, decoy IDs and amounts. Actual facts, answers, byte sizes
and pressure are unchanged. It tests nontrivial selection without editing probe
rubrics or leaking expected answers into the upkeep source.

Extraction defaults to configured reader model; `--extraction-model REF` is an
explicit override, never an automatic cheaper model. `--require-request-cap`
skips unsupported adapters before dispatch. Plan digest, dry-run workload and
cost estimate include that model, the binding sequence, and an explicit reservation
for every extraction: **128k bootstrap +64k incremental +64k incremental** input,
each with 4096 output tokens. Both hard corpora, two repeats and all four arms
plan **1920 answer calls +96 extractions =2016 completions**, without a judge.
Execution rejects old single-preparation or under-reserved bootstrap plans before opening the configured harness. **Codex stream_abort is not a hard output/billing bound**:
hidden reasoning/remote work may overrun; subscription/quota is not dollar
metering. Catalog planning estimates are not an invoice or a spending guarantee.

Results retain content-free host `upkeep` receipts, enforcement class, reported
actual output tokens, coverage omissions and committed generation identity.
Upkeep cost/tokens are added once through checkpoint accounting, even when a
failed extraction invalidates the treatment. Its input count includes cached
input; cache-class breakdown and whole-turn answer/upkeep reconciliation remain
future work. Provider-facing offline ledger counts verify treatment, not model
quality. Invalid/skipped extraction is excluded rather than scored as a quality
miss. Only a separately authorized paid comparison can establish quality gains.

Built offline mechanism proof: the existing
`node packages/app/scripts/smoke-continuity-pack.mjs --ledger` fixture verifies
that a buried retained tool ID and corrected amount reach the actual upkeep input
and outgoing cold provider request, while current input and effects remain once.
Add `--fail-upkeep` to verify invalid JSON leaves the deterministic fallback and
a content-free gap, with no repair. These are scripted local fixtures, not live
provider or mailbox tests. See [ledger trust and bounds](/runtime/continuity-ledger/).

### Ledger preparation safety and estimated paid input

`--aggregate-only` never executes units or upkeep; `--require-request-cap` still
executes, with the strict-cap policy in the confirmed plan. Real-mode preparation
uses the configured `providers.piAuthPath` credential resolver, just like the
answer path; no injected fixture models are used for real extraction.

Preparation keeps its receipt even when the harness, ledger read or close fails.
A zero-dispatch preparation contributes zero calls/tokens/cost, not an unknown
call. If an abort loses reported usage, the separately recorded conservative input
cost is counted as `estimatedPaidCalls` / `estimatedPaidInputCostUsd` and included
in estimated spend. It is **input-only**, not reported usage, full output cost or
a spending guarantee; output/hidden work can remain unknown. Strict request-cap
mode remains available. Codex requests compact output within its unchanged byte
guard; this does not reduce the 4,096-token planning allowance or claim a hard
server cap.

Reported-null upkeep input falls back to the separate inclusive input estimate
for invocation admission and `observedInput`; cache tokens are not added twice.
A failure after paid preparation (including checkpoint statistics, cleanup or
fork publication) preserves the partial checkpoint's upkeep in unit errors,
`results.upkeep` and aggregate usage. Compact Codex coverage counts only cited
spans; the three-boundary treatment can still be incomplete. It never adds
coverage-hole or repair calls beyond the confirmed three reservations.
Per-preparation receipts and usage components retain known subtotals and unknown
calls separately, without counting the aggregate again. A lost child acknowledgement
retains its conservative input allowance and invalidates the unit; an external
spend controller must retain the corresponding monetary reservation.

For fictional-only diagnostics, `--capture-upkeep-output` opts into saving the
raw extraction completion, stable validation `failure` code and merged validated
ledger under `OUTPUT/upkeep-output/r<repeat>-<trace>-p<1|2|3>.json`. It requires an explicit output
outside the checkout (also offline), uses owner-only files, refuses existing
capture files, and is **off by default**. Captures are benchmark artifacts, never
written into the continuity store or exposed by production runtime configuration.
No prompt or credentials are captured; model, auth, SSE and caps remain unchanged.
