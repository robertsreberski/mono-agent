---
title: "Runtime & Providers"
nav_order: 4
has_children: true
---

# Runtime & Providers

The runtime layer is what actually drives a model: which backend executes a turn, how reasoning effort and tool permissions are set, how failures fall back to backup models, how local providers are wired in, how provider sessions and concurrency are bounded, and which built-in tools (and their auto-guards) ship out of the box. Everything here is configured under `runtime`, `providers`, and `concurrency` in `mono-agent.config.json` and mirrored by `MONO_AGENT_*` environment variables.

## At a glance

A minimal runtime block selects a backend model and (optionally) backup models:

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "fallbackModels": ["pi:openai:gpt-5.5", "pi:ollama:gemma4:31b"],
    "executionMode": "sdk",
    "effort": "medium",
    "permissionMode": "default",
    "maxTurns": 0,
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000 }
  }
}
```

The `runtime.model` string is always `<backend>:<...>` — `claude:*`, `codex:*`, or `pi:<provider>:<model>`. Override it without touching config via `MONO_AGENT_MODEL`.

| Key | Env var | Default | Notes |
| --- | --- | --- | --- |
| `runtime.model` | `MONO_AGENT_MODEL` | — | `claude:…`, `codex:…`, `pi:<provider>:<model>` |
| `runtime.executionMode` | `MONO_AGENT_EXECUTION_MODE` | inferred from model | `sdk` or `cli` |
| `runtime.effort` | `MONO_AGENT_EFFORT` | `medium` | `none`/`low`/`medium`/`high`/`xhigh`/`max` |
| `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | `default` | CLI backends; `default`/`plan`/`acceptEdits`/`bypassPermissions` |
| `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | `0` (unlimited) | `1`–`100` caps turns |
| `runtime.workspace` | `MONO_AGENT_WORKSPACE` | `.` | working dir for runtime tools |

{: .note }
`runtime.reasoningSummary` (`MONO_AGENT_REASONING_SUMMARY`) is retained for back-compat but currently has no runtime effect — the codex/claude CLIs emit summaries on their own and pi-native derives reasoning from `effort`.

## Child pages

- [Model backends](backends.md) — the four backends (claude sdk/cli, codex cli, pi sdk with 15+ providers, opencode cli), the `<backend>:<model>` syntax, and `sdk` vs `cli` execution modes.
- [Execution effort & permissions](execution-effort-permissions.md) — tune reasoning depth with `runtime.effort` and the tool-permission posture for CLI backends with `runtime.permissionMode`.
- [Fallback chains](fallback.md) — `runtime.fallbackModels`: an ordered list of backup models the fallback router tries on retryable provider failures, with transcript-tail resume; failover is reported in run results, never silent.
- [Local providers](local-providers.md) — wire Ollama, LM Studio, or any OpenAI-compatible endpoint via `providers.local[]` for `pi:<provider>:<model>` references, plus pi-native transport tuning and OAuth credential resolution.
- [Sessions & concurrency](sessions-concurrency.md) — continuous provider sessions with idle eviction (`runtime.session`) and per-channel admission/execution bounds (`concurrency.maxConcurrentRuns`, `concurrency.maxPendingRuns`).
- [Built-in tools & auto-guards](tools-and-guards.md) — the bundled Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch tools and the automatic guards (tool-output bloat truncation, WebFetch retry, cost tracking, context compaction).

## Local providers in one block

Point `pi:<provider>:<model>` at a self-hosted endpoint. The `id` becomes the `<provider>` segment, so the model below is referenced as `pi:ollama:gemma4:31b`:

```json
{
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "trustPublicUrl": false,
        "apiKeyEnv": "MY_PROVIDER_KEY",
        "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }]
      }
    ]
  }
}
```

`type` is `ollama`, `lmstudio`, or `openai_compat`. Supply the key via `apiKeyEnv` (or inline `apiKey` in an untracked file only). See [Local providers](local-providers.md) for the full provider/env reference and [Embeddings](../memory/embeddings.md) for using the same providers in the memory tier.

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

`maxConcurrentRuns` (`MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`) caps how many runs hit the provider at once; `maxPendingRuns` (`MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS`) caps how many runs may be admitted before the provider step. Details and the session-store semantics are on [Sessions & concurrency](sessions-concurrency.md).

## Built-in tools & auto-guards

Every backend exposes Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch, gated by [tool policy](../tools/policy.md) (`tools.allowedTools` / `tools.disallowedTools`). Auto-guards run with no configuration: 256 KB tool-output truncation with artifact persistence to `artifacts.dir`, WebFetch in-tool retry on transient network errors, per-run cost/usage tracking, and bridge-driven context compaction. See [Built-in tools & auto-guards](tools-and-guards.md).

{: .tip }
Capabilities such as structured output (`runtimeOptions.outputSchema`), live in-flight input, human-in-the-loop approval gates, and tool parallelism are **code-only** — they are set through harness/runtime options, not config. See [Programmatic API](../programmatic/index.md) and [Approval & structured output](../programmatic/approval-and-structured-output.md).
