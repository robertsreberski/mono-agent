---
title: "Local & self-hosted providers"
parent: "Runtime & Providers"
nav_order: 4
---

This page covers running mono-agent against local and self-hosted model servers — Ollama, LM Studio, and any OpenAI-compatible gateway — through the Pi backend, plus the credential path used for built-in Pi OAuth providers. You configure them under `providers` and reference each model as `pi:<id>:<model>` from `runtime.model` or `runtime.fallbackModels`.

For an end-to-end walkthrough, see the playbook [Local-only Ollama agent](../playbooks/local-only-ollama-agent.md).

## How local providers map to model refs

Each entry in `providers.local[]` defines a provider with an `id`. The Pi backend reaches its models with the ref form `pi:<id>:<model>`. For example, a provider with `id: "ollama"` exposing model `gemma4:31b` is referenced as `pi:ollama:gemma4:31b`.

This is the same `pi:<provider>:<model>` form used by built-in Pi providers (e.g. `pi:openai:gpt-5.5`); local providers simply add new ids you control. See [Backends & model refs](backends.md) for the full ref taxonomy.

Coverage: `config` — `providers.local[]` (`MONO_AGENT_LOCAL_PROVIDERS_JSON`, or the `MONO_AGENT_LOCAL_PROVIDER_*` single-provider env vars).

## The provider entry shape

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | Provider id used in `pi:<id>:<model>` refs. |
| `type` | `ollama` \| `lmstudio` \| `openai_compat` | Wire protocol of the server. |
| `baseUrl` | string | Server URL, e.g. `http://localhost:11434`. |
| `enabled` | boolean | Set `false` to keep the entry without loading it. |
| `trustPublicUrl` | boolean | Default `false`. Non-private (public) URLs are blocked unless this is `true`. |
| `apiKey` \| `apiKeyEnv` | string | Inline key (untracked file only) or the name of an env var holding it. |
| `models[]` | array | Each `{ name, capabilities: { context_window } }`. |

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "fallbackModels": ["pi:ollama:gemma4:31b"]
  },
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "trustPublicUrl": false,
        "models": [
          { "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }
        ]
      }
    ]
  }
}
```

The `capabilities.context_window` you declare tells the runtime how large the model's window is — it drives compaction and budgeting. Set it to the real window of the model you pulled; an inaccurate value leads to premature or missed compaction.

## Ollama (primary path)

Ollama is the recommended local path. Pull the model first, then reference it. A standard local Ollama install listening on `localhost:11434` needs no API key.

```bash
ollama pull gemma4:31b
```

```json
{
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "models": [
          { "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }
        ]
      }
    ]
  }
}
```

The model `name` must match the exact tag you pulled (including any `:tag` suffix). If a ref resolves to a model Ollama has not pulled, the call fails — run `mono-agent validate` to surface reachability and model checks before starting. See [Validation & CLI](../memory/validation-and-cli.md).

{: .tip }
Ollama also powers memory embeddings and BuJo capture independently of the chat runtime — those live under `memory.embeddings` / `memory.llm`, not `providers.local`. See [Embeddings](../memory/embeddings.md).

## LM Studio and OpenAI-compatible gateways

LM Studio and any OpenAI-compatible server (vLLM, Together, a self-hosted proxy, etc.) use the same entry shape with `type: "lmstudio"` or `type: "openai_compat"`. Point `baseUrl` at the server and supply a key via `apiKeyEnv` (or inline `apiKey` in an untracked file) when the gateway requires one.

```json
{
  "providers": {
    "local": [
      {
        "id": "studio",
        "type": "lmstudio",
        "baseUrl": "http://localhost:1234",
        "enabled": true,
        "models": [
          { "name": "qwen3.6-32b", "capabilities": { "context_window": 32768 } }
        ]
      },
      {
        "id": "gateway",
        "type": "openai_compat",
        "baseUrl": "https://llm.example.com",
        "enabled": true,
        "trustPublicUrl": true,
        "apiKeyEnv": "MY_GATEWAY_KEY",
        "models": [
          { "name": "llama-3.3-70b", "capabilities": { "context_window": 131072 } }
        ]
      }
    ]
  }
}
```

Set the key in the environment (a `.env` in the agent folder is loaded automatically):

```bash
MY_GATEWAY_KEY=sk-...
```

These ids are then referenced as `pi:studio:qwen3.6-32b` and `pi:gateway:llama-3.3-70b`.

### Public URL safety

mono-agent blocks non-private `baseUrl` values by default. To use a public/remote endpoint you must explicitly opt in with `trustPublicUrl: true`, and the URL must be HTTPS. This prevents an agent from silently exfiltrating prompts to an unintended host.

{: .warning }
Only set `trustPublicUrl: true` for gateways you control or trust. Private addresses (`localhost`, `127.0.0.1`, LAN ranges) are allowed without it; anything else is rejected until you trust it explicitly.

## Setting providers via environment

The whole array can be supplied as JSON, which overrides the config file:

```bash
MONO_AGENT_LOCAL_PROVIDERS_JSON='[{"id":"ollama","type":"ollama","baseUrl":"http://localhost:11434","enabled":true,"models":[{"name":"gemma4:31b","capabilities":{"context_window":32768}}]}]'
```

For a single provider there are scalar equivalents: `MONO_AGENT_LOCAL_PROVIDER_ID`, `MONO_AGENT_LOCAL_PROVIDER_TYPE`, `MONO_AGENT_LOCAL_PROVIDER_BASE_URL`, `MONO_AGENT_LOCAL_PROVIDER_ENABLED`, `MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL`, and `MONO_AGENT_LOCAL_PROVIDER_API_KEY`. See [Environment variables](../config/env-vars.md) for precedence rules.

## Pi OAuth credentials (built-in providers)

Some Pi providers — for example `pi:openai-codex` — authenticate via OAuth rather than a static key. Their credentials are read from a Pi auth file, configured with `providers.piAuthPath` (default `~/.pi/agent/auth.json`).

```json
{
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json"
  }
}
```

Override the path with `MONO_AGENT_PI_AUTH_PATH`. This is separate from `providers.local[]`: OAuth providers are built into the Pi backend, while `local[]` registers your own servers.

Coverage: `config` — `providers.piAuthPath` (`MONO_AGENT_PI_AUTH_PATH`).

## Using a local model as a fallback

Local providers compose with the rest of the runtime. A common pattern is a hosted primary model with a local fallback so the agent stays available offline or when a quota is hit:

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "fallbackModels": ["pi:ollama:gemma4:31b"]
  }
}
```

Failover is reported in run results, never silent. See [Fallback chains](fallback.md) for ordering and behavior.

## Related

- [Backends & model refs](backends.md) — the `pi:<provider>:<model>` ref taxonomy.
- [Fallback chains](fallback.md) — composing local models into `fallbackModels`.
- [Embeddings](../memory/embeddings.md) — Ollama for memory recall.
- [Local-only Ollama agent](../playbooks/local-only-ollama-agent.md) — full walkthrough.
