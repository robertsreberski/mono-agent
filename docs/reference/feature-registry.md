---
title: "Feature registry (source of truth)"
sidebar:
  order: 3
---

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
| `runtime.max-turns` | Optional turn cap per run; omitted or `0` means unlimited | `config` | `runtime.maxTurns` (`MONO_AGENT_MAX_TURNS`) |
| `runtime.workspace` | Working directory for runtime tools | `config` | `runtime.workspace` (`MONO_AGENT_WORKSPACE`) |
| `runtime.provider-sessions` | Continuous provider session per conversation with idle eviction | `config` | `runtime.session.mode` + `runtime.session.idleTimeoutMs` (`MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS`) |
| `runtime.concurrency` | Admission/execution bounds for in-flight runs. **Per-channel, not a single global cap:** the app builds one harness per channel and each holds its own limiter, so these values bound *each* channel independently. With N enabled channels the effective ceiling is **N× the configured value** (e.g. `maxConcurrentRuns: 4` across 3 channels allows up to 12 simultaneous provider runs). `maxConcurrentRuns` caps how many runs execute against the provider at once; `maxPendingRuns` caps how many runs may be admitted before the expensive provider step. Queued follow-ups on a warm session hold no slot. **Scope note:** these bounds cover the harness run path (which begins at `responder.respond`). Channel adapters (Slack/Telegram) do per-conversation admission + attachment downloads *before* that boundary, so cross-conversation transport download IO is **not** covered by these bounds (per-file byte caps + timeouts apply instead); adapter queues are drained/aborted on `/cancel` and stop | `config` | `concurrency.maxConcurrentRuns` (`MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`), `concurrency.maxPendingRuns` (`MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS`) |
| `runtime.local-providers` | Ollama / LM Studio / OpenAI-compatible local model providers | `config` | `providers.local[]` (`MONO_AGENT_LOCAL_PROVIDERS_JSON` or `MONO_AGENT_LOCAL_PROVIDER_*`): id, type, baseUrl, apiKey/apiKeyEnv, models with capabilities/pricing |
| `runtime.pi-oauth` | Pi OAuth credential resolution (openai-codex etc.) | `config` | `providers.piAuthPath` (`MONO_AGENT_PI_AUTH_PATH`), default `~/.pi/agent/auth.json` |
| `runtime.pi-native-tuning` | Pi-native transport retries + durable session storage. `piSessionsRoot` persists provider sessions to JSONL so resume recovers from disk instead of re-sending full history | `config` | `providers.piNative.piMaxRetries` (`MONO_AGENT_PI_MAX_RETRIES`, 0-8, default 2), `providers.piNative.maxRetryDelayMs` (`MONO_AGENT_MAX_RETRY_DELAY_MS`, default 60000), `providers.piNative.piSessionsRoot` (`MONO_AGENT_PI_SESSIONS_ROOT`, e.g. `.mono-agent/sessions`; unset = in-memory) |
| `runtime.tool-parallelism` | Opt-in concurrent execution of a model step's tool calls (pi-agent-core QueueMode). Default serial; enable only when a step's tools are independent | `code` | `runtimeOptions.piToolParallelismMode: "one-at-a-time" \| "all"` (default `one-at-a-time`) |
| `runtime.webfetch-retry` | WebFetch retries transient network errors (timeout/ECONNRESET/5xx) in-tool with backoff so the model does not burn reasoning rounds re-fetching | `auto` | Built into the WebFetch tool |
| `runtime.context-compaction` | The pi bridge drives compaction via `AgentHarness.compact()`: proactive before a turn when the running model is near its window, plus reactive recovery (compact + single re-prompt) if a turn still overflows. The window auto-tracks the model serving the request and self-corrects from a real ceiling stated in an overflow error. Runs report `context_compaction_applied: true`/`false`/`null` (fired / enabled-but-not-needed / disabled) | `provider` + `settings` | Pi-native: bridge-driven auto-compaction (tune via `agent_compaction_*` settings); other bridges per their own behavior |
| `runtime.tool-bloat-guard` | 256KB tool-output truncation with artifact persistence | `auto` | Built in; artifacts land in `artifacts.dir` |
| `runtime.cost-tracking` | Per-run usage/cost/cache metrics + events | `auto` | Recorded in JSONL artifacts |
| `runtime.builtin-tools` | Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch | `config` | Gated by `tools.allowedTools` / `tools.disallowedTools` |
| `runtime.structured-output` | JSON-schema-enforced output on capable backends | `code` | `runtimeOptions.outputSchema` via harness options |
| `runtime.live-input` | In-flight user message steering | `code` | `runtimeOptions.liveInput` queue |
| `runtime.approval-gates` | Human-in-the-loop tool approval (risk tiers, timeout, always-allow) | `code` | `createMonoRuntime({ onToolApprovalRequest, toolRiskTiers, approvalDefaultRiskTier, approvalTimeoutMs, approvalAlwaysAllowTools })` — needs a host UI to answer; config posture is `runtime.permissionMode` |
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
| `memory.lite` | FTS keyword recall + rapid-log daily capture. No external deps (SQLite bundled). No Ollama required | `config` | `memory.mode: "lite"`, `memory.path`, `memory.maxBytes`, `memory.writeMode` |
| `memory.journal` | Hybrid recall (BM25+vector RRF) + salience decay on top of the lite tier. Needs a configured embeddings provider (`ollama` or `openai`). No LLM required | `config` | `memory.mode: "journal"`, `memory.path`, `memory.maxBytes`, `memory.embeddings.{provider,model,dim}` (`MONO_AGENT_MEMORY_EMBEDDINGS_*`) |
| `memory.bujo` | Full BuJo tier: everything in journal + LLM capture/reconcile (ADD/UPDATE/SUPERSEDE/NOOP), entity graph, reflection (decay + insight synthesis), monthly migration (promote/reschedule/cluster/forget), living `index.md` + `future-log.md`. Needs embeddings + a chat model. Rituals are **auto-scheduled in-app** (no external cron needed) | `config` | `memory.mode: "bujo"`, `memory.path`, `memory.embeddings.{provider,model,dim}`, `memory.llm.{provider,model,executionMode,endpoint}` — see `docs/memory/index.md` |
| `memory.bujo-reflection` | Auto-scheduled nightly reflection pass (decay + insight synthesis). In-app scheduler; no external cron needed. Override cadence or disable per-ritual | `config` | `memory.reflection.{enabled,cron}` (default `0 3 * * *`); env `MONO_AGENT_MEMORY_REFLECTION_CRON`, `MONO_AGENT_MEMORY_REFLECTION_ENABLED` |
| `memory.bujo-migration` | Auto-scheduled monthly migration pass (promote/reschedule/cluster/forget). In-app scheduler; no external cron needed | `config` | `memory.migration.{enabled,cron}` (default `0 4 1 * *`); env `MONO_AGENT_MEMORY_MIGRATION_CRON`, `MONO_AGENT_MEMORY_MIGRATION_ENABLED` |
| `memory.bujo-cli` | CLI for out-of-band / manual maintenance: rebuild SQLite index from markdown, hybrid recall, write living `index.md`, reflection pass, monthly migration | `cli` | `memory-bujo rebuild\|recall\|index\|reflect\|migrate <root>` (opt-in `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER`/`_MODEL`/`_DIM` enable semantic recall; `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_ENDPOINT` required for reflect/migrate) |
| `memory.validate` | `mono-agent validate` memory liveness check: root writable (all tiers); Ollama reachability/model checks only for components using Ollama; chat model pulled + ritual cadence reported for Ollama BuJo LLMs, agent-host BuJo LLMs are not checked against Ollama. Loud WARN on failure, never silent fallback | `cli` | `mono-agent validate [--config]` |
| `memory.write-mode` | How the host persists each completed turn: `disabled` (never), `append-host-summary` (deterministic single-line rapid-log, all tiers), or `capture` (bujo-only superset — see `memory.per-turn-capture`) | `config` | `memory.writeMode` (`MONO_AGENT_MEMORY_WRITE_MODE`) |
| `memory.per-turn-capture` | bujo-tier per-turn intelligent capture: each turn writes the sync rapid-log then enqueues an **async, serialized** distil→reconcile→entity capture; non-blocking (reply latency unchanged), drained on graceful shutdown. Validated to require `mode: "bujo"` | `config` | `memory.writeMode: "capture"` (`MONO_AGENT_MEMORY_WRITE_MODE=capture`; requires `MONO_AGENT_MEMORY_MODE=bujo`) |
| `memory.recall-tool` | Auto-provisioned read-only `memory_recall` tool (hybrid keyword+semantic search) exposed to the agent from the single memory config; no chat LLM. `agent-app` spawns it as a bundled `mono-agent-memory` stdio child using the same memory root + embeddings as the in-app memory. Beyond this on-demand tool, the harness appends recalled entries to the **user message** each turn (not the system prompt) so they survive session resume; a `memory_recalled` diagnostic keeps recall visible in traces. Its description directs proactive recall on missing/uncertain context | `config` | `config.memory.recallTool.enabled` (`MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`, default on for journal/bujo with embeddings) |
| `memory.llm-timeout` | Per-call timeout for the **in-app** memory LLM (per-turn capture + in-app rituals), distinct from the standalone CLI's timeout. A timeout now reports `agent-host memory LLM timed out after <ms>ms (provider too slow or unavailable)` instead of a generic `cancelled` | `config` | `memory.llm.timeoutMs` (`MONO_AGENT_MEMORY_LLM_TIMEOUT_MS`, 1000–600000, **default 60000**; the `memory-bujo` CLI reads the same var but defaults to 120000) |
| `memory.custom-store` | Any `MemoryStore` implementation | `code` | `createConfiguredAgentResponder({ memory })` |

