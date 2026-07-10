---
title: "Fallback models & failover"
sidebar:
  order: 3
---

This page covers `runtime.fallbackModels` — an ordered list of backup model references that the native failover router tries when the primary model hits a fallback-eligible provider failure. Failover is always reported in run results; the framework never silently swaps models behind your back.

## What failover does

When a turn fails against the primary `runtime.model` with a fallback-eligible provider error (transport errors, rate limits, transient 5xx, and provider authentication or credential failures), the router advances to the next entry in `runtime.fallbackModels` and retries the same turn there. It walks the list in order until one succeeds or the list is exhausted. Because mono-agent runs continuous provider sessions, the backup continues the existing conversation via transcript-tail resume — the prior turns are replayed onto the backup model so context is preserved across the switch.

The chosen model and the fact that failover occurred are surfaced in the run result, so callers (and observability traces) can see exactly which model produced the answer. When a chain is exhausted, the run no longer surfaces as a bare `provider_unavailable_exhausted` with no detail: the per-attempt failover history (each attempted model plus its failure subkind) and the underlying provider error are persisted to the run summary (`failoverHistory` + `error`) and surfaced in Phoenix traces as the `mono.agent.failover.count` / `mono.agent.failover.detail` / `mono.agent.error.message` attributes and the composed root-span status message (e.g. `failed (provider_unavailable_exhausted: pi:openai-codex:gpt-5.6-terra → timeout, pi:opencode-go:kimi-k2.6 → server_error; last error: 503 Service Unavailable …)`). See [Sessions & concurrency](/runtime/sessions-concurrency/) for how continuous sessions work, [Artifacts & traces](/observability/artifacts-and-traces/) for where run results land, and [Phoenix per-run attributes](/observability/phoenix-and-backfill/#per-run-attributes) for the trace fields.

:::note
Failover is for fallback-eligible *provider* failures, not for application-level disagreement with the answer. A successful-but-wrong response is not a failover trigger.
:::

## Coverage

| Capability | Coverage | Key |
| --- | --- | --- |
| Backup models on fallback-eligible provider failure | config | `runtime.fallbackModels` |

Set it three ways:

- Config: `runtime.fallbackModels`
- Env (CSV): `MONO_AGENT_FALLBACK_MODELS`
- Scaffold: `mono-agent init --fallback-models <csv>`

## Configure it

`fallbackModels` is an ordered array of model references in the same `pi:<provider>:<model> | claude:* | codex:* | opencode:*` form as `runtime.model`. The first entry is tried first.

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbackModels": [
      "pi:opencode-go:kimi-k2.6",
      "pi:ollama:gemma4:31b"
    ]
  }
}
```

The example above degrades from a primary cloud model to a cheaper cloud model, then to a local Ollama model as a last resort. Any `pi:<provider>:<model>` entry must reference a provider you have declared under `providers` — see [Local & self-hosted providers](/runtime/local-providers/).

### Env override (CSV)

`MONO_AGENT_FALLBACK_MODELS` takes a comma-separated list and overrides the JSON value (env > JSON > defaults):

```bash
export MONO_AGENT_FALLBACK_MODELS="claude:claude-haiku-4-6,pi:ollama:gemma4:31b"
```

### Scaffold from the CLI

`mono-agent init` accepts the same CSV when generating `mono-agent.config.json`:

```bash
mono-agent init \
  --model pi:openai-codex:gpt-5.6-terra \
  --fallback-models pi:opencode-go:kimi-k2.6,pi:ollama:gemma4:31b
```

## Execution mode of fallback entries

Fallback entries do **not** inherit the primary's `runtime.executionMode`. Each entry uses the execution mode *inferred from its own model reference* (the same default inference that applies when you omit `executionMode` for the primary). Pi, Claude, and direct OpenCode can mix when no mono-agent native sandbox is configured. Any chain containing direct `opencode:*` also requires exact allow-all tool policy, no effective MCP sources, no positive `maxTurns`, and no effort at runtime or static trigger scope. Direct OpenCode is per-run and non-resumable, so a configured mixed chain stays stateless end to end: the harness replays full conversation history on later turns, and the router strips any foreign session ids before an OpenCode attempt. Dynamic request effort is warned and ignored when such a fallback is retained. A chain containing direct `codex:*` must be all-direct because direct Codex has a distinct tool and sandbox contract. See [Backends & execution modes](/runtime/backends/) for how a model reference maps to an SDK or CLI backend.

:::caution
A configured mono-agent native sandbox rejects every chain containing Claude or
direct OpenCode: their provider-owned tool loops cannot enforce the configured
`srt` roots, deny-write globs, or network policy. (`pi:opencode-go:*` remains a
Pi route.) Direct Codex also rejects mono-agent native sandbox config and instead
runs under its own Codex-native sandbox. These checks fail closed during
validation and again at runtime.
:::

A CLI-backed fallback entry runs under that backend's own `permissionMode` semantics. If your primary is an SDK backend with strict tool policy, confirm the fallback backend's policy matches your expectations — see [Tool policy](/tools/policy/).

## Ordering and cost strategy

Order the list by preference, not just availability — the router stops at the first entry that succeeds, so put your best acceptable backup first. A common pattern is capability-then-cost-then-local: a strong cloud model, then a cheaper cloud model, then a self-hosted local model so the agent stays up even during a provider outage. Provider-transport retry tuning (how many times each model is retried before the router gives up on it) lives under `providers.piNative.piMaxRetries` for `pi:*` backends.

## Related

- [Multi-model fallback chain](/playbooks/multi-model-fallback-chain/) — end-to-end playbook building a tiered chain
- [Backends & execution modes](/runtime/backends/)
- [Local & self-hosted providers](/runtime/local-providers/)
- [Sessions & concurrency](/runtime/sessions-concurrency/)
