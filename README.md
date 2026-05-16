# Mono Agent

Mono Agent is a small pnpm workspace of reusable npm packages under the `@worklab-ai` scope. The framework is built around `@worklab-ai/agent-runtime`, but keeps runtime access, communication adapters, settings, skills, memory, observability, and operator surfaces as separate packages.

## Package Architecture

Package categories are catalog metadata, documentation, and architecture-guard inputs. The physical layout intentionally stays `packages/<package-name>` and published names stay `@worklab-ai/<package-name>`; a future physical move to `packages/<category>/<package-name>` would be a separate mechanical release-tooling task.

| Category | Packages | Allowed workspace dependency categories | Responsibility |
| --- | --- | --- | --- |
| `runtime` | `@worklab-ai/runtime-adapter` | `core` | The only package that wraps `@worklab-ai/agent-runtime`; parses model refs, validates execution modes, and exposes backend descriptors. |
| `core` | `@worklab-ai/agent-contracts`, `@worklab-ai/config`, `@worklab-ai/settings`, `@worklab-ai/tool-policy` | Package-specific `core` plus `runtime` only for config | Shared responder contracts, adapter-neutral core config, generic settings JSON/schema helpers, and fail-closed tool/MCP policy normalization. |
| `context` | `@worklab-ai/context`, `@worklab-ai/skills`, `@worklab-ai/memory-md` | `core`, `context` | Deterministic prompt assembly, selected-skill loading, and optional Markdown memory. |
| `execution` | `@worklab-ai/agent-harness` | `core`, `context`, `runtime`, `observability` | Composes context, runtime, memory, history, tool policy, skills, and observability for one request. |
| `observability` | `@worklab-ai/observability` | `core` | JSONL run recorder, local artifact reader, and file-backed trace source registry. |
| `communication` | `@worklab-ai/a2a-adapter`, `@worklab-ai/telegram-adapter`, `@worklab-ai/whatsapp-adapter` | `core` | Transport adapters that accept shared structural responders and own adapter-specific safety/config. A2A adds direct Agent Card discovery plus text/task inter-agent calls. |
| `operator-surface` | `@worklab-ai/operator-console`, `@worklab-ai/tui` | `core`, `observability` | Local browser and terminal operator surfaces. The browser console can aggregate registered source runs, but does not own runtime hosting or communication transport. |
| `host-demo` | `demos/final-agent` | All packages by explicit host composition | Non-publishable proof of composition that wires config, surface, communication, harness, runtime, memory, policy, and artifacts in one small host layer. |

## Dependency Direction

```text
demos/final-agent (not a workspace package)
  ├─ operator-console ── settings, observability
  ├─ a2a-adapter ── agent-contracts, settings, @a2a-js/sdk, express
  ├─ telegram-adapter ── agent-contracts, settings
  ├─ agent-harness
  │   ├─ agent-contracts
  │   ├─ context
  │   ├─ memory-md
  │   ├─ observability
  │   ├─ runtime-adapter ── @worklab-ai/agent-runtime
  │   ├─ skills ── context
  │   └─ tool-policy
  ├─ config ── settings, runtime-adapter
  ├─ tui ── config
  └─ core leaf packages as needed
```

Rules for future packages:

- New packages live under `packages/<package-name>` and publish as `@worklab-ai/<package-name>`.
- Add every workspace package to `scripts/package-catalog.mjs` with category, responsibility, and allowed dependency categories.
- Communication packages use `*-adapter` naming and must not depend on other adapters, the harness, or operator surfaces.
- Core config stays adapter-neutral; adapter credentials and allowlists live with the adapter package.
- Operator surfaces register field groups from other packages; they do not hardcode adapter settings.
- Demos compose packages but are not publishable packages.

## Final Demo

The final demo lives at `demos/final-agent/`. It starts the local operator console first, then starts Telegram and/or the A2A provider independently when their own adapter config plus core runtime config are valid.

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

The demo composes:

- `CORE_AGENT_FIELD_GROUPS` from `@worklab-ai/config`
- `a2aFieldGroup`, `loadA2AAdapterConfig`, and `startA2AProvider` from `@worklab-ai/a2a-adapter`
- `telegramFieldGroup` and `loadTelegramAdapterConfig` from `@worklab-ai/telegram-adapter`
- `startOperatorConsole` from `@worklab-ai/operator-console`
- the harness, runtime adapter, memory, tool policy, and observability packages

### Host Traceability

Mono Agent now has a local host traceability path. Each running host registers a `worklab.trace-source.v1` manifest in a registry directory such as `~/.mono-agent/trace-sources`; each manifest points at that source's artifact directory, where run summaries and event JSONL files remain. The operator console Traceability view reads the registry, marks stale sources when their heartbeat ages out, aggregates recent runs across sources, and loads details by `(sourceId, runId)` so duplicate run ids do not collide.

This is local-first and bearer-protected through the loopback console. It is not a LangSmith dependency, database, or cloud collector. LangSmith/OpenTelemetry export remains a later sink option.

