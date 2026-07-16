# Feature Coverage

Every framework capability and how a composed agent reaches it. This table is the **authoritative, exhaustive** answer to "can the config do X?" — answer from it, do not grep the `@mono-agent` package source to confirm. `config` = declarable in `mono-agent.config.json`; config fields may be JSON-only. Environment-variable overrides are optional: only fields with a documented `MONO_AGENT_*` mapping accept one, so consult the generated config reference's `Env override` column (`--` means none, as for `channels.plugins`) instead of inferring one. `cli` = a `mono-agent` CLI flag/command, `auto` = always on when the app runs, `code` = programmatic escape hatch only, `dev` = development/test tooling. A capability that is absent here, or marked `code`, is not reachable through config — that is the answer, not a cue to read source. The final column maps config-bearing rows back to the repo's canonical registry; multiple ids in one row are an intentional aggregation. The repo's `docs/reference/feature-registry.md` (framework checkout only) and the documentation site at <https://mono-agent-docs.vercel.app/> are longer-form human-facing mirrors of this same table.

## Runtime

| Capability | Coverage | Where | Registry config ids |
| --- | --- | --- | --- |
| Model backends: claude (sdk/cli), codex (cli direct fallback), pi sdk providers (OpenAI, OpenAI-Codex preferred when Pi auth exists, Copilot, OpenRouter, OpenCode-through-Pi, Ollama, LM Studio, ...), plus hand-authored opencode runtime refs (cli, `opencode:<provider>:<model>` via the OpenCode server) | config | `runtime.model` | `runtime.multi-backend` |
| Backup models on retryable provider failure | config | New configs use `runtime.fallbacks[]` with optional per-route effort. Legacy `runtime.fallbackModels` / `MONO_AGENT_FALLBACK_MODELS` remain compatibility inputs with no removal deadline; do not emit them for new agents | `runtime.fallback-models` |
| Route-safety contract for primary and fallback models | config | `runtime.routeSafety`: `uniform` (default) or `per-route-native` | `runtime.route-safety` |
| Execution mode (sdk/cli), effort, max turns, workspace | config + cli | `runtime.executionMode`, `runtime.effort` (`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`; `mono-agent init --effort <level>`). Reasoning-capable `pi:*` maps `ultra` to LOW; Pi without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged. Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public contract ends at `max` (the SDK JavaScript itself forwards the value). The Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above `max` only prevents keyword downgrade. `runtime.maxTurns`, `runtime.workspace` | `runtime.execution-modes`, `runtime.effort`, `runtime.max-turns`, `runtime.workspace` |
| Tool-permission posture for CLI backends (direct OpenCode asks/rejects unanswered by default; configure explicitly) | config | `runtime.permissionMode` | `runtime.permission-mode` |
| Continuous provider sessions with idle eviction and optional daily rollover | config | `runtime.session.{mode,idleTimeoutMs,rollover,rolloverTimezone,rolloverNotice}` | `runtime.provider-sessions` |
| Per-channel run admission/execution bounds | config | `concurrency.maxConcurrentRuns`, `concurrency.maxPendingRuns` | `runtime.concurrency` |
| Local providers (Ollama / LM Studio / OpenAI-compatible) | config | `providers.local[]` | `runtime.local-providers` |
| Pi OAuth credentials | config | `providers.piAuthPath` | `runtime.pi-credentials` |
| Pi-native transport, retry, and durable provider-session tuning | config | `providers.piNative.{transport,piMaxRetries,maxRetryDelayMs,piSessionsRoot}` | `runtime.pi-native-tuning` |
| Tool-output bloat guard, cost tracking | auto | built into every run | — |
| Context handling / auto-compaction | provider + auto | delegated to the provider; the pi bridge drives `AgentHarness.compact()` (proactive before a near-window turn + reactive recovery on overflow). Runs report `context_compaction_applied: true` / `false` / `null` | — |
| Structured output (JSON schema), live input steering | code | harness `runtimeOptions` | — |
| Tool approval gates (risk tiers, timeouts, always-allow) | code | `createMonoRuntime({ onToolApprovalRequest, ... })` — needs a host UI | — |
| Fully custom runtime | code | `startMonoAgentApp({ runtime })` | — |

## Context, skills, memory

