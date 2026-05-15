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

## JSON file layer (optional)

`loadMonoAgentConfigWithSources` reads a `mono-agent.config.json` file alongside the env. Precedence: **env beats JSON**. Missing or empty JSON is treated as an empty layer, so hosts can ship a partial file and let env fill in the rest.

```ts
import { loadMonoAgentConfigWithSources } from "@worklab-ai/config";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});
```

`writeMonoAgentConfigJson` writes the file atomically with mode `0o600` (temp + rename, deep-merge per section). `readMonoAgentConfigJson` returns `{ json, version, path, missing }` so callers can implement optimistic concurrency on top.

`@worklab-ai/config-ui` builds on these helpers to expose a browser-based editor without changing the env-only loader's contract.
