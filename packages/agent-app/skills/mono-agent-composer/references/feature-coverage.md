# Feature Coverage

Every framework capability and how a composed agent reaches it. Use this to answer "can the config do X?" without guessing: `config` = a `mono-agent.config.json` key (env var override always exists), `cli` = a `mono-agent` CLI flag/command, `auto` = always on when the app runs, `code` = programmatic escape hatch only, `dev` = development/test tooling. The repo's `docs/feature-registry.md` is the long-form source of truth.

## Runtime

| Capability | Coverage | Where |
| --- | --- | --- |
| Model backends: claude (sdk/cli), codex (cli), pi sdk providers (OpenAI, Copilot, OpenRouter, Ollama, ...) | config | `runtime.model` |
| Backup models on retryable provider failure | config | `runtime.fallbackModels` |
| Execution mode (sdk/cli), effort, max turns, workspace | config | `runtime.executionMode`, `runtime.effort`, `runtime.maxTurns`, `runtime.workspace` |
| Tool-permission posture for CLI backends | config | `runtime.permissionMode` |
| Reasoning summary verbosity | config | `runtime.reasoningSummary` |
| Continuous provider sessions with idle eviction | config | `runtime.session.{mode,idleTimeoutMs}` |
| Local providers (Ollama / LM Studio / OpenAI-compatible) | config | `providers.local[]` |
| Pi OAuth credentials | config | `providers.piAuthPath` |
| Tool-output bloat guard, cost tracking | auto | built into every run |
| Context handling | provider | delegated to the provider; the pi bridge (pi-agent-core AgentHarness) runs no automatic in-loop summarization, so runs report `context_compaction_applied: null` |
| Structured output (JSON schema), live input steering | code | harness `runtimeOptions` |
| Tool approval gates (risk tiers, timeouts, always-allow) | code | `createMonoRuntime({ onToolApprovalRequest, ... })` — needs a host UI |
| Fully custom runtime | code | `startMonoAgentApp({ runtime })` |

## Context, skills, memory

| Capability | Coverage | Where |
| --- | --- | --- |
| Identity + optional soul documents | config | `context.identityPath`, `context.soulPath` |
| Selected skills from a skills root | config | `context.skillsRoot`, `context.selectedSkills` |
| Per-skill byte cap | config | `context.skillMaxBytes` |
| Guarded self-authoring of local skills and cron jobs | config | `selfCapabilities.{enabled,mode,skillsRoot,cronDir,auditDir}`; default off, `mode: "propose"` persists proposals under `.mono-agent/self-capabilities/proposals/`; create tools require a saved `proposalId` plus a proposal-scoped approval token derived from `MONO_AGENT_SELF_CAPABILITIES_CONFIRMATION_TOKEN` |
| Conversation history (in-memory; unlimited unless turns are capped) | auto | sized from `runtime.maxTurns`; custom store via code |
| Lite memory (FTS keyword recall + rapid-log capture; no external deps) | config | `memory.mode: "lite"`, `path`, `maxBytes`, `writeMode` |
| Journal memory (hybrid recall BM25+vector + salience decay; needs configured embeddings) | config | `memory.mode: "journal"`, `path`, `memory.embeddings.{provider,model,dim}` (`provider: "ollama" | "openai"`) |
| BuJo memory (journal + LLM capture/reconcile ADD/UPDATE/SUPERSEDE/NOOP + entity graph + auto-scheduled reflection/migration; needs embeddings + an app-level `memory.llm`) | config | `memory.mode: "bujo"`, `path`, `memory.embeddings.{provider,model,dim}`, `memory.llm` with `provider: "ollama"` (`model`, optional `endpoint`) or `provider: "agent-host"` (`model` is an SDK runtime model ref, e.g. `pi:openai-codex:gpt-5.5`, optional `executionMode: "sdk"`) — see `docs/memory.md` |
| BuJo reflection auto-scheduler (nightly decay + insight synthesis; in-app, no external cron needed) | config | `memory.reflection.{enabled,cron}` (default `0 3 * * *`); env `MONO_AGENT_MEMORY_REFLECTION_CRON`, `MONO_AGENT_MEMORY_REFLECTION_ENABLED` |
| BuJo migration auto-scheduler (monthly promote/reschedule/cluster/forget; in-app) | config | `memory.migration.{enabled,cron}` (default `0 4 1 * *`); env `MONO_AGENT_MEMORY_MIGRATION_CRON`, `MONO_AGENT_MEMORY_MIGRATION_ENABLED` |
| Memory out-of-band maintenance CLI (rebuild/recall/index/reflect/migrate) | cli | `memory-bujo <subcommand> <root>`; opt-in `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER`/`_MODEL`/`_DIM` for semantic recall; reflect/migrate are Ollama-only and require `MONO_AGENT_MEMORY_LLM_MODEL` (optional `MONO_AGENT_MEMORY_LLM_ENDPOINT`) |
| Memory liveness check (root writable; provider-specific Ollama checks only when embeddings/chat use Ollama; BuJo LLM config + ritual cadence — loud warn, no silent fallback) | cli | `mono-agent validate` |
| Host summaries appended after runs | config | `memory.writeMode: "append-host-summary"` |
| Auto-provisioned read-only `memory_recall` tool (hybrid keyword+semantic search) exposed to the agent from the single memory config; no chat LLM | config | `config.memory.recallTool.enabled` (`MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`, default on for journal/bujo with embeddings) |

