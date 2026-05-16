# Final Agent Demo

This is the Mono Agent final demo. It is intentionally **not** an npm package: there is no `package.json`, no workspace entry, and no publishable export. The demo is just repo code that shows how the packages fit together.

## What it wires together

- `@worklab-ai/operator-console` starts a loopback settings UI for `mono-agent.config.json`, plus a Traceability view over registered agent sources and recorded run artifacts.
- `@worklab-ai/config` loads adapter-neutral core JSON plus environment overrides.
- `@worklab-ai/runtime-adapter` creates the runtime backed by `@worklab-ai/agent-runtime`.
- `@worklab-ai/agent-harness` assembles context, history, memory, skills, tools, runtime calls, and responses.
- `@worklab-ai/memory-md` provides optional Markdown memory.
- `@worklab-ai/tool-policy` converts configured tool/MCP policy into runtime options.
- `@worklab-ai/observability` writes JSONL events/run summaries and registers this host in the local trace source registry.
- `@worklab-ai/telegram-adapter` owns Telegram settings, Bot API handling, and long polling.
- `@worklab-ai/a2a-adapter` owns A2A Agent Card discovery, loopback provider hosting, bearer auth, and remote text-task calls.

`src/configuration.ts` is the only demo-local place that registers field groups, loads core plus adapter config, redacts runtime status, and resolves the artifact directory. `src/final-demo.ts` handles lifecycle: start the operator console, start Telegram and A2A independently when config is valid, build the harness/runtime responder, and stop cleanly.

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
- whether Telegram is `running`, `waiting_for_config`, or `failed`,
- whether A2A is `disabled`, `running`, `waiting_for_config`, or `failed`.
- whether traceability source registration is `running`, `disabled`, or `failed`.

Open the operator console and save a valid config. Telegram and A2A start independently: missing Telegram credentials do not block A2A, and missing A2A config does not block Telegram. Later config edits are written to disk but do not hot-reload a running Telegram poller or A2A server; restart the demo to apply runtime/token/allowlist changes.

The top navigation includes **Settings** and **Traceability**. Traceability is refresh-based: the registry discovers running/stale/stopped/failed Mono Agent sources, and each source points at persisted `*.summary.json` / `*.events.jsonl` files. The timeline shows visible runtime/tool/message events and does not infer or expose private model chain-of-thought. The old `#observability` hash remains an alias for the traceability surface.

## Deploy with Ollama Gemma 4

Use the deployment command when you want the final demo to start with a real local runtime and traceability already wired:

```bash
ollama list
ollama pull gemma4:31b
curl http://localhost:11434/api/tags
pnpm run deploy:final
```

The command builds the repo, verifies `gemma4:31b` is installed in Ollama, writes `.mono-agent/deploy/final-agent-gemma4.config.json`, and starts the operator console plus loopback A2A provider. It does not write secrets. Generated deployment state is ignored by git:

```text
.mono-agent/deploy/final-agent-gemma4.config.json
.mono-agent/deploy/MEMORY.md
.mono-agent/deploy/workspace/
.mono-agent/deploy/artifacts/
.mono-agent/trace-sources/
```

Useful options:

```bash
pnpm run deploy:final -- --port 5317
pnpm run deploy:final -- --a2a-port 4317
pnpm run deploy:final -- --config ./.mono-agent/deploy/custom.config.json
pnpm run deploy:final -- --no-start
```

The CLI prints the operator console URL/token, trace source id `final-agent-gemma4`, trace registry, artifact directory, model reference `pi:ollama:gemma4:31b`, and the A2A Agent Card URL. Send a no-secret local smoke request to the printed Agent Card URL:

```bash
node --input-type=module - <<'EOF'
import { sendA2AMessage } from "@worklab-ai/a2a-adapter";

const response = await sendA2AMessage({
  agentUrl: "http://127.0.0.1:4317/.well-known/agent-card.json",
  text: "Reply with one sentence from the deployed final demo."
});

console.log(response.text);
EOF
```

Then open the operator console Traceability view. It should list source `final-agent-gemma4` and show the new A2A run with runtime events loaded from `.mono-agent/deploy/artifacts/`. Stop the deployment with `Ctrl-C`; the trace source is marked stopped during shutdown. Telegram remains optional and is not required for this deployment smoke.

## Minimal `mono-agent.config.json`

Use fake placeholders here only as shape examples. Do not commit real bot tokens or provider credentials.

```json
{
  "telegram": {
    "botToken": "123456:telegram-bot-token",
    "allowedChatIds": ["123456789"]
  },
  "a2a": {
    "provider": {
      "enabled": false,
      "host": "127.0.0.1",
      "port": 0
    },
    "agent": {
      "name": "Mono Agent",
      "description": "Local Mono Agent over A2A.",
      "version": "0.1.0"
    },
    "skill": {
      "id": "mono-agent",
      "name": "Mono Agent",
      "description": "Runs the configured Mono Agent runtime over text.",
      "tags": ["mono-agent", "a2a"]
    },
    "consumer": {
      "remoteAgentUrls": [],
      "timeoutMs": 30000
    }
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
  },
  "traceability": {
    "registryDir": "~/.mono-agent/trace-sources",
    "sourceId": "final-agent",
    "sourceLabel": "Final Agent Demo",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000
  }
}
```

