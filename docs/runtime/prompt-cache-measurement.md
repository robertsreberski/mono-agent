---
title: Prompt cache measurement
description: Measure provider-side prompt-cache reuse without exposing request content or credentials.
---

Runtime prompt-cache diagnostics are disabled by default. Set `promptCacheDiagnostics: true` on a run to emit metadata-only request fingerprints, counts, and full-versus-delta interpretation. The event never contains prompt text, tool arguments, cache keys, endpoints, authorization data, or provider response IDs.

Use `node scripts/measure-prompt-cache.mjs --dry-run --scenario=multi-turn` to validate the bounded report format without credentials or provider spend. Supported scenarios are `multi-turn`, `durable-reopen`, `stateless`, `concurrent`, `recall-changing`, and `capability-change`. Reports keep exact context snapshots separate from cumulative billing totals; the aggregate hit ratio is token-weighted as `cacheRead / (input + cacheRead + cacheWrite)`.
