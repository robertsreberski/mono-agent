# Agent Framework Packages

This repository is a config-first pnpm workspace of reusable npm packages under the `@mono-agent` scope. The framework is built around `@mono-agent/agent-runtime` as the single shipped runtime implementation layer, while sandboxing, communication adapters, skills, memory, observability, and operator surfaces stay modular. `@mono-agent/agent-app` composes them from one shareable config file so an agent can be built, validated, and moved as configuration instead of host glue.

## Documentation

Full documentation and end-to-end playbooks: **<https://mono-agent-docs.vercel.app/>** (authored as markdown under [`docs/`](./docs/), built with Astro Starlight in [`website/`](./website/) and deployed on Vercel — see [`website/README.md`](./website/README.md) for the build/sync/deploy workflow and version-pin notes). [`docs/reference/feature-registry.md`](./docs/reference/feature-registry.md) remains the canonical feature reference, and [`docs/playbooks/`](./docs/playbooks/) holds copy-paste recipes for every channel and memory tier.

## Quickstart: An Agent Folder From One Config File

Any folder — empty or already holding knowledge (`AGENTS.md`, `CLAUDE.md`, docs) — becomes a validated agent folder with the `mono-agent` CLI. Use Node.js 20 or newer. Scaffold with no install:

```bash
npm create mono-agent@latest init      # npm-init convention → resolves create-mono-agent
# equivalently:
npx create-mono-agent init
```

Or install the CLI globally — the installer (which puts the natural `mono-agent` command on your `PATH`) or the scoped host directly:

```bash
npm i -g create-mono-agent          # gives you the `mono-agent` command
# or, equivalently:
npm i -g @mono-agent/agent-app      # the scoped host that owns the CLI
```

