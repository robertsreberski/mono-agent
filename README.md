# Agent Framework Packages

This repository is a small pnpm workspace of reusable npm packages under the `@mono-agent` scope. The framework is built around `@mono-agent/agent-runtime`, but keeps runtime access, sandboxing, communication adapters, settings, skills, memory, observability, evaluation, and operator surfaces as separate packages.

## Skill-Based Composition Guide

The repo includes a mono-agent-native skill document for agents that need to help users compose these packages into a working host:

- Skill: [`docs/skills/mono-agent-composer/SKILL.md`](./docs/skills/mono-agent-composer/SKILL.md)
- References: [`docs/skills/mono-agent-composer/references/`](./docs/skills/mono-agent-composer/references/)

Use it as a selected mono-agent skill by pointing `context.skillsRoot` at `./docs/skills` and adding `mono-agent-composer` to `context.selectedSkills`. The skill makes the agent ask discovery questions first, then walks through runtime, context, selected skills, optional memory, tool/MCP policy, communication adapters, operator surfaces, and validation.

## Package Architecture

Package categories are catalog metadata, documentation, and architecture-guard inputs. The physical layout intentionally stays `packages/<package-name>` and published names stay `@mono-agent/<package-name>`; a future physical move to `packages/<category>/<package-name>` would be a separate mechanical release-tooling task.

See [`PACKAGES.md`](./PACKAGES.md) for the current Mermaid package/layer map.

| Category | Packages | Allowed workspace dependency categories | Responsibility |
| --- | --- | --- | --- |
| `runtime` | `@mono-agent/agent-runtime`, `@mono-agent/runtime-adapter`, `@mono-agent/openai-agents-runtime`, `@mono-agent/sandbox` | `core`, `runtime` where needed | Provider/CLI runtime bridges, typed runtime facade, OpenAI Agents SDK adapter, and fail-closed sandbox policy/process wrapping. |
| `core` | `@mono-agent/agent-contracts`, `@mono-agent/config`, `@mono-agent/settings`, `@mono-agent/tool-policy` | Package-specific `core` plus `runtime` only for config | Shared responder contracts, adapter-neutral core config, generic settings JSON/schema helpers, and fail-closed tool/MCP policy normalization. |
| `context` | `@mono-agent/context`, `@mono-agent/skills`, `@mono-agent/memory-md` | `core`, `context` | Deterministic prompt assembly, selected-skill loading, and optional Markdown memory. |
| `execution` | `@mono-agent/agent-harness`, `@mono-agent/agent-host`, `@mono-agent/agent-orchestrator` | Package-specific `core`, `context`, `runtime`, `observability`, and execution helpers | Request execution, config-to-responder host composition, and bounded collaborator orchestration through runtime-visible tools. |
| `observability` | `@mono-agent/observability` | `core` | JSONL run recorder, local artifact reader, and file-backed trace source registry. |
| `evaluation` | `@mono-agent/agent-evals` | `core`, `execution`, `observability` | Local-first E2E eval scenarios for responders and harnesses, with deterministic checks and trajectory scoring. |
| `communication` | `@mono-agent/a2a-adapter`, `@mono-agent/cron-adapter`, `@mono-agent/openai-api-adapter`, `@mono-agent/slack-adapter`, `@mono-agent/telegram-adapter`, `@mono-agent/webhook-adapter`, `@mono-agent/whatsapp-adapter` | `core` | Transport and invocation adapters that accept shared structural responders and own adapter-specific safety/config. A2A adds direct Agent Card discovery plus text/task inter-agent calls; OpenAI API exposes Chat Completions for OpenWebUI-style clients. |
| `operator-surface` | `@mono-agent/operator-console`, `@mono-agent/tui` | `core`, `observability` | Local browser and terminal operator surfaces. The browser console can aggregate registered source runs, but does not own runtime hosting or communication transport. |
| `host-demo` | `demos/final-agent`, `demos/multi-agent` | All packages by explicit host composition | Non-publishable proofs of composition that load config, build responders, start surfaces/transports, and register local traces. |

## Dependency Direction