## Tools, MCP, sandbox

| Capability | Coverage | Where |
| --- | --- | --- |
| Fail-closed tool policy (empty allowlist = no tools) | auto | default |
| Tool allow/deny lists (deny wins) | config | `tools.allowedTools`, `tools.disallowedTools` |
| MCP servers (stdio/sse/http) from a JSON file | config | `tools.mcpConfigPath` |
| Sandbox on/off + srt engine | config | `sandbox.mode` |
| Network policy (none/localhost/allowlist/all) | config | `sandbox.network.{mode,allowlist}` |
| Filesystem scopes (readable/writable roots, deny-write globs) | config | `sandbox.readableRoots`, `sandbox.writableRoots`, `sandbox.denyWrite` |
| Fallback behavior when srt is unavailable | config | `sandbox.fallback`, `sandbox.unsafeAllowHostProcess` |
| Request-scoped policies only tighten, never widen | auto | harness merge |

## Channels

| Capability | Coverage | Where |
| --- | --- | --- |
| Webhook (sync/async HTTP invoke + status polling) | config | `webhook` section |
| OpenAI-compatible API (/v1/models, /v1/chat/completions, SSE, bearer) | config | `openaiApi` section |
| Telegram (long polling, chat allowlist) | config | `telegram` section |
| Slack (Socket Mode, channel allowlist, mention handling) | config | `slack` section |
| WhatsApp (Baileys, QR login, group mention/any triggers) | config | `whatsapp` section |
| A2A provider (Agent Card, JSON-RPC + REST, streaming, bearer) | config | `a2a.provider` + `a2a.agent` + `a2a.skill` |
| A2A consumer settings (remote agent URLs, timeouts) | config + code | `a2a.consumer` holds settings; calls via `createA2AConsumerResponder` |
| Cron jobs (five-field expressions, timezones, overlap skip) | config | `cron.jobs[]`, single-job `MONO_AGENT_CRON_*`, or one markdown file per job in `cron.dir` / `MONO_AGENT_CRON_DIR` (default `cron/`) |
| Channel message texts / stream tuning (welcome, debounce, ...) | code | channel driver overrides |
| Custom transports | code | implement `ChannelDriver`, pass via `startMonoAgentApp({ drivers })` |

## Observability, operator surfaces, composition

| Capability | Coverage | Where |
| --- | --- | --- |
| JSONL run artifacts (events + summaries, secrets redacted) | config | `artifacts.dir` |
| Trace-source registry (heartbeat manifests for dashboards) | config | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs}` |
| Operator console (browser settings editor, traceability views, live config re-apply, bearer token) | config + cli | `console.{enabled,port}`; `--port`, `--no-console` |
| Terminal chat (TUI with transcript + redacted config pane) | cli | `mono-agent-tui --config ./mono-agent.config.json` |
| Scaffold / validate / start / install-skill | cli | `mono-agent init|validate|start|install-skill` |
| `.env` auto-loading | cli | automatic; `--env-file <path>` |
| Explicit failure objects (no fake success) | auto | harness |
| Per-request runtime options, custom memory/history stores | code | `createConfiguredAgentResponder` options |
| Multi-agent delegation (`ask_collaborator` loopback MCP tool) | code | `@mono-agent/agent-orchestrator` |
| Eval scenarios/suites (trajectory + judge assertions) | dev | `@mono-agent/agent-evals`, live runs via `MONO_AGENT_EVAL_LIVE=1` |
