---
title: "Local & self-hosted providers"
sidebar:
  order: 4
---

This page covers running mono-agent against local and self-hosted model servers — Ollama, LM Studio, and any OpenAI-compatible gateway — through the Pi backend, plus the credential path used for built-in Pi providers. You configure them under `providers` and reference each model as `pi:<id>:<model>` from `runtime.model` or `runtime.fallbackModels`.

For an end-to-end walkthrough, see the playbook [Local-only Ollama agent](/playbooks/local-only-ollama-agent/).

## How local providers map to model refs

Each entry in `providers.local[]` defines a provider with an `id`. The Pi backend reaches its models with the ref form `pi:<id>:<model>`. For example, a provider with `id: "ollama"` exposing model `gemma4:31b` is referenced as `pi:ollama:gemma4:31b`.

This is the same `pi:<provider>:<model>` form used by built-in Pi providers (e.g. `pi:openai:gpt-5.5`); local providers simply add new ids you control. See [Backends & model refs](/runtime/backends/) for the full ref taxonomy.

Coverage: `config` — `providers.local[]` (`MONO_AGENT_LOCAL_PROVIDERS_JSON`, or the `MONO_AGENT_LOCAL_PROVIDER_*` single-provider env vars).

`mono-agent init` can discover local models while you scaffold: `ollama list` contributes `pi:ollama:<model>` choices, and LM Studio's default local server (`http://localhost:1234/v1/models`) contributes `pi:lmstudio:<model>` choices. Discovery is best-effort and bounded; missing CLIs or stopped servers show status in the wizard without failing the scaffold. Choosing a `pi:ollama:*` or `pi:lmstudio:*` primary or fallback model auto-adds the matching local provider module to the generated config, and `--auth` / interactive provider setup runs a reachability preflight instead of collecting secrets.

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
    "model": "pi:openai-codex:gpt-5.6-terra",
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

The model `name` must match the exact tag you pulled (including any `:tag` suffix). If a ref resolves to a model Ollama has not pulled, the call fails — run `mono-agent validate` to surface reachability and model checks before starting. See [Validation & CLI](/memory/validation-and-cli/).

Ollama also powers memory embeddings and BuJo capture independently of the chat runtime — those live under `memory.embeddings` / `memory.llm`, not `providers.local`. See [Embeddings](/memory/embeddings/).

## LM Studio and OpenAI-compatible gateways

LM Studio and any OpenAI-compatible server (vLLM, Together, a self-hosted proxy, etc.) use the same entry shape with `type: "lmstudio"` or `type: "openai_compat"`. Point `baseUrl` at the server and supply a key via `apiKeyEnv` (or inline `apiKey` in an untracked file) when the gateway requires one. If `apiKeyEnv` is declared but does not resolve to a non-empty value, `mono-agent validate` reports the route as `waiting`; omitting both key fields is treated as an intentional keyless provider.

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

:::caution
:::
Only set `trustPublicUrl: true` for gateways you control or trust. Private addresses (`localhost`, `127.0.0.1`, LAN ranges) are allowed without it; anything else is rejected until you trust it explicitly.

## Setting providers via environment

The whole array can be supplied as JSON, which overrides the config file:

```bash
MONO_AGENT_LOCAL_PROVIDERS_JSON='[{"id":"ollama","type":"ollama","baseUrl":"http://localhost:11434","enabled":true,"models":[{"name":"gemma4:31b","capabilities":{"context_window":32768}}]}]'
```

For a single provider there are scalar equivalents: `MONO_AGENT_LOCAL_PROVIDER_ID`, `MONO_AGENT_LOCAL_PROVIDER_TYPE`, `MONO_AGENT_LOCAL_PROVIDER_BASE_URL`, `MONO_AGENT_LOCAL_PROVIDER_ENABLED`, `MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL`, and `MONO_AGENT_LOCAL_PROVIDER_API_KEY`. See [Environment variables](/config/env-vars/) for precedence rules.

## Pi credentials (built-in providers)

Built-in Pi providers use the Pi auth file configured by `providers.piAuthPath` (default `~/.pi/agent/auth.json`) rather than `providers.local[]`. Some providers, such as `pi:openai-codex`, authenticate through OAuth/account flows; others, such as `pi:opencode-go`, use API-key credentials stored in the same auth file.

```json
{
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json"
  }
}
```

Override the path with `MONO_AGENT_PI_AUTH_PATH`. The single path precedence used by discovery, setup, `auth login`, readiness, validation, and runtime is `--pi-auth-path` (auth command only) → non-empty `MONO_AGENT_PI_AUTH_PATH` → non-empty `providers.piAuthPath` → `~/.pi/agent/auth.json`. A leading `~` expands to the current user's home; relative values resolve from the agent/invocation working directory. A malformed or unreadable config is an error; only a missing config falls through. This is separate from `providers.local[]`: built-in Pi providers are registered by the Pi backend, while `local[]` registers your own servers.

Run `mono-agent auth login <provider>` when a built-in Pi OAuth provider needs setup or re-auth. Supported login providers are `openai-codex`, `anthropic`, and `github-copilot`; OpenCode-Go is API-key based and uses `OPENCODE_API_KEY` during init.

mono-agent invokes the bundled Pi CLI against a private staged `auth.json`; it never trusts process exit alone. Before promotion it requires a JSON-object store, a valid credential for the requested provider, and unchanged sibling-provider data. Promotion runs under a durable identity-bound owner-only lock and installs a `0600` file with exclusive-link no-clobber semantics on supported POSIX systems. The canonical credential parent must be owned by the current user and not group/world-writable, while existing, staged, and recovery credential inodes must be current-user-owned, not group/world-writable, and have exactly the expected link count. An owned existing store may be read-permissive (for example `0644`) and is tightened to `0600`, but permissions that let another user write, foreign ownership, or multiple links fail closed. A pathname competitor is never replaced. For an existing store, mono-agent claims the validated inode, rechecks it before and after installing the staged file, and keeps any detected write through an already-open descriptor at a reported owner-only recovery path. As with any non-cooperative POSIX writer, a write that starts after the final recheck cannot be guaranteed. Malformed, symlinked, missing-provider, sibling-changing, or unprovable concurrent states fail closed. Automatic Pi credential persistence refuses Windows and auth paths inside Git worktrees; keep the store outside repositories, normally at the default under `~/.pi`.

The interactive `mono-agent init` wizard treats a missing Pi auth store as setup-required rather than as a skipped model: it keeps `pi:openai-codex:gpt-5.6-terra` selectable, shows the effective path and auth status, and can run the secure bundled login before writing the scaffold. When `pi:opencode-go:*` is selected, the wizard asks for an API key and stores it under `opencode-go` through the same locked, validated, no-clobber path. `mono-agent validate` reports missing or expired credentials read-only and never runs login or writes keys.

Coverage: `config` — `providers.piAuthPath` (`MONO_AGENT_PI_AUTH_PATH`).

## Using a local model as a fallback

Local providers compose with the rest of the runtime. A common pattern is a hosted primary model with a local fallback so the agent stays available offline or when a quota is hit:

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbackModels": ["pi:ollama:gemma4:31b"]
  }
}
```

Failover is reported in run results, never silent. See [Fallback chains](/runtime/fallback/) for ordering and behavior.

## Related

- [Backends & model refs](/runtime/backends/) — the `pi:<provider>:<model>` ref taxonomy.
- [Fallback chains](/runtime/fallback/) — composing local models into `fallbackModels`.
- [Embeddings](/memory/embeddings/) — Ollama for memory recall.
- [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) — full walkthrough.
