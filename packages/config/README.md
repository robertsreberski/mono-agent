# @mono-agent/config

## Category

Category: `core`

## Responsibility

Adapter-neutral core agent configuration. It loads runtime, context, memory, tool/MCP, and artifact settings from environment variables plus optional JSON, validates runtime model/execution-mode compatibility through `@mono-agent/runtime-adapter`, and exposes core field groups for settings UIs.

## Install / Usage

```bash
pnpm --filter @mono-agent/config run build
```

```ts
import {
  CORE_AGENT_FIELD_GROUPS,
  loadMonoAgentConfigWithSources,
} from "@mono-agent/config";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});
```

Environment variables win over JSON values. Missing or empty JSON is treated as an empty layer.

## Pi OAuth Auth

Built-in Pi OAuth providers such as `pi:openai-codex:gpt-5.5` read credentials
through the configured Pi auth file. The default path is
`~/.pi/agent/auth.json`; override it with JSON or env:

```json
{
  "providers": {
    "piAuthPath": ".worklab/auth.json"
  }
}
```

```bash
MONO_AGENT_PI_AUTH_PATH=/Users/example/.pi/agent/auth.json
```

Only the path is stored in config. Token contents stay in the auth JSON file and
are never included in `redactMonoAgentConfig()`.

## Local Providers

Core config can also define local Pi providers under `providers.local`. The primary supported path is Ollama:

```json
{
  "runtime": {
    "model": "pi:ollama:qwen3:8b",
    "executionMode": "sdk",
    "workspace": "."
  },
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "models": [
          { "name": "qwen3:8b", "capabilities": { "context_window": 32768 } }
        ]
      }
    ]
  }
}
```

`runtime.maxTurns` is optional. Omit it or set `0` for unlimited runs; set `1`-`100` to keep a hard cap.

Environment overrides for the common one-provider case:

```bash
MONO_AGENT_LOCAL_PROVIDER_ID=ollama
MONO_AGENT_LOCAL_PROVIDER_TYPE=ollama
MONO_AGENT_LOCAL_PROVIDER_BASE_URL=http://localhost:11434
MONO_AGENT_LOCAL_PROVIDER_ENABLED=true
MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL=false
```

`MONO_AGENT_LOCAL_PROVIDERS_JSON` can hold the full local-provider array. Env values win over JSON; empty env values are ignored. `MONO_AGENT_LOCAL_PROVIDER_API_KEY` and provider `apiKeyEnv` are passed only to the runtime path and are redacted from `redactMonoAgentConfig()`.

### Provider sessions

Continuous provider sessions are configured under `runtime.session` (JSON: `{ "runtime": { "session": { "mode": "continuous", "idleTimeoutMs": 1800000 } } }`):

```bash
MONO_AGENT_SESSION_MODE=continuous           # or per-message (today's stateless behavior)
MONO_AGENT_SESSION_IDLE_TIMEOUT_MS=1800000   # 30 min default; min 1s, max 24h
```

In `continuous` mode (the default) consecutive messages in a conversation reuse one live provider session (codex app-server thread, claude resume, pi Session transcript) and conversation history is omitted from the prompt while the session lives; sessions die after the idle timeout and the next message falls back to history replay.

## Sandbox Policy

Sandbox config is optional. When any `MONO_AGENT_SANDBOX_*` variable is present, config builds a fail-closed `@mono-agent/sandbox` policy rooted at `runtime.workspace`:

```bash
MONO_AGENT_SANDBOX_MODE=native
MONO_AGENT_SANDBOX_NETWORK=none
MONO_AGENT_SANDBOX_FALLBACK=fail-closed
```

Supported network modes are `none`, `localhost`, `allowlist`, and `all`. `allowlist` reads comma-separated domains from `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST`. Unsafe host-process fallback requires both `MONO_AGENT_SANDBOX_FALLBACK=unsafe-host-process` and `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS=true`.

## Public API

- `loadMonoAgentConfig`, `loadMonoAgentConfigWithSources`
- `redactMonoAgentConfig`
- `readMonoAgentConfigJson`, `writeMonoAgentConfigJson`
- `layerJsonOntoEnv`
- `CORE_AGENT_FIELD_GROUPS`, plus individual identity/runtime/memory/tools/providers/artifacts field groups
- `MonoAgentConfig`, `MonoAgentConfigJson`, `RedactedMonoAgentConfig`, `MonoAgentConfigError`

## Dependency Boundary

`@mono-agent/config` may depend on `@mono-agent/settings`, `@mono-agent/runtime-adapter`, and `@mono-agent/sandbox`. It must not depend on communication adapters, the operator console, agent harness, or UI packages.

## What This Package Does Not Own

It does not load Telegram, WhatsApp, Slack, or other adapter-specific credentials or allowlists. Adapter packages own those settings and their safety rules.

## Verification

```bash
pnpm --filter @mono-agent/config run build
pnpm --filter @mono-agent/config run typecheck
pnpm --filter @mono-agent/config run test
```
