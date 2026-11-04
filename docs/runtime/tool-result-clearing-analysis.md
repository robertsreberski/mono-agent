---
title: Tool-result clearing opportunity analysis
description: Read-only, aggregate-only evidence and offline provider payload qualification, without runtime clearing.
---

## Run locally

This developer tool **does not clear anything**. Use only explicit, offline
copies of native v2 journals and a checkpointed tool-history SQLite sidecar.
It never discovers home/state directories, authenticates, or contacts a provider.
Obtain permission before analyzing private data; keep reports local.

```bash
pnpm install --offline --frozen-lockfile
pnpm --filter '@mono-agent/app...' run build
node packages/turn/scripts/tool-result-clearing-qualify.mjs > /scratch/qualification.json
node scripts/tool-result-clearing-analyze.mjs \
  --journals /scratch/native \
  --sidecar /scratch/history.sqlite \
  --routes /scratch/routes.json \
  --qualification /scratch/qualification.json
```

`--journals` accepts one or more files/directories (recursive `.jsonl` selection).
For native session roots, pass `<root>/journals`, containing per-session `.jsonl`
files; not the parent root containing legacy imports, aliases or retired state.
`--sidecar` and `--routes` are also required. Output defaults to stdout.
`--out` exclusively creates an explicit new file, never overwrites an input.
The output parent is canonicalized with realpath. Input containment (including
filesystem roots) and existing aliases are checked by device/inode identity.
Same-directory input names and the sidecar’s `-wal`, `-shm` and `-journal`
companion names are compared case-insensitively on every platform. This can
conservatively refuse distinct case variants on case-sensitive filesystems;
unrelated sibling names remain valid outputs. Symlink destinations are refused.
Exit status is 0 for a complete analysis, 2 for incomplete/invalid inputs;
BUILD/DEFER/STOP is an evidence verdict, not an exit status.

## Input contracts

One entry per API in `--routes` applies homogeneous assumptions to that API's
history. Separate incompatible model/cache cohorts before analysis. Supported
APIs are `anthropic-messages`, `openai-responses`, `openai-codex-responses`, and
`openai-completions`. No arbitrary route labels are echoed.

```json
[{
  "api": "anthropic-messages",
  "triggerTokens": 200000,
  "drainTokens": 40000,
  "summaryInputTokens": 40000,
  "summaryOutputTokens": 2000,
  "cacheLifetimeMs": 300000,
  "cacheMarginMs": 30000,
  "prices": {"input": 3, "cacheRead": 0.3, "cacheWrite": 3.75, "output": 15},
  "quota": {"input": 1, "cacheRead": 0.1, "cacheWrite": 1.25, "output": 5},
  "quotaBudget": 100000000
}]
```

These are fictional modeling inputs, **not current provider prices**. Prices
are currency per million tokens; quota weights convert tokens to quota units,
and `quotaBudget` is the subscription budget in those units. Cache lifetime
can be `"unknown"`, which never qualifies as cold. Cold means a request gap
strictly greater than lifetime plus margin, measured from the latest preceding
assistant message timestamp, including failed/aborted dispatches and tool loops.
The first request's gap is unknown.

Optional `--agent-config` accepts an agent-period owner attestation:
`{"builtins":["Read","Grep"],"mcpTools":"none"}`. Alternatively `mcpTools` is a
complete array of `{"exposedName":"fictional-tool"}` entries exposed by configured
servers over the snapshot period. A built-in must be enabled and have no MCP
name collision. Configuration changes within that period invalidate the
attestation: split the period or use an array of per-run proofs, each adding
`runId`. Missing inventory is not proof; names alone never qualify.
Per-run proof arrays require unique, nonempty run IDs; contradictory or missing
IDs invalidate the input rather than selecting a first match.
No native writer records `tool_call.payload.origin` at this revision. Thus native
history needs supplied proof; MCP-origin fixtures do not imply real origin capture.
Optional `--app-allowlist` is a reviewed array of
`{server,tool,serverIdentityDigest,readOnly:true}` declarations, matched exactly
to captured MCP origin whose tool equals the message tool name, with `readOnlyHint:true` and no destructive hint. The digest
is SHA-256 of the reviewed server identity; repointing invalidates it. Inputs are
never echoed. Without captured provenance, app results remain upper-bound only.