```text
demos/final-agent and demos/multi-agent (not workspace packages)
  ├─ operator-console ── settings, observability
  ├─ a2a-adapter ── agent-contracts, settings, @a2a-js/sdk, express
  ├─ cron-adapter ── agent-contracts, settings, cron-parser
  ├─ openai-api-adapter ── agent-contracts, settings, express
  ├─ slack-adapter ── agent-contracts, settings, ws
  ├─ telegram-adapter ── agent-contracts, settings
  ├─ webhook-adapter ── agent-contracts, settings, express
  ├─ agent-host
  │   ├─ config
  │   ├─ agent-harness ── agent-contracts, context, skills, memory-md, observability, runtime-adapter, sandbox, tool-policy
  │   ├─ runtime-adapter ── @mono-agent/agent-runtime, sandbox types
  │   ├─ sandbox ── agent-contracts
  │   ├─ memory-md
  │   ├─ observability
  │   └─ tool-policy
  ├─ agent-orchestrator ── agent-contracts, MCP SDK
  ├─ agent-evals ── agent-contracts, agent-harness, observability, agentevals
  ├─ config ── settings, runtime-adapter, sandbox
  ├─ tui ── config
  └─ core leaf packages as needed
```

Rules for future packages:

- New packages live under `packages/<package-name>` and publish as `@mono-agent/<package-name>`.
- Add every workspace package to `scripts/package-catalog.mjs` with category, responsibility, and allowed dependency categories.
- Communication packages use `*-adapter` naming and must not depend on other adapters, the harness, or operator surfaces.
- Core config stays adapter-neutral; adapter credentials and allowlists live with the adapter package.
- Operator surfaces register field groups from other packages; they do not hardcode adapter settings.
- Demos compose packages but are not publishable packages.

## Final Demo

The final demo lives at `demos/final-agent/`. It starts the local operator console first, then starts Telegram, A2A, webhook, OpenAI API, and/or cron independently when their own adapter config plus core runtime config are valid. Config saves through the operator console are applied in-process: the demo stops and rebuilds Telegram, A2A, webhook, OpenAI API, cron, and traceability with the freshly saved settings while keeping the operator console URL, token, and port stable.

The preferred local deployment path generates an ignored config under `.mono-agent/deploy/`, verifies Ollama has Gemma 4 installed, then starts the operator console, traceability source, and loopback A2A provider:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run deploy:final
```

By default this uses `pi:ollama:gemma4:31b`. Check readiness with:

```bash
ollama list
ollama pull gemma4:31b
curl http://localhost:11434/api/tags
```

The operator console Traceability view should show source `final-agent-gemma4`. After a loopback A2A request to the printed Agent Card URL, the same view should show the recorded run from that source.

The generic manual demo command remains available when you want to provide your own config:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run demo:final
```

The readable package-composition path is:

```ts
const coreConfig = await loadFinalAgentCoreConfig({ env, cwd, configPath });
const runtime = createConfiguredAgentRuntime(coreConfig);
const responder = createConfiguredAgentResponder({ config: coreConfig, runtime });
```

The demo then passes that responder to whichever adapters are enabled:

- `CORE_AGENT_FIELD_GROUPS` from `@mono-agent/config`
- `createConfiguredAgentRuntime` and `createConfiguredAgentResponder` from `@mono-agent/agent-host`
- `a2aFieldGroup`, `loadA2AAdapterConfig`, and `startA2AProvider` from `@mono-agent/a2a-adapter`
- `telegramFieldGroup` and `loadTelegramAdapterConfig` from `@mono-agent/telegram-adapter`
- `webhookFieldGroup`, `loadWebhookAdapterConfig`, and `startWebhookAdapter` from `@mono-agent/webhook-adapter`
- `openAIApiFieldGroup`, `loadOpenAIApiAdapterConfig`, and `startOpenAIApiAdapter` from `@mono-agent/openai-api-adapter`
- `cronFieldGroup`, `loadCronAdapterConfig`, and `startCronAdapter` from `@mono-agent/cron-adapter`
- `startOperatorConsole` from `@mono-agent/operator-console`
- `registerTraceSource` from `@mono-agent/observability`

### Host Traceability

The workspace now has a local host traceability path. Each running host registers an `agent-runtime.trace-source.v1` manifest in a registry directory such as `~/.mono-agent/trace-sources`; each manifest points at that source's artifact directory, where run summaries and event JSONL files remain. The operator console Traceability view reads the registry, marks stale sources when their heartbeat ages out, aggregates recent runs across sources, and loads details by `(sourceId, runId)` so duplicate run ids do not collide.