## Tools & MCP (`@mono-agent/tool-policy`)

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `tool-policy.fail-closed` | Empty allowlist = no tools | `auto` | Default when `tools` lists are empty |
| `tool-policy.allowlist` / `tool-policy.denylist` | Tool allow/deny (deny wins; overlap rejected) | `config` | `tools.allowedTools`, `tools.disallowedTools` (`MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS`) |
| `tool-policy.mcp-servers` | MCP servers (stdio/sse/http) from a JSON file; inlined for SDK runtimes, path forwarded for CLI runtimes | `config` | `tools.mcpConfigPath` (`MONO_AGENT_MCP_CONFIG_PATH`) → `mcp.json` |
| `agent-app.adapter-send-tools` | App-owned MCP tools for sending through already-enabled Slack and Telegram adapters: `slack_send_message`, `telegram_send_message` | `config` | Requires exact tool names in `tools.allowedTools` plus valid `slack.*` / `telegram.*` adapter config; existing adapter allowlists remain the destination boundary |

## Channels (`@mono-agent/*-adapter`, composed by `@mono-agent/agent-app`)

All channels are independent JSON sections and opt-in via an `enabled` flag
(default off). A channel that is off reports `disabled`; an enabled channel with
incomplete config reports `waiting_for_config`. Either way it never blocks the
rest. Every field also has a `MONO_AGENT_<CHANNEL>_*` env var.

