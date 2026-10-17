# mono-agent architecture

This is the maintainer map for the repository. Start here when deciding where a change belongs; use the package README for the detailed contract of that package.

## System shape

`@mono-agent/app` is the config-first composition root. It loads one validated config, resolves channel drivers, builds one responder per active channel, and publishes lifecycle/traceability state. The execution path then crosses narrow package boundaries:

```text
channel adapter
  -> contracts request/stream interfaces
  -> app responder composition
  -> conversation turn orchestration
  -> turn/host protected host integration
  -> turn provider implementation
  -> turn/engine isolated loop, journal/storage and compaction

optional side paths
  -> memory
  -> observability
  -> operator endpoint/web surfaces
```

The exact workspace graph and package ownership descriptions are generated in [`PACKAGES.md`](./PACKAGES.md). The rules are enforced by `pnpm run check:architecture`.

## Layered composition map

**Diagram summary:** The app composes adapter-neutral config, request execution, runtime bridges, optional context and observability, communication adapters, and operator surfaces; arrows show the intended high-level dependency direction.

```mermaid
flowchart TB
  Host["Config-first app host<br/>mono-agent CLI or custom host"]

  subgraph Surfaces["Operator-surface choices"]
    Web["@mono-agent/web<br/>Always-on browser console"]
  end

  subgraph Communication["Communication adapter choices"]
    A2A["@mono-agent/channel-a2a<br/>extra plugin: Agent Card discovery + text tasks"]
    Cron["@mono-agent/trigger-cron<br/>Scheduled invocations"]
    OpenAIApi["@mono-agent/channel-openai-api<br/>OpenAI Chat Completions"]
    Slack["@mono-agent/channel-slack<br/>Socket Mode + Web API"]
    Telegram["@mono-agent/channel-telegram<br/>Bot API + long polling"]
    Webhook["@mono-agent/trigger-webhook<br/>HTTP sync/async invocation"]
    WhatsApp["@mono-agent/channel-whatsapp<br/>extra plugin: Baileys socket + group trigger policy"]
    Messenger["@mono-agent/channel-messenger<br/>extra plugin: Meta webhook + Send API"]
  end

  subgraph Core["Core contracts and config"]
    Contracts["@mono-agent/contracts<br/>request/response/stream/settings helpers"]
    Config["@mono-agent/config<br/>core runtime/context settings"]
  end

  subgraph PromptContext["Context layer"]
    Memory["@mono-agent/memory<br/>./store SQLite, ./search embeddings, ./bujo engine"]
  end

  subgraph AppLayer["App layer"]
    AgentApp["@mono-agent/app<br/>config to channels + responder"]
  end

  subgraph Execution["Execution layer"]
    Harness["@mono-agent/conversation<br/>request to runtime run<br/>context + skills + tool policy"]
    Orchestrator["@mono-agent/orchestrator<br/>extra: collaborator MCP tool"]
    Observability["@mono-agent/observability<br/>JSONL events + summaries + trace registry"]
  end

  subgraph Runtime["Pi runtime"]
    AgentRuntime["@mono-agent/turn<br/>Pi implementation"]
    PiSdk["Pi providers<br/>&lt;provider&gt;:&lt;model&gt;"]
  end

  Host -. optional .-> Web
  Host --> Telegram
  Host -. plugin .-> A2A
  Host --> Webhook
  Host --> OpenAIApi
  Host --> Cron
  Host -. optional package .-> Slack
  Host -. plugin .-> WhatsApp
  Host -. plugin .-> Messenger
  Host -. runtime extension .-> Orchestrator
  Host --> Config
  Host --> AgentApp

  Web --> Contracts
  Web --> Config
  Telegram --> Contracts
  A2A --> Contracts
  Cron --> Contracts
  OpenAIApi --> Contracts
  Slack --> Contracts
  Webhook --> Contracts
  WhatsApp --> Contracts
  Messenger --> Contracts

  Orchestrator --> Contracts
  Orchestrator -.->|runtime extension| Harness
  AgentApp --> Config
  AgentApp --> Harness
  AgentApp --> Memory
  AgentApp --> AgentRuntime
  AgentApp --> Observability
  Config --> Contracts
  Config --> AgentRuntime
  Harness --> Contracts
  Harness --> AgentRuntime
  Harness --> Observability

  AgentRuntime --> Contracts
  AgentRuntime --> PiSdk
```