This is local-first and bearer-protected through the loopback console. It is not a LangSmith dependency, database, or cloud collector. LangSmith/OpenTelemetry export remains a later sink option.

See [`demos/final-agent/README.md`](./demos/final-agent/README.md) for config shape and CLI options.

## Multi-Agent Demo

The multi-agent demo lives at `demos/multi-agent/`. It starts a Telegram-connected orchestrator plus three loopback A2A providers: the orchestrator itself for smoke tests, a researcher with web-oriented tools, and a worker with read-only local inspection tools. The orchestrator receives one `ask_collaborator` MCP tool from `@mono-agent/agent-orchestrator`, so the model decides whether to ask the researcher, the worker, or both multiple times before producing the final answer.

The preferred deployment path writes ignored role configs and local state under `.mono-agent/multi-agent/`, checks the configured Ollama model, starts traceability, and starts the role A2A providers:

```bash
pnpm run deploy:multi -- \
  --port 5417 \
  --orchestrator-a2a-port 5418 \
  --researcher-a2a-port 5419 \
  --worker-a2a-port 5420
```

Stop the older final demo before enabling Telegram here so only one process owns the bot token. Telegram credentials stay outside git and are read from the orchestrator config or `MONO_AGENT_TELEGRAM_BOT_TOKEN` plus `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS`.

See [`demos/multi-agent/README.md`](./demos/multi-agent/README.md) for topology, safe tool policies, Telegram ownership, and smoke checks.

### A2A Inter-Agent Discovery

`@mono-agent/a2a-adapter` exposes a Mono responder over the A2A v1 protocol using the pinned `@a2a-js/sdk@1.0.0-alpha.0`. Provider mode serves the public Agent Card at `/.well-known/agent-card.json` and message/task endpoints under `/a2a/json-rpc` and `/a2a/rest`. Consumer mode discovers direct Agent Card URLs and sends text messages to remote agents.

The A2A adapter remains deliberately text/task only: no central registry, gRPC hosting, push notifications, signed cards, file exchange, or adapter-owned delegation policy. Dynamic collaborator selection is composed above A2A by `@mono-agent/agent-orchestrator`. Provider binds to loopback by default; non-loopback bind or advertised public URLs require explicit config and should be deployed behind HTTPS with bearer auth.

### Local Providers

