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

## Offline lookup mechanics (opt-in)

Recall-only remains the default: omitting `--probe-mode` preserves its prompt
bytes, arm selection, plan schema and confirmation serialization. Lookup uses a
separate explicit protocol, not the registered ledger holdout or a claim that
retrieval improves a model:

```bash
pnpm --filter '@mono-agent/app...' run build
node scripts/continuity-benchmark.mjs --dry-run --probe-mode lookup-allowed-v1 --no-judge
node scripts/continuity-benchmark.mjs --probe-mode lookup-allowed-v1 --no-judge \
  --trace brightline-return --probe-limit 1
```

Lookup is **offline preparation only**. `--real` fails before credential-path
validation or provider setup. The default reader binding is Sol, with Luna as the
scripted alternate; both are faux providers, never model calls. The scripted
reader performs a packed-ID get when available, a query, search pagination and
complete get-cursor traversal. Its dispatch capacity exceeds the pinned turn
ceiling, allowing eight or more tool rounds. Budget exhaustion is an expected,
explicit mechanics outcome; the scripted answer is not semantic evaluation.

Only `native-lookup` and `continuity-pack-cold` are admitted. Native lookup
captures retained records and offers ConversationHistory, but injects no pack,
ledger or upkeep and never compacts. It uses the reader's native session, an
**in-place** snapshot restore and a fresh probe child. Both arms must show
retained records, an offered tool and a healthy store; native must also prove
absence of an injected pack. Lookup checkpoint keys are namespaced, so they
cannot reuse recall-only capture-off checkpoints.

The benchmark copies `scripts/fixtures/continuity-soul-v1.md` to every lookup
workspace and sets `context.soulPath`. Its raw SHA-256 and production-normalized
core SHA-256 are bound into the confirmation and frozen budget policy. Missing,
modified or mismatched soul bytes fail; there is no checkout-default fallback.
This freezes the original core independently of later default-soul changes.

### Frozen sizing policy

`scripts/continuity-lookup-budget.mjs` measures a content-free inventory using
real retained stores, configured replay and real loopback ConversationHistory
calls. The sizing corpus is the four original traces, hard and hard-distractor
seeds 101–108, plus 27,600-byte UTF-8 and escaped-content regression records.
The regression records also traverse the production handler and response
splitter. The **reference path**, distinct from the quality reader, gets a
source's packed record ID when displayed; otherwise it issues **one** search
with an evaluator-only source-line query at limit 10, then follows every 8-KiB
get cursor. It never performs an unfiltered linear search. Queries and expected
values do not enter ordinary reader prompts or persisted witnesses.

Only unambiguous literal tool-identifier sources are annotated in this version;
other source provenance remains `unknown`. Redaction probes remain `protected`,
even when a native transcript contained raw values. Sources are resolved
independently against each arm's sanitized store, not borrowed from another arm.
The measured inventory contains 112 paths, 9,370 retained-size observations and
370 serialized response-size observations. Every measured path discovered its
source and verified the concatenated retained UTF-8 digest.

| Binding | Frozen value |
| --- | --- |
| Call budget, identical per arm/probe | 8 dispatched calls |
| Byte budget, identical per arm/probe | 126,976 UTF-8 bytes (124 KiB) |
| Maximum reference path | 6 calls / 61,718 bytes |
| Largest serialized response | 32,608 bytes |
| Inventory SHA-256 (canonical JSON) | `6c45a457f926af1d259c4b53bc3b45821b939ca3fdfd1a830b38b538f415a6b9` |

Each arm/probe gets a fresh meter with these identical call and byte limits;
they are **not pooled** across arms or probes. Calls are `max(path calls) + 2`, capped at `min(96, 100 - 2)`. Bytes are
`max(path bytes) + 2 × largest response`, rounded upward to KiB and capped at
8 MiB. The policy and content-free per-slot reference costs are checked in at
`scripts/fixtures/continuity-lookup-budget-v1.json`; the detailed inventory is a
separate archived artifact, never retrieved text in a repository fixture. The
inventory digest binds that specific archived inventory used for the checked-in
policy, **not byte-identical remeasurement reproducibility**: generation, run
and record identities are random. A new measurement has its own receipt and
digest; do not claim that reproducing the protocol must reproduce this hash. Re-run
measurement into a fresh directory to prepare a **new** policy, not to enlarge
budgets after seeing trial outcomes:

```bash
node scripts/continuity-lookup-budget.mjs --output .worklab-tmp/lookup-sizing-new
```

Feasibility additionally reserves a 16,000-token context margin within the
272,000-token scripted reader window. It conservatively charges each serialized
response byte as one token plus 300 tokens per round. Initial input uses the larger of the observed first forwarded context's UTF-8
JSON bytes divided by three (the conservative handoff-style estimate) and the
trace estimate. Native input is at least 150,000 tokens **on every round**;
the pack floor is the cold estimate plus 12,000. This observes wrappers,
metadata and schemas, not just source-text sizes. The sum of repeated inputs must
also fit the existing per-invocation observed-input admission cap (6 million
for originals, 400 million for long suites). Passing a slot's reference check
does not reserve capacity for every planned slot: cumulative admission may
still leave later slots unstarted. These are conservative scripted-reader
feasibility estimates, not tokenizer or latency guarantees for a future model.
There are 64 feasible paths and 48 `budget-infeasible` native long-trace paths:
the conservative observed-request estimate exceeds the scripted reader's
context bound. Do not count those slots as reader failures, omit them from
coverage or widen the policy to make them fit. Cap-bound, context-bound,
undiscovered or admission-bound paths retain the same classification. Corpus
or protocol changes require a new frozen policy.

### Forwarding, deadlines and interpretation

A benchmark-only forwarding server rewrites **only the URL** under the existing
`mono-agent-conversation-history` key. It preserves server identity, listing,
schema and production handler behavior. Calls are reserved atomically before
dispatch. Exact UTF-8 `JSON.stringify(result.content)` bytes are charged before
delivery, excluding `structuredContent`. An over-budget response is withheld
whole, never clipped; the lookup is aborted with an explicit calls/bytes cause. The
scripted mechanics reader also observes the planned call budget and stops
voluntarily before dispatching an excess call, even during long cursor paths.
The proxy uses an unguessable UUID path, an exact loopback Host check and SDK
DNS-rebinding protection. Effective probe MCP endpoints are allowlisted to the
metered ConversationHistory server only: **SessionHistory is not part of
`lookup-allowed-v1`**, nor is any other history/tool-history alias or MCP server.
Unexpected endpoints fail closed rather than exposing an unmetered route.

The probe deadline is 600 seconds, with a 60-second cleanup allowance, a
690-second turn safety timeout and a 720-second parent-enforced child watchdog.
For probe turns, `maxTurns = callBudget + 2 = 10` stays within the config maximum of 100; this
probe ceiling does not constrain scripted checkpoint replay. Child failures
retain their explicit code and accumulated content-free meter/witness state
even on a nonzero exit. Latency exhaustion is distinct from the hard child watchdog; test clocks prove deadline
admission without waiting ten minutes.

The lookup report keeps **every planned slot**, including missing, duplicate,
unstarted, failed and budget-infeasible slots. Per arm it reports source
availability, reference feasibility, exact-value accuracy (excluding
budget-infeasible slots from both numerator and denominator), witnessed recovery,
calls, bytes, latency and exhaustion. `exact` describes completed eligible
exact-value slots. `exactWithFailures` additionally counts failed feasible slots as incorrect, with a separate
failed-feasible count; missing/not-run slots remain coverage-only, so partial
runs do not masquerade as reader failures. Both accuracy figures and the
failure count appear in the lookup table. Witnesses persist only IDs, digests,
counts and classifications. Recovery requires an initially absent value, an
available retained source fully returned with a verified digest, and a correct
answer. Unknown initial presence/provenance or protected bytes cannot establish
recovery. This is descriptive evidence, not a causal treatment-benefit estimate.
Cross-checkout role attribution and paid qualification are separate work.

## Cross-checkout lookup roles (offline only)

`continuity-lookup-compare.mjs` registers six explicit roles. `pack-cold` below
means the existing `continuity-pack-cold` arm, with no ledger upkeep:

| Role | Arm | Code | Frozen soul |
|---|---|---|---|
| `native` | `native-lookup` | R0 | S0 |
| `pack` | `pack-cold` | R0 | S0 |
| `pack-only` | `pack-cold` | Rpack | S0 |
| `soul-only` | `pack-cold` | R0 | S1 |
| `shipping` | `pack-cold` | Rpack | S1 |
| `native-soul` | `native-lookup` | R0 | S1 |

S0 is `scripts/fixtures/continuity-soul-v1.md`. S1 is the separately frozen
`scripts/fixtures/continuity-soul-v2.md`, exactly the default core after the
ConversationHistory routing change, without a final newline. Its raw and
normalized-core SHA-256 are both
`e625bc0ddb256f336ec66bf94335d260396fa2c5139e37d44f8e0370fef808a9`.
Missing or incorrect soul bindings fail closed; no role follows a moving default.
S1 exceeds S0 by 167 bytes, about 56 conservative tokens (ceil(167/3)). That is
small
relative to the 16k-token context margin, but S1-role feasibility has **not** been
remeasured: the frozen budget and registered reference classifications are unchanged.

Both supplied checkouts must implement **`continuity-lookup-role-v1`**. An old
checkout without role-protocol support is incompatible, not adapted by a hidden shim. Registration
binds clean full SHAs (not ancestry or branch names), independently checked
entrypoint/reader/scorer, lockfile and frozen budget digests, identical corpus
and model settings, and fresh app-closure output hashes. It builds each checkout
using the fresh-clean-head policy, verifies the hashes again before/after each
role, and launches that checkout's lookup entrypoint in a separate Node child.
`--lookup-role` is an explicit offline arm/soul/receipt contract; ordinary lookup and
recall-only plans retain their original digests and behavior.

Rpack must differ from R0 in **at least one** file and **only** the 14 frozen
allowed guidance paths (`GUIDANCE_FILES` in `scripts/lib/continuity-lookup-roles.mjs`).
The diff must include `pack.ts` or `render-fit.ts`, and the exported
`PACK_RETRIEVAL_GUIDANCE` witness must be present in Rpack's `render-fit.ts`
and absent in R0's; reversed roles fail `lookup_rpack_direction_invalid`.
Docs/test-only deltas cannot establish a treatment. Clean checks explicitly
include all untracked files and submodules; assume-unchanged/skip-worktree
index flags are rejected. Complete Git tree comparisons include modes and deletions, also across independent
local repositories; no shared ancestor is assumed. The launcher never fetches,
checks out, cherry-picks, or silently substitutes latest-main. Isolated role/suite
output and state directories prevent shared checkpoints from crossing treatments.

### Maintainer checkout construction and launch

Use Node 24.18.0 and locally available dependencies. The maintainer constructs
these checkouts **after role-protocol support is merged**: Rpack is that clean main revision, R0 is
that same revision with only the original guidance patch reversed. The two
historic local commits below identify the guidance patch, not role revisions;
no historical checkout lacking role-protocol support is run. Those objects must already exist
locally. Stop on conflicts; resolve only the frozen guidance paths, never widen
the accepted diff or silently change a registered revision.

```bash
BASE=$(git rev-parse origin/main)
R0=/tmp/lookup-r0
RPACK=/tmp/lookup-rpack
PATCH=/tmp/lookup-b2-guidance.patch
REG=/tmp/lookup-registration
RUN=/tmp/lookup-run
# All destinations must be unused. This construction is performed by the maintainer.
git cat-file -e '629c1db6f^{commit}'
git cat-file -e 'd76457ba8^{commit}'
git diff --no-ext-diff --binary 629c1db6f d76457ba8 > "$PATCH"
git worktree add --detach "$RPACK" "$BASE"
git worktree add --detach "$R0" "$BASE"
git -C "$R0" apply --reverse --3way "$PATCH"
git -C "$R0" commit -m "test(benchmark): isolate pre-guidance lookup code"
# Prepare cached local dependencies in both checkouts; stop if unavailable.
pnpm --dir "$R0" install --offline --frozen-lockfile
pnpm --dir "$RPACK" install --offline --frozen-lockfile
R0_SHA=$(git -C "$R0" rev-parse HEAD)
RPACK_SHA=$(git -C "$RPACK" rev-parse HEAD)
node "$RPACK/scripts/continuity-lookup-compare.mjs" register \
  --r0 "$R0" --r0-revision "$R0_SHA" \
  --rpack "$RPACK" --rpack-revision "$RPACK_SHA" --output "$REG"
FILE_SHA=$(node -p 'require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex")' "$REG/registration.json")
node "$RPACK/scripts/continuity-lookup-compare.mjs" run \
  --registration "$REG/registration.json" --sha256 "$FILE_SHA" --output "$RUN"
node "$RPACK/scripts/continuity-lookup-compare.mjs" aggregate \
  --registration "$REG/registration.json" --sha256 "$FILE_SHA" --output "$RUN"
```

Registration defaults to the three frozen suites, one repeat, all probes, and
Sol/low with no judge. For a small mechanics smoke, registration may specify
`--suites original --traces brightline-return --probe-limit 1`; the restricted
workload is itself registered, not hidden as missing coverage. `register` always
builds the app closure; dependencies must already be available. `run` requires a
new absolute output directory, not a resume directory. Registration's printed
`sha256` is the raw file hash used by `--sha256`; `registrationDigest` is its
canonical content digest, bound into role receipts.

