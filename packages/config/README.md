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
  buildMonoAgentConfigView,
  loadMonoAgentConfigWithSources,
} from "@mono-agent/config";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});
```

Environment variables win over JSON values. Missing or empty JSON is treated as an empty layer.

## Agent Identity and Runtime Routes

`agent.name` is public display metadata. It can seed human-facing trace and A2A
labels, but it never changes paths, service ids, session keys, or provider
identity. `MONO_AGENT_NAME` overrides the JSON value.

Use `runtime.fallbacks` for new fallback chains. It is an ordered, uncapped array
of `{ model, effort? }` entries; omitted route effort means the provider default.
`runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain compatibility
surfaces and retain their historical inheritance from `runtime.effort`.

```json
{
  "agent": { "name": "Research Companion" },
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [
      { "model": "claude:claude-sonnet-5", "effort": "xhigh" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "per-route-native"
  }
}
```

`routeSafety` defaults to `uniform`; `per-route-native` is the explicit opt-in
for isolated provider-native contracts in a mixed chain. Effort values are
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, subject
to the selected model's supported subset.

`ultra` is route-specific. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi
without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged; Claude
SDK rejects `ultra`; Claude CLI forwards `ultra` unchanged; direct OpenCode
rejects explicit effort. `effortRank`
places `ultra` above `max` only so keyword escalation cannot downgrade an
explicitly configured value.

## Pi Credentials

Built-in Pi OAuth and API-key providers read credentials through the configured
Pi auth file. The default path is
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

Pi-native transport selection is optional and defaults to `auto`. Configure
`providers.piNative.transport` or `MONO_AGENT_PI_TRANSPORT` with `auto`, `sse`,
`websocket`, or `websocket-cached`; unsupported providers ignore the choice.

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

## Managed Memory Embeddings

Journal and BuJo accept `ollama`, `lmstudio`, or `openai` in
`memory.embeddings.provider`. Keep the provider, service root, exact model, and
actual dimension explicit because they form the managed index identity:

```json
{
  "memory": {
    "mode": "journal",
    "path": "./.mono-agent/memory",
    "embeddings": {
      "provider": "lmstudio",
      "endpoint": "http://localhost:1234",
      "model": "text-embedding-nomic-embed-text-v1.5",
      "dim": 768,
      "apiKeyEnv": "LM_STUDIO_API_KEY"
    }
  }
}
```

Omit `apiKeyEnv` for keyless LM Studio. When the field is present, the loader
preserves the variable name and resolves its value only from the environment;
the app reports a missing/empty declared variable as `waiting` and never silently
retries keyless. OpenAI still requires a resolved key. Provider selection is
exclusive and does not define fallback behavior. Changing provider, model, or
dimension on an existing Journal/BuJo root requires the config-aware stopped
`mono-agent memory rebuild` workflow.

### Provider sessions

Continuous provider sessions are configured under `runtime.session` (JSON: `{ "runtime": { "session": { "mode": "continuous", "idleTimeoutMs": 1800000 } } }`):

```bash
MONO_AGENT_SESSION_MODE=continuous           # or per-message (today's stateless behavior)
MONO_AGENT_SESSION_IDLE_TIMEOUT_MS=1800000   # 30 min default; min 1s, max 24h
MONO_AGENT_SESSION_ROLLOVER=daily            # none (default) or daily
MONO_AGENT_SESSION_ROLLOVER_TIMEZONE=UTC     # optional IANA timezone for daily rollover
MONO_AGENT_SESSION_ROLLOVER_NOTICE=true      # opt in to adapter-visible new-bucket notices
```

In `continuous` mode (the default) consecutive messages in a conversation reuse one live provider session (codex app-server thread, claude resume, pi Session transcript) and conversation history is omitted from the prompt while the session lives; sessions die after the idle timeout and the next message falls back to history replay.

## Sandbox Policy

Sandbox config is optional. When any `MONO_AGENT_SANDBOX_*` variable is present, config builds a fail-closed `@mono-agent/runtime-adapter` policy rooted at `runtime.workspace`:

```bash
MONO_AGENT_SANDBOX_MODE=native
MONO_AGENT_SANDBOX_NETWORK=none
MONO_AGENT_SANDBOX_FALLBACK=fail-closed
```

Enforced network modes are `none`, `localhost`, and `allowlist`. `allowlist` reads comma-separated domains from `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST`. `all`, bare `*`, and IPv6 literals are rejected because pinned SRT 0.0.64 cannot enforce them exactly. Migrate an existing native `network.mode: "all"` config to `none`, `localhost`, or an explicit allowlist; if unrestricted shell networking is intentional, set `sandbox.mode: "off"` and remove the network policy. Unsafe host-process fallback requires both `MONO_AGENT_SANDBOX_FALLBACK=unsafe-host-process` and `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS=true`.

## Public API

- `loadMonoAgentConfig`, `loadMonoAgentConfigWithSources`
- `redactMonoAgentConfig`
- `readMonoAgentConfigJson`, `writeMonoAgentConfigJson`
- `buildMonoAgentConfigView`, `CONFIG_ENV_KEYS` — the single source-annotated view of a resolved config (env/json/default per field), used by the TUI config pane and `mono-agent config`
- `EFFORT_LEVELS`, `ROUTE_SAFETY_MODES`, `PERMISSION_MODES`
- `MonoAgentConfig`, `MonoAgentConfigJson`, `PiNativeProviderConfig`, `RedactedMonoAgentConfig`, `MonoAgentConfigError`

## Dependency Boundary

`@mono-agent/config` may depend on `@mono-agent/agent-contracts` and `@mono-agent/runtime-adapter`. It must not depend on communication adapters, agent harness, or UI packages.

## What This Package Does Not Own

It does not load Telegram, WhatsApp, Slack, or other adapter-specific credentials or allowlists. Adapter packages own those settings and their safety rules.

## Verification

```bash
pnpm --filter @mono-agent/config run build
pnpm --filter @mono-agent/config run typecheck
pnpm --filter @mono-agent/config run test
```