Hosts can pass local OpenAI-compatible providers into `@mono-agent/agent-runtime` through the Pi adapter. Ollama is the primary supported local path:

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
      { "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434", "enabled": true }
    ]
  }
}
```

Run Ollama locally and pull the model first, for example `ollama pull qwen3:8b`. Standard local Ollama needs no provider API key. LM Studio and other OpenAI-compatible local gateways use the same `providers.local` shape with `type: "lmstudio"` or `type: "openai_compat"`; public URLs must be explicitly trusted and use HTTPS.

## Development Verification

```bash
pnpm install --frozen-lockfile
pnpm run check:architecture
pnpm run build
pnpm run typecheck
pnpm test
pnpm run build:demo
pnpm run typecheck:demo
pnpm run test:demo
git diff --check
```

For package-level work:

```bash
pnpm --filter @mono-agent/<package> run build
pnpm --filter @mono-agent/<package> run typecheck
pnpm --filter @mono-agent/<package> run test
```

## Safety Model

- No secrets, `.env*`, OAuth files, provider keys, OpenAI API adapter keys, Telegram tokens, WhatsApp auth state, or transcripts are committed.
- Settings JSON is local, schema-validated, and written with restrictive file permissions where the settings helper writes it.
- Secret fields are write-only in the operator console and redacted in diagnostics.
- Tool policy is explicit and fail-closed.
- Sandbox policy is explicit, fail-closed by default, and routes runtime-owned process execution through a native sandbox engine when configured.
- Memory writes are host-owned and optional.
- Fixtures and fake runtimes are for tests only, not product-runtime substitutes.

## Layered Workflow

```mermaid
flowchart TB
  Host["Host composition layer\n`demos/final-agent`"]

  subgraph Surfaces["Operator-surface choices"]
    Console["`@mono-agent/operator-console`\nBrowser settings + runs"]
    Tui["`@mono-agent/tui`\nTerminal chat + read-only config"]
  end

  subgraph Communication["Communication adapter choices"]
    A2A["`@mono-agent/a2a-adapter`\nAgent Card discovery + text tasks"]
    Cron["`@mono-agent/cron-adapter`\nScheduled invocations"]
    OpenAIApi["`@mono-agent/openai-api-adapter`\nOpenAI Chat Completions"]
    Slack["`@mono-agent/slack-adapter`\nSocket Mode + Web API"]
    Telegram["`@mono-agent/telegram-adapter`\nBot API + long polling"]
    Webhook["`@mono-agent/webhook-adapter`\nHTTP sync/async invocation"]
    WhatsApp["`@mono-agent/whatsapp-adapter`\nBaileys socket + group trigger policy"]
  end

  subgraph Core["Core contracts and settings"]
    Contracts["`@mono-agent/agent-contracts`\nrequest/response/stream/cancel"]
    Settings["`@mono-agent/settings`\nfield groups + redaction"]
    Config["`@mono-agent/config`\ncore runtime/context settings"]
    Policy["`@mono-agent/tool-policy`\nfail-closed tools + MCP"]
  end

  subgraph PromptContext["Context layer"]
    Context["`@mono-agent/context`\nprompt assembly"]
    Skills["`@mono-agent/skills`\nselected skill blocks"]
    Memory["`@mono-agent/memory-md`\noptional memory file"]
  end

  subgraph Execution["Execution layer"]
    AgentHost["`@mono-agent/agent-host`\nconfig to responder"]
    Harness["`@mono-agent/agent-harness`\nrequest to runtime run"]
    Orchestrator["`@mono-agent/agent-orchestrator`\ncollaborator MCP tool"]
    Observability["`@mono-agent/observability`\nJSONL events + summaries + trace registry"]
  end

  subgraph Runtime["Runtime backend choices"]
    RuntimeAdapter["`@mono-agent/runtime-adapter`\nmodel refs + backend support"]
    Sandbox["`@mono-agent/sandbox`\nfail-closed sandbox policy"]
    AgentRuntime["`@mono-agent/agent-runtime`\nprovider/CLI implementation"]
    ClaudeSdk["Claude SDK\n`claude:<model>` + `sdk`"]
    ClaudeCli["Claude Code CLI\n`claude:<model>` + `cli`"]
    CodexCli["Codex app CLI\n`codex:<model>` + `cli`"]
    PiSdk["Pi SDK providers\n`pi:<provider>:<model>` + `sdk`"]
  end

  Host --> Console
  Host -. optional .-> Tui
  Host --> Telegram
  Host --> A2A
  Host --> Webhook
  Host --> OpenAIApi
  Host --> Cron
  Host -. optional package .-> Slack
  Host -. optional package .-> WhatsApp
  Host -. optional package .-> Orchestrator
  Host --> Config
  Host --> AgentHost

  Console --> Settings
  Console --> Observability
  Tui --> Contracts
  Tui --> Config
  Telegram --> Contracts
  Telegram --> Settings
  A2A --> Contracts
  A2A --> Settings
  Cron --> Contracts
  Cron --> Settings
  OpenAIApi --> Contracts
  OpenAIApi --> Settings
  Slack --> Contracts
  Slack --> Settings
  Webhook --> Contracts
  Webhook --> Settings
  WhatsApp --> Contracts
  WhatsApp --> Settings

  Orchestrator --> Contracts
  Orchestrator -.->|runtime extension| Harness
  AgentHost --> Config
  AgentHost --> Harness
  AgentHost --> Memory
  AgentHost --> Policy
  AgentHost --> Sandbox
  AgentHost --> RuntimeAdapter
  AgentHost --> Observability
  Config --> Settings
  Config --> RuntimeAdapter
  Config --> Sandbox
  Harness --> Contracts
  Harness --> Context
  Harness --> Skills
  Harness --> Memory
  Harness --> Policy
  Harness --> Sandbox
  Harness --> RuntimeAdapter
  Harness --> Observability

  RuntimeAdapter --> AgentRuntime
  RuntimeAdapter --> Sandbox
  AgentRuntime --> Sandbox
  AgentRuntime --> ClaudeSdk
  AgentRuntime --> ClaudeCli
  AgentRuntime --> CodexCli
  AgentRuntime --> PiSdk
```
