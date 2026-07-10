# Feature Coverage

Every framework capability and how a composed agent reaches it. This table is the **authoritative, exhaustive** answer to "can the config do X?" — answer from it, do not grep the `@mono-agent` package source to confirm. `config` = a `mono-agent.config.json` key (env var override always exists), `cli` = a `mono-agent` CLI flag/command, `auto` = always on when the app runs, `code` = programmatic escape hatch only, `dev` = development/test tooling. A capability that is absent here, or marked `code`, is not reachable through config — that is the answer, not a cue to read source. The repo's `docs/reference/feature-registry.md` (framework checkout only) and the documentation site at <https://mono-agent-docs.vercel.app/> are longer-form human-facing mirrors of this same table.

## Runtime

| Capability | Coverage | Where |
| --- | --- | --- |
| Model backends: claude (sdk/cli), codex (cli direct fallback), pi sdk providers (OpenAI, OpenAI-Codex preferred when Pi auth exists, Copilot, OpenRouter, OpenCode-through-Pi, Ollama, LM Studio, ...), plus hand-authored opencode runtime refs (cli, `opencode:<provider>:<model>` via the OpenCode server) | config | `runtime.model` |
| Backup models on retryable provider failure | config | `runtime.fallbackModels` |
| Execution mode (sdk/cli), effort, max turns, workspace | config + cli | `runtime.executionMode`, `runtime.effort` (`mono-agent init --effort <level>`; unsupported for direct OpenCode SDK 1.x), `runtime.maxTurns`, `runtime.workspace` |
| Tool-permission posture for CLI backends (direct OpenCode asks/rejects unanswered by default; configure explicitly) | config | `runtime.permissionMode` |
| Continuous provider sessions with idle eviction | config | `runtime.session.{mode,idleTimeoutMs}` |
| Local providers (Ollama / LM Studio / OpenAI-compatible) | config | `providers.local[]` |
| Pi OAuth credentials | config | `providers.piAuthPath` |
| Tool-output bloat guard, cost tracking | auto | built into every run |
| Context handling / auto-compaction | provider + auto | delegated to the provider; the pi bridge drives `AgentHarness.compact()` (proactive before a near-window turn + reactive recovery on overflow). Runs report `context_compaction_applied: true` / `false` / `null` |
| Structured output (JSON schema), live input steering | code | harness `runtimeOptions` |
| Tool approval gates (risk tiers, timeouts, always-allow) | code | `createMonoRuntime({ onToolApprovalRequest, ... })` — needs a host UI |
| Fully custom runtime | code | `startMonoAgentApp({ runtime })` |

## Context, skills, memory

| Capability | Coverage | Where |
| --- | --- | --- |
| Identity + optional soul documents | config | `context.identityPath`, `context.soulPath` |
| Selected skills from a skills root | config | `context.skillsRoot`, `context.selectedSkills` |
| Per-skill byte cap | config | `context.skillMaxBytes` |
| Conversation history (in-memory; unlimited unless turns are capped) | auto | sized from `runtime.maxTurns`; custom store via code |
| Lite memory (FTS keyword recall + rapid-log capture; no external deps) | config | `memory.mode: "lite"`, `path`, `maxBytes`, `writeMode` |
| Journal memory (hybrid recall BM25+vector + salience decay; needs configured embeddings) | config | `memory.mode: "journal"`, `path`, `memory.embeddings.{provider,model,dim}` (`provider: "ollama" | "openai"`) |
| BuJo memory (journal + LLM capture/reconcile ADD/UPDATE/SUPERSEDE/NOOP + entity graph + auto-scheduled consolidation; needs embeddings + an app-level `memory.llm`) | config | `memory.mode: "bujo"`, `path`, `memory.embeddings.{provider,model,dim}`, `memory.llm` with `provider: "ollama"` (`model`, optional `endpoint`) or `provider: "agent-host"` (`model` is an SDK runtime model ref, e.g. `pi:openai-codex:gpt-5.5`, optional `executionMode: "sdk"`) — see `docs/memory/index.md` |
| BuJo consolidation auto-scheduler (lightweight decay + duplicate superseding; in-app, no external cron needed) | config | `memory.consolidation.{enabled,cron}` (default `0 */2 * * *`); env `MONO_AGENT_MEMORY_CONSOLIDATION_CRON`, `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED` |
| Memory out-of-band maintenance CLI (rebuild/recall/index/legacy reflect/migrate) | cli | `memory-bujo <subcommand> <root>`; opt-in `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER`/`_MODEL`/`_DIM` for semantic recall; legacy reflect/migrate are Ollama-only and require `MONO_AGENT_MEMORY_LLM_MODEL` (optional `MONO_AGENT_MEMORY_LLM_ENDPOINT`) |
| Config-aware memory preview CLI (stats/today/show/search/top plus metadata-only audit; local search warns and falls back to FTS-only when embeddings are down) | cli | `mono-agent memory stats\|today\|show <date>\|search <query>\|top\|audit [--limit <n>] [--json]` |
| Memory liveness check (root writable; provider-specific Ollama checks only when embeddings/chat use Ollama; BuJo LLM config + consolidation cadence — loud warn, no silent fallback) | cli | `mono-agent validate` |
| Host summaries appended after runs | config | `memory.writeMode: "append-host-summary"` |
| Auto-provisioned read-only `MemoryRecall` tool exposed for every configured memory tier; no chat LLM | config | `config.memory.recallTool.enabled` (`MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`, default on; explicit false opts out) |

