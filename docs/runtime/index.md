---
title: "Runtime & Providers"
description: "Understand runtime selection, provider configuration, sessions, tools, and safety controls."
sidebar:
  order: 0
---

The runtime layer is what actually drives a model: which provider executes a turn, how reasoning effort and tool permissions are set, how failures fall back to backup models, how local providers are wired in, how provider sessions and concurrency are bounded, and which built-in tools (and their auto-guards) ship out of the box. Every turn runs through the Pi runtime. The config-first controls live under `runtime`, `providers`, and `concurrency` in `mono-agent.config.json`, with the documented `MONO_AGENT_*` environment overrides. Custom runtimes, interactive approval callbacks, direct live-input queues, and orchestration remain programmatic surfaces; managed Slack, Telegram, and web-console turns supply their own live-input queue automatically.

## At a glance

A minimal runtime block selects a provider model and (optionally) backup models:

```json
{
  "runtime": {
    "model": "openai-codex:gpt-5.6-terra",
    "fallbacks": [
      { "model": "opencode-go:kimi-k2.6", "effort": "medium" },
      { "model": "ollama:gemma4:31b" }
    ],
    "effort": "medium",
    "permissionMode": "default",
    "maxTurns": 0,
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000 }
  }
}
```

The `runtime.model` string is always `<provider>:<model>`. A leading `pi:` prefix is canonicalized away. Override it without touching config via `MONO_AGENT_MODEL`.

Guided init searches every bundled model for the Pi catalog — Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go — plus discovered local models. Hand-authored `providers` refs remain compatible outside the guided cloud-provider set. Every provider listed in the [Providers](/runtime/providers/) map makes its full catalog selectable; `ollama` and `lmstudio` are zero-config autodiscovered. The offline entry does not fabricate effort metadata, so only provider-default effort is available until live discovery succeeds. GPT-5.6 Sol can be selected explicitly as `openai-codex:gpt-5.6-sol`.

| Key | Env var | Default | Notes |
| --- | --- | --- | --- |
| `runtime.model` | `MONO_AGENT_MODEL` | `openai-codex:gpt-5.6-terra` | Guided init can initially select the live provider default; refs use `<provider>:<model>`. |
| `runtime.fallbacks` | `MONO_AGENT_FALLBACKS_JSON` | `[]` | ordered `{model, effort?}` routes; omitted effort = provider default |
| `runtime.effort` | `MONO_AGENT_EFFORT` | provider/model default when unset | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`; model support is narrower where advertised. Reasoning-capable models map `ultra` to LOW; models without reasoning use OFF. The doctor warns and names the nearest valid level when an advertised level is not supported |
| `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | `default` | `default`/`plan`/`acceptEdits`/`bypassPermissions` |
| `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | `0` (unlimited) | `1`–`100` caps turns |
| `runtime.workspace` | `MONO_AGENT_WORKSPACE` | `.` | working dir for runtime tools |

## Child pages

- [Pi runtime & model references](/runtime/backends/) — the `<provider>:<model>` syntax, rejected legacy spellings, and how the Pi runtime routes a turn.
- [Providers](/runtime/providers/) — declare which providers the agent supports, widen selection to full catalogs, and configure Pi auth and transport.
- [Execution effort & permissions](/runtime/execution-effort-permissions/) — tune reasoning depth with `runtime.effort` and the tool-permission posture with `runtime.permissionMode`.
- [Fallback chains](/runtime/fallback/) — canonical `runtime.fallbacks`, exact route effort, legacy compatibility, and visible failover history.
- [Local providers](/runtime/local-providers/) — wire Ollama, LM Studio, or any OpenAI-compatible endpoint for `<provider>:<model>` references, plus pi-native transport tuning and Pi credential resolution.
- [Sessions & concurrency](/runtime/sessions-concurrency/) — continuous provider sessions with idle eviction (`runtime.session`) and per-channel admission/execution bounds (`concurrency.maxConcurrentRuns`, `concurrency.maxPendingRuns`).
- [Built-in tools & auto-guards](/runtime/tools-and-guards/) — the managed Read/Write/Edit/Glob/Grep/Exec/Bash/NodeRepl/WebFetch/WebSearch tools and the automatic guards (loss-aware process execution, tool-output truncation, web retry, cost tracking, context compaction).

## Local providers in one block

Point `<provider>:<model>` at a self-hosted endpoint. The `id` becomes the `<provider>` segment, so the model below is referenced as `ollama:gemma4:31b`:

```json
{
  "providers": {
    "ollama": {
      "type": "ollama",
      "baseUrl": "http://localhost:11434",
      "apiKeyEnv": "MY_PROVIDER_KEY",
      "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }]
    }
  }
}
```

`type` is `ollama`, `lmstudio`, or `openai_compat`. Supply the key via `apiKeyEnv`: keep the secret value in `.env` and only its variable name in config. Inline `apiKey` remains schema-compatible for existing consumers, but ignored or untracked source config is not an exception to this placement convention. `ollama` and `lmstudio` are also zero-config autodiscovered when not declared. See [Providers](/runtime/providers/), [Local providers](/runtime/local-providers/) for the full provider/env reference, and [Embeddings](/memory/embeddings/) for using the same providers in the memory tier.

## Sessions & concurrency

By default a conversation keeps a continuous provider session that is evicted after `idleTimeoutMs`; set `runtime.session.mode` to `per-message` for a fresh session each turn. Admission and execution are bounded **per channel**, so with N enabled channels the effective ceiling is N× the configured value:

```json
{
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16
  }
}
```

`maxConcurrentRuns` (`MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`) caps how many runs hit the provider at once; `maxPendingRuns` (`MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS`) caps how many runs may be admitted before the provider step. Details and the session-store semantics are on [Sessions & concurrency](/runtime/sessions-concurrency/).

## Built-in tools & auto-guards

Mono-agent's managed tool surface includes Read/Write/Edit/Glob/Grep/Exec/Bash/NodeRepl/WebFetch/WebSearch, gated by [tool policy](/tools/policy/) (`tools.allowedTools` / `tools.disallowedTools`) and enforced uniformly by the Pi runtime on every route. Auto-guards run with no configuration: loss-aware process termination/output capture, 256 KB model-facing tool-output truncation with best-effort separate artifact persistence to `artifacts.dir`, WebFetch retry on transient failures, per-run cost/usage tracking, and bridge-driven context compaction. See [Built-in tools & auto-guards](/runtime/tools-and-guards/) and [Local-first web research](/tools/web-research/).

:::tip
Capabilities such as structured output (`runtimeOptions.outputSchema`), live in-flight input, human-in-the-loop approval gates, and tool parallelism are **code-only** — they are set through harness/runtime options, not config. See [Programmatic API](/programmatic/) and [Approval & structured output](/programmatic/approval-and-structured-output/).
:::
