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
`--sidecar` and `--routes` are also required. Output defaults to stdout.
`--out` exclusively creates an explicit new file, never overwrites an input.
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
strictly greater than lifetime plus margin; the first request's gap is unknown.

Optional `--agent-config` is an array of complete run proofs:
`{"runId":"fictional-run","builtins":["Read"],"mcpTools":[]}`. Each MCP entry
lists its `exposedName`; missing collision inventory is not proof. Native
host-captured `tool_call.payload.origin` can also prove built-in identity.
Names alone never qualify. Optional `--app-allowlist` is a reviewed array of
`{server,tool,serverIdentityDigest,readOnly:true}` declarations, matched exactly
to captured MCP origin with `readOnlyHint:true` and no destructive hint. The digest is SHA-256 of the reviewed server identity;
repointing the server invalidates the declaration. Neither input is echoed.

## Privacy, eligibility and snapshot limits

The analyzer measures original/retained bytes and computes digests in memory.
It prints only fixed codes, category/API enums, counts, byte totals, histograms
and modeled numbers: never text, arguments, paths, URLs, identities, digests or
raw exceptions. The analyzer does not import provider, auth or credential code.
SQLite opens read-only. WAL/shared-memory/rollback-journal companions are
refused without opening the DB, so even shared-memory creation is avoided.
Size/mtime/inode checks include inputs, directories and absent DB companions;
changed snapshots are incomplete. This is change detection, not an atomic
cross-file backup or protection against an adversarial writer restoring metadata.

Native validation and schema assumptions come from `engine/journal-schema.ts`,
`engine/session-context.ts`, `tool-history/continuity-storage.ts`, and
`tool-history/continuity-lifecycle.ts`. Finalized tool IDs are reconstructed from
physical conversation, host turn/run and call identity, not text similarity.
Imports, inherited projections and interruption repairs currently defer rather
than guessing context. Duplicate journals/boundaries, invalid or open turns,
and missing routes/owners also defer the entire snapshot.

Only successful, completed, returned-and-placed, single plain-text results with
byte-identical committed/finalized, unredacted, untruncated retention qualify.
Latest input/current turn, three latest whole turns, ten latest tool starts,
approvals, unresolved effects, errors, images and opaque/mixed blocks stay intact.
Known instruction/history/effectful tools are excluded. Ambiguous identity is
reported only in a separate, pin-budget-bounded upper bound, never the gate.
The opportunity numerator tests each boundary independently against a fresh pin
budget; the pressure/cost counterfactual separately applies persistent pins,
cooldown and effective (already reduced) occupancy. Lower-bound batches require 20k net heuristic tokens, five completed prompt runs
between batches and at most 8 MiB pinned per physical conversation. Compaction
releases modeled pins. Categories and web yield are reported per API and overall.
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
A conservative mean-context bound charges S/(2C) extra on-arm occupancy. Summary
input growth charges delayed native growth plus at most 500 heuristic tokens
per cleared result (the summarizer's 2,000-character limit). If the modeled summary
cannot fit within the trigger, no pressure reduction is credited. Warm/unknown-cache full-prefix rewrite bounds are also
reported, but warm clearing is not enabled. No quality improvement is inferred.
`--retrieval-rate` defaults to 5%, explicitly **pending lookup-pilot evidence**;
0%, 5%, 20% and the supplied rate are always reported and cost-gated.

Per API, BUILD requires **all** of:

- At least 10 pressured pre-turn boundaries across at least 3 logical conversations;
  pressure means `0.75T ≤ E < T`.
- At least 25% of pressured cold boundaries admit at least 20k lower-bound net tokens.
- At least 15% less modeled compaction pressure.
- At most 5% higher modeled total cost at every retrieval sensitivity in both views.
- Zero unintended payload differences in offline qualification.

Insufficient representativeness/cold evidence or an incomplete snapshot means
DEFER. Missing payload evidence fails the payload criterion. With representative evidence, another failure
means STOP. Thresholds are fixed. Overall BUILD requires every supplied API to
BUILD; otherwise STOP takes precedence over DEFER. Denominators are never pooled.
Codex always DEFERs: **wire-unproven (transport)**. Offline `onPayload` comparison
cannot establish provider acceptance, signature validity or delivery over any
Codex transport. The qualification exercises real installed builders, compares
complete payloads and allows only targeted earlier result-text leaves to change;
reasoning, signatures, IDs, ordering, arguments and pairing remain unchanged.
