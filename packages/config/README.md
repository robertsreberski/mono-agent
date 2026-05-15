# @worklab-ai/config

Strict configuration loader for Mono Agent hosts.

The package reads explicit environment variables into a typed `MonoAgentConfig`, validates model/execution-mode compatibility through `@worklab-ai/runtime-adapter`, requires a Telegram chat allowlist, and provides a redacted export for logs or diagnostics.

Required variables for the Telegram demo:

```bash
MONO_AGENT_TELEGRAM_BOT_TOKEN=123456:bot-token
MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS=123456789
MONO_AGENT_MODEL=pi:openai-codex:gpt-5.5
MONO_AGENT_IDENTITY_PATH=./IDENTITY.md
```

Optional variables include `MONO_AGENT_SOUL_PATH`, `MONO_AGENT_SKILLS_ROOT`, `MONO_AGENT_SELECTED_SKILLS`, `MONO_AGENT_MEMORY_PATH`, `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS`, `MONO_AGENT_MCP_CONFIG_PATH`, `MONO_AGENT_WORKSPACE`, `MONO_AGENT_ARTIFACT_DIR`, `MONO_AGENT_EFFORT`, and `MONO_AGENT_MAX_TURNS`.

`redactMonoAgentConfig()` never includes the bot token or raw chat ids.
