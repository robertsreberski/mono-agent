# Agents SDK Demo

Three responders side-by-side, one per first-class in-repo runtime package, each exposed over A2A on its own port:

| Runtime | Package | Default port | Skipped if |
| --- | --- | --- | --- |
| Claude | `@mono-agent/claude-agents-runtime` | 41100 | `ANTHROPIC_API_KEY` is unset |
| OpenAI | `@mono-agent/openai-agents-runtime` | 41101 | `OPENAI_API_KEY` is unset |
| Codex  | `@mono-agent/codex-app-runtime`     | 41102 | `OPENAI_API_KEY` is unset (Codex CLI auth) |

Proves the framework's premise: any team picks the SDK they want, the host composes responders identically, A2A handles interop.

## Run

Each agent's responder reads identity, tools, artifacts, etc. from the same `MonoAgentConfig` (loaded from env), but the runtime + model is supplied at composition time, so the env's `MONO_AGENT_MODEL` is a placeholder.

```bash
export MONO_AGENT_MODEL="claude:claude-sonnet-4-6"   # placeholder, runtime overrides it
export MONO_AGENT_IDENTITY_PATH="/path/to/IDENTITY.md"
export ANTHROPIC_API_KEY="sk-ant-..."                # enables Claude responder
export OPENAI_API_KEY="sk-..."                       # enables OpenAI + Codex responders
pnpm run build
pnpm run demo:agents-sdk
```

For Codex, the `codex` binary must be on `PATH`. The `@openai/codex` workspace dep installs it under `node_modules/.bin/`.

## Interop check

Once running, query any agent over A2A:

```bash
curl http://127.0.0.1:41100/.well-known/agent-card | jq .
curl http://127.0.0.1:41101/.well-known/agent-card | jq .
curl http://127.0.0.1:41102/.well-known/agent-card | jq .
```

All three respond with valid Agent Cards. Any A2A-compliant client can drive them; the orchestrator from `@mono-agent/agent-orchestrator` discovers and routes between them.
