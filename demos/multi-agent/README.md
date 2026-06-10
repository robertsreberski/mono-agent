# Multi-Agent Demo

This non-package demo proves a three-agent Mono Agent topology using reusable orchestration and communication packages.

Each role uses `@mono-agent/agent-host` for the core config-to-responder step:

```ts
const runtime = createConfiguredAgentRuntime(coreConfig);
const responder = createConfiguredAgentResponder({ config: coreConfig, runtime });
```

The orchestrator keeps the same shape, but adds one request-scoped runtime extension from `@mono-agent/agent-orchestrator` so the model can call collaborators through a bounded `ask_collaborator` MCP tool.

## Topology

- Orchestrator: connected to Telegram when credentials are configured, exposed over loopback A2A for smoke tests, and responsible for deciding which collaborator to ask before final synthesis.
- Researcher: loopback A2A provider with `WebSearch` and `WebFetch` allowed.
- Worker: loopback A2A provider with `Read`, `Grep`, and `Bash` allowed, and `Write`/`Edit` disallowed.

The orchestration is model-directed through that bounded tool. The model may ask the researcher, the worker, both, or either one multiple times before producing the final answer. Collaborator failures return visible tool errors instead of hidden fallback success.

## Stop The Final Demo First

Only one Telegram long poller should own a bot token. Stop the older final demo before starting this one:

```bash
launchctl bootout gui/501 ~/Library/LaunchAgents/ai.mono-agent.final-demo-gemma4.plist
lsof -nP -iTCP:5317 -iTCP:5318 -iTCP:5203 -sTCP:LISTEN
```

The `lsof` check should show no local `node` listener for the old final demo ports before you start Telegram here.

## Deploy Locally

The deploy command writes ignored role configs, memory files, workspaces, artifacts, and trace source manifests under `.mono-agent/multi-agent/`. It does not write Telegram tokens.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run deploy:multi -- \
  --port 5417 \
  --orchestrator-a2a-port 5418 \
  --researcher-a2a-port 5419 \
  --worker-a2a-port 5420
```

Defaults use local Ollama model `gemma4:31b`. Override all roles with `--model <tag>`, or set role-specific tags with `--orchestrator-model`, `--researcher-model`, and `--worker-model`.

Generated orchestrator configs use a 300s collaborator timeout. Local Gemma/Ollama calls can take more than 60s, especially when the researcher uses web tools and the worker runs local inspection before the orchestrator synthesizes. Researcher and worker configs keep the regular 60s consumer default because they are not the caller in the demo collaboration path.

## Telegram

Telegram credentials are read from the orchestrator config or environment:

```bash
MONO_AGENT_TELEGRAM_BOT_TOKEN=123456:token
MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

Use `--no-telegram` when you only want the A2A smoke path. The generated configs intentionally contain no Telegram secrets.

Operator-console config saves persist changes to disk, but this demo reports a restart-required apply status. Restart the multi-agent process before expecting changed role, model, tool, A2A, or collaborator timeout settings to affect running Telegram or A2A responders.

## A2A Smoke

The deploy command prints the orchestrator Agent Card URL. Send a text request to that URL with `sendA2AMessage` from `@mono-agent/a2a-adapter` or any A2A client. A successful request that calls both collaborator agents should record three runs in the operator console Traceability view:

- `multi-agent-orchestrator`
- `multi-agent-researcher`
- `multi-agent-worker`

Direct calls to the researcher and worker Agent Card URLs verify their distinct tool policies independently. If a request does not need one collaborator, a successful orchestrator answer may record only the collaborator runs the model actually asked for.

If the final answer says a collaborator timed out, check the role traces before assuming the researcher or worker runtime failed. The timeout means the orchestrator stopped waiting for the A2A response; the collaborator may still have completed later and recorded its own trace.

## Manual Start

After generated configs exist, start without rewriting them:

```bash
pnpm run build
pnpm run demo:multi -- --config-dir ./.mono-agent/multi-agent --port 5417
```

Use `SIGINT` or `SIGTERM` to stop the operator console, Telegram poller, A2A providers, and trace source heartbeats cleanly.