See [`demos/final-agent/README.md`](./demos/final-agent/README.md) for config shape and CLI options.

### A2A Inter-Agent Discovery

`@worklab-ai/a2a-adapter` exposes a Mono responder over the A2A v1 protocol using the pinned `@a2a-js/sdk@1.0.0-alpha.0`. Provider mode serves the public Agent Card at `/.well-known/agent-card.json` and message/task endpoints under `/a2a/json-rpc` and `/a2a/rest`. Consumer mode discovers direct Agent Card URLs and sends text messages to remote agents.

The first pass is deliberately text/task only: no central registry, gRPC hosting, push notifications, signed cards, file exchange, or autonomous tool-selected delegation. Provider binds to loopback by default; non-loopback bind or advertised public URLs require explicit config and should be deployed behind HTTPS with bearer auth.

### Local Providers

Mono Agent can pass local OpenAI-compatible providers into `@worklab-ai/agent-runtime` through the Pi adapter. Ollama is the primary supported local path:

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
pnpm --filter @worklab-ai/<package> run build
pnpm --filter @worklab-ai/<package> run typecheck
pnpm --filter @worklab-ai/<package> run test
```

## Safety Model

- No secrets, `.env*`, OAuth files, provider keys, Telegram tokens, WhatsApp auth state, or transcripts are committed.
- Settings JSON is local, schema-validated, and written with restrictive file permissions where the settings helper writes it.
- Secret fields are write-only in the operator console and redacted in diagnostics.
- Tool policy is explicit and fail-closed.
- Memory writes are host-owned and optional.
- Fixtures and fake runtimes are for tests only, not product-runtime substitutes.

## Layered Workflow

```mermaid
flowchart TB
  Host["Host composition layer\n`demos/final-agent`"]

  subgraph Surfaces["Operator-surface choices"]
    Console["`@worklab-ai/operator-console`\nBrowser settings + runs"]
    Tui["`@worklab-ai/tui`\nTerminal chat + read-only config"]
  end

  subgraph Communication["Communication adapter choices"]
    Telegram["`@worklab-ai/telegram-adapter`\nBot API + long polling"]
    WhatsApp["`@worklab-ai/whatsapp-adapter`\nBaileys socket + group trigger policy"]
    A2A["`@worklab-ai/a2a-adapter`\nAgent Card discovery + text tasks"]
    FutureAdapter["Future Slack/webhook adapter\nsame shared responder seam"]
  end

  subgraph Core["Core contracts and settings"]
    Contracts["`@worklab-ai/agent-contracts`\nrequest/response/stream/cancel"]
    Settings["`@worklab-ai/settings`\nfield groups + redaction"]
    Config["`@worklab-ai/config`\ncore runtime/context settings"]
    Policy["`@worklab-ai/tool-policy`\nfail-closed tools + MCP"]
  end

  subgraph PromptContext["Context layer"]
    Context["`@worklab-ai/context`\nprompt assembly"]
    Skills["`@worklab-ai/skills`\nselected skill blocks"]
    Memory["`@worklab-ai/memory-md`\noptional memory file"]
  end

  subgraph Execution["Execution layer"]
    Harness["`@worklab-ai/agent-harness`\nrequest to runtime run"]
    Observability["`@worklab-ai/observability`\nJSONL events + summaries + trace registry"]
  end

  subgraph Runtime["Runtime backend choices"]
    RuntimeAdapter["`@worklab-ai/runtime-adapter`\nmodel refs + backend support"]
    AgentRuntime["`@worklab-ai/agent-runtime`\nprovider/CLI implementation"]
    ClaudeSdk["Claude SDK\n`claude:<model>` + `sdk`"]
    ClaudeCli["Claude Code CLI\n`claude:<model>` + `cli`"]
    CodexCli["Codex app CLI\n`codex:<model>` + `cli`"]
    PiSdk["Pi SDK providers\n`pi:<provider>:<model>` + `sdk`"]
  end

  Host --> Console
  Host -. optional .-> Tui
  Host --> Telegram
  Host --> A2A
  Host -. optional package .-> WhatsApp
  Host -. future package .-> FutureAdapter
  Host --> Config
  Host --> Harness

  Console --> Settings
  Console --> Observability
  Tui --> Contracts
  Tui --> Config
  Telegram --> Contracts
  Telegram --> Settings
  A2A --> Contracts
  A2A --> Settings
  WhatsApp --> Contracts
  WhatsApp --> Settings
  FutureAdapter --> Contracts

  Config --> Settings
  Config --> RuntimeAdapter
  Harness --> Contracts
  Harness --> Context
  Harness --> Skills
  Harness --> Memory
  Harness --> Policy
  Harness --> RuntimeAdapter
  Harness --> Observability

  RuntimeAdapter --> AgentRuntime
  AgentRuntime --> ClaudeSdk
  AgentRuntime --> ClaudeCli
  AgentRuntime --> CodexCli
  AgentRuntime --> PiSdk
```
