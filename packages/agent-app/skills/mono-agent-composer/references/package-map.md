# Package Composition Map

Use this map to select the smallest mono-agent package set for a host. Package categories are logical ownership boundaries; the physical workspace layout stays flat under `packages/<package-name>`.

## App Join (default)

`@mono-agent/agent-app` is the config-first host: it loads `mono-agent.config.json`, builds the responder through `agent-host`, and drives every configured channel plus the operator console and traceability. It ships the `mono-agent` CLI (`init`, `validate`, `start`) and is the only publishable package allowed to compose communication adapters.

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
| Configured responder | `@mono-agent/agent-host` | Turns `MonoAgentConfig` into runtime, harness, and responder | Polling chats, serving APIs, adapter settings |

Minimal local host:

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-host";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = createConfiguredAgentResponder({ config });
```

## Context And Skill Join

Use this path when the agent needs identity, selected skills, history, and optional memory:

| Need | Package | Use |
| --- | --- | --- |
| Prompt assembly | `@mono-agent/context` | Load identity/SOUL/skills/history/memory into deterministic prompt context |
| Selected skill bodies | `@mono-agent/skills` | Load only configured skills from `<skillsRoot>/<name>/SKILL.md` |
| Memory substrate (schema, migrations, FTS+vector db, RRF) | `@mono-agent/memory-store` | SQLite storage, BM25 FTS, optional vector index, hybrid recall; `MemoryStore`/`MemoryBlock`/`MemoryWriteResult` contract |
| Memory engine (all tiers: lite/journal/bujo) | `@mono-agent/memory-bujo` | `BujoMemoryStore` — tier-aware: FTS recall (lite), hybrid recall + decay (journal), LLM capture/reconcile + entity graph + reflection/migration + auto-scheduler (bujo) |
| Embedding providers | `@mono-agent/memory-search` | Ollama/OpenAI embedding providers used by memory-store for vector recall |

Mono-agent selected skills are not auto-selected by description. The host chooses `context.selectedSkills`, and the harness loads those exact bodies.

## Execution Join

Use `@mono-agent/agent-harness` directly when a host needs custom runtime, memory, history, recorder, or request-scoped runtime options. Use `@mono-agent/agent-host` when config-driven composition is enough.

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

Use `@mono-agent/tool-policy` for fail-closed tool/MCP policy normalization:

```ts
import { createToolPolicy, toolPolicyToRuntimeOptions } from "@mono-agent/tool-policy";

const policy = createToolPolicy({
  allowedTools: ["Read", "Grep"],
  disallowedTools: ["WebFetch"],
  mcpConfigPath: "./mcp.json",
});

const runtimeOptions = toolPolicyToRuntimeOptions(policy);
```

Do not grant broad tool access as a fallback. If the requested task needs tools, ask for the narrow allowlist or MCP config path.

## Adapter Join

Communication adapters are edge packages. They accept an `AgentResponder` and own only their transport-specific config and safety rules.

| Surface | Package | First smoke |
| --- | --- | --- |
| Telegram | `@mono-agent/telegram-adapter` | Allowed chat sends a message |
| Slack | `@mono-agent/slack-adapter` | Allowed channel or DM gets a streamed reply |
| WhatsApp | `@mono-agent/whatsapp-adapter` | Allowed sender/group trigger produces a reply |
| OpenAI-compatible API | `@mono-agent/openai-api-adapter` | `curl /v1/models` and `/v1/chat/completions` |
| A2A provider/consumer | `@mono-agent/a2a-adapter` | Send text to the Agent Card URL |
| Webhook | `@mono-agent/webhook-adapter` | `curl` the configured invocation path |
| Cron | `@mono-agent/cron-adapter` | One scheduled or manually triggered invocation |

Adapters must not import the harness, runtime adapter, memory packages (`memory-store`, `memory-bujo`, `memory-search`), or other adapters. `@mono-agent/agent-app` composes them from config; custom hosts and demos may compose them directly.

## Operator And Observability Join

Use:

- `@mono-agent/operator-console` for local browser settings and traceability (`console` config section; per-boot bearer token; saves re-apply live).
- `@mono-agent/tui` for local terminal chat and redacted read-only config (`mono-agent-tui --config ./mono-agent.config.json`).
- `@mono-agent/observability` for JSONL event artifacts, summaries, and trace-source registration.

Traceability is local-first. A running host registers a source manifest; the operator console reads artifacts by `(sourceId, runId)` so duplicate run ids do not collide.

## Evaluation Join

Use `@mono-agent/agent-evals` to define end-to-end scenarios against a responder or harness: final-text assertions, trajectory/tool-call matching, cost/turn/duration budgets, and custom judges, with local JSON/markdown artifacts. Live-provider scenarios are skipped unless `MONO_AGENT_EVAL_LIVE=1`.

## Multi-Agent Join

Use `@mono-agent/agent-orchestrator` when one runtime should call named collaborator responders through a bounded MCP tool. Keep collaborator selection in the orchestrator layer, not inside A2A. A2A remains direct discovery and text/task communication.

## Runtime Join

Use `@mono-agent/runtime-adapter` unless the host has a custom runtime implementation that already satisfies `MonoRuntimeLike`.

Supported model reference families:

- `codex:<model>` with CLI execution
- `claude:<model>` with SDK or CLI execution
- `pi:<provider>:<model>` with SDK execution, including local providers such as Ollama

Provider credentials belong in the provider/runtime environment, not in committed config.
