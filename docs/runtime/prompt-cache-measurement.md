---
title: Prompt cache measurement
description: Measure provider-side prompt-cache reuse without exposing request content or credentials.
---

Runtime prompt-cache diagnostics are disabled by default. Set `promptCacheDiagnostics: true` on a run to emit metadata-only request fingerprints, counts, and full-versus-delta interpretation. The event never contains prompt text, tool arguments, cache keys, endpoints, authorization data, or provider response IDs.

Use `node scripts/measure-prompt-cache.mjs --dry-run --scenario=multi-turn` to run real configured-agent and harness assembly through Pi's deterministic faux provider, without credentials or provider spend. The disposable agent root stays below `.mono-agent/cache-benchmark/`, offers only the `Read` tool, has no channels or memory capture, and is removed after the run. Supported scenarios are `multi-turn`, `durable-reopen`, `stateless`, `concurrent`, `recall-changing`, and `capability-change`.

Reports contain request fingerprints, observed input/cache/output counters and cost source, history mode, compaction and reseed events, plus separate exact context snapshots and cumulative billing totals. The aggregate hit ratio is token-weighted as `cacheRead / (input + cacheRead + cacheWrite)`; percentages are never averaged.

Live measurement is deliberately explicit. It requires `--live`, an exact `--model provider:model`, a supported `--transport`, a positive `--spend-ceiling-usd`, `--authorize-spend=YES`, and exactly one available credential source: `--credential-env NAME` or `--pi-auth PATH`. A Pi auth file must contain an entry for the selected provider. Validation reports only whether the chosen source is available; it never prints its value. For example, after separate spend authorization:

```sh
node scripts/measure-prompt-cache.mjs --live \
  --model "$CACHE_SMOKE_MODEL" --transport sse \
  --spend-ceiling-usd "$CACHE_SMOKE_CEILING" --authorize-spend=YES \
  --credential-env "$CACHE_SMOKE_CREDENTIAL_ENV" \
  --scenario multi-turn --turns 4 --repeats 3 \
  --fixture-tokens 8192 --output .mono-agent/cache-benchmark/live.json
```

The implementation test suite exercises only `--dry-run`; it never authorizes or sends an authenticated provider request.
