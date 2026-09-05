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
| Hyphenated provider id | `openai-codex:gpt-5.6-terra` |
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
| `opencode:<provider>:<model>` | `<provider>:<model>` (the inner pair; a plain `opencode:<model>` stays valid) |

A leading `pi:` prefix is silently canonicalized away (`pi:openai-codex:gpt-5.6-terra` loads as `openai-codex:gpt-5.6-terra`) — the `pi:` is not part of the provider id. Tier aliases (`haiku`, `sonnet`, `opus`) are rejected; use an exact model id.

The replacement is named in the message every operator surface prints — `mono-agent doctor`, `mono-agent validate`, `mono-agent config`, per-trigger override checks and the startup error alike — with the offending value quoted back:

```text
runtime.model `codex:gpt-5.6-terra` is not a valid runtime model reference:
codex is no longer a runtime backend; use openai-codex:gpt-5.6-terra
```

The message names the source you actually edit. A value from
`mono-agent.config.json` is attributed to its JSON path, as above; the same value
supplied through the environment is attributed to the variable instead:

```text
MONO_AGENT_MODEL `codex:gpt-5.6-terra` is not a valid runtime model reference:
codex is no longer a runtime backend; use openai-codex:gpt-5.6-terra
```

The quoted value is bounded and rendered on one line, so an over-long or
newline-bearing value cannot flood the output or forge a second diagnostic line.

`openai-codex` is a different auth store from the removed `codex` bridge, so applying that replacement is a deliberate choice, not a rename. Every model-carrying field is checked the same way: `runtime.model`, each `runtime.fallbacks[].model`, each `subagents.definitions[].model`, an `agent-host` `memory.llm.model`, and per-trigger `model` overrides.

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

Pi 0.85.1 includes GPT-6 Astra under both first-party OpenAI providers:
`openai:gpt-6-astra` uses an OpenAI API key, while
`openai-codex:gpt-6-astra` uses a Codex subscription. The Codex route is part of
guided setup; the direct OpenAI route remains compatible through hand-authored
provider configuration.

```json
{
  "runtime": {
    "model": "github-copilot:gpt-4.1",
    "effort": "high"
  }
}
```

Self-hosted and local providers used via `<provider>:<model>` are declared in the `providers` map (the legacy `providers.local[]` array still loads) — see [Local providers](/runtime/local-providers/). Zero-config autodiscovery finds `ollama` (localhost:11434) and `lmstudio` (localhost:1234) for the catalog, but running one still needs a declared entry; see [Providers](/runtime/providers/).

## Provider credentials

Pi credentials are resolved from the auth store at `providers.piAuthPath` (default `~/.pi/agent/auth.json`). OAuth/account-backed providers (Anthropic, GitHub Copilot, OpenAI Codex) are authenticated through `mono-agent auth login <provider>`. API-key providers (OpenCode-Go) use `OPENCODE_API_KEY` or a stored key. Local providers may declare `apiKeyEnv` for their own credentials. See [Providers](/runtime/providers/) for the full credential reference.

## How routing works

The Pi runtime resolves a `<provider>:<model>` reference by matching the provider id against:

1. Providers declared in the `providers` map — one key per provider id, plus legacy `providers.local[]` entries (explicit)
2. Pi built-in providers (bundled catalog)

If no match is found, the runtime rejects the route with a repair message suggesting a `providers` config entry.

Zero-config autodiscovery of `ollama` and `lmstudio` is a third source for *route admission and the model catalog*, not for execution: it lets an undeclared local route load and be picked, but the turn itself still needs a declared entry — `"providers": { "ollama": {} }` — to get an endpoint. See [Providers](/runtime/providers/#zero-config-local-autodiscovery).

## Fallback chains

`runtime.fallbacks` takes an ordered, uncapped list of `{ model, effort? }` routes tried on retryable provider/auth failures. Omitted effort means the route's provider default. Every fallback route uses the same Pi runtime — there is no cross-runtime safety concern, and no per-route sandbox guarantee to record. Every route keeps the same mono-agent tool policy and the one configured `sandbox` block; `mono-agent status` and `mono-agent validate` report that one effective state for the agent, not one per route. Unsupported capabilities skip a route rather than being silently removed. Any fallback chain disables cross-turn provider-session reuse and relies on history/snapshot replay.

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
