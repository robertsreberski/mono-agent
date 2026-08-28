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
| Live operator skill registry | `@mono-agent/agent-app` + `@mono-agent/operator-adapter` | Classify installed skills as inlined, on-demand, or unavailable and expose a bounded memory-only snapshot for console discovery |
| Memory substrate (schema, migrations, FTS+vector db, RRF) | `@mono-agent/memory/store` | SQLite storage, BM25 FTS, optional vector index, hybrid recall; re-exports `MemoryStore`/`MemoryBlock`/`MemoryWriteResult` from `@mono-agent/agent-contracts` |
| Memory engine (all tiers: lite/journal/bujo) | `@mono-agent/memory/bujo` | `BujoMemoryStore` — tier-aware: FTS recall (lite), hybrid recall + static salience (journal), LLM capture/reconcile + entity graph + projection-only scheduled consolidation (bujo) |
| Embedding providers | `@mono-agent/memory/search` | Exclusive Ollama/LM Studio/OpenAI embedding providers used by the store subpath for vector recall; `agent-app` owns guided typed discovery and the real readiness probe |
| Composer documentation search + guided reading | `@mono-agent/docs-mcp` (optional plugin) | Exact-version offline hybrid semantic/BM25 `mono_agent_docs` search plus anchored reads, cross-link resolution, and continuation windows over canonical docs and composer references; paired by `mono-agent install-skill`, outside the composed agent's own `mcp.json` |
| External Supermemory backend | `@mono-agent/memory-supermemory` (optional plugin) | Explicitly installed lockstep package selected by `memory.backend: "supermemory"`; proxies the shared `MemoryStore` / `MemoryRecall` contracts to local or hosted Supermemory for server-side extraction, consolidation, and hybrid recall |
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

The `mono-agent-docs` MCP server paired with this authoring skill is a harness
companion, not an MCP server injected into every composed agent. Add project
MCP servers to the agent's own `mcp.json`; do not copy the documentation server
there unless the resulting agent itself must answer mono-agent framework questions.

`RunHistory`, `SessionHistory`, and `SetConversationTitle` are app-owned
request-scoped tools, not entries for `mcp.json`. `SessionHistory` searches the
current logical session's retained managed-tool calls/results and needs no config
key. `SetConversationTitle` appears only for writable interactive web threads;
it keeps automatic semantic titles current, while a user rename permanently
wins. Allow-all exposes eligible tools on compatible routes; a specific
allowlist must name each one. Direct OpenCode suppresses all three; direct ACP
retains and cold-projects lifecycle evidence but cannot expose `SessionHistory`.
`@mono-agent/agent-app` also owns rich reply composition. `PublishReplyFile`
copies a confined generated file into owner-private integrity storage and is
available under allow-all (or by exact name in a restrictive policy). Supported
Pi-native MCP tool results can register their declared MCP App UI resource for
the web console. An all-Pi route chain is required for Apps; direct or fallback
routes that cannot carry the bridge do not advertise it. Adapters consume the
shared reply-part contract: Slack and Telegram confirm native uploads, the web
serves authorized downloads and sandboxed Apps, and machine/verbatim adapters
preserve answer text when they cannot represent a part.

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
| Telegram | `@mono-agent/telegram-adapter` | Allowed chat receives text and a generated reply file through `sendDocument` |
| Slack | `@mono-agent/slack-adapter` | Allowed channel or DM receives text and a generated reply file through the external upload flow |
| WhatsApp | `@mono-agent/whatsapp-adapter` (external channel plugin) | Allowed sender/group trigger produces a reply |
| OpenAI-compatible API | `@mono-agent/openai-api-adapter` | `curl /v1/models` and `/v1/chat/completions` |
| Operator endpoint | `@mono-agent/operator-adapter` | `mono-agent tui` and `mono-agent web` connect for chat |
| A2A provider/consumer | `@mono-agent/a2a-adapter` (external channel plugin) | Send text to the Agent Card URL |
| Webhook | `@mono-agent/webhook-adapter` | `curl` the configured invocation path (with `Authorization: Bearer ...` when `apiKey` is set) |
| Cron | `@mono-agent/cron-adapter` | One scheduled or manually triggered invocation |

Adapters must not import the harness, runtime adapter, memory package (`@mono-agent/memory` subpaths), or other adapters. `@mono-agent/agent-app` composes them from config; custom hosts and demos may compose them directly.

## Observability Join

Use:

- `@mono-agent/tui` for the pi-tui operator console (`mono-agent tui`): live chat with structured stream-event insight, recorded-run replay, and config view. Remote event frames have a strict 256 KiB UTF-8 NDJSON cap: assistant-thought/tool-call payload fields are reduced and remeasured, while another oversized variant or a reducible event whose minimal form still does not fit becomes a bounded `oversized_event` marker. Other frame kinds are unaffected, and replay contains only sensitive-key-redacted, credential-scanned, capped events that reached terminal JSONL persistence.
- `@mono-agent/web` for the assistant-ui always-on browser console (`mono-agent web`): persistent multi-agent conversations and same-thread quotes, fixed compact/expanded agent navigation with offline filtering, explicit alive-page/PWA response notifications, device-local file picking, integrity-checked reply downloads, confirmation-gated MCP Apps in a double-frame sandbox, streamed reasoning/tools, internal telemetry-backed cumulative context usage, cancellation, LAN-default HTTP on port 5050, and conflict-safe optional Tailscale Serve HTTPS. It has no app login; network reachability is the access boundary.
- `@mono-agent/operator-adapter` for the loopback NDJSON stream endpoint the TUI and web chat console connect to (`tui` config section, on by default).
- `@mono-agent/observability` for JSONL event artifacts, summaries, trace-source registration, and the `@mono-agent/observability/otel` Phoenix OTLP exporter configured via `observability.exporters`.

Traceability is local-first. A running host registers a source manifest; `mono-agent status` reads the trace-source registry to report live sources, and artifacts are keyed by `(sourceId, runId)` so duplicate run ids do not collide. Phoenix is the recommended trace viewer when an `observability.exporters` (phoenix) entry is configured; its terminal-batched export is best-effort. Independently, the local recorder writes empty events plus a `running` summary at start and a sensitive-key-redacted, credential-scanned, capped snapshot at finish/fail. Events stay in RAM between those boundaries, so a crash can lose them. Without Phoenix, those bounded terminal JSONL snapshots are the only local run record.

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
