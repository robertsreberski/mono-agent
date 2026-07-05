# Agent Framework Packages

This repository is a config-first pnpm workspace of reusable npm packages under the `@mono-agent` scope. The framework is built around `@mono-agent/agent-runtime` as the single shipped runtime implementation layer, while sandboxing, communication adapters, skills, memory, observability, and operator surfaces stay modular. `@mono-agent/agent-app` composes them from one shareable config file so an agent can be built, validated, and moved as configuration instead of host glue.

## Documentation

Full documentation and end-to-end playbooks: **<https://mono-agent-docs.vercel.app/>** (authored as markdown under [`docs/`](./docs/), built with Astro Starlight in [`website/`](./website/) and deployed on Vercel — see [`website/README.md`](./website/README.md) for the build/sync/deploy workflow and version-pin notes). [`docs/reference/feature-registry.md`](./docs/reference/feature-registry.md) remains the canonical feature reference, and [`docs/playbooks/`](./docs/playbooks/) holds copy-paste recipes for every channel and memory tier.

## Quickstart: An Agent Folder From One Config File

Any folder — empty or already holding knowledge (`AGENTS.md`, `CLAUDE.md`, docs) — becomes a working agent with the `mono-agent` CLI from `@mono-agent/agent-app`. Use Node.js 20 or newer, and install the CLI once:

```bash
npm i -g @mono-agent/agent-app
```

(No install needed if you prefix each command with `npm exec --package @mono-agent/agent-app -- `; there is no standalone `mono-agent` npm package, so `npx mono-agent` would fail.)

The easiest path on a terminal is the guided setup — it presents the recipe catalog, prompts for the model and channel add-ons, scaffolds, validates, and prints a secrets checklist:

```bash
# in the agent folder
mono-agent setup
```

Or drive it with flags (`setup` falls back to this form when stdin is not a TTY):

```bash
mono-agent init --model claude:claude-sonnet-4-6 --fallback-models pi:ollama:gemma4:31b
export ANTHROPIC_API_KEY=sk-...   # key for whatever model you chose
mono-agent validate               # per-section report; `mono-agent doctor` is an alias
mono-agent start                  # backgrounds on macOS (launchd); use `start --foreground` elsewhere
```

Then smoke-test over the webhook channel that `init` enables by default — it needs no channel credentials (the model key above is the only secret involved):

```bash
curl -s http://127.0.0.1:<PORT>/webhook/invoke \
  -H 'content-type: application/json' \
  -d '{"text": "Say hello and tell me what you are."}'
```

`<PORT>` comes from the `start` output. A reply means runtime, model, identity, and channel wiring all work.

`init` scaffolds `mono-agent.config.json` (webhook enabled as the credential-free smoke channel), an `IDENTITY.md` that references the folder's existing knowledge, and `.mono-agent/` working dirs — never overwriting existing files. The config file declares everything: runtime model plus ordered backup models (`runtime.fallbackModels`, served by the native failover router), channels (`telegram`, `slack`, `a2a`, `webhook`, `openaiApi`, `cron`, `whatsapp`), skills, MCP servers, memory strategy, sandbox policy, and observability. `validate` reports every section before anything starts; `start` runs traceability and every configured channel, each with independent `running` / `waiting_for_config` / `disabled` / `failed` status. For unreleased or source-build testing, use the source build flow in [`docs/getting-started/install.md`](./docs/getting-started/install.md); pnpm 10 is only required for that path.

### Recipes: executable example configs

Thirteen recipes cover the common shapes — personal Telegram assistant with tiered memory, Slack team bot, OpenAI-compatible gateway, cron digest, A2A provider, fully local model setups, sandboxed code agent, safe/full blueprints, and more. Each generates a working config with secrets externalized to `.env.example`, and most mirror a copy-paste playbook in [`docs/playbooks/`](./docs/playbooks/):

```bash
mono-agent recipes list
mono-agent recipes show personal-telegram-bujo
mono-agent init --recipe personal-telegram-bujo
```

Recipes that ship `sandbox.mode: "native"` require `srt` on `PATH`; run `mono-agent validate --recipe <id>` and read the `Sandbox` section before starting. Safe recipes such as `sandboxed-code-agent` and `full-safe` use `fallback: "fail-closed"` so missing `srt` produces `sandbox_unavailable` instead of host execution. `full-local-power` is intentionally high risk: it opts into `unsafe-host-process`, so if `srt` is missing, roots/denyWrite are inert and commands run unsandboxed.

