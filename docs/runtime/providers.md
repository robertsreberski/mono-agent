---
title: "Providers"
description: "Declare which providers an agent supports, widen model selection to full provider catalogs, and configure Pi auth and transport."
sidebar:
  order: 2
---

The `providers` config map declares which model providers the agent supports, and it is a **gate**, not a hint. What an agent advertises as selectable is exactly:

- every provider listed in `providers`,
- every provider named by `runtime.model` or a `runtime.fallbacks[]` entry — routing through a provider you did not mean to support is not possible, so those count as declared,
- `ollama` and `lmstudio` when zero-config discovery finds them running.

Declaring a provider widens selection to that provider's **full catalog**, not just the models you route to. A Pi built-in that nobody declared and no route uses is not offered at all: advertising all 39 would let an operator pick a provider the agent holds no credential for, and the failure would surface only when the turn ran.

Coverage: **config**. Configure the map in `mono-agent.config.json` under `providers`, or via `MONO_AGENT_PROVIDERS_JSON` as a JSON object with the same shape.

## Reserved keys

Three keys inside `providers` are reserved for Pi runtime configuration; every other key is a provider id:

| Key | Purpose |
| --- | --- |
| `piAuthPath` | Path to the Pi auth store (default `~/.pi/agent/auth.json`; env `MONO_AGENT_PI_AUTH_PATH`). OAuth/account credentials and API keys live here. |
| `piNative` | Pi transport and retry tuning: `transport` (`auto`/`sse`/`websocket`/`websocket-cached`), `piMaxRetries` (0–8, default 2), `maxRetryDelayMs` (default 60000), `piSessionsRoot` (durable JSONL session storage). |
| `local` | Legacy compatibility projection for `providers.local[]`. New configs prefer the provider-map shape below. |

## Declaring a provider

Each non-reserved key is a provider id, and its value is a provider definition:

```json
{
  "providers": {
    "ollama": {
      "type": "ollama",
      "baseUrl": "http://localhost:11434",
      "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }]
    },
    "my-gateway": {
      "type": "openai_compat",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKeyEnv": "GATEWAY_API_KEY"
    }
  }
}
```

Each definition accepts: `enabled`, `type` (`ollama`/`lmstudio`/`openai_compat` for a self-hosted endpoint — a `baseUrl` requires one of these unless the id is `ollama` or `lmstudio`), `baseUrl`, `trustPublicUrl`, `apiKey` / `apiKeyEnv` (give the secret's variable name in `.env`, never an inline value), `models[]` (with `name`, optional `alias`/`displayName`, `enabled`, `capabilities` like `context_window`, and `pricing`), and `maxAdvertisedModels`.

In JSON config, providers are always the map above (or the legacy `providers.local[]`). `providers.entries[]` is the **resolved** shape — what `resolveConfiguredProviders()` returns and what a programmatic embedder constructing a `MonoAgentConfig` in code may set directly. It is not accepted from `mono-agent.config.json` or `MONO_AGENT_PROVIDERS_JSON`: `entries` is not a reserved key there, so it would be read as a provider whose id is `entries`. Duplicate provider ids are rejected.

## Zero-config local autodiscovery

`ollama` and `lmstudio` are checked against their localhost endpoints without any configuration. A route that names either id is admitted even when `providers` does not list it, and the running agent probes the endpoint live:

| Provider id | Endpoint |
| --- | --- |
| `ollama` | `http://localhost:11434` |
| `lmstudio` | `http://localhost:1234` |

Probes run concurrently, fail independently, and a live probe lists the endpoint's models into the operator-facing catalog (bounded by `maxAdvertisedModels`, default 100). A provider entry that declares `enabled: false` is not probed. This is what lets a bare `runtime.model: "ollama:gemma4:31b"` work with zero provider config.

## Widening selection

A declared provider's full catalog becomes selectable. That applies to:

- `runtime.model` and `runtime.fallbacks[]` (`<provider>:<model>` refs)
- per-trigger `model` overrides (cron jobs, webhook endpoints and request bodies)
- the per-conversation model selector surfaced by Telegram/Slack/web `runtimeControls`
- agent-host `memory.llm.model` when you run BuJo capture through a declared provider

A route that names a provider in none of `providers`, Pi's built-in catalog, nor the two autodiscoverable ids fails closed at startup with a repair message — for example `Provider "private-provider" used by runtime.model is not available; add "providers": { "private-provider": {} }`.

## Credential resolution

- **Pi-level auth** (OAuth/account providers such as Anthropic, GitHub Copilot, OpenAI Codex; API-key providers such as OpenCode-Go) resolves through `providers.piAuthPath`. Set it up with `mono-agent auth login <provider> [--pi-auth-path ...]`.
- **Provider-level keys** resolve through the definition's `apiKeyEnv`: keep the value in `.env` and reference only its variable name in config, so the committed file carries no secret.

## Env form

`MONO_AGENT_PROVIDERS_JSON` is a JSON object of the same shape — provider ids plus the reserved `local`/`piAuthPath`/`piNative` keys. Prefer the config file, but the env override is the escape hatch for secrets-free ephemeral setups:

```bash
export MONO_AGENT_PROVIDERS_JSON='{"ollama": {"type": "ollama"}, "piAuthPath": "~/.pi/agent/auth.json"}'
```

`MONO_AGENT_LOCAL_PROVIDERS_JSON` is deprecated in favor of this map shape.

## Related

- [Pi runtime & model references](/runtime/backends/) — the `<provider>:<model>` grammar and rejected legacy spellings.
- [Local providers](/runtime/local-providers/) — the full local-provider and env reference for self-hosted endpoints.
- [Fallback & failover](/runtime/fallback/) — ordered backup routes using the same providers.
- [Environment variables](/config/env-vars/) — `MONO_AGENT_PROVIDERS_JSON` and friends.