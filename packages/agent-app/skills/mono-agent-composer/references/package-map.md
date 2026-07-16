# Package Composition Map

Use this map to select the smallest mono-agent package set for a host. Package categories are logical ownership boundaries; the physical workspace layout stays flat under `packages/<package-name>`.

## App Join (default)

`@mono-agent/agent-app` is the config-first host: it loads `mono-agent.config.json`, owns configured runtime/harness/responder/memory composition, and drives every configured channel plus traceability and any configured observability exporters. It ships the `mono-agent` CLI (`init`, `validate`, `start`) and is the only publishable package allowed to compose communication adapters.

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({ cwd: process.cwd() });
```

Reach below it (the joins that follow) only when config cannot express the host.

## Core Join

Every real host needs these concepts:

| Need | Package | Owns | Does not own |
| --- | --- | --- | --- |
| Shared request/response shape | `@mono-agent/agent-contracts` | `AgentResponder`, request, response, stream, cancellation contracts | Prompt building, runtime execution, transport |
| Core config | `@mono-agent/config` | Runtime, context, memory, tools, artifact, traceability settings | Adapter credentials, chat allowlists |
| Runtime facade | `@mono-agent/runtime-adapter` | Model refs, execution-mode validation, local provider runtime options | Prompts, adapters, memory |
| Configured responder | `@mono-agent/agent-app` | Turns `MonoAgentConfig` into runtime, memory, harness, and responder | Polling chats, serving APIs, adapter settings |

Minimal local host:

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = await createConfiguredAgentResponder({ config });
```

## Context And Skill Join

Use this path when the agent needs identity, selected skills, history, and optional memory:

| Need | Package | Use |
| --- | --- | --- |
| Prompt assembly | `@mono-agent/agent-harness` | Load identity/SOUL/skills/history/memory into deterministic prompt context |
| Selected skill bodies | `@mono-agent/agent-harness` | Load only configured skills from `<skillsRoot>/<name>/SKILL.md` |
| Memory substrate (schema, migrations, FTS+vector db, RRF) | `@mono-agent/memory/store` | SQLite storage, BM25 FTS, optional vector index, hybrid recall; re-exports `MemoryStore`/`MemoryBlock`/`MemoryWriteResult` from `@mono-agent/agent-contracts` |
| Memory engine (all tiers: lite/journal/bujo) | `@mono-agent/memory/bujo` | `BujoMemoryStore` — tier-aware: FTS recall (lite), hybrid recall + static salience (journal), LLM capture/reconcile + entity graph + projection-only scheduled consolidation (bujo) |
| Embedding providers | `@mono-agent/memory/search` | Exclusive Ollama/LM Studio/OpenAI embedding providers used by the store subpath for vector recall; `agent-app` owns guided typed discovery and the real readiness probe |
| Recall tool surface | `@mono-agent/agent-app` (bundled) | Auto-provisions read-only `MemoryRecall` for every configured tier and direct configured responder; automatic/tool recall share the same store and per-turn query cache |

Mono-agent selected skills are not auto-selected by description. The host chooses `context.selectedSkills`, and the harness loads those exact bodies.

## Execution Join

Use `@mono-agent/agent-harness` directly when a host needs custom prompt/runtime/memory/history/recorder wiring below the config layer. Use `@mono-agent/agent-app` when config-driven composition is enough.

`@mono-agent/agent-harness` owns:

- loading identity/context files
- loading selected skill bodies
- reading memory blocks
- invoking the runtime
- recording run events and summaries
- appending conversation history
- optionally appending deterministic host summaries to memory
- returning explicit failure objects instead of fake success

## Tools And MCP Join

Use `@mono-agent/agent-harness` for tool/MCP policy normalization. The **config** default is allow-all (`["*"]`); `createToolPolicy` itself does no defaulting, and the harness's no-policy safety net is `failClosedToolPolicy()` (an empty, fail-closed policy):

```ts
import { createToolPolicy, toolPolicyToRuntimeOptions } from "@mono-agent/agent-harness";

const policy = createToolPolicy({
  allowedTools: ["*"],              // ["*"] = all; ["Read","Grep"] = specific; [] = none
  disallowedTools: ["WebFetch"],   // deny wins, even under allow-all
  mcpConfigPath: "./mcp.json",
});

const runtimeOptions = toolPolicyToRuntimeOptions(policy);
```

Match the user's intent: allow-all is the recommended default. Prefer subtracting with `disallowedTools` over hand-curating an allowlist, and only narrow to a specific list when the user asks for it.

## Adapter Join

Communication adapters are edge packages. They accept an `AgentResponder` and own only their transport-specific config and safety rules.

| Surface | Package | First smoke |
| --- | --- | --- |
| Telegram | `@mono-agent/telegram-adapter` | Allowed chat sends a message |
| Slack | `@mono-agent/slack-adapter` | Allowed channel or DM gets a streamed reply |
| WhatsApp | `@mono-agent/whatsapp-adapter` (external channel plugin) | Allowed sender/group trigger produces a reply |
| OpenAI-compatible API | `@mono-agent/openai-api-adapter` | `curl /v1/models` and `/v1/chat/completions` |
| Operator endpoints | `@mono-agent/operator-adapter` | `mono-agent tui` connects; `mono-agent web` observes live runs |
| A2A provider/consumer | `@mono-agent/a2a-adapter` (external channel plugin) | Send text to the Agent Card URL |
| Webhook | `@mono-agent/webhook-adapter` | `curl` the configured invocation path |
| Cron | `@mono-agent/cron-adapter` | One scheduled or manually triggered invocation |

Adapters must not import the harness, runtime adapter, memory package (`@mono-agent/memory` subpaths), or other adapters. `@mono-agent/agent-app` composes them from config; custom hosts and demos may compose them directly.

## Observability Join

Use:

- `@mono-agent/tui` for the pi-tui operator console (`mono-agent tui`): live chat with full stream-event insight, recorded-run replay, config view.
- `@mono-agent/operator-adapter` for the loopback NDJSON stream endpoint the console connects to (`tui` config section, on by default) and the live SSE endpoint `mono-agent web` observes (`live` config section, on by default).
- `@mono-agent/observability` for JSONL event artifacts, summaries, trace-source registration, and the `@mono-agent/observability/otel` Phoenix OTLP exporter configured via `observability.exporters`.

Traceability is local-first. A running host registers a source manifest; `mono-agent status` reads the trace-source registry to report live sources, and artifacts are keyed by `(sourceId, runId)` so duplicate run ids do not collide. Phoenix is the recommended trace viewer when an `observability.exporters` (phoenix) entry is configured; local JSONL artifacts are the fallback otherwise.

## Multi-Agent Join

Use `@mono-agent/agent-orchestrator` when one runtime should call named collaborator responders through a bounded MCP tool. Keep collaborator selection in the orchestrator layer, not inside A2A. A2A remains direct discovery and text/task communication.

## Runtime Join

Use `@mono-agent/runtime-adapter` unless the host has a custom runtime implementation that already satisfies `MonoRuntimeLike`.

Supported model reference families:

- `codex:<model>` with CLI execution
- `claude:<model>` with SDK or CLI execution
- `pi:<provider>:<model>` with SDK execution, including Pi OpenAI-Codex, OpenCode-through-Pi (`pi:opencode-go:*`), and local providers such as Ollama and LM Studio
- `opencode:<provider>:<model>` with CLI execution for hand-authored OpenCode backend config

Provider credentials belong in the provider/runtime environment, not in committed config.