## Tools, MCP, sandbox

| Capability | Coverage | Where |
| --- | --- | --- |
| Allow-all tool policy (omitted / `["*"]` = all tools; `[]` = none) | config | default `tools.allowedTools`; the harness no-policy safety net is `failClosedToolPolicy()` |
| Tool allow/deny lists (deny wins, even under allow-all; pi doesn't deny external MCP tools) | config | `tools.allowedTools`, `tools.disallowedTools` |
| MCP servers (stdio/sse/http) from a JSON file | config | `tools.mcpConfigPath` |
| Adapter-derived send tools for enabled Slack/Telegram adapters | config | auto-available under allow-all once the channel is enabled; a **specific** `tools.allowedTools` must include `SlackSendMessage` / `TelegramSendMessage`; valid `slack.*` / `telegram.*` config and existing adapter allowlists provide credentials and destination bounds |
| Sandbox on/off + srt engine (Pi-owned tools; direct Codex has its own sandbox, Claude/direct OpenCode reject native mono policy) | config | `sandbox.mode` |
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
| External channel plugins | config | `channels.plugins[]: { package, id?, label?, config? }`; package must export `createChannelDriver(options)` or a default driver factory |
| WhatsApp (Baileys, QR login, group mention/any triggers) | config | `channels.plugins[].package: "@mono-agent/whatsapp-adapter"` plus plugin `config.{enabled,allowedChatJids,allowAllChats,groupMode,botJids,mentionTextAliases,stripMentionText}` |
| A2A provider (Agent Card, JSON-RPC + REST, streaming, bearer) | config | `channels.plugins[].package: "@mono-agent/a2a-adapter"` plus plugin `config.provider`, `config.agent`, `config.skill`; `config.enabled` is canonical |
| A2A consumer settings (remote agent URLs, timeouts) | config + code | same A2A plugin entry's `config.consumer`; calls via `createA2AConsumerResponder` |
| TUI stream endpoint (operator console transport) | config | `tui.{enabled,host,port,basePath,allowNonLoopback,apiKey}`; default on, loopback |
| Live event relay (read-only run-event SSE for web) | config | `live.{enabled,host,port,basePath,allowNonLoopback,apiKey}`; default on, loopback |
| Cron jobs (five-field expressions, timezones, overlap skip) | config | `cron.jobs[]`, single-job `MONO_AGENT_CRON_*`, or one markdown file per job in `cron.dir` / `MONO_AGENT_CRON_DIR` (default `cron/`) |
| Channel message texts / stream tuning (welcome, debounce, ...) | code | channel driver overrides |
| Custom transports | code | implement `ChannelDriver`, pass via `startMonoAgentApp({ drivers })` |

## Observability, operator surfaces, composition

| Capability | Coverage | Where |
| --- | --- | --- |
| JSONL run artifacts (events + summaries, secrets redacted) | config | `artifacts.dir`, `artifacts.retention`, `artifacts.memoryRetention` |
| Trace-source registry (heartbeat manifests `mono-agent status` reads) | config | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs,globalDiscovery}` |
| Phoenix trace viewer (OTLP exporter; local JSONL artifacts are the fallback) | config | `observability.exporters` (phoenix entry) |
| Operator console (live chat with thinking/tool/telemetry insight, run replay, config view) | cli | `mono-agent tui [--agent <label>]`; agents serve the `tui` stream endpoint by default (`tui.enabled`, loopback) |
| Session Recorder web PWA (read-only run browser) | cli | `mono-agent web [--host] [--port] [--no-open] [--allow-non-loopback] [--include-memory]`; consumes the default-on `live` relay and local artifacts; memory runs are opt-in |
| Setup presets (saved answer-sets: generate config + `.env.example` + checklist) | cli | `mono-agent presets list\|show <id>`, `mono-agent init --preset <id> --yes` (`recipes`/`--recipe` deprecated aliases) |
| Interactive setup wizard (preset/custom; walks model→channels→memory→tools→sandbox→observability) | cli | `mono-agent init` (no flags, on a TTY; `setup` alias) |
| Tools reporting + no-tools guardrail (allow-all → `All tools allowed`; explicit empty `allowedTools: []` → `waiting`; unknown-tool "did you mean"; send-tool/channel cross-checks) | cli | part of `mono-agent validate`/`doctor`; the wizard's tools step |
| Resolved config view (every field tagged env/json/default) | cli | `mono-agent config` |
| Scaffold / validate / start / install-skill | cli | `mono-agent init [--model <ref>] [--fallback-models <csv>] [--effort <level>] [--auth]\|validate [--consumer <path>]\|config\|presets\|start\|install-skill` |
| Preset capability check (selected preset live?) | cli | `mono-agent validate --preset <id>` |
| `.env` auto-loading | cli | automatic; `--env-file <path>` |
| Explicit failure objects (no fake success) | auto | harness |
| Per-request runtime options, custom memory/history stores | code | `createConfiguredAgentResponder` options |
| Multi-agent delegation (`AskCollaborator` loopback MCP tool) | code | `@mono-agent/agent-orchestrator` |
