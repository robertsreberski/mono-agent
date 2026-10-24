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
# Workload plan and confirmation digest; no build, credentials or network
pnpm run benchmark:continuity:dry-run

# Build the app closure, then run the offline contract (scripted providers)
pnpm run benchmark:continuity

# Once built, the direct entrypoint defaults to the offline contract too
node scripts/continuity-benchmark.mjs --trace brightline-return --probe-limit 2
```

**Offline results are not model quality.** The offline contract uses the real
harness, durable history, tool-history sidecar, Pi sessions and compaction
driver, but the reader and summarizer are scripted. It proves that every arm
crosses its boundary and that scoring and accounting run; its accuracy numbers
mean nothing. CI runs the offline unit and contract tests only.

## Corpus

`scripts/fixtures/continuity/` holds four invented traces (`fictional: true`;
people, companies, addresses and identifiers are made up). Each trace is a
single conversation spread over five days with 36–38 owner turns,
about 28 realistic tool results (email, chat, web page, document, calendar
and parcel-tracking outputs) and a mid-turn steer. Every trace contains early
owner constraints, later corrections that supersede earlier facts,
identifiers that appear only in tool output, sent versus drafted commitments,
artifacts with a status, open items, and a designated tool-free mid-trace turn.

Each trace has 13 probes across seven categories:

| Category | Scoring | Example |
| --- | --- | --- |
| `tool_identifier` | Normalised exact match; superseded decoys count as stale | Order or reservation number seen only in a tool result |
| `active_constraint` | Recall: required terms. Task: forbidden-pattern violation detection | Draft a message without stating where the owner lives |
| `superseded_current` | Current value present and superseded value absent | Refund amount after a correction |
| `commitment_status` | First status token (`SENT`, `DRAFTED`, …) | Complaint drafted but never sent |
| `artifact_status` | First status token (`DRAFT`, `FINAL`, `SHARED`, …) | Checklist marked final |
| `next_action` | Deterministic keyword proxy; optional judge reported separately | Print the label before Thursday's collection |
| `abstention` | `UNKNOWN` or an explicit "never came up" | A PIN that was never mentioned |

Validation runs before any replay. It rejects traces that are not marked fictional, are too short, lack a steer or a category, or whose
identifier probes appear anywhere outside tool output. The replay projection
contains no probes, expected answers, rubrics or categories; the reader sees
only the probe text. Probe wording explicitly counts tool results as part of
the conversation. Without that, readers answered `UNKNOWN` for values they had
only seen in a tool result, which measured wording rather than retention.

## Replay and arms

Every turn goes through `resolveJsonMonoAgentConfig` →
`createConfiguredAgentRuntime` → `createConfiguredConversationHarness`, with
continuous durable sessions, the durable canonical history store and the
tool-history sidecar. Scripted history turns are served by Pi's faux provider
posing as the bound model through the runtime's existing `piResolvedModel`
seam. Their tool calls are real MCP calls to a loopback fixture server that
returns the frozen output, so the native transcript and tool-history records are
written by production code. The steer is delivered with `offerLiveInput` while
a scripted tool call is in flight and must reach the next model request.
Scripted turns never compact, because a faux model cannot produce a real summary.

After the checkpoint, the workspace is copied once per probe. A new tool-free
harness asks the probe on the reader model. Forks of one checkpoint share a
provider-session identity, so they never run concurrently.

| Arm | Boundary at the probe turn | Production path exercised |
| --- | --- | --- |
| `native` (a) | None: resume the reader's own native Pi transcript, tool calls and results included | Durable session resume; default compaction policy |
| `cold-rebuild` (b) | History is bound to `--alternate`; the probe runs on the reader | Default configured model change: `resume_replay`/`model_change`, canonical last-64 text messages plus the bounded tool-history projection |
| `compaction-1` (c) | One proactive compaction before answering | `runtime.compaction` with the smallest allowed trigger: window 32,000, ratio 0.2, 4,000-token recent tail, cooldown 0 |
| `compaction-2` (d) | A compaction at the live mid-trace turn, then another at the probe | Same policy at both live turns; scripted history continues between them |

Each sample records the boundary actually observed (`session_boundary` and
terminal `context_compaction` events). A probe that did not cross its arm's
boundary is `boundary_unverified` and excluded from accuracy; a mid-trace
compaction that did not happen fails that checkpoint.

Arms are data in `scripts/lib/continuity-arms.mjs`: a replay binding, an
optional live mid-trace turn and a `runtime` config patch, plus the boundary
evidence each one must produce. To add an arm (a continuity ledger, tool-result
stubs, or `runtime.maxInputTokens` once available), add an entry whose patch
enables the production feature and declare its expected evidence. Unknown
config keys fail in production config resolution.

## Paid runs

Paid mode is explicit and never part of CI. It refuses whenever `CI` exists in
the environment, even when empty, and requires a clean checkout. It also
requires the confirmation digest from an identical dry run, an explicit Pi
auth file and an output directory outside the checkout:

```bash
node scripts/continuity-benchmark.mjs --dry-run --repeats 2 \
  --pi-auth-path /ABSOLUTE/PATH/TO/pi-auth.json

