# Final Agent Demo

This is the Mono Agent final demo. It is intentionally **not** an npm package: there is no `package.json`, no workspace entry, and no publishable export. The demo is just repo code that shows how the packages fit together.

## What it wires together

- `@worklab-ai/operator-console` starts a loopback settings UI for `mono-agent.config.json`, plus a separate Observability view over recorded run artifacts.
- `@worklab-ai/config` loads adapter-neutral core JSON plus environment overrides.
- `@worklab-ai/runtime-adapter` creates the runtime backed by `@worklab-ai/agent-runtime`.
- `@worklab-ai/agent-harness` assembles context, history, memory, skills, tools, runtime calls, and responses.
- `@worklab-ai/memory-md` provides optional Markdown memory.
- `@worklab-ai/tool-policy` converts configured tool/MCP policy into runtime options.
- `@worklab-ai/observability` writes JSONL events and run summaries.
- `@worklab-ai/telegram-adapter` owns Telegram settings, Bot API handling, and long polling.

`src/configuration.ts` is the only demo-local place that registers field groups, loads core plus Telegram config, redacts runtime status, and resolves the artifact directory. `src/final-demo.ts` handles lifecycle: start the operator console, start Telegram when config is valid, build the harness/runtime responder, and stop cleanly.

## Run it

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run demo:final
```

The CLI prints:

- an operator console URL containing a per-boot local token,
- the config file path,
- whether Telegram is `running`, `waiting_for_config`, or `failed`.

Open the operator console, save a valid config, and Telegram starts once. Later config edits are written to disk but do not hot-reload a running Telegram poller; restart the demo to apply runtime/token/allowlist changes.

The top navigation includes **Settings** and **Runs**. Runs are refresh-based and read persisted `*.summary.json` / `*.events.jsonl` files from the same artifact directory used by the request recorder. The timeline shows visible runtime/tool/message events and does not infer or expose private model chain-of-thought.

## Minimal `mono-agent.config.json`

Use fake placeholders here only as shape examples. Do not commit real bot tokens or provider credentials.

```json
{
  "telegram": {
    "botToken": "123456:telegram-bot-token",
    "allowedChatIds": ["123456789"]
  },
  "runtime": {
    "model": "pi:openai-codex:gpt-5.5",
    "executionMode": "sdk",
    "maxTurns": 8,
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "selectedSkills": []
  },
  "memory": {
    "path": "./MEMORY.md",
    "maxBytes": 64000,
    "scope": "single-file",
    "writeMode": "disabled"
  },
  "tools": {
    "allowedTools": [],
    "disallowedTools": [],
    "mcpConfigPath": "./mcp.json"
  },
  "artifacts": {
    "dir": "./.mono-agent/artifacts"
  }
}
```

Environment variables override the JSON file. Keep provider credentials in the provider/runtime environment expected by `@worklab-ai/agent-runtime`; the operator console JSON is not a secret manager.

## Ollama Local Provider

To run the demo through a local Ollama model, start Ollama, pull a chat model, and point the Pi runtime reference at the local provider id:

```bash
ollama pull qwen3:8b
pnpm run demo:final
```

```json
{
  "runtime": {
    "model": "pi:ollama:qwen3:8b",
    "executionMode": "sdk",
    "maxTurns": 8,
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

Standard local Ollama needs no API key. The demo validates local-provider URLs before Telegram starts: private/local HTTP(S) URLs are allowed, while public URLs must use `https://` and set `trustPublicUrl: true`.

For artifact lookup, `MONO_AGENT_ARTIFACT_DIR` wins, then `artifacts.dir` from `mono-agent.config.json`, then the built-in `./.mono-agent/artifacts` default. This lets the Observability view show existing default artifacts even while the rest of the demo config is incomplete.

Useful env overrides:

```bash
MONO_AGENT_TELEGRAM_BOT_TOKEN=...
MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS=...
MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS=false
MONO_AGENT_MODEL=pi:openai-codex:gpt-5.5
MONO_AGENT_IDENTITY_PATH=./IDENTITY.md
MONO_AGENT_LOCAL_PROVIDER_ID=ollama
MONO_AGENT_LOCAL_PROVIDER_TYPE=ollama
MONO_AGENT_LOCAL_PROVIDER_BASE_URL=http://localhost:11434
```

## CLI options

```bash
pnpm run demo:final -- --config ./mono-agent.config.json --port 3007
```

- `--config <path>` changes the config file path.
- `--port <port>` pins the operator console port; omit it to choose a free loopback port.

## Safety notes

- The operator console binds to loopback and requires its per-boot bearer token for API calls.
- Telegram bot tokens are write-only in the operator console; GET responses redact them.
- Telegram chat ids are redacted in demo diagnostics.
- The demo uses fake runtime/Telegram only in tests. The CLI path uses the real adapter, poller, and runtime adapter.
