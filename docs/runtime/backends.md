---
title: "Backends & model references"
parent: "Runtime & Providers"
nav_order: 1
---

# Backends & model references

This page documents every runtime backend mono-agent can route a turn to, the model-reference string that selects each one, and the execution mode and provider boundary involved. You pick a backend implicitly by setting one config key — `runtime.model` — to a model reference; the agent-runtime bridge registry resolves the reference (plus `runtime.executionMode`) to a concrete backend.

Coverage: **config**. Set the model reference in `runtime.model` (env `MONO_AGENT_MODEL`) and, when needed, `runtime.executionMode` (env `MONO_AGENT_EXECUTION_MODE`).

## Model reference grammar

A model reference is a `:`-delimited string. The leading segment is the runtime SDK id, which determines the backend family:

| SDK id | Reference shape | Example |
| --- | --- | --- |
| `claude` | `claude:<model>` | `claude:claude-sonnet-4-6` |
| `codex` | `codex:<model>` | `codex:gpt-5.5` |
| `pi` | `pi:<provider>:<model>` | `pi:openai:gpt-5.5` |
| `opencode` | `opencode:<provider>:<model>` | `opencode:github-copilot:gpt-4.1` |

Only four SDK ids are active: `claude`, `pi`, `codex`, `opencode` (`ACTIVE_RUNTIME_IDS` in [`packages/agent-runtime/src/ai/runtime/model-refs.js`](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-runtime/src/ai/runtime/model-refs.js)). The ids `openai`, `vercel`, `claude-code`, and `codex-cli` are *reserved legacy spellings* — they are canonicalized (`openai:x` → `pi:openai:x`, `claude-code:x` → `claude:x`, `vercel:p:m` → `pi:p:m`) or rejected. Tier aliases (`haiku`, `sonnet`, `opus`) are rejected; use an exact model id.

For `pi:` and `opencode:` only the **first** colon separates provider from model, so model ids may contain slashes (e.g. `opencode:openrouter:anthropic/claude-3.5-sonnet`).

## Backends

| Backend | Reference format | Execution mode | Provider boundary | Example |
| --- | --- | --- | --- | --- |
| Claude SDK | `claude:<model>` | `sdk` | `@anthropic-ai/claude-agent-sdk` | `claude:claude-sonnet-4-6` |
| Claude Code CLI | `claude:<model>` | `cli` | `claude` CLI binary (resumes via `--resume`) | `claude:claude-sonnet-4-6` |
| Codex CLI | `codex:<model>` | `cli` (only) | Codex app-server subprocess | `codex:gpt-5.5` |
| Pi SDK | `pi:<provider>:<model>` | `sdk` (only) | Pi SDK provider gateway (15+ providers) | `pi:github-copilot:gpt-4.1` |
| OpenCode | `opencode:<provider>:<model>` | `cli` (only) | `@opencode-ai/sdk` against OpenCode `auth.json` (75+ providers) | `opencode:github-copilot:gpt-4.1` |

### Claude (SDK and CLI)