Environment variables override the JSON file. Keep provider credentials in the provider/runtime environment expected by `@worklab-ai/agent-runtime`; the operator console JSON is not a secret manager.

## A2A Local Smoke

Start Agent A with A2A provider enabled and a real runtime configuration:

```json
{
  "a2a": {
    "provider": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 4300
    },
    "agent": {
      "name": "Agent A",
      "description": "Local A2A provider.",
      "version": "0.1.0"
    },
    "skill": {
      "id": "agent-a",
      "name": "Agent A",
      "description": "Answers text prompts.",
      "tags": ["mono-agent", "a2a"]
    }
  }
}
```

The CLI prints an Agent Card URL such as:

```text
a2a:       running - http://127.0.0.1:4300/.well-known/agent-card.json
```

From another local Mono host or a one-off package smoke, discover Agent A and send text:

```bash
node --input-type=module - <<'EOF'
import { sendA2AMessage } from "@worklab-ai/a2a-adapter";

const response = await sendA2AMessage({
  agentUrl: "http://127.0.0.1:4300/.well-known/agent-card.json",
  text: "Say hello from Agent B."
});

console.log(response.text);
EOF
```

If `a2a.provider.requireBearer` is true, also set `a2a.provider.bearerToken` for Agent A and pass `bearerToken` in the consumer call. The public Agent Card remains discoverable, but message/task endpoints require `Authorization: Bearer`.

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

For artifact lookup, `MONO_AGENT_ARTIFACT_DIR` wins, then `artifacts.dir` from `mono-agent.config.json`, then the built-in `./.mono-agent/artifacts` default. This lets the traceability view show existing default artifacts even while the rest of the demo config is incomplete.

For source discovery, `MONO_AGENT_TRACE_REGISTRY_DIR` wins, then `traceability.registryDir`, then `~/.mono-agent/trace-sources`. The default is intentionally host-shared so multiple Mono Agent processes from different working directories appear in one local dashboard. Source id and label can be set with `MONO_AGENT_TRACE_SOURCE_ID` / `MONO_AGENT_TRACE_SOURCE_LABEL` or `traceability.sourceId` / `traceability.sourceLabel`; otherwise the demo uses a deterministic path-derived id and the label `Final Agent Demo`.

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
MONO_AGENT_A2A_PROVIDER_ENABLED=true
MONO_AGENT_A2A_HOST=127.0.0.1
MONO_AGENT_A2A_PORT=4300
MONO_AGENT_A2A_AGENT_NAME="Mono Agent"
MONO_AGENT_A2A_AGENT_DESCRIPTION="Local Mono Agent over A2A."
MONO_AGENT_A2A_AGENT_VERSION=0.1.0
MONO_AGENT_A2A_SKILL_ID=mono-agent
MONO_AGENT_A2A_SKILL_NAME="Mono Agent"
MONO_AGENT_A2A_SKILL_DESCRIPTION="Runs the configured Mono Agent runtime over text."
MONO_AGENT_A2A_REMOTE_AGENT_URLS=http://127.0.0.1:4300/.well-known/agent-card.json
MONO_AGENT_TRACE_REGISTRY_DIR=~/.mono-agent/trace-sources
MONO_AGENT_TRACE_SOURCE_ID=final-agent
MONO_AGENT_TRACE_SOURCE_LABEL="Final Agent Demo"
```

## CLI options

```bash
pnpm run demo:final -- --config ./mono-agent.config.json --port 3007
pnpm run deploy:final -- --model gemma4:31b --ollama-url http://localhost:11434 --port 3007 --a2a-port 4300
```

- `--config <path>` changes the config file path.
- `--port <port>` pins the operator console port; omit it to choose a free loopback port.
- `deploy:final` also accepts `--model <ollama-tag>`, `--ollama-url <url>`, `--a2a-port <port>`, and `--no-start`.

## Safety notes

- The operator console binds to loopback and requires its per-boot bearer token for API calls.
- Traceability is local-only. The registry stores source manifests; run details stay in each source's local artifact directory.
- Telegram bot tokens are write-only in the operator console; GET responses redact them.
- Telegram chat ids are redacted in demo diagnostics.
- The A2A provider binds to loopback by default. Non-loopback bind or advertised public URLs require explicit opt-in and should be deployed only behind HTTPS plus bearer auth.
- A2A bearer tokens are write-only in the operator console and redacted from statuses.
- Trace event payloads are bounded and sensitive keys such as tokens, authorization headers, passwords, cookies, and API keys are redacted. Redaction is defensive, not a guarantee for arbitrary user-provided secret text.
- The demo uses fake runtime/Telegram only in tests. The CLI path uses the real adapters, poller/server, and runtime adapter.
- LangSmith/OpenTelemetry export is not part of this MVP. The current trace registry captures enough source/run timestamps to support a future export sink without adding external credentials to `mono-agent.config.json`.