`create-mono-agent` is a thin installer whose `create-mono-agent` and `mono-agent` bins forward every command to `@mono-agent/agent-app`; behaviour is identical either way. (The bare `mono-agent` npm name isn't ours — npm blocks it as too similar to an unrelated `monoagent` package — so the installer follows the `create-*` convention instead.)

The easiest path on a terminal is the interactive wizard — `mono-agent init` with no flags walks you through a preset (or custom) build: model, channels, memory, and, importantly, the **tools** your agent may call (pre-checked with a safe default plus your channels' send tools, so it isn't left tool-less), then it scaffolds, validates, and prints a secrets checklist:

```bash
mkdir my-agent
cd my-agent
mono-agent init                   # step-by-step wizard on a TTY (`mono-agent setup` is an alias)
```

Or drive it with flags (`init` writes the scaffold non-interactively when given any flag, or when stdin is not a TTY):

```bash
mono-agent init --model claude:claude-sonnet-4-6 --fallback-models pi:ollama:gemma4:31b
mono-agent validate               # per-section report; `mono-agent doctor` is an alias
```

For unreleased source testing, use the built CLI entry directly instead of the published package:

```bash
repo=/absolute/path/to/mono-agent
mkdir my-agent
cd my-agent
node "$repo/packages/agent-app/dist/cli.js" init --model claude:claude-sonnet-4-6
node "$repo/packages/agent-app/dist/cli.js" validate
```

`validate` proves the folder and config are startable; it does not fake a provider call. To get a real first reply, export credentials for the model you chose, start the agent, then smoke-test over the webhook channel that `init` enables by default. The webhook needs no channel credentials; model auth is still required for a model response.

```bash
export ANTHROPIC_API_KEY=...      # or the auth expected by your model/backend
mono-agent start                  # backgrounds on macOS (launchd); use `start --foreground` elsewhere
```

```bash
curl -s http://127.0.0.1:<PORT>/webhook/invoke \
  -H 'content-type: application/json' \
  -d '{"text": "Say hello and tell me what you are."}'
```

`<PORT>` comes from the `start` output. A reply means runtime, model, identity, and channel wiring all work. On a local build with packages already installed and built, `init` plus `validate` should take well under a minute; first reply time depends on provider authentication, network latency, and model availability.

`init` scaffolds `mono-agent.config.json` (webhook enabled as the credential-free smoke channel), an `IDENTITY.md` that references the folder's existing knowledge, and `.mono-agent/` working dirs — never overwriting existing files. The config file declares everything: runtime model plus ordered backup models (`runtime.fallbackModels`, served by the native failover router), built-in channels (`telegram`, `slack`, `webhook`, `openaiApi`, `cron`, `tui`, `live`), external channel plugins under `channels.plugins[]` (`@mono-agent/a2a-adapter`, `@mono-agent/whatsapp-adapter`, or your own `ChannelDriver` package), skills, MCP servers, memory strategy, sandbox policy, and observability. `validate` reports every section before anything starts; `start` runs traceability and every configured channel, each with independent `running` / `waiting_for_config` / `disabled` / `failed` status. For unreleased or source-build testing, use the source build flow in [`docs/getting-started/install.md`](./docs/getting-started/install.md); pnpm 10 is only required for that path.

### Presets & the setup wizard

`mono-agent init` composes an agent from **capability modules** (channels, memory tiers, sandbox, observability) and walks you through the tool allowlist so the agent can actually do something. **Presets** are saved answer-sets for six common shapes — `starter` (webhook smoke agent), `telegram-assistant` (BuJo memory), `telegram-supermemory`, `slack-bot`, `local-private` (Ollama), and `code-sandbox`. Each preset prints its generated config with secrets externalized to `.env.example`, and mirrors a copy-paste playbook in [`docs/playbooks/`](./docs/playbooks/):

```bash
mono-agent presets list
mono-agent presets show telegram-assistant
mono-agent init --preset telegram-assistant --yes
```

The `code-sandbox` preset ships `sandbox.mode: "native"`, which requires `srt` on `PATH`; run `mono-agent validate --preset code-sandbox` and read the `Sandbox` section before starting. It uses `fallback: "fail-closed"`, so a missing `srt` produces `sandbox_unavailable` instead of host execution.

The old `mono-agent recipes …` / `--recipe <id>` surface still works as a deprecated alias — retired recipes map to the preset that replaced them. See [`docs/reference/recipes.md`](./docs/reference/recipes.md) for the presets, the capability modules, the tools/no-tools guardrail, and the full deprecation map.

## Skill-Based Composition Guide

The repo includes a composer skill that walks an agent (in mono-agent itself, Claude Code, or another harness that reads `SKILL.md` files) through constructing an agent folder with the flow above:

- Skill: [`packages/agent-app/skills/mono-agent-composer/SKILL.md`](./packages/agent-app/skills/mono-agent-composer/SKILL.md)
- References: [`packages/agent-app/skills/mono-agent-composer/references/`](./packages/agent-app/skills/mono-agent-composer/references/)

The skill asks discovery questions (runtime + backup models, channels incl. crons and webhooks, skills, MCP, memory strategy incl. semantic search, sandbox, observability), maps each answer to config keys, then runs `mono-agent init` → `validate` → `start` and a channel-matched smoke test. [`docs/reference/feature-registry.md`](./docs/reference/feature-registry.md) is the source of truth mapping every framework feature to its config/CLI/programmatic surface; the skill ships a condensed copy as `references/feature-coverage.md`. The skill ships with `@mono-agent/agent-app`; install it into Claude Code and Codex with:

```bash
mono-agent install-skill   # copies into ~/.claude/skills and ~/.agents/skills
```

To use it as a selected mono-agent skill instead, point `context.skillsRoot` at `./packages/agent-app/skills` and add `mono-agent-composer` to `context.selectedSkills`.

## Package Architecture

Package categories are catalog metadata, documentation, and architecture-guard inputs. Core packages live under `packages/<package-name>` and optional **plugin-tier** extras live under `extras/<package-name>`. Both use `@mono-agent/<package-name>` names and both are `publishable: true` (released together on the npm lockstep tag); the extras are marked `tier: "plugin"` and are loaded only through explicit composition or `channels.plugins[]`.

See [`PACKAGES.md`](./PACKAGES.md) for the current Mermaid package/layer map.

Before adding new capability surface area, use the [`Capability ladder`](./docs/reference/capability-ladder.md) to decide whether the work belongs in an existing package, config/skills, a new package, an MCP tool boundary, or a shared core contract.

Current catalog count: 17 core publishable packages plus 3 plugin-tier extras plus 1 unscoped alias (`create-mono-agent`, the `npm create mono-agent` installer that ships `create-mono-agent`/`mono-agent` bins delegating to `@mono-agent/agent-app`).

| Category | Packages | Allowed workspace dependency categories | Responsibility |
| --- | --- | --- | --- |
| `runtime` | `@mono-agent/agent-runtime`, `@mono-agent/runtime-adapter` | `core`, `runtime` where needed | Provider/CLI runtime bridges, typed runtime facade, and fail-closed sandbox policy/process wrapping. |
| `core` | `@mono-agent/agent-contracts`, `@mono-agent/config` | Package-specific `core` plus `runtime` only for config | Shared responder contracts and settings JSON/env helpers with adapter-neutral core config. |
| `context` | `@mono-agent/memory`, `@mono-agent/memory-supermemory` | `core`, `context` | Tiered memory (lite/journal/bujo via `@mono-agent/memory` subpaths plus optional Supermemory backend). The agent's `memory_recall` tool is auto-provisioned in-app from the single `memory` config block. |
| `execution` | `@mono-agent/agent-harness`, `@mono-agent/agent-orchestrator` (extra) | Package-specific `core`, `context`, `runtime`, `observability`, and execution helpers | Request execution, prompt assembly, selected-skill loading, tool/MCP policy normalization (with a fail-closed no-policy safety net), and bounded collaborator orchestration through runtime-visible tools. |
| `observability` | `@mono-agent/observability` (`./otel` subpath for Phoenix export) | `core` | JSONL run recorder, local artifact reader, file-backed trace source registry, and subpath-only OTLP trace export. |
| `communication` | `@mono-agent/a2a-adapter` (extra), `@mono-agent/cron-adapter`, `@mono-agent/openai-api-adapter`, `@mono-agent/operator-adapter`, `@mono-agent/slack-adapter`, `@mono-agent/telegram-adapter`, `@mono-agent/webhook-adapter`, `@mono-agent/whatsapp-adapter` (extra) | `core` | Transport and invocation adapters that accept shared structural responders and own adapter-specific safety/config. Built-in channel sections cover Telegram, Slack, webhook, OpenAI API, cron, TUI stream, and live relay; A2A and WhatsApp are config-loaded channel plugins. Operator exposes the TUI NDJSON and live SSE loopback endpoints. |
| `operator-surface` | `@mono-agent/session-web`, `@mono-agent/tui` | `core`, `observability` | Local operator surfaces. They read registered source runs but do not own runtime hosting or communication transport. |
| `app` | `@mono-agent/agent-app`, `create-mono-agent` (unscoped `alias` tier) | `app` | Config-first host: loads `mono-agent.config.json`, builds the responder, drives every configured channel plus traceability, and ships the `mono-agent` CLI (`init`/`validate`/`start`). The only publishable package allowed to compose communication adapters. `create-mono-agent` is the unscoped `npm create mono-agent` installer whose `create-mono-agent`/`mono-agent` bins delegate to it (the bare `mono-agent` npm name is blocked as too similar to an unrelated `monoagent`). |
| `host-demo` | `demos/final-agent` | All packages by explicit host composition | Non-publishable proof of composition. `demos/final-agent` is now a thin facade over `@mono-agent/agent-app`. |

## Dependency Direction

```text
demos/final-agent (not a workspace package)
  ├─ agent-app ── all of the below; config-first host + mono-agent CLI + configured runtime/responder/memory composition
  ├─ a2a-adapter ── agent-contracts, @a2a-js/sdk, express
  ├─ cron-adapter ── agent-contracts, cron-parser
  ├─ openai-api-adapter ── agent-contracts, express
  ├─ operator-adapter ── agent-contracts, express
  ├─ slack-adapter ── agent-contracts, ws
  ├─ telegram-adapter ── agent-contracts
  ├─ webhook-adapter ── agent-contracts, express
  ├─ whatsapp-adapter ── agent-contracts, baileys
  ├─ agent-harness ── agent-contracts, observability, runtime-adapter (owns context assembly, selected skills, tool policy)
  ├─ runtime-adapter ── agent-contracts, @mono-agent/agent-runtime, sandbox policy/types
  ├─ memory (./store, ./search, ./bujo)
  ├─ memory-supermemory
  ├─ config ── agent-contracts, runtime-adapter
  ├─ observability
  ├─ session-web ── agent-contracts, observability
  ├─ tui ── config
  └─ core leaf packages as needed
```

Rules for future packages:

- New publishable packages live under `packages/<package-name>` and publish as `@mono-agent/<package-name>`.
- Optional plugin-tier add-ons may live under `extras/<package-name>` when cataloged with `publishable: true` and `tier: "plugin"` (published in the lockstep but outside the core app closure).
- Add every workspace package to `scripts/package-catalog.mjs` with category, responsibility, and allowed dependency categories.
- Communication packages use `*-adapter` naming and must not depend on other adapters, the harness, or operator surfaces.
- Core config stays adapter-neutral; adapter credentials and allowlists live with the adapter package.
- Operator surfaces register field groups from other packages; they do not hardcode adapter settings.
- The final demo composes packages but is not a publishable package.

## Final Demo

The final demo lives at `demos/final-agent/`. It starts Telegram, A2A, webhook, OpenAI API, and/or cron independently when their own adapter config plus core runtime config are valid. Config edits are made directly in `mono-agent.config.json` and take effect on the next restart.

The preferred local deployment path generates an ignored config under `.mono-agent/deploy/`, verifies Ollama has Gemma 4 installed, then starts the traceability source and loopback A2A provider:

```bash
pnpm install --frozen-lockfile
pnpm run deploy:final
```

By default this uses `pi:ollama:gemma4:31b`. Check readiness with:

```bash
ollama list
ollama pull gemma4:31b
curl http://localhost:11434/api/tags
```

The trace-source registry should show source `final-agent-gemma4` (visible via `mono-agent status` or a configured Phoenix exporter). After a loopback A2A request to the printed Agent Card URL, the recorded run from that source appears in the local JSONL artifacts (and Phoenix, if configured).

The generic manual demo command remains available when you want to provide your own config:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run demo:final
```

The demo is a thin facade over `@mono-agent/agent-app`: it selects the five demo channels (Telegram, A2A, webhook, OpenAI API, cron), wires its test seams into channel driver overrides, and keeps its historical status shapes. The composition path it exercises is the same one the `mono-agent` CLI uses:

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({ cwd, configPath });
```

### Host Traceability

The workspace now has a local host traceability path. Each running host registers an `agent-runtime.trace-source.v1` manifest in a registry directory such as `~/.mono-agent/trace-sources`; each manifest points at that source's artifact directory, where run summaries and event JSONL files remain. `mono-agent status` reads the registry, marks stale sources when their heartbeat ages out, and aggregates recent runs across sources by `(sourceId, runId)` so duplicate run ids do not collide.

This is local-first. It is not a LangSmith dependency, database, or cloud collector.

Phoenix is the recommended trace viewer for local development. When an `observability.exporters` entry (currently the `phoenix` preset) is configured, the host additively exports each run lifecycle to Phoenix's OTLP HTTP traces endpoint as binary protobuf (`application/x-protobuf`) via `@mono-agent/observability/otel`. Spans use OpenInference semantics (AGENT/LLM/TOOL/CHAIN kinds with input/output) and land in a named project (`projectName`, defaulting to the trace source label/id). Export is best-effort and bounded by a timeout — it never changes the run outcome and never suppresses JSONL writes. Raw prompts, reasoning, and tool I/O are metadata-only by default (`includeSensitiveData: false`). The local JSONL artifacts remain the local fallback and source of truth. `mono-agent start`, `mono-agent status`, and `mono-agent validate` report the configured exporter endpoint (validate POSTs an empty protobuf to confirm Phoenix will accept exports, not just that the port is open). Use `mono-agent backfill --all` to retroactively export already-recorded runs with their historical timestamps; deterministic per-run ids make re-exports idempotent.

See [`demos/final-agent/README.md`](./demos/final-agent/README.md) for config shape and CLI options.

## A2A Inter-Agent Discovery

`@mono-agent/a2a-adapter` exposes a Mono responder over the A2A v1 protocol using the pinned `@a2a-js/sdk@1.0.0-alpha.0`. Provider mode serves the public Agent Card at `/.well-known/agent-card.json` and message/task endpoints under `/a2a/json-rpc` and `/a2a/rest`. Consumer mode discovers direct Agent Card URLs and sends text messages to remote agents.

The A2A adapter remains deliberately text/task only: no central registry, gRPC hosting, push notifications, signed cards, file exchange, or adapter-owned delegation policy. Dynamic collaborator selection is composed above A2A by `@mono-agent/agent-orchestrator`. Provider binds to loopback by default; non-loopback bind or advertised public URLs require explicit config and should be deployed behind HTTPS with bearer auth.

## Local Providers

Hosts can pass local OpenAI-compatible providers into `@mono-agent/agent-runtime` through the Pi adapter. Ollama is the primary supported local path:

```json
{
  "runtime": {
    "model": "pi:ollama:qwen3:8b",
    "executionMode": "sdk",
    "workspace": "."
  },
  "providers": {
    "local": [
      { "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434", "enabled": true }
    ]
  }
}
```

Run Ollama locally and pull the model first, for example `ollama pull qwen3:8b`. Standard local Ollama needs no provider API key. LM Studio and other OpenAI-compatible local gateways use the same `providers.local` shape with `type: "lmstudio"` or `type: "openai_compat"`; public URLs must be explicitly trusted and use HTTPS. `runtime.maxTurns` is optional; omit it or set `0` for unlimited runs, or set `1`-`100` for a hard cap.

Built-in Pi OAuth providers, such as `pi:openai-codex:gpt-5.5`, use the Pi auth
file instead of `providers.local`. Core config defaults `providers.piAuthPath` to
`~/.pi/agent/auth.json` and exposes `MONO_AGENT_PI_AUTH_PATH` for hosts that keep
credentials elsewhere.

## Development Verification

Use the combined repository and golden-consumer gate when you need one final
verdict:

```bash
pnpm install --frozen-lockfile
pnpm run verify:all
```

`pnpm run verify:all` runs the repository gate, then validates the committed
golden consumer fixtures for `local-agent-alpha` and `local-agent-beta`. The consumer
checks use redacted fixtures, `liveness:false`, no network probes, and no
secrets by default.

To run only the consumer fixture contracts:

```bash
pnpm run verify:consumers
```

To add a deeper read-only audit of a downstream checkout's run artifacts:

```bash
pnpm run verify:consumers -- --consumer /path/to/downstream-agent
```

Focused checks remain useful while debugging a specific failure:

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
- Secret fields are redacted in diagnostics and status output.
- Tool policy is allow-all by default (omit `tools.allowedTools`, or set `["*"]`, for every tool); narrow with a specific list, subtract with `disallowedTools` (deny wins), or go chat-only with an explicit `[]`. The programmatic harness safety net with no policy is fail-closed (`failClosedToolPolicy()`).
- Sandbox policy is explicit, fail-closed by default, and routes runtime-owned process execution through a native sandbox engine when configured.
- Memory writes are host-owned and optional.
- Fixtures and fake runtimes are for tests only, not product-runtime substitutes.

## Layered Workflow

```mermaid
flowchart TB
  Host["Host composition layer\n`demos/final-agent`"]

  subgraph Surfaces["Operator-surface choices"]
    Tui["`@mono-agent/tui`\nTerminal chat + read-only config"]
  end

  subgraph Communication["Communication adapter choices"]
    A2A["`@mono-agent/a2a-adapter`\nextra plugin: Agent Card discovery + text tasks"]
    Cron["`@mono-agent/cron-adapter`\nScheduled invocations"]
    OpenAIApi["`@mono-agent/openai-api-adapter`\nOpenAI Chat Completions"]
    Slack["`@mono-agent/slack-adapter`\nSocket Mode + Web API"]
    Telegram["`@mono-agent/telegram-adapter`\nBot API + long polling"]
    Webhook["`@mono-agent/webhook-adapter`\nHTTP sync/async invocation"]
    WhatsApp["`@mono-agent/whatsapp-adapter`\nextra plugin: Baileys socket + group trigger policy"]
  end

  subgraph Core["Core contracts and config"]
    Contracts["`@mono-agent/agent-contracts`\nrequest/response/stream/settings helpers"]
    Config["`@mono-agent/config`\ncore runtime/context settings"]
  end

  subgraph PromptContext["Context layer"]
    Memory["`@mono-agent/memory`\n./store SQLite, ./search embeddings, ./bujo engine"]
    MemorySupermemory["`@mono-agent/memory-supermemory`\nSupermemory-backed store"]
  end

  subgraph AppLayer["App layer"]
    AgentApp["`@mono-agent/agent-app`\nconfig to channels + responder"]
  end

  subgraph Execution["Execution layer"]
    Harness["`@mono-agent/agent-harness`\nrequest to runtime run\ncontext + skills + tool policy"]
    Orchestrator["`@mono-agent/agent-orchestrator`\nextra: collaborator MCP tool"]
    Observability["`@mono-agent/observability`\nJSONL events + summaries + trace registry"]
  end

  subgraph Runtime["Runtime backend choices"]
    RuntimeAdapter["`@mono-agent/runtime-adapter`\nmodel refs + sandbox policy"]
    AgentRuntime["`@mono-agent/agent-runtime`\nprovider/CLI implementation"]
    ClaudeSdk["Claude SDK\n`claude:<model>` + `sdk`"]
    ClaudeCli["Claude Code CLI\n`claude:<model>` + `cli`"]
    CodexCli["Codex app CLI\n`codex:<model>` + `cli`"]
    PiSdk["Pi SDK providers\n`pi:<provider>:<model>` + `sdk`"]
  end

  Host -. optional .-> Tui
  Host --> Telegram
  Host -. plugin .-> A2A
  Host --> Webhook
  Host --> OpenAIApi
  Host --> Cron
  Host -. optional package .-> Slack
  Host -. plugin .-> WhatsApp
  Host -. runtime extension .-> Orchestrator
  Host --> Config
  Host --> AgentApp

  Tui --> Contracts
  Tui --> Config
  Telegram --> Contracts
  A2A --> Contracts
  Cron --> Contracts
  OpenAIApi --> Contracts
  Slack --> Contracts
  Webhook --> Contracts
  WhatsApp --> Contracts

  Orchestrator --> Contracts
  Orchestrator -.->|runtime extension| Harness
  AgentApp --> Config
  AgentApp --> Harness
  AgentApp --> Memory
  AgentApp -. optional backend .-> MemorySupermemory
  AgentApp --> RuntimeAdapter
  AgentApp --> Observability
  Config --> Contracts
  Config --> RuntimeAdapter
  Harness --> Contracts
  MemorySupermemory --> Contracts
  Harness --> RuntimeAdapter
  Harness --> Observability

  RuntimeAdapter --> AgentRuntime
  RuntimeAdapter --> Contracts
  AgentRuntime --> ClaudeSdk
  AgentRuntime --> ClaudeCli
  AgentRuntime --> CodexCli
  AgentRuntime --> PiSdk
```
