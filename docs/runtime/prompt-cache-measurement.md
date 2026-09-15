---
title: Prompt cache measurement
description: Measure provider-side prompt-cache reuse without exposing request content or credentials.
---

Runtime prompt-cache diagnostics are disabled by default. Set `promptCacheDiagnostics: true` on a run to emit metadata-only request fingerprints, counts, and full-versus-delta interpretation. The event never contains prompt text, tool arguments, cache keys, endpoints, authorization data, or provider response IDs.

Use `node scripts/measure-prompt-cache.mjs --dry-run --scenario=multi-turn` to run real configured-agent and harness assembly through Pi's deterministic faux provider, without credentials or provider spend. The disposable agent root stays below `.mono-agent/cache-benchmark/`, offers only the `Read` tool, has no channels or memory capture, and is removed after the run. Supported scenarios are `multi-turn`, `durable-reopen`, `stateless`, `concurrent`, `recall-changing`, and `capability-change`.

Reports contain request fingerprints, observed input/cache/output counters and cost source, history mode, compaction and reseed events, plus separate exact context snapshots and cumulative billing totals. The aggregate hit ratio is token-weighted as `cacheRead / (input + cacheRead + cacheWrite)`; percentages are never averaged.

Live provider dispatch is disabled at this revision. A post-response spend check cannot enforce a hard ceiling because one request—or a concurrent batch—may already exceed it. The command refuses before agent state or provider dispatch until an explicit provider-pricing and request-token bound can conservatively reserve each request before it starts. Post-response accounting remains in the shared scenario runner as secondary evidence, not as a claimed ceiling.

The disabled live preflight still validates the intended contract: `--live`, an exact `--model provider:model`, a supported `--transport`, a positive `--spend-ceiling-usd`, `--authorize-spend=YES`, and exactly one credential source. `--credential-env NAME` accepts only the active API-key environment variable Pi maps to the selected provider and binds that value to the private runtime credential resolver; it never copies the value into config, state, diagnostics, or reports. `--pi-auth PATH` requires an entry for the selected provider. Neither path prints credential values. This command validates those inputs and then exits with the live-dispatch-disabled error without contacting a provider:

```sh
node scripts/measure-prompt-cache.mjs --live \
  --model "$CACHE_SMOKE_MODEL" --transport sse \
  --spend-ceiling-usd "$CACHE_SMOKE_CEILING" --authorize-spend=YES \
  --credential-env OPENAI_API_KEY \
  --scenario multi-turn --turns 4 --repeats 3 \
  --fixture-tokens 8192 --output .mono-agent/cache-benchmark/live.json
```

The implementation test suite exercises dry-run assembly plus positive and negative live preflight refusal. It never sends an authenticated provider request.

## Read real run artifacts

Set `providers.piNative.promptCacheDiagnostics: true` in the agent config (or
`MONO_AGENT_PI_PROMPT_CACHE_DIAGNOSTICS=true`) before starting the agent. The
default is `false`; unset config leaves runtime options unchanged. Emit
metadata-only prompt-cache request fingerprints into run artifacts; never prompt
text, tool arguments, cache keys, endpoints or credentials. Existing artifact
retention and the recorder's general redaction still apply. Other event types
and run summaries retain their existing content policy.

From a framework checkout, read the existing artifacts without starting a console:

```bash
node scripts/summarize-prompt-cache.mjs --artifacts-dir /path/to/agent/.mono-agent/artifacts
node scripts/summarize-prompt-cache.mjs --conversation 'web:conversation-id' --since 2026-09-08T00:00:00Z --json
```

The default directory is `.mono-agent/artifacts` relative to the current working
directory. Each JSONL requires its companion `.summary.json` for the conversation
id and run start time; missing summaries produce warnings. Invalid JSON fails
with a file and line number, without printing its contents. `--since` selects
runs by start time, retaining older runs as comparison baselines.

Rows show request usage (`input / cacheRead / cacheWrite / output`), wire and
logical full/delta interpretation, and tools/system fingerprint changes against
the previous request in that run and the last request of the previous run in the
same conversation. A previous run without diagnostics provides no baseline.
Codex pre-transport payloads may have unavailable wire interpretation even when
logical input is full. A changed fingerprint proves a payload change, not a
cache miss; identical fingerprints do not guarantee a hit.

Usage comes from the latest `context_usage` snapshot following each diagnostic;
snapshots are replaced, not summed. Totals sum requests and use
`cacheRead / (input + cacheRead + cacheWrite)`, never an average of percentages.
Missing usage stays unknown (`?` in the table, `null` in JSON), including affected
totals. Zero denominators also have an unknown ratio. Runs recorded before
diagnostics were enabled show zero diagnosed requests, not measured cache usage.

## Consecutive first requests

The additive `consecutiveFirstRequests` section compares the first assistant
request of run N with the last assistant request of the immediately preceding
run in the same conversation. It does not skip an intervening run to find a
better baseline. Both diagnostic model/API and summary `providerSessionId` must
match. Missing baselines, missing diagnostics/identity, session/model resets and
overlapping runs are reported in `pairs` and `excluded`, not classified as cache
hits or misses. Exclusion counts can overlap. Earlier `--since` baselines remain
available; concurrent-run cache-key grouping is intentionally not attempted.

Idle gap is current `startedAt` minus previous `endedAt`, with buckets `<5m`,
`5–60m`, `>=60m`, `overlap`, and `unknown`. Missing timestamps remain null.
Comparable cohorts group by model/API, tools `stable|changed|unknown`, idle gap
and retention treatment (requested setting plus observed TTL metadata). Legacy
exports without retention metadata remain unknown. System fingerprints and
message-prefix comparison evidence retain full/delta, truncated and unknown
interpretation; an equal observed prefix is not proof that an unobserved tail is
equal or that the provider still has a cache entry.

Usage is joined by request ID using its latest snapshot, never by summing
snapshots. Cohorts report token sums and per-field coverage, uncached
`input + cacheWrite`, and a **token-weighted** hit ratio over pairs with all three
input counters available. Incomplete pairs are not silently treated as zero;
all-unknown aggregates remain null. First-request costs and their coverage are
separate from run costs. Only the last `cost_accumulated.cumulativeUsd` snapshot
is used for cumulative run accounting; it is never substituted for a missing
first-request cost. The existing all-request and compaction outputs remain.

## Measurement gates

**Gate A — stable definitions and unchanged admission.** Under unchanged
configuration, model, skill catalog and authority profile, normal user/job-wake/
monitor-wake/cron transitions must produce zero definition changes, including
constant-count changes. Persistent children have a separate profile. Offline
provider-wire tests compare serialized Anthropic and OpenAI Responses tool
arrays; refusal tests prove that visibility does not grant authority. Real
configuration, third-party schema and infrastructure discovery changes remain
possible prefix breaks. Separately authorized short-retention observations under
five minutes should corroborate first-request reuse; investigate exceptions
using system/message evidence, not fingerprints alone.

**Gate B — separately evaluated long retention.** Only after A, separately
approved evidence may compare matched stable-prefix requests at 5–60 minutes
with observed one-hour TTL metadata on a supported model. Compare uncached input,
cache-write/read costs and whole-run costs, not just hit percentages. These gates
provide no rollout or spending authorization and do not enable the disabled live
benchmark. Offline equality proves payload stability, not provider residency,
actual billing or a guaranteed hit.