| Feature id | What it is | Coverage | Config section / keys |
| --- | --- | --- | --- |
| `telegram.long-polling` | Telegram bot via long polling | `config` | `telegram.enabled`, `telegram.botToken`, `telegram.allowedChatIds` or `telegram.allowAllChats` |
| `slack.socket-mode` | Slack Socket Mode bot. A built-in **heartbeat watchdog** (on by default: 30s ping probe / 90s silence budget) detects and force-recycles a silently half-open socket so the connection self-heals after host sleep or a network blip | `config` (heartbeat: `auto`, code-only tuning) | `slack.enabled`, `slack.botToken`, `slack.appToken`, `slack.allowedChannelIds` or `slack.allowAllChannels`, `slack.botUserIds`, `slack.mentionTextAliases`, `slack.stripMentionText`. Heartbeat has **no config/env key** — tune via `startSlackAdapter` / `SlackSocketModeRunner` `heartbeat: { intervalMs, timeoutMs }` (`timeoutMs: 0` disables) |
| `whatsapp.baileys` | WhatsApp via Baileys socket (QR login; auth state in `.mono-agent/whatsapp-auth`) | `config` | `whatsapp.enabled`, `whatsapp.allowedChatJids` or `whatsapp.allowAllChats`, `whatsapp.groupMode` (mention/any), `whatsapp.botJids`, `whatsapp.mentionTextAliases`, `whatsapp.stripMentionText` |
| `webhook.http-invoke` | HTTP POST invocation, sync or async with status polling; multiple named endpoints on one port, each with an optional `prompt` (pre-instructions prepended to the request text) | `config` | `webhook.enabled`, `host`, `port`, `path`, `prompt`, `defaultMode` (sync/async), `allowNonLoopback`, `retentionMs`, `maxStoredRequests`; multiple endpoints via `webhook.endpoints[]` (`name`/`path`/`mode`/`prompt`/`enabled`) or `webhook.dir` `*.md` files (also `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON`, `MONO_AGENT_WEBHOOK_DIR`) |
| `openai-api.chat-completions` | OpenAI-compatible `/v1/models` + `/v1/chat/completions` (SSE streaming, optional bearer key; session continuity via `X-OpenWebUI-Chat-Id`/`X-Conversation-Id` headers with latest-message extraction) | `config` | `openaiApi.enabled`, `host`, `port`, `basePath`, `allowNonLoopback`, `apiKey`, `modelId` |
| `a2a.provider` | A2A provider with Agent Card discovery, JSON-RPC + REST, streaming, optional bearer | `config` | `a2a.provider.{enabled,host,port,publicBaseUrl,allowNonLoopback,requireBearer,bearerToken}`, `a2a.agent.{name,description,version,providerOrganization,providerUrl}`, `a2a.skill.{id,name,description,tags,examples}` |
| `a2a.consumer` | Calling remote A2A agents (discovery + sendMessage) | `config`+`code` | `a2a.consumer.{remoteAgentUrls,defaultRemoteAgentUrl,bearerToken,timeoutMs}` holds the settings; invoking remote agents is programmatic (`createA2AConsumerResponder`, used by multi-agent hosts) |
| `cron.scheduled-prompts` | Five-field cron jobs (timezone-aware, overlap-skipping) invoking the responder | `config` | `cron.jobs[]: {id, enabled, expression, timezone, prompt, conversationId}` (`MONO_AGENT_CRON_JOBS_JSON` or single-job `MONO_AGENT_CRON_*`), or one `*.md` file per job in the cron folder (frontmatter metadata + prompt body) at `cron.dir` / `MONO_AGENT_CRON_DIR` (default `cron/`) — folder and config jobs merge, duplicate ids error |
| `channel.proactive-notify` | On a **cron or webhook turn**, the agent is given two tools — `notify_conversation(conversationId, text)` and `list_notify_destinations()` — to proactively message a conversation it is not currently handling. `notify_conversation` runs `text` as a **real turn on the destination channel's own live session** (so the user sees it natively and the conversation remembers it — not a side-channel post), enforcing that channel's allowlist; it returns `{delivered, reason}`. The destination is chosen dynamically: from the triggering request payload (a webhook async-callback carries the originating `conversationId`) or from `list_notify_destinations` (conversations the agent has handled + single-allowlist entries; WhatsApp excluded). The tools are hosted by an in-process loopback HTTP MCP server and injected **only on cron/webhook turns** (gated by request metadata); live channel turns never see them. The current conversationId is surfaced in every turn's context so a live agent can wire an async callback back to itself. **Telegram + Slack** are notify-capable; a `whatsapp:` destination returns `delivered:false` (no notify hook yet). | `config` | Injected only on cron/webhook turns (gated by request metadata — these auto-provisioned MCP tools are not themselves filtered by `tools.allowedTools`/`disallowedTools`); each destination is bounded by the owning channel's allowlist (`telegram.allowedChatIds` / `slack.allowedChannelIds` or `allowAll*`), the declarative config surface; no per-job/endpoint config |
| `cron.run-watchdog` | The cron channel aborts a run that does not settle within ~20 minutes and reclaims its slot, so a wedged run can't starve every future tick (skip-on-overlap only guards a *still-running* prior tick). Per-job; an aborted run is recorded with `interrupted` status | `code` | `maxRunMs` default `1200000` set by the cron channel; override only via `startCronAdapter({ maxRunMs })` — no JSON/env key |
| `channel.final-only-delivery` | Telegram & Slack default to delivering only the final answer (no streamed interim edits) while showing a working indicator: Telegram a "typing…" chat action, Slack a 👀 "seen" reaction on the user's message. Set `stream.finalOnly: false` to restore live interim streaming. (The OpenAI-compatible `/v1/chat/completions` endpoint still streams token-by-token for clients like Open WebUI.) | `code` | Adapter `stream.finalOnly` (default `true` for telegram/slack); substrate option `ResilientMessageStream({ finalOnly })` + `ChannelTransport.indicateActivity()` |
| `channel.stream-tuning` | Status text, edit debounce, max message chars, welcome/help/error texts per chat channel | `code` | Adapter `stream`/`messages` options via custom channel drivers (`createTelegramChannelDriver` etc.) |
| `channel.custom` | Bespoke transports | `code` | Implement `ChannelDriver`, pass via `startMonoAgentApp({ drivers })` |

