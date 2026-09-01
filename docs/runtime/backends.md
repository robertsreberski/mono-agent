---
title: "Pi runtime & model references"
description: "How the Pi runtime selects providers and models, the canonical model-reference syntax, and rejected legacy spellings."
sidebar:
  order: 1
---

mono-agent runs only the Pi runtime. Every turn — across Telegram, Slack, webhook, cron, TUI, web, or the programmatic API — executes through the Pi SDK provider gateway. There are no alternate runtime bridges, no `sdk`/`cli` execution-mode switch, and no backend dispatch table. You pick a model by setting one config key — `runtime.model` — to a `<provider>:<model>` reference; the Pi runtime resolves the reference to a concrete provider.

Coverage: **config**. Set the model reference in `runtime.model` (env `MONO_AGENT_MODEL`).

## Model reference grammar

A model reference is a `:`-delimited string. The first colon separates the provider id from the model id:

| Shape | Example |
| --- | --- |
| `<provider>:<model>` | `github-copilot:gpt-4.1` |
| `<provider>:<model>` with nested id | `openai-codex:gpt-5.6-terra` |
| Local provider | `ollama:gemma4:31b` |

Only the **first** colon is significant — model ids may contain slashes and colons (e.g. `openrouter:anthropic/claude-3.5-sonnet`).

### Rejected legacy spellings

These prefixes were removed in 0.21.0 and are hard-rejected with a named replacement:

| Rejected prefix | Replacement |
| --- | --- |
| `codex:<model>` | `openai-codex:<model>` (via Pi) |
| `claude:<model>` | `anthropic:<model>` (via Pi) |
| `claude-code:<model>` | `anthropic:<model>` (via Pi) |
| `codex-cli:<model>` | `openai-codex:<model>` (via Pi) |
| `acp:<model>` | The ACP client runtime backend was removed; use Pi directly |
| `vercel:<provider>:<model>` | `<provider>:<model>` |

A leading `pi:` prefix (e.g. `pi:openai-codex:gpt-5.6-terra`) is silently canonicalized away — the `pi:` is not part of the provider id. Tier aliases (`haiku`, `sonnet`, `opus`) are rejected; use an exact model id.

Note that `openai-codex` and `opencode-go` are **Pi provider ids**, not survivals of the removed bridges. Routes naming them are ordinary Pi routes and keep working.

### What was not removed

Four surfaces share names with the deleted runtime bridges and are unaffected by 0.21.0:

| Surface | Still works |
| --- | --- |
| [ACP **server** bridge](/programmatic/composition/) (`mono-agent bridge acp`) | mono-agent still *serves* ACP to clients. Only the ACP *client* runtime backend was removed. |
| `mono-agent install-skill --target claude\|codex` | Writes managed skills into those tools' directories. |
| [Documentation MCP pairing](/tools/documentation-mcp/) | Pairs the docs MCP with Claude Code and Codex. |
| [Codex web search](/tools/web-research/) (`tools.web.search.backend: "codex"`) | Drives a real `codex app-server` through the extracted client. |

## The Pi runtime

`<provider>:<model>` resolves through the Pi SDK provider gateway, which fronts 15+ providers including `openai`, `openai-codex`, `anthropic`, `github-copilot`, `opencode-go`, `openrouter`, `ollama`, and `lmstudio`. Subscription/account-backed providers are reachable here, including OpenAI-Codex, Anthropic, GitHub Copilot, and OpenCode-Go.

```json
{
  "runtime": {
    "model": "github-copilot:gpt-4.1",
    "effort": "high"
  }
}
```

Self-hosted and local providers used via `<provider>:<model>` are declared under `providers.local[]` — see [Local providers](/runtime/local-providers/). Zero-config autodiscovery covers `ollama` (localhost:11434) and `lmstudio` (localhost:1234); see [Providers](/runtime/providers/).

## Provider credentials

Pi credentials are resolved from the auth store at `providers.piAuthPath` (default `~/.pi/agent/auth.json`). OAuth/account-backed providers (Anthropic, GitHub Copilot, OpenAI Codex) are authenticated through `mono-agent auth login <provider>`. API-key providers (OpenCode-Go) use `OPENCODE_API_KEY` or a stored key. Local providers may declare `apiKeyEnv` for their own credentials. See [Providers](/runtime/providers/) for the full credential reference.

## How routing works

The Pi runtime resolves a `<provider>:<model>` reference by matching the provider id against:

1. Declared `providers.entries[]` or `providers.local[]` entries (explicit)
2. Pi built-in providers (bundled catalog)
3. Zero-config autodiscovered local providers (`ollama`, `lmstudio`)

If no match is found, the runtime rejects the route with a repair message suggesting a `providers` config entry.

## Fallback chains

`runtime.fallbacks` takes an ordered, uncapped list of `{ model, effort? }` routes tried on retryable provider/auth failures. Omitted effort means the route's provider default. Every fallback route uses the same Pi runtime — there is no cross-runtime safety concern. Pi keeps mono-agent tool policy and records the configured sandbox guarantee: `disabled` for no sandbox policy, `mono-agent-srt` for fail-closed SRT, or `mono-agent-srt-unsafe-host-fallback` when policy prefers SRT but explicitly permits unsandboxed host execution. Unsupported capabilities skip a route rather than being silently removed. Any fallback chain disables cross-turn provider-session reuse and relies on history/snapshot replay.

```json
{
  "runtime": {
    "model": "openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [
      { "model": "openai-codex:gpt-5.6-sol", "effort": "xhigh" },
      { "model": "ollama:gemma4:31b" }
    ]
  }
}
```

Env: `MONO_AGENT_FALLBACKS_JSON`. CLI: repeat `--fallback <ref>` and optionally follow each with `--fallback-effort <provider-default|level>`. `runtime.fallbackModels`, `MONO_AGENT_FALLBACK_MODELS` and the CLI `--fallback-models` flag were all retired. See [Fallback & failover](/runtime/fallback/) for router behavior and the failover report.

## Related

- [Providers](/runtime/providers/) — declaring providers, zero-config autodiscovery, and credential resolution.
- [Local providers](/runtime/local-providers/) — declaring Ollama / LM Studio / OpenAI-compatible providers.
- [Execution, effort & permissions](/runtime/execution-effort-permissions/) — `effort`, `permissionMode`.
- [Fallback & failover](/runtime/fallback/) — ordered backup models.
- [Sessions & concurrency](/runtime/sessions-concurrency/) — continuous vs per-message sessions and resume.
- [Environment variables](/config/env-vars/) — `MONO_AGENT_MODEL` and friends.
