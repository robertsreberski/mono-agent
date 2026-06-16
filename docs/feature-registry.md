# Mono-Agent Feature Registry

Source of truth mapping **every framework capability** to (a) how a config-first
agent reaches it through `mono-agent.config.json` / env vars / the `mono-agent`
CLI, and (b) where the `mono-agent-composer` skill documents it. When a feature
is added to any package, add a row here and update the skill references.

**Coverage legend**

| Code | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json` (env var override always available) |
| `cli` | Reached through a `mono-agent` CLI flag/command |
| `auto` | Always active when the app runs; needs no declaration |
| `code` | Programmatic escape hatch only (`startMonoAgentApp` options / lower-level packages) — intentional |
| `dev` | Development/test-time tooling, not part of a running agent |

Env precedence everywhere: process env > `mono-agent.config.json` > built-in defaults.

## Runtime (`@mono-agent/agent-runtime`, `@mono-agent/runtime-adapter`)

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `runtime.multi-backend` | claude (sdk/cli), codex (cli), pi (sdk, 15+ providers), opencode (cli) | `config` | `runtime.model` (`MONO_AGENT_MODEL`), e.g. `claude:claude-sonnet-4-6`, `codex:gpt-5.5`, `pi:openai:gpt-5.5` |
| `runtime.execution-modes` | sdk vs cli execution | `config` | `runtime.executionMode` (`MONO_AGENT_EXECUTION_MODE`), default inferred from model |
| `runtime.fallback-models` | Ordered backup models on retryable provider failure (fallback router, transcript-tail resume) | `config` | `runtime.fallbackModels` (`MONO_AGENT_FALLBACK_MODELS`), `mono-agent init --fallback-models` |
| `runtime.effort` | Reasoning effort hint | `config` | `runtime.effort` (`MONO_AGENT_EFFORT`): none/low/medium/high/xhigh/max |
| `runtime.permission-mode` | Tool-permission posture for CLI backends | `config` | `runtime.permissionMode` (`MONO_AGENT_PERMISSION_MODE`): default/plan/acceptEdits/bypassPermissions |
| `runtime.reasoning-summary` | Provider reasoning-summary verbosity | `config` | `runtime.reasoningSummary` (`MONO_AGENT_REASONING_SUMMARY`): auto/concise/detailed/off/on |
| `runtime.max-turns` | Optional turn cap per run; omitted or `0` means unlimited | `config` | `runtime.maxTurns` (`MONO_AGENT_MAX_TURNS`) |
| `runtime.workspace` | Working directory for runtime tools | `config` | `runtime.workspace` (`MONO_AGENT_WORKSPACE`) |
| `runtime.provider-sessions` | Continuous provider session per conversation with idle eviction | `config` | `runtime.session.mode` + `runtime.session.idleTimeoutMs` (`MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS`) |
| `runtime.local-providers` | Ollama / LM Studio / OpenAI-compatible local model providers | `config` | `providers.local[]` (`MONO_AGENT_LOCAL_PROVIDERS_JSON` or `MONO_AGENT_LOCAL_PROVIDER_*`): id, type, baseUrl, apiKey/apiKeyEnv, models with capabilities/pricing |
| `runtime.pi-oauth` | Pi OAuth credential resolution (openai-codex etc.) | `config` | `providers.piAuthPath` (`MONO_AGENT_PI_AUTH_PATH`), default `~/.pi/agent/auth.json` |
| `runtime.context-compaction` | Automatic context compaction with summarization | `auto` | Built into agent-runtime runs |
| `runtime.tool-bloat-guard` | 256KB tool-output truncation with artifact persistence | `auto` | Built in; artifacts land in `artifacts.dir` |
| `runtime.cost-tracking` | Per-run usage/cost/cache metrics + events | `auto` | Recorded in JSONL artifacts |
| `runtime.builtin-tools` | Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch | `config` | Gated by `tools.allowedTools` / `tools.disallowedTools` |
| `runtime.structured-output` | JSON-schema-enforced output on capable backends | `code` | `runtimeOptions.outputSchema` via harness options |
| `runtime.live-input` | In-flight user message steering | `code` | `runtimeOptions.liveInput` queue |
| `runtime.approval-gates` | Human-in-the-loop tool approval (risk tiers, timeout, always-allow) | `code` | `createMonoRuntime({ onToolApprovalRequest, toolRiskTiers, approvalDefaultRiskTier, approvalTimeoutMs, approvalAlwaysAllowTools })` — needs a host UI to answer; config posture is `runtime.permissionMode` |
| `runtime.openai-agents-sdk` | `@mono-agent/openai-agents-runtime` (OpenAI Agents SDK backend) | `code` | Pass `createOpenAIAgentsRuntime(...)` as `startMonoAgentApp({ runtime })` / `createConfiguredAgentResponder({ runtime })` |
| `runtime.custom` | Any `MonoRuntimeLike` implementation | `code` | `startMonoAgentApp({ runtime })` |

## Sandbox (`@mono-agent/sandbox`)

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `sandbox.mode` | native (srt-wrapped commands) vs off | `config` | `sandbox.mode` (`MONO_AGENT_SANDBOX_MODE`) |
| `sandbox.network-policy` | none / localhost / allowlist / all (+ domain allowlist) | `config` | `sandbox.network.mode`, `sandbox.network.allowlist` (`MONO_AGENT_SANDBOX_NETWORK`, `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST`) |
| `sandbox.filesystem-scopes` | readable/writable roots + deny-write globs (root defaults to workspace; `.env*`, `.git/config`, `.git/hooks/**` denied by default) | `config` | `sandbox.readableRoots`, `sandbox.writableRoots`, `sandbox.denyWrite` (`MONO_AGENT_SANDBOX_READABLE_ROOTS`, `MONO_AGENT_SANDBOX_WRITABLE_ROOTS`, `MONO_AGENT_SANDBOX_DENY_WRITE`) |
| `sandbox.fallback` | fail-closed vs unsafe-host-process when srt is unavailable | `config` | `sandbox.fallback` (`MONO_AGENT_SANDBOX_FALLBACK`), `sandbox.unsafeAllowHostProcess` (`MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS`) |
| `sandbox.monotonic-merge` | Request-scoped policies can only tighten, never widen | `auto` | Harness merges configured + request policies |

## Context, skills, memory (`@mono-agent/context`, `skills`, `memory-*`)

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `context.identity` | Identity markdown loaded into every prompt | `config` | `context.identityPath` (`MONO_AGENT_IDENTITY_PATH`) |
| `context.soul` | Optional secondary voice/guardrail doc | `config` | `context.soulPath` (`MONO_AGENT_SOUL_PATH`) |
| `context.history` | Conversation history assembly (in-memory store, capped only when turns are capped) | `auto` | Sized from `runtime.maxTurns`; unlimited when `runtime.maxTurns` is omitted or `0`; custom store via `code` (`createConfiguredAgentResponder({ historyStore })`) |
| `skills.selected-activation` | Explicitly selected skills loaded from `<skillsRoot>/<name>/SKILL.md` | `config` | `context.skillsRoot`, `context.selectedSkills` (`MONO_AGENT_SKILLS_ROOT`, `MONO_AGENT_SELECTED_SKILLS`) |
| `skills.byte-capping` | Per-skill instruction byte cap (default 48000) | `config` | `context.skillMaxBytes` (`MONO_AGENT_SKILL_MAX_BYTES`) |
| `memory.markdown` | Single-file or per-conversation capped markdown memory | `config` | `memory.mode: "markdown"`, `memory.path`, `memory.maxBytes`, `memory.scope` |
| `memory.journal` | Global daily journal; today's note always in context | `config` | `memory.mode: "journal"`, `memory.path` (root dir), `memory.maxBytes` |
| `memory.bujo` | BuJo memory: SQLite-indexed daily markdown; hybrid recall (BM25+vector RRF). **Runtime** = hybrid recall + rapid-log capture. The intelligent write path (capture→reconcile ADD/UPDATE/SUPERSEDE/NOOP + entity graph) and rituals (reflection: decay + insight synthesis; migration: promote/reschedule/cluster/forget; future-log + living index) run via the `memory-bujo` CLI/API — not yet auto-scheduled | `config` | `memory.mode: "bujo"`, `memory.path` (root dir), `memory.embeddings.{provider,model,dim}`, `memory.llm.{provider,model,endpoint}` — see `docs/memory.md` |
| `memory.bujo-cli` | CLI for BuJo capture/recall/maintenance: rebuild SQLite index from markdown, hybrid recall, write living `index.md`, reflection pass, monthly migration | `cli` | `memory-bujo rebuild\|recall\|index\|reflect\|migrate <root>` (`MONO_AGENT_EMBED_MODEL`, `MONO_AGENT_EMBED_DIM`; `MONO_AGENT_LLM_MODEL`, `MONO_AGENT_LLM_ENDPOINT` for reflect/migrate) |
| `memory.bujo-validate` | `mono-agent validate` confirms bujo is live: Ollama reachable, embeddings model pulled (`ollama pull nomic-embed-text:v1.5`), optional chat model present, memory root writable — loud WARN on any failure, never silent fallback | `cli` | `mono-agent validate [--config]` |
| `memory.write-mode` | disabled vs deterministic host summaries appended after runs | `config` | `memory.writeMode` (`MONO_AGENT_MEMORY_WRITE_MODE`) |
| `memory.entity-graph` | JSONL entity graph next to the journal; salience digest folded into context | `config` | Automatic in journal mode; path override via `memory.graphPath` (`MONO_AGENT_MEMORY_GRAPH_PATH`), default `<memory.path>/graph.jsonl` |
| `memory.recall-tools` | MCP tools: `memory_read_day`, `memory_list_days`, `memory_grep`, `memory_search`, `entity_get` | `config` | `memory.tools.enabled` (journal mode) |
| `memory.journal-append-tool` | Model-initiated `journal_append` notes | `config` | `memory.tools.allowJournalAppend` |
| `memory.semantic-search` | Embedding-backed `memory_search` (Ollama `nomic-embed-text` or OpenAI; falls back to keyword search when unset) | `config` | `memory.embeddings.provider/model/endpoint/apiKey/apiKeyEnv` (`MONO_AGENT_MEMORY_EMBEDDINGS_*`), forwarded to the memory MCP server |
| `memory.consolidation-tools` | `entity_upsert` + `memory_reindex` MCP tools for host-driven consolidation jobs | `code` | Exposed by `@mono-agent/memory-mcp`; not in the default runtime allowlist — pair with a cron prompt + custom policy if wanted |
| `memory.custom-store` | Any `MemoryStore` implementation | `code` | `createConfiguredAgentResponder({ memory })` |

## Tools & MCP (`@mono-agent/tool-policy`)

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `tool-policy.fail-closed` | Empty allowlist = no tools | `auto` | Default when `tools` lists are empty |
| `tool-policy.allowlist` / `tool-policy.denylist` | Tool allow/deny (deny wins; overlap rejected) | `config` | `tools.allowedTools`, `tools.disallowedTools` (`MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS`) |
| `tool-policy.mcp-servers` | MCP servers (stdio/sse/http) from a JSON file; inlined for SDK runtimes, path forwarded for CLI runtimes | `config` | `tools.mcpConfigPath` (`MONO_AGENT_MCP_CONFIG_PATH`) → `mcp.json` |

## Channels (`@mono-agent/*-adapter`, composed by `@mono-agent/agent-app`)

All channels are independent JSON sections and opt-in via an `enabled` flag
(default off). A channel that is off reports `disabled`; an enabled channel with
incomplete config reports `waiting_for_config`. Either way it never blocks the
rest. Every field also has a `MONO_AGENT_<CHANNEL>_*` env var.

| Feature id | What it is | Coverage | Config section / keys |
| --- | --- | --- | --- |
| `telegram.long-polling` | Telegram bot via long polling | `config` | `telegram.enabled`, `telegram.botToken`, `telegram.allowedChatIds` or `telegram.allowAllChats` |
| `slack.socket-mode` | Slack Socket Mode bot | `config` | `slack.enabled`, `slack.botToken`, `slack.appToken`, `slack.allowedChannelIds` or `slack.allowAllChannels`, `slack.botUserIds`, `slack.mentionTextAliases`, `slack.stripMentionText` |
| `whatsapp.baileys` | WhatsApp via Baileys socket (QR login; auth state in `.mono-agent/whatsapp-auth`) | `config` | `whatsapp.enabled`, `whatsapp.allowedChatJids` or `whatsapp.allowAllChats`, `whatsapp.groupMode` (mention/any), `whatsapp.botJids`, `whatsapp.mentionTextAliases`, `whatsapp.stripMentionText` |
| `webhook.http-invoke` | HTTP POST invocation, sync or async with status polling | `config` | `webhook.enabled`, `host`, `port`, `path`, `allowNonLoopback`, `defaultMode` (sync/async), `retentionMs`, `maxStoredRequests` |
| `openai-api.chat-completions` | OpenAI-compatible `/v1/models` + `/v1/chat/completions` (SSE streaming, optional bearer key; session continuity via `X-OpenWebUI-Chat-Id`/`X-Conversation-Id` headers with latest-message extraction) | `config` | `openaiApi.enabled`, `host`, `port`, `basePath`, `allowNonLoopback`, `apiKey`, `modelId` |
| `a2a.provider` | A2A provider with Agent Card discovery, JSON-RPC + REST, streaming, optional bearer | `config` | `a2a.provider.{enabled,host,port,publicBaseUrl,allowNonLoopback,requireBearer,bearerToken}`, `a2a.agent.{name,description,version,providerOrganization,providerUrl}`, `a2a.skill.{id,name,description,tags,examples}` |
| `a2a.consumer` | Calling remote A2A agents (discovery + sendMessage) | `config`+`code` | `a2a.consumer.{remoteAgentUrls,defaultRemoteAgentUrl,bearerToken,timeoutMs}` holds the settings; invoking remote agents is programmatic (`createA2AConsumerResponder`, used by multi-agent hosts) |
| `cron.scheduled-prompts` | Five-field cron jobs (timezone-aware, overlap-skipping) invoking the responder | `config` | `cron.jobs[]: {id, enabled, expression, timezone, prompt, conversationId}` (`MONO_AGENT_CRON_JOBS_JSON` or single-job `MONO_AGENT_CRON_*`), or one `*.md` file per job in the cron folder (frontmatter metadata + prompt body) at `cron.dir` / `MONO_AGENT_CRON_DIR` (default `cron/`) — folder and config jobs merge, duplicate ids error |
| `channel.stream-tuning` | Status text, edit debounce, max message chars, welcome/help/error texts per chat channel | `code` | Adapter `stream`/`messages` options via custom channel drivers (`createTelegramChannelDriver` etc.) |
| `channel.custom` | Bespoke transports | `code` | Implement `ChannelDriver`, pass via `startMonoAgentApp({ drivers })` |

## Observability & operator surfaces

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `observability.jsonl-artifacts` | Append-only run event JSONL + summaries (secrets redacted, strings truncated) | `config` | `artifacts.dir` (`MONO_AGENT_ARTIFACT_DIR`) |
| `observability.trace-registry` | Host publishes a heartbeat manifest so dashboards discover running agents | `config` | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs}` (`MONO_AGENT_TRACE_*`) |
| `operator-console.http` | Local browser console: settings editor (field groups, secret redaction), observability + traceability views, per-boot bearer token, live config re-apply | `config`+`cli` | `console.enabled`, `console.port` (`MONO_AGENT_CONSOLE_ENABLED`, `MONO_AGENT_CONSOLE_PORT`); CLI `--port` / `--no-console` override |
| `operator-console.live-apply` | Saving config in the console restarts channels without restarting the app | `auto` | Built into `mono-agent start` |
| `tui.chat` | Terminal chat + transcript + redacted config pane | `cli` | `mono-agent-tui --config ./mono-agent.config.json` (ships with `@mono-agent/tui`) |

## Execution & composition (`agent-harness`, `agent-host`, `agent-orchestrator`, `agent-app`)

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `app.cli-init` | Non-destructive scaffold (config + IDENTITY.md + `.mono-agent/`) | `cli` | `mono-agent init [--model] [--fallback-models] [--memory]` |
| `app.cli-validate` | Per-section config report (core, runtime, context, memory, tools, sandbox, console, every channel) | `cli` | `mono-agent validate [--config] [--env-file]` |
| `app.cli-start` | Console + traceability + every configured channel | `cli` | `mono-agent start [--config] [--port] [--no-console] [--env-file]` |
| `app.cli-install-skill` | Copy the composer skill into `~/.claude/skills` / `~/.codex/skills` | `cli` | `mono-agent install-skill [--target claude\|codex\|both] [--force]` |
| `app.env-file` | `.env` auto-load (exported shell vars win) | `cli` | automatic; `--env-file <path>` to override |
| `harness.failure-handling` | Explicit failure objects (never fake success) | `auto` | Built into every run |
| `harness.request-runtime-options` | Per-request runtime option extensions | `code` | `createConfiguredAgentResponder({ runtimeOptionsForRequest })` |
| `orchestrator.ask-collaborator` | Loopback MCP tool delegating to named collaborator responders (call caps, per-collaborator timeout) | `code` | `createCollaboratorToolRuntimeExtension` + `runtimeOptionsForRequest` (see multi-agent demo) |
| `evals.scenarios` | End-to-end eval scenarios/suites with trajectory + judge assertions, local artifacts | `dev` | `@mono-agent/agent-evals` (`defineAgentEvalScenario`, `runAgentEvalSuite`; live runs gated by `MONO_AGENT_EVAL_LIVE=1`) |

## Maintenance rules

- A new option in any package is **not done** until it has a row here, a
  `MonoAgentConfig`/channel-config surface (or an explicit `code`/`dev`
  justification), and coverage in the composer skill references.
- The composer skill files that must stay in sync:
  `packages/agent-app/skills/mono-agent-composer/SKILL.md`,
  `references/config-blueprint.md`, `references/discovery-questions.md`,
  `references/package-map.md`, `references/validation.md`.