## Privacy, eligibility and snapshot limits

The analyzer measures original/retained bytes and computes digests in memory.
It prints only fixed codes, category/API enums, counts, byte totals, histograms
and modeled numbers: never text, arguments, paths, URLs, identities, digests or
raw exceptions. The analyzer does not import provider, auth or credential code.
SQLite opens read-only. WAL-mode header bytes (18–19) and WAL/shared-memory/
rollback-journal companions are refused with `SIDECAR_NOT_OFFLINE` before opening,
including WAL-mode databases without companions. No shared-memory creation is
needed or permitted.
Size/mtime/inode checks include inputs, directories and absent DB companions;
changed snapshots are incomplete. This is change detection, not an atomic
cross-file backup or protection against an adversarial writer restoring metadata.

Native validation and schema assumptions come from `engine/journal-schema.ts`,
`engine/session-context.ts`, `tool-history/continuity-storage.ts`, and
`tool-history/continuity-lifecycle.ts`. Finalized tool IDs are reconstructed from
physical conversation, host turn/run and call identity, not text similarity.
Unsupported/imported/inherited/interrupted, invalid, open or duplicate journals
are skipped, as are owner-missing, unsupported-API and duplicate boundaries.
`skippedJournals` and `skippedBoundaries` publish separate fixed reason counts;
representativeness uses what remains. A journal contributes nothing unless its
entire replay succeeds. It accumulates fresh local results, reads committed ID
indices without copying them, and copies only touched conversation policies.
Successful journals merge their contributions; failure discards boundary skips too.
Same-journal re-prompts continue the existing boundary, even when first skipped;
only a matching boundary first seen in another journal is skipped.
Only `SNAPSHOT_CHANGED`, `SIDECAR_NOT_OFFLINE`, `INPUT_INVALID` and `NO_JOURNALS`
mark the snapshot globally incomplete.

Only successful, completed, returned-and-placed, single plain-text results with
byte-identical committed/finalized, unredacted, untruncated retention qualify.
Latest input/current turn, three latest **prompt** turns, ten latest tool starts,
errors, images and opaque/mixed blocks stay intact. Approval/unresolved-effect
state is not recorded natively here: this analyzer cannot attest its protection.
Only proven read-only identities qualify; this limitation is not runtime authority.
Known instruction/history/effectful built-in names are excluded from both bounds,
even without identity proof. Ambiguous identity is upper-bound only.
The gate counts a boundary only for newly cleared lower-bound results in the
step-by-step simulation, against the remaining 8 MiB per-conversation budget.
Each result counts once; five completed prompt runs separate batches, using
already-reduced effective occupancy. Compaction releases pins, not the historical
set of counted results. Independent per-boundary upper bounds are informational.
`exclusionUnit` labels exclusions as result-boundary occurrences, not unique results.
Categories and web yield are reported per API and overall.
`structuredScanLosses` counts redacted JSON web envelopes rejected again by the
existing credential/private-evidence guard (not exclusive causal attribution).
`escapedBytes` and `escapedToOriginalRatio` measure retrieval's extra JSON layer.

## Models and decision gate

Boundary estimates use latest valid assistant usage plus trailing heuristic
messages, otherwise the engine's UTF-16 characters/4 heuristic (1,200 tokens per
image). Unrecorded system/tool overhead is not reconstructed without usage.
Observed checkpoint drains, summary sizes and request gaps are reported separately.
All opportunity, pressure and cost results are **modeled**, not observed savings.

Let native growth be G, trigger T, drain P, admitted net savings S, and expected
retrieved text R. Off pressure is C=G/(T-P); savings per cycle is S/C; on pressure
is (G+retrievalRate×R)/(T-P+S/C). This continuous whole-cycle approximation uses
frozen continuations, not alternate assistant behavior. Ordinary input/output,
cache reads/writes, summaries, drain recaches, full retrieval round trips and
returned-history growth are charged in both list-price and quota-share views.
Every assistant message is a request. Off-arm request costs use its observed
`input/cacheRead/cacheWrite/output` usage, otherwise an explicitly labeled
uncached character-heuristic fallback. Assumptions publish request count, fallback
count and share. More than 5% fallback requests means `USAGE_FALLBACK_EXCESSIVE`
and DEFER: inflated uncached baselines must not manufacture a passing cost ratio.