See [`docs/reference/recipes.md`](./docs/reference/recipes.md) for the full catalog at a glance.

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

Package categories are catalog metadata, documentation, and architecture-guard inputs. The physical layout intentionally stays `packages/<package-name>` and published names stay `@mono-agent/<package-name>`; a future physical move to `packages/<category>/<package-name>` would be a separate mechanical release-tooling task.

See [`PACKAGES.md`](./PACKAGES.md) for the current Mermaid package/layer map.

Before adding new capability surface area, use the [`Capability ladder`](./docs/reference/capability-ladder.md) to decide whether the work belongs in an existing package, config/skills, a new package, an MCP tool boundary, or a shared core contract.

| Category | Packages | Allowed workspace dependency categories | Responsibility |
| --- | --- | --- | --- |
| `runtime` | `@mono-agent/agent-runtime`, `@mono-agent/runtime-adapter` | `core`, `runtime` where needed | Provider/CLI runtime bridges, typed runtime facade, and fail-closed sandbox policy/process wrapping. |
| `core` | `@mono-agent/agent-contracts`, `@mono-agent/config` | Package-specific `core` plus `runtime` only for config | Shared responder contracts and settings JSON/env helpers with adapter-neutral core config. |
| `context` | `@mono-agent/memory`, `@mono-agent/memory-supermemory` | `core`, `context` | Tiered memory (lite/journal/bujo via `@mono-agent/memory` subpaths plus optional Supermemory backend). The agent's `memory_recall` tool is auto-provisioned in-app from the single `memory` config block. |
| `execution` | `@mono-agent/agent-harness`, `@mono-agent/agent-orchestrator` | Package-specific `core`, `context`, `runtime`, `observability`, and execution helpers | Request execution, prompt assembly, selected-skill loading, fail-closed tool/MCP policy normalization, and bounded collaborator orchestration through runtime-visible tools. |
| `observability` | `@mono-agent/observability` (`./otel` subpath for Phoenix export) | `core` | JSONL run recorder, local artifact reader, file-backed trace source registry, and subpath-only OTLP trace export. |
| `communication` | `@mono-agent/a2a-adapter`, `@mono-agent/cron-adapter`, `@mono-agent/openai-api-adapter`, `@mono-agent/operator-adapter`, `@mono-agent/slack-adapter`, `@mono-agent/telegram-adapter`, `@mono-agent/webhook-adapter`, `@mono-agent/whatsapp-adapter` | `core` | Transport and invocation adapters that accept shared structural responders and own adapter-specific safety/config. A2A adds direct Agent Card discovery plus text/task inter-agent calls; OpenAI API exposes Chat Completions for OpenWebUI-style clients; Operator exposes the TUI NDJSON and live SSE loopback endpoints. |
| `operator-surface` | `@mono-agent/session-web`, `@mono-agent/tui` | `core`, `observability` | Local operator surfaces. They read registered source runs but do not own runtime hosting or communication transport. |
| `app` | `@mono-agent/agent-app` | All categories | Config-first host: loads `mono-agent.config.json`, builds the responder, drives every configured channel plus traceability, and ships the `mono-agent` CLI (`init`/`validate`/`start`). The only publishable package allowed to compose communication adapters. |
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

- New packages live under `packages/<package-name>` and publish as `@mono-agent/<package-name>`.
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
- Tool policy is explicit and fail-closed.
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
    A2A["`@mono-agent/a2a-adapter`\nAgent Card discovery + text tasks"]
    Cron["`@mono-agent/cron-adapter`\nScheduled invocations"]
    OpenAIApi["`@mono-agent/openai-api-adapter`\nOpenAI Chat Completions"]
    Slack["`@mono-agent/slack-adapter`\nSocket Mode + Web API"]
    Telegram["`@mono-agent/telegram-adapter`\nBot API + long polling"]
    Webhook["`@mono-agent/webhook-adapter`\nHTTP sync/async invocation"]
    WhatsApp["`@mono-agent/whatsapp-adapter`\nBaileys socket + group trigger policy"]
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
    Orchestrator["`@mono-agent/agent-orchestrator`\ncollaborator MCP tool"]
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
  Host --> A2A
  Host --> Webhook
  Host --> OpenAIApi
  Host --> Cron
  Host -. optional package .-> Slack
  Host -. optional package .-> WhatsApp
  Host -. optional package .-> Orchestrator
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