node scripts/continuity-benchmark.mjs --real --repeats 2 \
  --pi-auth-path /ABSOLUTE/PATH/TO/pi-auth.json \
  --output /ABSOLUTE/PATH/OUTSIDE/CHECKOUT/run-1 \
  --confirm-plan DIGEST_FROM_DRY_RUN --repeat 1 --concurrency 4
```

The defaults are reader `openai-codex:gpt-6-luna` at low effort, alternate
binding `openai-codex:gpt-6.1-sol` (scripted history only; it is never called),
and judge `openai-codex:gpt-6.1-sol` at low effort, or `--no-judge`. Models,
efforts, repeats, arms and `--probe-limit` are bound into the digest.
`--trace`, `--repeat`, `--concurrency` and `--output` are execution-only, and
they select a subset of the confirmed plan. Completed units in the output
directory are skipped, so a long plan can be run in chunks and re-aggregated
with `--aggregate-only`. The auth file is read lazily by the existing Pi
credential resolver; only a fingerprint of its path enters the plan.

Each invocation stops admitting new live turns after an auth or quota failure,
after the planned live-turn count, or once its observed input tokens cross
`limits.maxObservedInputTokensPerInvocation`. These are observed, not
reserved, limits: one in-flight request can exceed them.

## Reading results

The output directory contains `plan.json`, one `units/r<repeat>-<trace>-<arm>.json`
per completed unit (answers, scores, observed boundary evidence, usage), and the
aggregate `results.json` and `summary.md`:

- **Accuracy** per arm and category is the mean of per-repeat accuracies, with
  `n`, the per-repeat split, the SD across repeats, and the delta versus
  `native` in percentage points.
- **Flip rate** is the share of probes whose pass/fail changed between repeats.
- **Outcomes** separate `stale` (the superseded value), `conflicted`,
  `abstained` (including false abstentions), `violation` and `fabricated`.
- **Excluded** counts `boundary_unverified` and failed samples; they are never
  scored as passes or failures.
- **Judge** agreement compares the next-action judge with the deterministic
  proxy. The main category table always uses the proxy.
- **Spend** reports live turns, input, cache-read, cache-write and output
  tokens per arm, including mid-trace turns. Compaction summary requests are
  shown as an "of which" subtotal; the judge is reported separately. Cost is
  the Pi catalog list-price estimate when the runtime reports one;
  subscription routes are not billed per token, and missing values stay unknown.

## Limitations

- The corpus is checked in and author-visible. It is not a secret holdout and does not
  represent every conversation shape. Fixed tool outputs are shorter than many
  real ones, so they understate projection and summary pressure.
- History before the checkpoint is scripted. The arm (d) mid-trace reply is
  generated live and may restate or misstate facts, so (d) is not a pure
  "summary of a summary" comparison.
- Arm (c) compacts once per probe, while arm (d)'s first summary is shared by
  that repeat's probes. Summary variance therefore appears per probe in (c) and
  per repeat in (d).
- Two repeats give a variance signal, not a confidence interval. The
  deterministic scorer can miss correct paraphrases or accept lucky
  substrings. Inspect the stored answers before drawing conclusions from small
  deltas.
- The benchmark measures retention at the probe turn. It does not measure
  memory capture, recall tools or long-term memory.