## Dependency direction

```text
Static manifest dependencies (abridged; see PACKAGES.md for every edge)

@mono-agent/app
  ├─ config + contracts
  ├─ conversation
  ├─ turn (host integration + provider runtime)
  ├─ memory + observability
  ├─ built-in channel adapters
  ├─ channel-operator
  └─ tui + web

conversation ── contracts + turn + observability
tui / web ── contracts + config + observability

Runtime-only composition (not manifest dependency edges)

tui / web ── HTTP operator protocol ──> channel-operator
app ── channels.plugins[] ──> channel-a2a / channel-whatsapp / channel-messenger
custom host ── request-scoped extension ──> orchestrator
authoring harness ── explicit MCP companion ──> docs-mcp
```

Rules for future packages:

- New publishable packages live under `packages/<package-name>` and publish as `@mono-agent/<package-name>`.
- Optional plugin-tier add-ons may live under `extras/<package-name>` when cataloged with `publishable: true` and `tier: "plugin"` (published in the lockstep but outside the core app closure).
- Add every workspace package to `scripts/package-catalog.mjs` with category, responsibility, and allowed dependency categories.
- Communication packages use `*-adapter` naming and must not depend on other adapters, the harness, or operator surfaces.
- Core config stays adapter-neutral; adapter credentials and allowlists live with the adapter package.
- Operator surfaces register field groups from other packages; they do not hardcode adapter settings.

## Where changes belong

| Change | Primary owner |
| --- | --- |
| Shared request, stream, channel, or host-safety contract | `packages/contracts` |
| Config schema, validation, or source precedence | `packages/config` |
| Host/CLI/config composition | `packages/app` |
| Conversation/history orchestration and host turn policy | `packages/conversation` |
| Typed runtime construction, metadata or sandbox facade | `packages/turn/src/host` |
| Per-turn routing/execution, tools/providers or native sessions | `packages/turn` |
| Transport-specific behavior | The matching `*-adapter` package |
| Memory persistence, recall, or maintenance | `packages/memory` or an explicitly selected plugin backend |
| Run artifacts, trace discovery, or exporters | `packages/observability` |
| Browser/shared operator experience | `packages/web` or `packages/channel-operator` |

Choose the lowest rung in [`docs/reference/capability-ladder.md`](./docs/reference/capability-ladder.md). A shared contract change is the last resort, not the default home for reusable-looking code.

## Agent-app internals

`app-controller.ts` owns lifecycle state and delegates operations. Each `app-controller-*.ts` module declares the narrow controller port it needs; operation modules must not import the concrete controller. Cross-cutting service logic lives in focused modules such as `background-log-maintenance.ts`, `doctor-runs.ts`, and `managed-web-logs.ts` rather than returning to the CLI/controller entrypoints.

The normal lifecycle is:

1. Strictly load config and resolve channel drivers.
2. Establish sandbox, traceability, local recording, and continuation services.
3. Start configured channels and their responders.
4. Publish the completed startup snapshot.
5. On reload or stop, block new work, stop transports, dispose responders/runtimes, and close shared services with bounded waits.

## Generated surfaces

Do not hand-edit generated blocks or inventories:

- `pnpm run generate:package-docs` owns catalog metadata, `PACKAGES.md`, and package-directory tables.
- `pnpm run generate:public-api-docs` owns package public API inventories and migration subpath inventories.
- `pnpm run generate:config-reference` owns the JSON schema and config-reference tables from the typed config metadata.

Architecture and docs checks fail when these outputs drift. Narrative package responsibilities and examples remain hand-authored beside their generated blocks.

## Change discipline

- Keep one responsibility per package and one reason to change per module.
- Prefer explicit typed inputs over reaching into a composition root's full state.
- Keep queues, retained samples, log files, streams, and shutdown waits bounded.
- Preserve real failure states; do not replace provider or transport failures with fallback success.
- Add behavior tests at the owning boundary, then select verification from the diff's risk.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development and verification workflow.
