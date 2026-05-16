# Final Agent Demo

This is the Mono Agent final demo. It is intentionally **not** an npm package: there is no `package.json`, no workspace entry, and no publishable export. The demo is just repo code that shows how the packages fit together.

## What it wires together

- `@worklab-ai/config-ui` starts a loopback settings UI for `mono-agent.config.json` using the core field groups plus a tiny demo-only Artifacts tab.
- `@worklab-ai/config` loads JSON plus environment overrides into a typed config.
- `@worklab-ai/runtime-adapter` creates the runtime backed by `@worklab-ai/agent-runtime`.
- `@worklab-ai/agent-harness` assembles context, history, memory, skills, tools, runtime calls, and responses.
- `@worklab-ai/memory-md` provides optional Markdown memory.
- `@worklab-ai/tool-policy` converts configured tool/MCP policy into runtime options.
- `@worklab-ai/observability` writes JSONL events and run summaries.
- `@worklab-ai/telegram-bridge` runs the real Telegram Bot API bridge and long poller.

## Run it

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run demo:final
```

The CLI prints:

- a config UI URL containing a per-boot local token,
- the config file path,
- whether Telegram is `running`, `waiting_for_config`, or `failed`.

Open the config UI, save a valid config, and Telegram starts once. Later config edits are written to disk but do not hot-reload a running Telegram poller; restart the demo to apply runtime/token/allowlist changes.

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

Environment variables override the JSON file. Keep provider credentials in the provider/runtime environment expected by `@worklab-ai/agent-runtime`; the config UI JSON is not a secret manager.

Useful env overrides:

```bash
MONO_AGENT_TELEGRAM_BOT_TOKEN=...
MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS=...
MONO_AGENT_MODEL=pi:openai-codex:gpt-5.5
MONO_AGENT_IDENTITY_PATH=./IDENTITY.md
```

## CLI options

```bash
pnpm run demo:final -- --config ./mono-agent.config.json --port 3007
```

- `--config <path>` changes the config file path.
- `--port <port>` pins the config UI port; omit it to choose a free loopback port.

## Safety notes

- The config UI binds to loopback and requires its per-boot bearer token for API calls.
- Telegram bot tokens are write-only in the config UI; GET responses redact them.
- Telegram chat ids are redacted in demo diagnostics.
- The demo uses fake runtime/Telegram only in tests. The CLI path uses the real bridge, poller, and runtime adapter.