The separate `continuity-lookup-registration-v1` schema never enters legacy v2
ledger qualification gates. Aggregation verifies role/plan/build receipts and
unit payload hashes and identities before joining planned role × suite × trace × probe × repeat
slots. A nonzero child exit with a verified receipt is recorded in `launches.json`
and does not prevent later roles from running. Missing results/receipts (including
a failure of the child's post-aggregate verification) leave that role's slots
missing with an explicit reason, without discarding other roles. Present tampered
receipts and cross-role replay still fail closed. Missing roles remain missing;
duplicate observations remain duplicate
slots with occurrence counts, never last-write-wins. Ambiguous duplicates are
excluded from exact accuracy and slot cost statistics rather than double-scored.
Each role reports both completed eligible `exact` and `exactWithFailures`, plus
failed-feasible counts. Missing/not-run slots are coverage-only. Infeasible
native paths remain the registered reference limitations, not reader failures
or a newly measured feasibility result for different models.

Contrasts are `pack-only − pack`, `soul-only − pack`, `shipping − pack`,
`native-soul − native`, and `native − pack` as context. Reports retain planned,
paired-completed and failure-inclusive counts, discordant correct counts and
paired descriptive deltas. **These are not significance, power, qualification,
model-quality or treatment-benefit claims.** The automated two-checkout
faux/real-loopback smoke rebuilds both app closures and runs all six roles with a
runtime guidance delta; it adds approximately **3–4 minutes** to CI.

Registration and run output directories must be outside **both** checkout roots,
including through symlink aliases. Registration reserves its new directory before
building either checkout; an existing directory fails immediately. A failed
registration may leave that reserved directory empty; use a new path to retry.

### Offline workload and cost sensitivity

```bash
node scripts/continuity-lookup-estimate.mjs \
  --registration "$REG/registration.json" --sha256 "$FILE_SHA"
# No checkout registration or build is needed for workload-only arithmetic:
node scripts/continuity-lookup-estimate.mjs --suites original --probe-limit 1
```

The estimator performs no provider, network or credential calls and rejects
`--real` before reading artifacts. It reports Sol first, Luna screening, and a
separate fixed Opus sensitivity profile (`anthropic:claude-opus-5-5`, overridable
with `--opus-model REF`), never pooled model results. Installed local catalog
prices may be unknown; missing input/output/cache prices stay unknown, not zero.
Pricing applies the highest strictly exceeded input tier **per call**, including
cached input in threshold selection, rather than pricing the whole experiment
at the base rate or selecting a tier from its combined token total. Reports retain
call-input histograms, tiered-call counts and unknown-price counts.

Conservative sizing uses the maximum frozen observed context bytes/3 and initial
bound versus native's 150k floor/source shape or cold + 12k, plus the S1 and
Rpack guidance allowances. Each returned byte is charged as one input token in
every subsequent round, with the frozen assistant-history replay bound. These
are not new measurements. Output size (300 tokens per round), source-shape
estimates for unseen context, and cache fractions remain labeled heuristics, not
model-tokenizer or invoice guarantees. The 0/2/8 lookup-call levels,
0/half/full returned-byte levels,
repeated input and 0/50/90% cache sensitivities are assumptions, not predictions.
Output includes configured deadline/cleanup/turn/watchdog limits, not measured
latency, power, invoice guarantees, or spending authorization. Provider fees,
reasoning variance, cache writes, model-specific context feasibility and checkpoint
replay wall time are not inferred from a faux run.

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
  repeated verbatim (the `redaction` category). Continuity retention omits a
  whole tool-result string once it contains a textual credential assignment,
  so an identifier that shares a result with such a credential is deliberately
  unavailable to the ledger and the cold pack. A resulting `tool_identifier`
  miss reflects that privacy rule, not a selection or extraction fault;
  no partial salvage of omitted results is attempted;
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
Owner-authored web steers supply `ownerText` bound to the exact steer text, just
as production web does. The trace schema has no steer-author field: replay
assumes every trace steer/interruption is owner-authored web live input.
Anonymous offers, background wakes and mismatched text
remain unknown; no product channel authority rule changes. This attribution
also moves retained steers into owner sections in the pack arm, not just the
ledger arm. Archived results made without this binding are not directly
comparable: any future comparison must use the corrected runner for all arms,
including pack. A valid empty ledger still requires injected pack evidence;
owner, tool, generated-summary or neutral sections all establish its presence.
Reclassifying a steer from neutral to owner evidence does not exclude that trial
or shrink the scoring denominator. A missing pack or one with no evidence
sections remains an invalid treatment.
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
baselines recorded before the feature existed. The prepared-continuity arms (g) and (h) turn
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

### Ledger preparation degradation and integrity

The ledger arm continues all three fresh-child preparations after allowlisted
product degradation, using the last published ledger or deterministic evidence.
Provider/validation reasons are `output_aborted`, `aborted`, `provider_output`,
`empty_output`, `validation_or_publication`, `input_overrun`, `output_overrun`,
and `unavailable` **after invocation**; an unacknowledged dispatch/outcome is
`uncertain`.
Capacity reasons are `input_budget`, `model_headroom`, `ledger_scan_capacity`,
`ledger_render_budget`, `ledger_payload_budget`, `ledger_lineage_budget`,
`ledger_aggregate_capacity`, `ledger_quota_budget`, `source_oversized`,
`upkeep_dispatch_rejected`, `upkeep_repeat_suppressed`,
`already_covered`, `unchanged`, and `no_source`. Results report degradation
reasons and separate `d6InputOverruns` and `d6OutputOverruns` counters.
Output overruns include the explicit reason or a reported `outputOverrun` flag.
Failed output is never a successful extraction or a fabricated generation.

Configuration/eligibility skips (including `read_only`, `disabled`,
`detached_attempt`, `continuation_boundary`, `per_message`, `isolated`,
`unowned_store`, `history_unavailable`, `model_unavailable`, `model_identity`)
and unrecognized reasons are **protocol-integrity failures**, not degradations.
At least one preparation must be non-config-skipped; an all-`read_only`
checkpoint is invalid, not an untreated sample scored as the ledger arm.

The boundary and journal protocol remain fail-closed: unverified model changes,
missing/extra operations, a second consumed bootstrap, duplicate preparation
children, lost prior entries, excessive/repeated offers, upkeep during probes,
or mismatched injection invalidate the checkpoint/sample. A proven non-invocation
may add one unique **released** journal row. Released rows are reported by state
but consume neither bootstrap nor provider offers; the next actual reservation
can still be bootstrap. Conservative reserves use non-released bootstrap rows.
Every new row must match its receipt and the appropriate budget.

Known catalog usage/cost and unknown-call conservative charges are separate.
An unknown upkeep call reserves the full input allowance (128k bootstrap or 64k
incremental) plus 4096 output tokens at catalog prices, never merely its visible
input estimate. Unknown/unpriced reservations remain disclosed, not reported as
zero-cost known calls. **This is accounting, not an invoice guarantee:** Codex
`stream_abort` does not enforce a remote output cap; hidden reasoning or remote
work can exceed reservations. This limitation also applies to earlier paid runs.
See the [ledger budget limits](./continuity-ledger.md) for the unchanged D6 rules.

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
entries. A valid analysis-only stage can preserve the same generation without
adding entries; it still consumes and accounts one admitted operation. The offline
fixture deliberately returns an empty second delta to exercise that path. All processes use the same absolute durable roots and normal ownership;
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
call. If reported input, output, or cost is missing, a potentially invoked call
is unknown and receives a full conservative reservation: 128k bootstrap or 64k
incremental input plus 4096 output tokens at catalog prices. `conservativeCalls`,
`conservativeCostUsd` and `unpricedConservativeCalls` are separate from known
`estimatedCostUsd`. A partial finite cost is NOT added on top of that full
reservation. Missing catalog pricing remains explicitly unpriced, not free.
These reservations are accounting, not an invoice/remote-output guarantee;
Codex `stream_abort` cannot cap hidden reasoning or remote work. This limitation
also applies to earlier runs. Strict request-cap mode remains available.

`conservativeInputTokens` carries the full inclusive unknown input reserve into
invocation admission and `observedInput`, even when a smaller partial input count
was reported. Otherwise reported input/cache counts or the inclusive input
estimate apply. The larger observed input wins on overrun; cache tokens are not
added twice. Stale input-only estimated-paid fields have been removed.
A failure after paid preparation (including checkpoint statistics, cleanup or
fork publication) preserves the partial checkpoint's upkeep in unit errors,
`results.upkeep` and aggregate usage. Compact Codex coverage counts only cited
spans; the three-boundary treatment can still be incomplete. It never adds
coverage-hole or repair calls beyond the confirmed three reservations.
Per-preparation receipts and usage components retain known subtotals and unknown
calls separately, without counting the aggregate again. A lost child acknowledgement
retains its conservative input allowance and invalidates the unit; an external
spend controller must retain the corresponding monetary reservation.
Journal snapshots reconcile operation IDs across stages, not just count deltas.
A pre-dispatch `reserved` row may become `released` at the next claim without
consuming bootstrap or offers. Both states are non-consuming; only dispatched,
non-released rows determine whether lost-ack input reserves use 128k or 64k.

For fictional-only diagnostics, `--capture-upkeep-output` opts into saving the
raw extraction completion, stable validation `failure` code and merged validated
ledger under `OUTPUT/upkeep-output/r<repeat>-<trace>-p<1|2|3>.json`. It requires an explicit output
outside the checkout (also offline), uses owner-only files, refuses existing
capture files, and is **off by default**. Captures are benchmark artifacts, never
written into the continuity store or exposed by production runtime configuration.
No prompt or credentials are captured; model, auth, SSE and caps remain unchanged.

### Free selection replay baseline

`scripts/lib/continuity-selection-replay.mjs` is a reusable, provider-free helper
for three preparations through the real retention, upkeep source selection,
fitting and durable offer settlement. Its regression test in
`scripts/__tests__/continuity-benchmark.test.mjs` uses development-generator
seeds and newly authored fictional transition/pressure cases, not holdout data.
It returns exact fitted source descriptors and their retained records on every
pass, including the deliberately empty second delta. Compact snapshots pin
those offers by digest, counts, owner ordinals, caps and budget projections.
The candidate gives never-offered, host-attested owner paragraphs of at most
256 UTF-8 bytes a bounded score bonus, with no vocabulary or tool-header priority.
Source round robin, oldest-never-offered fitting reservation, caps and budgets
remain unchanged. `scripts/__tests__/continuity-selection.test.mjs` compares
three-pass candidate offers with frozen base counts and source digests captured
using the preceding selector. It requires the previously missed fictional
completion report and suggestion to be offered, preserves base-offered owner
constraints/next actions in the same pass, and retains at least 80% of base tool
record counts per pass without lowering fitted-span counts or delta caps.
Fictional owner/tool floods also check that the opposite source is still offered
within three passes. These are deterministic availability regressions, not
extraction quality or semantic commitment/constraint/next-action scores.

The helper's source-only trace projection is not the full benchmark harness.
The benchmark still requires exact ledger injection counts and its scripted
empty-pass check. Cumulative published `ledger.inputs` cannot reconstruct an
empty pass's offers; archived completion captures and aggregate exclusion
counts do not provide that missing record-level evidence.

### Evaluation independence limitation

The label-kind rules were introduced after inspecting category findings in this
benchmark's audit: this is **dev-set tuning**. Worked examples from its scenario
families have been removed, leaving generic kind/tense definitions. A regression
test rejects stopword-stripped three-word overlaps from all generator string and
template literals in the production prompt and ranking constants, including
fragments separated by interpolations. This check cannot establish conceptual independence.
Label-precision numbers remain optimistic; neither an independent holdout result
nor a causal ablation is claimed.

Chronology uses host-cited source positions: extraction inputs are source-ordered,
and rendered entries carry their latest cited ordinal in ascending order. This
does not prove event time or make derived relative-order prose authoritative.
The manual interpretation audit, not the scorer, reports chronology findings
as part of context findings and also separately.

Source metadata admission is already bounded: `validateRecord` closes the keys,
`safeMetadata` caps the three optional metadata strings at 512 bytes each,
`normalizeId` caps the attested input ID at 4096 bytes, and the request digest is
64 hex characters. Even pessimistic sixfold JSON escaping plus the fixed keys and
safe-integer revision stays below 36 KiB, less than the scan's 64 KiB source cap.
Oversized writes are rejected before publication; admission-boundary and healthy
scan tests cover this. Corrupted on-disk rows still fail closed rather than being
accepted as authentic source metadata.

## External frozen lookup preparation (offline only)

An explicit lookup source is `{manifestPath, manifestSha256,
statisticalSpecPath}`. `loadTraces({suite: "holdout", lookupSource})` reuses
`loadFrozenHoldout`, including freeze/tooling/runtime verification and trace
hashes. This is not legacy holdout registration, ledger selection or
qualification. Recall-only plans and checked-in lookup plan digests remain unchanged.

Use the existing validate/overlap/freeze commands with `--statistical-spec FILE`;
expanded overlap references invalidate earlier overlap reports, which must be regenerated before freezing;
see the [holdout preparation guide](../../scripts/continuity-holdout/README.md#smaller-external-lookup-populations).
The transport specification's `repeats`, shard dollar cap and statistical gates
are ignored by lookup, which explicitly requires one repeat. Preregister an integer seed **before** measuring and pass `--selection-seed N`
(and optional `--per-group 2`) consistently to budget, estimate, register and
benchmark planning. `seeded-sha256-rank-v1` sorts the frozen family IDs, ranks
by SHA-256 of `${seed}:${id}`, and takes two families per group. Each family has
one conversation. The algorithm, seed, per-group count and selected family IDs
are bound into the policy, registration and plans. Explicit external `--traces`,
`--lookup-traces` and execution `--trace` selections are refused. Unselected
families are sealed spares, not outcome-driven replacements.

External-only workload flags (`--selection-seed`, `--per-group`, `--lookup-policy`
and its hash, `--output-limit` and its source, `--catalog-cap-usd`) are refused
without the complete manifest/hash/statistical-spec source triple. Checkout
roots `--r0`/`--rpack` remain required for legacy registration; in estimation
they require an external source. Legacy budget sizing still accepts only
`--output`; fixed-budget sizing requires an external source. These flags never
silently fall back to a legacy workload.

```bash
node scripts/continuity-lookup-budget.mjs \
  --r0 /external/r0 --r0-revision FULL_SHA \
  --rpack /external/rpack --rpack-revision FULL_SHA \
  --corpus-manifest /external/frozen/manifest.json --manifest-sha256 SHA256 \
  --statistical-spec /external/statistics.json --selection-seed N --per-group 2 \
  --fixed-budget-sha256 RAW_V1_POLICY_SHA256 --output /external/new-sizing
```

This fixed-budget, feasibility-only path never derives limits: eight calls,
126,976 returned bytes, ten rounds and unchanged deadlines. Each role × selected
conversation × probe combination is one slot: six roles ×
four conversations × 15 probes = **360 slots** with `--per-group 2` and no probe
limit. Every slot records observed initial context and initial admission.
Identifiers use that role's sanitized store and digest-verified reference path;
other questions use an explicit conservative full-budget envelope, independent
of identifier provenance. Classifications are recomputed from recorded metrics
and failure evidence when a policy is read. Only call/byte exhaustion is budget
infeasibility; latency and other exhaustion causes are unknown and block pricing. Unknown reference feasibility blocks pricing approval.
The content-free `budget.json` binds source/spec/selection, reader, protocol,
clean code/build bindings and the raw v1 policy hash. It contains no questions,
answers, retrieved text or narrative. Scratch replay stays private and is removed.

For estimate and compare registration, pass the same source/selection plus
`--lookup-policy /external/new-sizing/budget.json --lookup-policy-sha256 SHA256`,
`--output-limit N --output-limit-source catalog_max` (N must equal the selected
model's catalog maximum) or `enforced` (requires separate execution proof).
`continuity-lookup-estimate.mjs` accepts these flags directly or a hash-bound
`--registration FILE --sha256 SHA256`. Compare `register` also requires
`--catalog-cap-usd C`, exactly reproducing the estimate. External registrations
use v2; v1 default registration shape and legacy plan digests remain unchanged.
A standalone offline benchmark uses `--suite holdout --probe-mode lookup-allowed-v1`
with the source triple, `--selection-seed N --per-group 2`, both `--r0`/`--rpack`
roots (or a policy that binds them), and optional hash-bound policy. Role-aware execution passes role-filtered policy paths through plans, receipts and scoring.

Pricing retains planned denominators, excludes inventory-infeasible slots and
blocks unknown slots. It reports per-role/per-trial expected, worst/reservation,
lookup overhead, tier crossings and C/expected. Expected is only a scenario:
two lookups, half the byte budget, 50% cache and 300 output tokens per round.
Reservation uses **ten rounds**, **no cache**, the **full catalog context input
bound on every call** (including replay) and the explicit per-call output limit.
C is `ceil-to-cents(1.25 * summed eligible reservations)`, a run-wide proposed
catalog-equivalent cap, never a per-shard cap or spending authorization.
Missing catalog, selected model, rates (including tier/cache rates), context or
output limits block numerical approval rather than becoming zero or unknown-allowed.

### Pilot readiness and inventory skips

`lookupPilotReadiness()` in `scripts/lib/continuity-lookup-roles.mjs` is a
pure diagnostic, not authorization. It reports separate output-cap,
input-envelope and pricing readiness; unknown or unsupported components block.
In ordinary mode for `openai-codex:gpt-6.1-sol`, the output cap is
**unsupported** and the backend input envelope is **unknown**, so `ready`
remains false. The separate cap-gated artifact mode accepts registered
assumptions only with a validated bound authorization. Before authorization,
complete pricing/assumptions report `awaiting_authorization`. Catalog readiness
requires complete assumption-compatible rates and limits; it is not billing or
backend-enforcement evidence. There is no caller-supplied capability override.

The installed Pi Codex serializer is tested with its actual provider URL/model,
synthetic unexpired credentials and an injected `options.fetch` that never
forwards. The test decodes zstd when present and captures exactly one attempted
send: reasoning effort survives, but no max-output field is serialized.
This negative evidence does not test backend acceptance or reasoning-inclusive
enforcement. Payload mutation, if tested separately, is **serialized only**,
never enforcement evidence. `catalog_max` is an offline modeling assumption,
not a proved transport ceiling. Byte geometry alone does not establish backend
tokenization, framing or opaque reasoning-restoration bounds.

`lookupSlotDisposition()` recomputes role-specific inventory feasibility before
`execute()` loads the runtime, builds checkpoints or admits provider work.
Inventory-infeasible slots get `infeasible` records with the fixed
`inventory_infeasible` code, no provider usage/count, score, reservation or
manufactured completion. Mixed units dispatch only eligible probes; all-skipped
units need no checkpoint. Skips retain the planned denominator, are reported
separately and are not missing observations or reader failures. Skipped units
are not marked complete, so partial coverage remains visible with a nonzero
exit. Units separately record whether all eligible probes have terminal results;
resume leaves terminal mixed/all-skipped units untouched without replaying their
finished eligible probes. Unstarted eligible work remains retryable. The generic
Failed column excludes inventory skips but still counts actual failures.
Unknown feasibility blocks execution; absent observations with unknown
inventory remain missing, not inferred completions. The `blocked` count measures
slots with `lookup_unknown_feasibility`, independently of observation status;
it can overlap missing or duplicate observations. Lookup Markdown reports show
skipped, blocked and missing counts explicitly. The distinct later refusal
codes `not_admitted_input_envelope` and `not_admitted_cap` are reserved but not
used by this offline preparation path. Feasible inventory is not an input-envelope
proof. A present empty/whitespace `--fixed-budget-sha256` fails with
`lookup_empty_fixed_budget_sha256` before workload/source validation.

Dollars do not predict subscription quota: report token/turn envelopes, not a
dollar-to-quota conversion. **All real-execution refusals remain in force**;
no real dispatcher, active admission controller or provider reservation is
implemented here. Separate pilot artifacts register the cap policy and validate
single-use local authorizations; they do not dispatch. Faux accuracy proves
mechanics only. Protocol-covered script changes
invalidate older code-bound registrations; regenerate them for matching clean
checkouts, not as execution approval. All raw content and private artifacts
stay outside checkouts; share only counts, IDs, hashes and numerical summaries.

### Offline guarded request contract

`scripts/lib/continuity-lookup-guard.mjs` exports `guardedLookupModels(models,
{ contract, permit, send, assumptions })`. It is plumbing, **not execution authority**:
no pilot command, controller, authorization, or real route is enabled. All seven
existing refusal sites remain unchanged (compare parser/main, benchmark
main/execute, runner non-offline branch/enclosing lookup guard, and probe child).
The private runner branch is still unreachable for non-offline lookup; it is not
itself an authorization check. Ordinary readiness remains false.

Create one wrapper per sequential probe run with unique `runId` and `slotId`.
`LOOKUP_GUARD_CONTRACT` freezes version `lookup-guard-v1`, the exact Sol
provider/model/API/base URL and high effort. Only `streamSimple` may dispatch;
other request methods, including native handoff `completeSimple`, refuse with
`lookup_method_forbidden` and classification `failed/pilot_method_forbidden`.
Metadata/auth access preserves its receiver; provider metadata cannot expose an
unguarded dispatch method. Request options are allowlisted from Pi's simple
options and the agent-loop configuration. A matching loop-supplied `model` is
allowed; a changed identity is not. Every call requires SSE and `maxRetries: 0`;
the construction contract binds `piMaxRetries: 0` and `maxRetries: 0`. Retry
budgets/profiles, unknown options and caller `options.fetch` (even undefined)
refuse. The latter returns `lookup_external_fetch_forbidden`, preventing the
turn's outage-profile retrying fetch from being used. The sole transport is the
constructor's trusted single-shot `send(url, init)`, never a retry wrapper.
The follow-up pilot controller must select the corresponding non-outage runtime
configuration. No fallback,
context1M or per-request route substitution is allowed.

The turn advanced option `piModelsDecorator(models) => models` wraps normally
constructed, credentialed Models before dispatch. It is exclusive with
`piResolvedModels`. It does not replace or duplicate OAuth resolution/refresh.
It is **not propagated** to Models rebuilt by continuity upkeep or provider-check
preparation. The follow-up pilot controller's resolved auxiliary-callers check
must prohibit those paths;
the decorator alone is not a guard over every runtime caller.

The optional contract `promptCacheKey`, if supplied, must contain the unique
per-probe `runId`. A payload cache key must exactly match it; without a declared
key, payload `prompt_cache_key` is forbidden. The follow-up pilot controller must
assign distinct run IDs/cache keys across slots and arms. The real turn exposes
`providerAttributionSessionId`: the host-turn test sets it to the declared key,
which becomes the native session metadata ID and the serializer's `sessionId`.
The guard also binds emitted `session-id`/`x-client-request-id` headers to that key.

Non-empty caller `options.headers` and `options.env` are refused before admission;
the real harness needs neither. Before consumption, send headers are limited to
`originator`, `user-agent`, `authorization`, `chatgpt-account-id`, `openai-beta`,
`accept`, `content-type`, `session-id`, `x-client-request-id`, and
`content-encoding`, compared as lowercase names. Unknown headers stop without
sending. A fetch entered without admission also awaits an integrity stop.

The last composed `onPayload` runs existing mutation hooks first, then checks the
final payload and computes:

```text
U_k = UTF8Bytes(JSON.stringify(finalPayload))
    + sum(previous settled raw output_tokens in this probe run)
    + H(finalPayload)
I = 272000; O = 128000
```

Opaque reasoning is prohibited in payload 1. Images, remote content, unsupported
input items and non-function tools refuse. Pi replays server reasoning items
verbatim from their thinking signatures. Reasoning `content` may be absent,
null, an empty array, or one `{type: "reasoning_text", text: string}` item; these
bytes are counted in U like the encrypted content and summary. Top-level payload
keys are allowlisted
from Codex `buildRequestBody`; each supported input item has its own key allowlist.
Stored-input expansion fields such as conversation/prompt/background/truncation
are refused before admission. Requests 1–10 may be admitted; request
11 refuses before any hold or send. `U_k > I` returns
`not_admitted_input_envelope` before admission. JSON is detached from earlier
mutation hooks, and the guard compares the final serialized (or zstd-decoded) body
to its locally retained admission digest before calling `consume`. A mismatch
is `lookup_body_mismatch`, even if the injected permit source does not compare.
No default/global fetch is used.

Only raw `response.completed`/`response.incomplete` with integer
`input_tokens >= 1` and `output_tokens >= 0` can settle. Zero or negative input
is `lookup_invalid_usage`. Normalized message usage is never
used as a substitute. Missing usage, a failed response, or a lost stream retains
the hold and makes that probe run terminal. Any later request in the run refuses
pre-send with `lookup_slot_terminal`, without a new hold, send or pilot stop. Raw
hooks compose without allowing later hooks to
rewrite the captured usage. Tiers are allowlisted: `default` 1×, `flex` 0.5×,
`priority` 2×; an absent or null tier settles conservatively at 2×. Unknown
non-null tiers stop.
Input includes cache reads/writes; reasoning is not added again to output.
Post-settlement violations of input ≤ U, output ≤ O, reasoning ≤ output, valid
cache breakdowns, or catalog cost ≤ hold cause sticky integrity stops. Failed
response events also validate a reported tier: an unknown tier stops, while a
known/absent tier leaves failed usage lost. Empty or length-terminal replies cannot issue a finalization request: the refusal is
`pilot_empty_final_output`, classified `failed/pilot_empty_final_output`.

#### Frozen permit interface

`LOOKUP_PERMIT_CONTRACT` freezes interface version `lookup-permit-v1`. The
injected source implements four awaitable methods. Opaque permits must be
bound by the future controller to its live epoch, worker, slot, round, sequence,
payload digest and reservation; the wrapper supplies the request-side bindings.

```text
admit({ requestId, slotId, round, payloadDigest, rmax })
  -> opaquePermit | { refused: true, code }
consume(opaquePermit, bodyDigest) -> void
settle(opaquePermit, { kind, code?, cost? }, rawUsageOrNull, rawTierOrNull) -> void
stop(code) -> void
```

The guard installs its own `options.fetch` and latches entry before any await.
A dispatched permit is consumed once after the body digest/URL check, then the
guard invokes its construction-time single-shot `send` once. A second fetch
entry is an integrity stop and never invokes `send` again, including overlapping
calls. An admitted request may fail before send, retaining its hold as lost;
therefore the guarantee is **at most one send per permit**, not that every
admission sends. The guard independently rejects body mismatch before
consumption; the permit source must also reject digest mismatch and reuse.
`settle` runs once per admitted request; a missing
tier stays null in the record while `cost` uses 2×. Unknown tiers are redacted to
null with a fixed integrity code. Usage records allowlist only numeric input,
output, cache-read/cache-write and reasoning counts, preserving optional-field
absence rather than forwarding arbitrary raw-event fields. The source must persist the
hold before granting, reject stale/disconnected epochs, enforce sticky stops,
and retain unknown/lost reservations. It owns durable cap admission and pricing
accounting; the guard checks the frozen catalog arithmetic independently.

| Outcome kind | Hold | Stop policy |
| --- | --- | --- |
| `refused_pre_send` | None for this request; no permit settlement | Capacity/terminal refusal continues; policy violation stops |
| `own_abort_after_send` | Retained as lost | Continue pilot; slot terminal |
| `settled` | Replace with actual catalog cost | Continue |
| `lost` | Retained, including admitted abort before fetch | Continue pilot; slot terminal |
| `integrity_stop` | Retained | Sticky pilot stop |

Refusals thrown inside `onPayload` before admission propagate even if the
provider normalizes them into zero-usage errors; they are not pilot-wide stops.
After admission, failure before fetch is conservatively lost, not a fictitious
no-hold refusal. Own deadline/latency aborts after send retain the hold without
immediately stopping the pilot. A later request in that terminated run is not
admissible and returns `lookup_slot_terminal` without a pilot stop. Only an
`integrity_stop` closes pilot admission. The guard's result/terminal iterator
awaits `permit.stop()` before rejecting. A stop rejection preserves the original
integrity `code`, adds `stopCode: "lookup_stop_failed"`, and keeps the IPC error
as `cause`; if settlement also failed, `settleCause` retains that error. It never
becomes an unobserved fire-and-forget operation.

`createTestOnlyLookupPermitSource()` is the only implementation shipped here;
it is branded `lookup-faux-test-only-v1`, `testOnly: true`, in-memory and
non-durable. `assertRealLookupPermitSource()` rejects it. Future real-route entry
must call this guard and independently validate authorization; a brand is not
an authorization credential. No body, response text or credentials enter permit
records. The smoke uses two real local processes, loopback MCP and the installed
serializer hosted by faux Models with injected scripted SSE; external sockets,
fetch and WebSocket are denied. A separate integration test uses the same public
host runtime entry as the benchmark, with `piModelsDecorator`, fake OAuth,
the installed serializer and scripted SSE `send`, across two rounds including
a real local tool execution and verbatim encrypted reasoning replay. A second
real-turn case selects the outage retry profile and proves it refuses caller
fetch with zero sends, admissions or holds. No real route is enabled by either
proof.

#### Registered assumptions: assumed-v1

`LOOKUP_ASSUMPTIONS` is deeply frozen and versioned. These are **assumptions, not
backend enforcement evidence**. For the pilot they replace the earlier
requirement for a proved backend framing
allowance before any admission, and replace the fixed maximum-output allowance
for every replayed response with the sum of settled output usage. Authorization
from the follow-up pilot controller must bind the entire registry, formula,
values and catalog rates.

| Assumption | Registered value / check |
| --- | --- |
| Literal input tokens ≤ UTF-8 bytes | Entire serialized payload counted; check reported input ≤ U |
| Framing H | 4096/request + 256/input item + 1024/reasoning item + 1024/tool + 256/schema property + 4096 if instructions exists |
| Output includes reasoning | Require reported reasoning ≤ output; never add it twice |
| Restored reasoning ≤ prior settled output | Sum prior raw settled output; unknown predecessor blocks next admission |
| Catalog max output | 128000; reported output above this falsifies the bound |
| Max tier multiplier | 2×; unknown tier stops, absent tier priced at 2× |
| Reservation Rmax | 2 × (272000 × 2.5 + 128000 × 10) / 10⁶ = $3.92 |

H deliberately overcounts: one 4096-token request/instructions slab each, one
256-token slab per input item/property, and four slabs per tool/reasoning item.
Properties count recursively through tool schemas. These generous power-of-two
allowances have no proved backend derivation. Literal content remains in B,
including schemas, instructions, signatures and JSON syntax; replayed visible
output is deliberately counted both in B and prior settled output. Rates per
million are input 2, output 10, cache-read 0.1 and cache-write 2.5. The input tier
above 272000 is excluded by I; the threshold is strict. Each settlement checks
the observable implications above, but cannot independently prove tokenizer,
framing or encrypted-restoration semantics. An overrun falsifies the assumption;
a stop cannot retroactively undo spend.

`assertLookupAuxiliaryCallersOff()` and `assertLookupChildSafety()` require
`plan.judge === null`, explicit false for memory/subagents/upkeep/compaction and
no output schema. The follow-up pilot controller must call them on resolved
configuration at pilot entry
and in each child before model preparation. The faux smoke exercises the child
check; the existing production child still refuses every non-offline lookup.
Controller leases, durable permits, accounting, concurrency-one scheduling,
resume refusal, authorization, readiness extension and re-registration are not
part of this offline contract.


### Cap-gated pilot artifacts and local attestations

The separate `continuity-lookup-pilot-registration-v1` schema wraps an unchanged
external full-upfront registration and a
`continuity-lookup-pilot-descriptor-v1` descriptor. It is not a legacy
registration and cannot enable the ordinary paid lookup routes. All seven
ordinary refusal seams remain in force. There is no enabled pilot dispatcher or approval
issuer or authorization builder in these artifact helpers.

The descriptor registers `cap-gated-v1`, an explicit numeric cap C, concurrency
one, the complete `assumed-v1` registry and its digest, catalog binding, schedule
seed/version/digest, deadlines and `controller-issued-transport-key-v1` cache
policy. The schedule registration binds the inventory and selection; these
helpers do not execute a schedule or allocate cache keys.

The offline estimator uses exact decimal rational money arithmetic. It reports:

- E and its scenario: two lookups, half the returned-byte budget, half cached
  input, three rounds of up to 300 output tokens and 900 input allowance tokens
  per round, at the default service tier; this is not measured usage;
- Rmax = 2 × (272,000 × maximum applicable input/cache-class rate +
  128,000 × maximum applicable output rate), divided by one million;
- C, C − Rmax and C/E (null when E is zero).

Sol's registered rates pin Rmax to $3.92. The maximum input-class rate includes
cache writes ($2.50/M), not just uncached input ($2/M); the maximum output rate
is $10/M. Only strictly exceeded input-tier thresholds at I = 272,000 apply.
Missing prices, changed base assumptions, changed catalog bindings or an altered
maximum refuse validation. C must be at least Rmax, in whole cents representable as a safe integer. A corrected full-upfront
comparison remains available: ceil to cents of 1.25 × ten maximum reservations
per eligible slot. It is not the admission gate, and the nested legacy
registration retains its original full-upfront validation unchanged.

`continuity-lookup-estimate --registration FILE --sha256 SHA256` accepts the
separate pilot registration for this offline estimate. No credential is read
and no provider is contacted by estimation. Artifact helper APIs are in
`scripts/lib/continuity-lookup-pilot.mjs`; they do not add a CLI execution route.

The registered accounting total is
`T = sum(complete settled) + sum(max(retained hold, known partial)) + sum(active holds)`.
Admission would require `T + Rmax <= C`. Lost requests and own aborts, including
own latency aborts, are incomplete rather than invalid. Two consecutive such
admitted slots trigger `lookup_repeated_loss`; other admitted terminal slots
reset the streak, and unadmitted slots do not affect it. Alternating losses are
still bounded by C, not by that consecutive-loss rule. These are registered
rules only; the controller and accounting adapters are not supplied here.

Ordinary readiness is unchanged and false. Cap-gated diagnostics independently
show pricing and registered assumption readiness. With complete pricing and
assumptions but no valid bound attestation, status is `awaiting_authorization`
and its sole blocker is `lookup_authorization_required`, not unsupported caps
mixed with missing authorization. Only a locally validated, descriptor-bound
attestation can promote the assumed input/output components to ready. Incomplete
pricing still blocks. Readiness is diagnostic, never dispatch authority.

#### Private authorization and consumption

A real-schema authorization is a trusted local attestation, not cryptographic
proof of the approver's identity. Provisioning remains an external trusted-owner
operation after fresh registration and separate numeric-cap approval. There is
no production issuer, builder, environment upgrade or faux-to-real conversion.
The faux schema has a distinct registry domain and cannot pass the real
validator.

The private attestation binds its ID, both raw and canonical registration
hashes, controller checkout, both code/build bindings, protocol, catalog,
policy/source/selection, reader/effort, complete descriptor including all
assumptions, cap, schedule, cache policy and deadlines, canonical external
output root and credential location. It also binds a random salt and a
domain-separated commitment to the Codex account ID, plus timestamp, approver
and numeric-approval reference. Account validation uses the resolver's local
`readCredential` method without OAuth resolution or refresh, matching the same
JWT account claim as Codex. Same-account token rotation is allowed; account
substitution refuses. Tokens, token hashes, paths, path hashes, salt and account
commitment never leave the validator through its opaque handle or consumption
result. The private attestation and markers are not public exports.

The real registry is fixed from `os.userInfo().homedir`, never `HOME`, XDG,
configuration or arguments:
`~/.local/state/mono-agent/lookup-pilot/consumed-v1/<key>/`.
The key is SHA256 of the real domain followed by the authorization ID **only**;
reformatting or renaming the artifact cannot create a second use of that ID.
The raw artifact digest is stored inside the private claim, not in its key.
Output and registry must be disjoint, outside both registered checkouts, and
have owner-safe ancestors. Pilot directories are private. No-follow reads,
owned regular files, single-link checks and private file modes reject aliases.

Acquire an opaque lease with `acquireLookupPilotLease(outputRoot)` from
`scripts/lib/continuity-lookup-lease.mjs`, pass it as the third argument to
`consumeLookupAuthorization`, and retain it until controller shutdown. The
helper exclusively creates a private SQLite lease, records this process's PID
and UTC/C-locale start identity, and holds a writer transaction. Consumption
checks the active local handle, controller metadata and SQLite lock. Lease
identity checks use `lstat` only: opening and closing a non-SQLite descriptor
would release this process's POSIX locks, even with the SQLite transaction
still marked active. A matching filename, empty file, unrelated database or
released/fabricated handle is not proof. Real child-process tests demonstrate
that writer exclusion survives consumption and repeated identity checks;
a reader in another process accepts the live lease and refuses after release
or controller death. The legacy holdout controller keeps its original persisted identity
semantics and is not imported by the lookup identity helper.
Failed acquisition closes SQLite before removing only its own still-matching
lease inode; it does not delete pre-existing or replacement files.

Under that verified lease:

1. Revalidate the attestation, bindings, safe files and local account. Require
   the root to be unused (except its lease), with no `units/` or fixed marker.
2. Exclusively create the registry entry first. Its existence alone burns the
   ID. Each registry ancestor's parent is synced before advancing, even after EEXIST,
   and the entry's parent is synced before either claim is written.
3. Exclusively write and sync `authorization-consumed.json` in the output root,
   then `claim.json` in the registry entry via `durable()`.
4. Verify the complete matching pair before setup. Claims bind authorization
   ID/raw digest, output root, run ID, controller epoch and controller PID/process
   start identity, plus output-root device/inode and lease-file device/inode.
   Verification rechecks these filesystem identities without opening the lease
   through filesystem read helpers, and checks the held SQLite writer lock.
   Private JSON reads reject known lease aliases before opening them, then
   compare the opened inode too: detecting a raced live lease permanently
   invalidates it, so later local assertions and verification refuse.
   A recreated root with a copied-back marker cannot pass. There is no nonce
   file or IPC message authentication.
5. Only **after consumption**, launch children. Future child setup must check
   its parent PID against the recorded live controller PID/start identity.

A partial or corrupt pair is permanently unusable. There is no identical-claim
replay, repair or rollback. Recreating the output root does not undo a burn.
A hostile same-user actor can still race trusted paths; detection invalidates the affected lease rather than restoring its OS locks.
The registry guards ordinary crash/root recreation, not deliberate destruction
of all trusted per-user state. CI and debug-variable presence always refuse in
production. Unit tests redirect only the home lookup to synthetic temporary
homes. They exercise real frozen fictional inputs, clean temporary checkouts,
deterministic local builds, pilot registration validation, Pi credential reads,
SQLite locks and synced filesystem writes. They assert credential bytes, inode
and mtime remain unchanged across validate/consume/verify, including expired
fictional credentials. Build fixtures do not share writable `node_modules`
directories with the source checkout: dependency-free authorization builds
use selected read-only package imports outside their pnpm workspaces. Fixture
pnpm commands are offline with dependency verification disabled and never
install. Suite-level witnesses check the source dependency entry list, state
file bytes/mtimes and Vitest executable before and after tests.
Success fixtures clear CI only in-process with egress
denied. They do not launch a production child with CI
removed, access real credentials or write the user's registry. Physical
power-loss durability, backend framing/billing assumptions and live OAuth are
not established by these offline tests.


### Pilot controller and partial reports

The internal `runLookupPilot` controller currently accepts only
`continuity-lookup-faux-authorization-v1`. A real-schema authorization refuses
with `lookup_pilot_real_route_unavailable` before artifact-driven setup or lease acquisition. There is
a closed `pilot` command; real send construction is child-gated and its production
entry remains unavailable pending the separate process proof.
Faux runs are accepted under CI; debug-variable presence refuses in every
process. Neither controller nor worker removes CI from its environment.

The controller runs from the registered R0 checkout after verifying both clean
checkouts, builds and protocol. It talks **directly to one detached probe child
per slot**, rather than relaying through a role parent: this reduces admission
peers and makes containment and the parent/child disk witness explicit. The
child independently verifies its registration, role request, reconstructed
plan, build, assigned PID, live parent start identity and writer lease before
ready. The controller persists a unique ASCII transport `cacheKey` for every
slot (at most 64 characters, never truncated), and records uniqueness. The child
checks membership and uniqueness before constructing its contract. The guard
requires that exact key in `prompt_cache_key`, `session-id` and
`x-client-request-id`; all three must be present. Only the inner serializer
receives this key as its `sessionId`. Harness/runtime session IDs, native
authority, provider session IDs and restored messages are not replaced. Native
and pack slots use the same allocation policy. Configured-harness tests use
faux sends only; the real route remains unavailable.

One serialized writer holds the lease from faux consumption through reporting.
The faux burn registry has its own domain under the output's parent, never the
real per-user registry. A fixed consumption marker precedes the epoch/schedule
snapshot and any launch. The seeded schedule freezes conversation/probe pair
blocks and interleaves all roles within each block, at concurrency one, without
spares, retry, resume or public-trace substitution.

Guard admission, consumption, settlement and stop use lockstep IPC, with no
retries. Epoch, slot, worker identity and the expected next message bind each
exchange. Holds and one-time consumption are persisted before acknowledgement;
the client independently reads the acknowledgement from disk. A disconnect,
integrity error or timeout stops and contains the owned group before another
slot can start. Settlement remains legal after a sticky stop, never admission. An IPC stop
allows a bounded 250 ms settle grace, drains messages already received, then
contains the owned process group;
unreconciled containment is an absorbing safety stop taking precedence over
other causes. The child waits for a `done-ack` before disconnecting; the controller
records descendant membership before sending that ACK. Timeout and disconnect
containment also persist proven membership before the first signal, so a leader
exiting on SIGTERM does not strand a SIGTERM-resistant descendant. This is production
synchronization, not a fixture delay. Surviving descendants cause a durable
`lookup_worker_lost` stop before signalling. Before each signal, the controller re-proves a recorded member
alive with the same start identity and process group: either the original
unreaped leader, or a descendant observed while that leader pinned the group.
Descendant identities are persisted from a content-free process snapshot. A
live group with no re-proven member remains unreconciled and is not signaled.
These POSIX observations are not atomic kernel capabilities.
Recovery is observation/reconciliation only: it never launches, readmits or
signals a previously recorded process group.

Money comparisons use exact half-tenth-microdollar units. Total admission spend
is complete settled cost plus max(retained hold, independently priced known
partial) per uncertain request plus active holds. Known partial usage is
computed on integrity outcomes too, even when the cost claim is wrong. Missing
service tier retains 2× pricing. Legacy holdout accounting is unchanged unless
its explicit lookup adapter is selected; no ledger unit is fabricated.

Validity counts admitted slots, not requests. Lost and own-aborted slots are
incomplete, not invalid; wrong answers complete an observation. Admission
capacity refusals without holds are unadmitted; a capacity-refused later round is incomplete,
never a provider loss. Empty final
output is invalid, and strictly more than 10% invalid admitted slots stops.
Two consecutive admitted provider-side losses stop the run. Own latency aborts neither count toward
nor reset that streak; skipped/unadmitted slots are also invisible. Other
admitted terminal slots reset it. Alternating losses with completed slots are
bounded only by C.

Partial slot receipts are synced independently of worker exit. Aggregation
refuses duplicate, changed, unplanned and unvisited receipts. Planned and
eligible totals describe the entire frozen inventory. Execution status counts
(skipped, unadmitted, admitted, completed, incomplete, invalid and missing)
cover visited slots only. In a partial view the assigned in-flight slot is
visited: it counts as unadmitted before its first admission and as incomplete
once admitted. Unvisited slots remain in inventory totals and schedule
truncation, never in execution status counts. Journal status counts and missing
receipt copies are independent coverage counters;
paired blocks require verified receipt copies. Reports
are strictly projected to opaque identities, content hashes, fixed codes and
numeric usage/cost/scoring. They exclude paths and path hashes, commitments,
salts, credentials, requests, answers, stderr and free-form errors. Faux scores
are mechanics fixtures, not measured quality. Physical power-loss and provider
billing behavior are not established by these local tests. Private reads require
canonical roots and refuse aliases. Their before/after path checks are best-effort
against a same-user attacker: a precisely timed double swap can still pass;
this is not an OS isolation boundary.


### Configured pilot harness safety

The scripts-only faux pilot option checks resolved settings before constructing
Models or the configured harness, at runtime dispatch, and at every guarded
request. The local serializer child separately checks its actual fixed faux
settings. Pilot IPC and non-test permit sources require an assigned key and
resolved safety at guard construction; neither can be omitted. Legacy standalone
test-only callers retain their existing contract. The judge must be null; memory, subagents, ledger upkeep, compaction
and output schemas are absent/off. Model switching, custom/1M routes,
fallbacks, extra primary attempts and outage retry budgets/profiles refuse.
Transport is SSE with zero provider retries. Arms cannot request a mid-checkpoint,
ledger upkeep or output capture. Ordinary runner defaults are unchanged.

Only a guard-owned, module-privately branded decorator may dispatch in pilot
mode. It ignores configured Models and uses a guard-wrapped serializer with
fictional in-memory credentials; the harness strips supplied credential paths
and uses a verified absent path. An identity decorator or forged brand refuses.

The runtime proxy exposes only `run` for inference, plus explicit local lifecycle
operations: tool-context configuration, session synchronization, reconciliation,
recovery, refresh, invalidation, retirement and disposal. Preparation,
compaction, provider checks and unknown methods refuse rather than forwarding.
The guarded route can install only its Models decorator and the registered
ConversationHistory forwarding endpoint; it cannot replace native context. A
length and content-digest snapshot also detects in-place transcript mutation.

Auxiliary caller inventory (all paths below are scripts-local unless qualified):

- Judge runtime (`lib/continuity-runner.mjs`, `createJudge`): null judge required.
- Checkpoint replay (`buildCheckpoint`): literal offline mode and a credential path whose parent and file both return ENOENT; only scripted Models, never pilot mode.
- Mid-checkpoint compaction (`manualCompaction`): forbidden arm and explicit pilot-entry refusal before opening a harness.
- Preparation and real-credential capture Models (`prepareLedgerCheckpoint`): upkeep/capture forbidden and pilot entry refused before any constructor.
- Memory LLM and embeddings (`packages/app/src/composition/configured-memory.ts`): no memory configuration.
- Subagent/delegation runtime (`packages/app/src/composition/configured-subagents.ts`): disabled in resolved configuration.
- Native prepared dispatch/handoff: model switch disabled and proxy denies preparation methods.
- Provider-check rebuilt Models: no check method exposed or invoked.
- Structured repair/finalization: no output schema; existing guarded method/finalization limits remain.
- Router/provider/outage retry and fallback: empty fallback chain, one primary attempt, SSE, zero retries, no budget/profile; guarded one-send boundary.
- Model/web/shell tools: no such tools exposed; only registered ConversationHistory forwarding is permitted.

| Fixed refusal code | Meaning |
| --- | --- |
| `lookup_cache_assignment_invalid` | Invalid, duplicate or foreign assigned key. |
| `lookup_prompt_cache_key_forbidden` | Payload or either cache header is missing or differs from the assigned key. |
| `lookup_auxiliary_callers_forbidden` | Judge, memory, subagents, upkeep, compaction, output schema or host override is unsafe. |
| `lookup_model_switch_forbidden` | Resolved model switching is enabled. |
| `lookup_preparation_forbidden` | Arm, preparation, compaction or capture would enter an auxiliary caller. |
| `lookup_route_mismatch` | Model/custom/1M/fallback/attempt/transport/retry settings differ from the contract. |
| `lookup_retry_profile_forbidden` | An outage budget/profile or prebuilt Models override is present. |
| `lookup_tools_forbidden` | Tools, MCP configuration or forwarding differ from the registered history boundary. |
| `lookup_method_forbidden` | Non-allowlisted runtime/model method. |
| `lookup_native_identity_forbidden` | Route attempts to overwrite native context or other protected options. |
| `lookup_unguarded_dispatch` | Route lacks a guard decorator. |
| `lookup_arrival_persist_failed` / `lookup_arrival_receipt_invalid` | Child arrival-witness failure, distinct from controller persistence/receipt failures. |

A guard pre-send refusal carries a fixed code in the child's terminal message.
Only `not_admitted_input_envelope`, `lookup_request_limit`, `not_admitted_cap`,
`lookup_stopped` and `lookup_slot_terminal` may continue. With no holds a capacity
refusal is unadmitted; after admission it is incomplete, not a provider loss.
Every guard policy violation is a sticky fixed-code stop; with holds its terminal
is `integrity_stop`, otherwise unadmitted. A refusal does not invent admission
or accept a child-claimed unadmitted terminal after admission.
Controller persistence/receipt stop codes are not child-settable.

The actual configured-harness proof covers native checkpoint restoration and
cold pack model-change replay, reasoning/tool replay and exact cache headers.
Its ConversationHistory server is test-owned, bound to an ephemeral loopback
port with fictional data. Socket destinations are restricted to that endpoint;
other sockets, provider/global external fetches and WebSockets refuse. Rejected
fetches are recorded too, so swallowed errors cannot hide auxiliary egress. Cleanup
has an explicit hook budget. Scripted checkpoint work uses absent credentials;
no provider call, paid smoke or full pilot execution is established by this proof.

### Child-authorized pilot construction (entry unavailable)

The explicit `continuity-lookup-compare pilot` command exists but refuses with
`lookup_pilot_real_route_unavailable` before any argument-driven artifact read,
lease acquisition or output setup. `LOOKUP_PILOT_REAL_ROUTE_ENABLED` in
`scripts/lib/continuity-lookup-pilot-entry.mjs` is the single release gate. It
must remain false until the separately reviewed two-process configured smoke
proves the complete controller/child flow. No authorization issuer is provided.
Ordinary benchmark/compare and probe-child refusal seams remain unchanged.
Pilot restart and in-place probes also refuse with `lookup_pilot_boundary_required`
until their fresh-process boundary can be preserved; they never silently run as
in-process substitutes.

The sole real-send factory independently checks the child's registered code,
role, build and plan; the shared authorization validator and raw-byte consumption
binding; both markers; parent/child PID and start identity; epoch, slot and exact cache key;
live IPC; readiness; non-recovery state; and resolved safety. CI or debug-variable
presence refuses, including empty values. There is no nonce file or IPC MAC.
Registered pack children reuse the same authorization validator without becoming
controller checkouts. Real and faux decorators have disjoint private brands and
are one-shot; an object literal, faux artifact or branded permit alone cannot
construct a real send. Static caller inventories guard the dispatch boundaries.

The real wrapper requires a fresh consumed, unsettled hold matching the exact
body digest and allows only one native fetch per hold, with redirects refused
and no retry. Final account headers must match the salted commitment; same-account
token rotation is permitted. Account mismatch, HTTP 401/403, HTTP 429 and known
Codex usage-limit JSON/SSE errors await their fixed sticky stops. The guard's
settlement contract is unchanged. Unit tests use mocked verification graphs,
fictional values and denied egress, not execution-valid authorizations.

Containment retains proven members in memory when journal persistence fails.
Fresh PID/start/pgid proof remains mandatory for every signal; persistence failure
is never treated as a grant or a successful durable write. Done ACK cleanup and
containment rejection remain bounded even when the journal is sticky-failed.
The controller releases its lease; observation-only recovery cannot grant more.

The two-process native/pack smoke, explicit inherited egress/credential preload,
per-process canaries, persisted hold/consumption listener checks and arrival-kill
proof remain a separate required step. No live provider behavior, billing,
power-loss durability or operator acceptance is established by these unit tests.