`claude:<model>` references run under either execution mode. With `executionMode: "sdk"` (the default for `claude:`) the turn goes through the Anthropic `@anthropic-ai/claude-agent-sdk`. With `executionMode: "cli"` it runs through the local `claude` CLI binary, which supports session resume across turns.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "executionMode": "sdk"
  }
}
```

### Codex CLI

`codex:<model>` is CLI-only. The bridge keeps the Codex app-server subprocess and thread alive across turns when session keep-alive is set. Setting `executionMode: "sdk"` for a `codex:` model is rejected with "Codex CLI requires CLI execution mode."

```json
{
  "runtime": {
    "model": "codex:gpt-5.5",
    "executionMode": "cli"
  }
}
```

The default execution mode for a `codex:` model is already `cli`, so `executionMode` can be omitted.

### Pi SDK

`pi:<provider>:<model>` is SDK-only and is the broadest backend — the Pi SDK fronts 15+ providers, including `openai`, `openai-codex`, `github-copilot`, `openrouter`, and `ollama`. Copilot-class providers are reachable here (e.g. `pi:github-copilot:gpt-4.1`). Self-hosted and local providers used via `pi:<provider>:<model>` are declared under `providers.local[]` — see [Local providers](local-providers.md).

```json
{
  "runtime": {
    "model": "pi:github-copilot:gpt-4.1",
    "executionMode": "sdk"
  },
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json"
  }
}
```

A `pi:` provider that only runs under SDK mode (which is all of them) is rejected under `cli`. For `pi:openai-codex:*` the error suggests `codex:<model>` for the Codex CLI path.

### OpenCode

`opencode:<provider>:<model>` is a real backend, CLI-only, bridged through `@opencode-ai/sdk` talking to an OpenCode server. Provider and model ids come from OpenCode's own registry (its `auth.json`), spanning 75+ providers including Copilot and ChatGPT. Setting `executionMode: "sdk"` for an `opencode:` model is rejected with "OpenCode CLI requires CLI execution mode."

```json
{
  "runtime": {
    "model": "opencode:github-copilot:gpt-4.1",
    "executionMode": "cli"
  }
}
```

Copilot-class models are therefore reachable two ways: through `pi:github-copilot:<model>` (SDK) and through `opencode:github-copilot:<model>` (CLI). Pick the backend whose execution mode and auth source you want.

{: .note }
OpenCode is registered as the `opencode-app` bridge in [`packages/agent-runtime/src/ai/runtime/registry.js`](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-runtime/src/ai/runtime/registry.js); it self-registers and matches `sdk === "opencode" && executionMode === "cli"`.

## Execution modes

`runtime.executionMode` is `sdk` or `cli`. When omitted, mono-agent infers a default from the model reference (e.g. `claude:` → `sdk`, `codex:` → `cli`). Each backend constrains which modes are valid; incompatible combinations are rejected with a specific reason rather than silently coerced. See [Execution, effort & permissions](execution-effort-permissions.md) for `effort`, `permissionMode`, and `reasoningSummary`.

| SDK id | Allowed execution mode(s) |
| --- | --- |
| `claude` | `sdk` or `cli` |
| `pi` | `sdk` only |
| `codex` | `cli` only |
| `opencode` | `cli` only |

## How routing actually works

There are two backend tables in the codebase, and only one of them performs routing.

- **Routing (real):** the agent-runtime bridge registry in [`packages/agent-runtime/src/ai/runtime/registry.js`](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-runtime/src/ai/runtime/registry.js). `listRuntimeBridges()` / `resolveRuntimeBridge()` pick the first bridge whose `supports(ref, options)` matches. This registry includes `opencode-app`, so OpenCode is fully routable.
- **Vocabulary metadata (descriptive only):** `RUNTIME_BACKEND_DEFINITIONS` in [`packages/runtime-adapter/src/runtime-adapter.ts`](https://github.com/robertsreberski/mono-agent/blob/main/packages/runtime-adapter/src/runtime-adapter.ts) lists four entries (claude-sdk, claude-code-cli, codex-app-cli, pi-sdk). Its own docstring states it is **"NOT wired into agent-host routing; consumers read it to align vocabularies."** It is a declarative descriptor table, not the router — the absence of an OpenCode entry there does not mean OpenCode is unrouted.

{: .warning }
When auditing backends, read the bridge registry (`registry.js`), not the runtime-adapter descriptor table. The descriptor table is intentionally a vocabulary surface and is not authoritative for which backends can actually run.

## Fallback chains

`runtime.fallbackModels` takes an ordered list of additional model references tried on retryable provider failures, fronted by the fallback router. Entries can mix backends.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "fallbackModels": ["pi:openrouter:anthropic/claude-3.5-sonnet", "pi:ollama:gemma4:31b"]
  }
}
```

Env: `MONO_AGENT_FALLBACK_MODELS`. CLI: `mono-agent init --fallback-models ...`. See [Fallback & failover](fallback.md) for router behavior and the failover report.

## Related

- [Local providers](local-providers.md) — declaring Ollama / LM Studio / OpenAI-compatible providers for `pi:<provider>:<model>`.
- [Execution, effort & permissions](execution-effort-permissions.md) — `executionMode`, `effort`, `permissionMode`, `reasoningSummary`.
- [Fallback & failover](fallback.md) — ordered backup models.
- [Sessions & concurrency](sessions-concurrency.md) — continuous vs per-message sessions and resume.
- [Environment variables](../config/env-vars.md) — `MONO_AGENT_MODEL`, `MONO_AGENT_EXECUTION_MODE`, and friends.