For each price/quota view, the observed blended prefix rate is
`(input×inputWeight + cacheRead×readWeight + cacheWrite×writeWeight) / (input+cacheRead+cacheWrite)`.
Output is excluded from this rate; a zero-input request contributes zero ordinary
prefix delta. Removed tokens (capped to observed prefix occupancy), extra retained
native context S/(2C), and retrieved-history growth use this **same** rate. This
symmetric approximation assumes comparable cache mix for changed prefix tokens,
not knowledge of their cache position. Expected extra retrieval round trips use
the cohort's token-weighted prefix blend; their output remains output-priced.
Summary-cycle changes and enlarged summaries are separate deltas. Summary input
growth charges delayed native growth plus at most 500 heuristic tokens per
cleared result (the summarizer's 2,000-character limit). If the summary cannot fit
within the trigger, no pressure reduction is credited.

`listDelta` and `quotaShareDelta` expose signed `retained`, `removed`, `summary`
and `retrieval` components; their sum equals on minus off in the respective units.
A zero off-arm baseline with positive on-arm cost has a null (unbounded) ratio
and fails cost admission; zero over zero remains neutral at 1.
`allUncachedInformational` is a **non-gating** upper-bound scenario: reprice the
remaining on-arm request prefixes and retrieval round trips at no less than
uncached input, never discounting a higher observed write-premium blend; reprice
summary drain recaches similarly. Its `gating` field is always false. Warm/unknown
full-prefix rewrite figures are informational too; warm clearing is not enabled.
No quality improvement is inferred.
`--retrieval-rate` defaults to 5%, explicitly **pending lookup-pilot evidence**;
0%, 5%, 20% and the supplied rate are always reported and cost-gated.

Per API, BUILD requires **all** of:

- At least 10 pressured pre-turn boundaries across at least 3 logical conversations;
  pressure means `0.75T ≤ E < T`.
- At least 10 cold pressured boundaries across at least 3 logical conversations.
- At least 25% of these boundaries admit at least 20k **new** lower-bound net tokens.
- At least 15% less modeled compaction pressure.
- At most 5% higher modeled total cost at every retrieval sensitivity in both views.
- Zero unintended payload differences in offline qualification.

Insufficient representativeness/cold evidence or an incomplete snapshot means
DEFER. Candidates with no proven lower-bound identity yield `IDENTITY_UNPROVEN`;
missing/stale qualification yields `PAYLOAD_UNQUALIFIED`. These mean route DEFER,
not STOP. Restrict journals to the period when continuity capture was enabled.
Per-route `retention` counts unique proven-identity, successful, completed,
returned-and-placed plain-text results, including protected ones. A match requires
identity-linked, finalized committed retention without tombstones or integrity
mismatches. Redacted and truncated rows prove capture: they remain matched and
counted as redacted/truncated, but are ineligible and reduce opportunity yield.
For unredacted, untruncated rows, byte counts, digest and complete text must match.
Proven results with no matches yield `RETENTION_UNMATCHED`; a matched share below
the fixed **50%** floor means
`RETENTION_COVERAGE_LOW`. Both DEFER: today's retention may omit pre-capture,
unowned or evicted results and cannot establish historical opportunity absence.
An empty proven-result set is not itself missing retention. Unproven plain-text
candidates still DEFER via `IDENTITY_UNPROVEN`; sufficient evidence with no
qualifying opportunity can reach STOP, including redaction-dominated low yield.
Qualification must match the installed pi-ai version and digest of the
exact fixture-builder/diff/reference sources; the analyzer prints only the version,
not the digest. With sufficient evidence, a failed criterion means STOP. Thresholds
are fixed. Overall BUILD requires every supplied API to
BUILD; otherwise STOP takes precedence over DEFER. Denominators are never pooled.
Codex always DEFERs: **wire-unproven (transport)**. Offline `onPayload` comparison
cannot establish provider acceptance, signature validity or delivery over any
Codex transport. The qualification exercises real installed builders, compares
complete payloads and allows only targeted earlier result-text leaves to change;
reasoning, signatures, IDs, ordering, arguments and pairing remain unchanged.