| Capability | Coverage | Where | Registry config ids |
| --- | --- | --- | --- |
| Public name plus identity and optional soul documents; wizard Role has one explicit destination and created/preserved outcome | config + cli | `agent.name`, `context.identityPath`, `context.soulPath`; guided Role is `IDENTITY.md` → `## Role`, and an existing identity is never overwritten | `agent.public-name`, `context.identity`, `context.soul` |
| Selected skills from a skills root | config | `context.skillsRoot`, `context.selectedSkills` | `skills.selected-activation` |
| Generated project configuration skills with progressive disclosure | config + cli | init selects `mono-agent-configure` + `mono-agent-memory` under `./skills` with `context.skillDisclosure: "index"`; drift: `mono-agent install-skill --project --check\|--update` | `app.managed-project-skills` |
| Per-skill byte cap | config | `context.skillMaxBytes` | `skills.byte-capping` |
| Conversation history (owner-only durable store) | auto | 64 messages per exact conversation id independent of `runtime.maxTurns`; aggregate defaults 256 MiB / 10,000 conversations / 365 inactive days; staged atomic publication and post-commit pruning; custom store via code | — |
| Lite memory (FTS keyword recall + rapid-log capture; no external deps) | config | `memory.mode: "lite"`, `path`, `maxBytes`, `writeMode` | `memory.lite` |
| Semantic embedding provider selection for Journal/BuJo | config + cli | `memory.embeddings.{provider,endpoint,model,dim,apiKeyEnv}`; guided init supports exclusive Ollama or LM Studio discovery and proof | `memory.embeddings-config` |
| Journal memory (hybrid recall BM25+vector + static canonical salience; needs configured embeddings) | config | `memory.mode: "journal"`, `path`, `memory.embeddings.{provider,endpoint,model,dim,apiKeyEnv}` (`provider: "ollama" \| "lmstudio" \| "openai"`; exclusive, no cross-provider fallback) | `memory.journal` |
| BuJo memory (journal + LLM capture/reconcile ADD/UPDATE/SUPERSEDE/NOOP + entity graph + auto-scheduled consolidation; needs embeddings + an app-level `memory.llm`) | config | `memory.mode: "bujo"`, `path`; selected Ollama/LM Studio/OpenAI embeddings are independent from explicit `memory.llm` with `provider: "ollama"` (`model`, optional `endpoint`) or `provider: "agent-host"` (`model` is an SDK runtime model ref, optional `executionMode: "sdk"`) — see `docs/memory/index.md` | `memory.bujo` |
| Supermemory external backend (server-side extraction/consolidation; async ingestion; explicitly installed plugin) | config | `memory.backend: "supermemory"`, `memory.writeMode`, `memory.supermemory.{baseUrl,apiKey,apiKeyEnv,container,timeoutMs,exposeMcpServer}`; install the exact matching `@mono-agent/memory-supermemory` version | `memory.backend-supermemory` |
| BuJo consolidation auto-scheduler (projection-only `index.md` refresh + empty `future-log.md` stub + duplicate-group reporting; in-app, no external cron needed) | config | `memory.consolidation.{enabled,cron}` (five-field UTC, default `0 */2 * * *`, no hashed `H`); env `MONO_AGENT_MEMORY_CONSOLIDATION_CRON`, `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED` | `memory.bujo-consolidation` |
| Memory out-of-band maintenance CLI (rebuild/recall/index/legacy reflect/migrate) | cli | `memory-bujo <subcommand> <root>`; opt-in `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` (`ollama`/`lmstudio`/`openai`), `_MODEL`, and `_DIM` for semantic recall; advanced `migrate` remains Ollama-only, outside guided init, and requires `MONO_AGENT_MEMORY_LLM_MODEL` (optional `_ENDPOINT`) | — |
| Config-aware memory preview CLI (stats/today/show/search/top plus metadata-only audit; remains available when the live recall tool is disabled; local search warns and falls back to FTS-only when embeddings are down) | cli | `mono-agent memory stats\|today\|show <date>\|search <query>\|top\|audit [--limit <n>] [--json]` | — |
| Memory liveness check (managed tier/provider/model/dimension identity; provider-native typed discovery plus real finite-vector/dimension probe for Ollama or LM Studio; declared auth env; BuJo LLM config + consolidation cadence; no cross-provider fallback) | cli | `mono-agent validate` | — |
| Memory write modes and per-turn BuJo capture | config | `memory.writeMode`: `disabled`, `append-host-summary`, or `capture`; capture requires `memory.mode: "bujo"` | `memory.write-mode`, `memory.per-turn-capture` |
| Auto-provisioned read-only `MemoryRecall` tool exposed for every configured memory tier; no chat LLM | config | `config.memory.recallTool.enabled` (`MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`, default on; explicit false opts out) | `memory.recall-tool` |
| In-app memory LLM call timeout | config | `memory.llm.timeoutMs` (`MONO_AGENT_MEMORY_LLM_TIMEOUT_MS`, default 60000) | `memory.llm-timeout` |

