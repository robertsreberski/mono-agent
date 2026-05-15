# @worklab-ai/telegram-agent-demo

Private local demo host that composes the Mono Agent packages into a real Telegram long-polling agent.

The host code intentionally stays thin: it loads strict config, creates the runtime adapter, optional Markdown memory, observability recorder, fail-closed tool policy, agent harness, Telegram API client, bridge, and long poller.

## Required environment

```bash
MONO_AGENT_TELEGRAM_BOT_TOKEN=123456:bot-token
MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS=123456789
MONO_AGENT_MODEL=pi:openai-codex:gpt-5.5
MONO_AGENT_IDENTITY_PATH=./IDENTITY.md
```

Optional environment is documented in `@worklab-ai/config`.

## Run locally

```bash
npm run build --workspace @worklab-ai/telegram-agent-demo
node packages/telegram-agent-demo/dist/cli.js
```

Automated tests use fake Telegram/runtime clients only. The runtime product path uses the real Telegram Bot API client and real `@worklab-ai/agent-runtime` through `@worklab-ai/runtime-adapter` when credentials are supplied.