## Observability & operator surfaces

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `observability.jsonl-artifacts` | Append-only run event JSONL + summaries (secrets redacted, strings truncated) | `config` | `artifacts.dir` (`MONO_AGENT_ARTIFACT_DIR`) |
| `observability.latency-attribution` | Per-turn `provider_bridge_latency` event (provider+tool+IO time vs harness overhead) and per-tool `tool_timing` events (`execution_ms`); MCP tool results carry `mcp_call_duration_ms`. Lets traces separate model-reasoning time from tool/MCP time | `auto` | Emitted into the run JSONL artifacts |
| `observability.trace-registry` | Host publishes a heartbeat manifest so dashboards discover running agents | `config` | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs}` (`MONO_AGENT_TRACE_*`) |
| `observability.phoenix-exporter` | Additive best-effort OTLP/HTTP **protobuf** export of each run lifecycle to Phoenix as a SEMANTIC timeline: streaming assistant deltas coalesce into one "Assistant thoughts"/"Assistant message" span, and a tool's `tool_use`+`tool_timing`+`tool_result` events merge by `tool_use_id` into one TOOL span (input=args, output=result). Spans carry OpenInference semantics (`openinference.span.kind` AGENT/LLM/TOOL/CHAIN, or `memory` for memory-maintenance runs, `input.value`/`output.value`) and route to a named project via `openinference.project.name` (defaults to the trace source label/id). Deterministic per-run ids make re-export idempotent. Metadata-only by default; failures are bounded by timeout and never change the run outcome or suppress JSONL writes. Transport lives in `@mono-agent/observability-otel` (via `@opentelemetry/otlp-transformer`); `start`/`status` show the endpoint, `validate` POSTs an empty protobuf to confirm export-compatibility (not just reachability) | `config` | `observability.exporters[]: {type:"phoenix", endpoint, projectName, includeSensitiveData, headers, timeoutMs}` (`MONO_AGENT_OBSERVABILITY_EXPORTERS` JSON array) |
| `observability.backfill` | Retroactively export already-recorded run artifacts (`run-*.summary.json` + `run-*.events.jsonl`) to Phoenix with their historical timestamps, reusing the live OTLP mapping. Deterministic ids make re-runs overwrite rather than duplicate | `cli` | `mono-agent backfill (--run <id> \| --all) [--since <iso>] [--until <iso>] [--dry-run]` |
| `observability.rich-traces` | Root run spans carry roll-up attributes — `llm.model_name`/`mono.agent.model`, `llm.token_count.*` (incl. prompt-cache read/write), `mono.agent.cost_usd`, `mono.agent.duration_ms`, and (only with `includeSensitiveData`) the redacted system prompt (`llm.input_messages.0.*`, 32KB cap). Memory-maintenance runs additionally export `openinference.span.kind="memory"` + `mono.agent.memory.operation` (distill/reconcile/entities/reflect/migrate); channel runs stay AGENT. (Redaction was fixed so numeric token counts survive export.) | `auto` | Exported on every run; the system prompt is gated by `observability.exporters[].includeSensitiveData` |
| `observability.stale-run-reconciliation` | At startup the host rewrites any run summary left at `running` by a crashed prior process to `interrupted` (failureKind `process_death`); fire-and-forget, runs in the background, never gates readiness. `interrupted` maps to an ERROR span in Phoenix | `auto` | `reconcileStaleRunArtifacts()` run once at startup over `artifacts.dir` |
| `tui.chat` | Terminal chat + transcript + redacted config pane. The TUI is a communication adapter, not a harness: `--responder <file>` (ESM module exporting an `AgentResponderLike` or `createResponder(env, cwd, configJson)`) is **required**; `--config` is optional (enables the Config pane, forwarded to `createResponder()`) | `cli` | `mono-agent-tui --responder <file> [--config <path>]` (ships with `@mono-agent/tui`) |

## Execution & composition (`agent-harness`, `agent-host`, `agent-orchestrator`, `agent-app`)

| Feature id | What it is | Coverage | Config / entry point |
| --- | --- | --- | --- |
| `app.cli-init` | Non-destructive scaffold (config + IDENTITY.md + `.mono-agent/`) | `cli` | `mono-agent init [--model] [--fallback-models] [--memory]` |
| `app.cli-validate` | Per-section config report (core, runtime, provider credentials, context, memory, tools, sandbox, observability, every channel) | `cli` | `mono-agent validate [--config] [--env-file]` |
| `app.provider-credentials-check` | `validate` resolves every referenced Pi model (primary, fallbacks, agent-host `memory.llm`) against the Pi auth store + sibling `models.json`; a keyless or expired-OAuth provider is flagged `waiting` with a `pi auth login <provider>` hint. Static and read-only — no network, no token mutation. Catches the silent class of failure where an expired OAuth token quietly breaks crons/memory | `cli` | Part of `mono-agent validate`; resolves against `providers.piAuthPath` |
| `app.cli-start` | Start the agent — traceability + every configured channel. Defaults to a **background macOS service (launchd)** that survives logins (auto-restart on crash) until `stop`; `--foreground`/`-f` runs blocking in the foreground (use this off macOS) | `cli` | `mono-agent start [--config] [--env-file] [--foreground\|-f]` |
| `app.cli-stop` | Stop the background instance for this config and remove its LaunchAgent (macOS background mode) | `cli` | `mono-agent stop [--config]` |
| `app.cli-logs` | Print (and optionally follow) the background instance's log files | `cli` | `mono-agent logs [--config] [--follow\|-f] [--lines <n>]` |
| `app.cli-restart-clean` | Restart the background instance (starts it if stopped). `--force` first purges the persisted pi-session store (`providers.piNative.piSessionsRoot`) so the agent resumes nothing — a fresh start. Durable memory under `memory.path` is untouched; a no-op when sessions are in-memory | `cli` | `mono-agent restart [--config] [--force]` |
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
  `references/config-blueprint.md`, `references/feature-coverage.md`,
  `references/discovery-questions.md`, `references/package-map.md`,
  `references/validation.md`, and `references/playbooks.md` (when a recipe changes).
- The published documentation site under `docs/` (built with Astro Starlight in
  `website/` and deployed on Vercel — see `website/README.md` for the build/sync/deploy
  workflow and the Astro/Starlight version pins) is the reader-friendly projection of this
  registry. When a feature row changes, also update its prose page under `docs/<area>/`, the
  scannable `docs/reference/feature-matrix.md`, and — if a recipe is affected —
  the matching `docs/playbooks/<slug>.md` and the composer's `references/playbooks.md`.
  This file (`docs/reference/feature-registry.md`) remains the canonical source of truth.