## Tools, MCP, sandbox

| Capability | Coverage | Where | Registry config ids |
| --- | --- | --- | --- |
| Allow-all tool policy (omitted / `["*"]` = all tools; `[]` = none) | config | default `tools.allowedTools`; the harness no-policy safety net is `failClosedToolPolicy()` | `tool-policy.allow-all` |
| Built-in tool allow/deny lists (deny wins, even under allow-all; pi doesn't deny external MCP tools) | config | `tools.allowedTools`, `tools.disallowedTools`; built-ins are Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch | `tool-policy.allowlist`, `tool-policy.denylist`, `runtime.builtin-tools` |
| MCP servers (stdio/sse/http) from a JSON file | config | `tools.mcpConfigPath` | `tool-policy.mcp-servers` |
| Durable origin-bound continuations for trusted stdio/loopback-HTTP MCP services | config + auto | `tools.continuationServers` + `continuations.*`; interactive claims pin a bounded immutable origin snapshot before commit, exact rollover buckets are preserved, v3 state is restart-safe, and unavailable/legacy snapshots use a fixed zero-model fallback | `agent-app.durable-continuations` |
| Adapter-derived send tools for enabled Slack/Telegram adapters | config | auto-available under allow-all once the channel is enabled; a **specific** `tools.allowedTools` must include `SlackSendMessage` / `TelegramSendMessage`; valid `slack.*` / `telegram.*` config and existing adapter allowlists provide credentials and destination bounds | `agent-app.adapter-send-tools` |
| Human-in-the-loop interaction bridge for blocking asks and MCP progress | config + auto | `interaction.bridge.{host,port}`, `interaction.askUser.timeoutMs`, `interaction.progress.enabled`; env `MONO_AGENT_INTERACTION_BRIDGE_HOST`, `MONO_AGENT_INTERACTION_BRIDGE_PORT`, `MONO_AGENT_ASK_USER_TIMEOUT_MS`, `MONO_AGENT_PROGRESS_ENABLED`. It auto-starts when `AskUser` or `TelegramAskButtons` is allowed, when an `interaction` block or interaction env override is configured, or when `interaction.progress.enabled` resolves true and `tools.mcpRequestContextServers` names at least one opted project stdio MCP server. | `interaction.bridge` |
| Sandbox on/off + srt engine (Pi-owned tools; direct Codex has its own sandbox, Claude/direct OpenCode reject native mono policy) | config | `sandbox.mode` | `sandbox.mode` |
| Network policy (none/localhost/allowlist/all) | config | `sandbox.network.{mode,allowlist}` | `sandbox.network-policy` |
| Filesystem scopes (readable/writable roots, deny-write globs) | config | `sandbox.readableRoots`, `sandbox.writableRoots`, `sandbox.denyWrite` | `sandbox.filesystem-scopes` |
| Fallback behavior when srt is unavailable | config | `sandbox.fallback`, `sandbox.unsafeAllowHostProcess` | `sandbox.fallback` |
| Request-scoped policies only tighten, never widen | auto | harness merge | — |

## Channels

| Capability | Coverage | Where | Registry config ids |
| --- | --- | --- | --- |
| Webhook (sync/async HTTP invoke + status polling + optional bearer) | config | `webhook` section; `apiKey` protects invoke/status and is required with non-loopback opt-in; endpoint overrides at `webhook.endpoints[].{model,effort,maxRunMs}`; endpoint `maxRunMs` wins over the `webhook.maxRunMs` fallback and `0` disables that endpoint watchdog | `webhook.http-invoke`, `webhook.run-watchdog` |
| OpenAI-compatible API (/v1/models, /v1/chat/completions, SSE, bearer) | config | `openaiApi` section; sampling fields remain request metadata, while non-default values are ignored with a `runtime_warning` and runtime config stays authoritative | `openai-api.chat-completions` |
| Telegram long polling and chat allowlist | config | `telegram` section | `telegram.long-polling` |
| Telegram command/reaction/button/file interactivity | config | `telegram.commands[]`, `telegram.reactions`, `telegram.quietHours`; `TelegramAskButtons` / `TelegramSendFile` through `tools.allowedTools` | `telegram.interactive` |
| Telegram inbound audio transcription | config | `telegram.transcription.{endpoint,model,language,timeoutMs}`; opt-in OpenAI-compatible transcription endpoint for voice notes, audio files, and round-video attachments | `telegram.transcription` |
| Slack (Socket Mode, channel allowlist, mention handling) | config | `slack` section | `slack.socket-mode` |
| Slack global/message shortcuts | config | `slack.shortcuts[]: {callbackId, prompt, channelId?, ackText?, threadReply?}`; JSON-only | `slack.shortcuts` |
| Slack App Home actions | config | `slack.homeTab: {enabled?, headerText?, buttons?:[{actionId, label, prompt, channelId?, ackText?, threadReply?}]}`; `enabled` defaults to `false`, `buttons` defaults to `[]`; JSON-only | `slack.app-home` |
| External channel plugins | config | `channels.plugins[]: { package, id?, label?, config? }`; package must export `createChannelDriver(options)` or a default driver factory | `channel.plugins` |
| WhatsApp (Baileys, QR login, group mention/any triggers) | config | `channels.plugins[].package: "@mono-agent/whatsapp-adapter"` plus plugin `config.{enabled,allowedChatJids,allowAllChats,groupMode,botJids,mentionTextAliases,stripMentionText}` | `whatsapp.baileys` |
| A2A provider (Agent Card, JSON-RPC + REST, streaming, bearer, opt-in durable dispatch identity) | config | `channels.plugins[].package: "@mono-agent/a2a-adapter"` plus plugin `config.provider` (including `idempotency.{namespace,stateDir,retentionMs,maxRecords}`), `config.agent`, `config.skill`; `config.enabled` is canonical | `a2a.provider` |
| A2A consumer settings (remote agent URLs, timeouts) and calls | config + code | same A2A plugin entry's `config.consumer`; calls via `sendA2AMessage({ idempotencyKey })` or `createA2AConsumerResponder({ idempotencyKeyForRequest })` | `a2a.consumer` |
| TUI stream endpoint (operator console transport) | config | `tui.{enabled,host,port,basePath,allowNonLoopback,apiKey}`; default on, loopback | `tui.stream-endpoint` |
| Live event relay (read-only run-event SSE for web) | config | `live.{enabled,host,port,basePath,allowNonLoopback,apiKey}`; default on, loopback | `live.event-relay` |
| Cron jobs (five-field expressions, timezones, stable job-id-seeded `H`; agent-app pins overlap to skip) | config + code | `cron.jobs[]`, including per-job `model` / `effort`; single-job `MONO_AGENT_CRON_*`, or one markdown file per job in `cron.dir` / `MONO_AGENT_CRON_DIR` (default `cron/`); queue/replace controls are programmatic-only `startCronAdapter` options | `cron.scheduled-prompts` |
| Cron per-run watchdog | config + code | `cron.jobs[].maxRunMs` or `maxRunMs` frontmatter; programmatic adapter fallback via `startCronAdapter({ maxRunMs })` | `cron.run-watchdog` |
| Per-trigger runtime model and effort overrides | config + code | `cron.jobs[].{model,effort}`; `webhook.endpoints[].{model,effort}` plus request body `{model,effort}` (request wins) | `runtime.per-trigger-model` |
| Native final-answer notification for cron/webhook | config | Per job/endpoint `notify`; explicit `notifyConversationId` wins, otherwise inference occurs only with exactly one notify-capable Telegram/Slack candidate. With 0 or 2+ candidates delivery is skipped with a warning. Cron model-exhaustion notices require an explicit `notifyConversationId` and never infer; `notifyFailureCooldownHours` rate-limits them. | `channel.native-notify` |
| Channel message texts / stream tuning (welcome, debounce, ...) | code | channel driver overrides | — |
| Custom transports | config + code | implement `ChannelDriver` and expose it through `channels.plugins[]`, or pass it via `startMonoAgentApp({ drivers })` | `channel.custom` |

## Observability, operator surfaces, composition

| Capability | Coverage | Where | Registry config ids |
| --- | --- | --- | --- |
| JSONL run artifacts (events + summaries; strings capped; non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; free text is not content-scanned) | config | `artifacts.dir`, `artifacts.retention`, `artifacts.memoryRetention` | `observability.jsonl-artifacts` |
| Trace-source registry (heartbeat manifests `mono-agent status` reads) | config | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs,globalDiscovery}` | `observability.trace-registry` |
| Phoenix trace viewer (best-effort terminal-batched OTLP exporter; independent local JSONL has bounded terminal snapshots and can lose RAM-buffered events on crash) | config | `observability.exporters` (phoenix entry) | `observability.phoenix-exporter` |
| Operator console (live chat with thinking/tool/telemetry insight, run replay, config view) | cli | `mono-agent tui [--agent <label>]`; agents serve the `tui` stream endpoint by default (`tui.enabled`, loopback) | — |
| Managed proposal-only configuration conversation | cli + tool | macOS `mono-agent tui --configure` attaches to the authoritative background agent; `/configure`; separate configuration/ordinary conversation ids; host-gated `ProposeAgentConfiguration`; approval restarts and waits for readiness, failed start rolls files/agent back. `--local` is ordinary chat only; off macOS configuration is manual | — |
| Session Recorder web PWA (read-only run browser) | cli | `mono-agent web [--host <addr>] [--port <n>] [--no-open] [--allow-non-loopback] [--show-auth-url] [--include-memory] [--max-runs <n>] [--config <path>] [--env-file <path>]`; package `@mono-agent/session-web`; non-loopback/non-interactive auth uses `MONO_AGENT_WEB_AUTH_TOKEN` | — |
| Setup presets (saved answer-sets: generate config + `.env.example` + checklist) | cli | `mono-agent presets list\|show <id>`, `mono-agent init --preset <id> --yes` (`recipes`/`--recipe` deprecated aliases removed in v2.0.0) | — |
| Interactive setup wizard (preset/custom; exact `IDENTITY.md` → `## Role` prompt/outcome; walks model→channels→memory→tools→sandbox→observability; Journal/BuJo explicitly choose Ollama or LM Studio service root/model/dimension/optional auth env using typed discovery and a real probe; macOS starts the background agent before temporary configuration) | cli | `mono-agent init` (no flags, on a TTY; `setup` alias); manual embedding entry still requires readiness probe; flags/non-TTY stay scaffold-only; unsupported platforms use manual configuration/foreground start/ordinary TUI | — |
| Tools reporting + no-tools guardrail (allow-all → `All tools allowed`; explicit empty `allowedTools: []` → `waiting`; unknown-tool "did you mean"; send-tool/channel cross-checks) | cli | part of `mono-agent validate`/`doctor`; the wizard's tools step | — |
| Resolved config view (every field tagged env/json/default) | cli | `mono-agent config` | — |
| Scaffold / validate / start / install-skill | cli | `mono-agent init [--model <ref>] [--fallback <ref> [--fallback-effort <provider-default\|level>]]... [--effort <level>] [--auth]\|validate [--consumer <path>]\|config\|presets\|start\|install-skill`; legacy CLI `--fallback-models <csv>` is removed in v2.0.0 | — |
| Preset capability check (selected preset live?) | cli | `mono-agent validate --preset <id>` | — |
| `.env` auto-loading | cli | automatic; `--env-file <path>` | — |
| Explicit failure objects (no fake success) | auto | harness | — |
| Per-request runtime options, custom memory/history stores | code | `createConfiguredAgentResponder` options | — |
| Multi-agent delegation (`AskCollaborator` loopback MCP tool) | code | `@mono-agent/agent-orchestrator` | — |
