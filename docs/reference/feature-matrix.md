---
title: "Feature matrix"
sidebar:
  order: 1
---

# Feature matrix

A scannable projection of every mono-agent capability for non-linear readers: each feature id mapped to its coverage type, the config key(s) and env var(s) that reach it, the prose page that explains it, and any playbook that puts it to work.

[`docs/reference/feature-registry.md`](/reference/feature-registry/) is the canonical long-form source of truth — when this matrix and the registry disagree, the registry wins. This page projects the same rows into a grid for quick lookup.

## Coverage legend

| Code | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json` (env var override always available) |
| `cli` | Reached through a `mono-agent` CLI flag/command |
| `auto` | Always active when the app runs; needs no declaration |
| `code` | Programmatic escape hatch only — see [Programmatic API](/programmatic/) |
| `dev` | Development/test-time tooling, not part of a running agent |

Env precedence everywhere: process env > `mono-agent.config.json` > built-in defaults.

## Runtime

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `runtime.multi-backend` | config | `runtime.model` | `MONO_AGENT_MODEL` | [Backends](/runtime/backends/) | [Multi-model fallback](/playbooks/multi-model-fallback-chain/) |
| `runtime.execution-modes` | config | `runtime.executionMode` | `MONO_AGENT_EXECUTION_MODE` | [Backends](/runtime/backends/) | — |
| `runtime.fallback-models` | config | `runtime.fallbackModels` (fallback-eligible provider failures, including auth failures) | `MONO_AGENT_FALLBACK_MODELS` | [Fallback](/runtime/fallback/) | [Multi-model fallback](/playbooks/multi-model-fallback-chain/) |
| `runtime.effort` | config | `runtime.effort` | `MONO_AGENT_EFFORT` | [Execution, effort, permissions](/runtime/execution-effort-permissions/) | — |
| `runtime.per-trigger-model` | config + code | `cron.jobs[].{model,effort}`; `webhook.endpoints[].{model,effort}` + request body `{model,effort}` (request wins over endpoint config; override becomes the turn's primary, keeping `runtime.fallbackModels`) | `MONO_AGENT_CRON_MODEL` / `MONO_AGENT_CRON_EFFORT`, `MONO_AGENT_WEBHOOK_MODEL` / `MONO_AGENT_WEBHOOK_EFFORT` | [Cron](/channels/cron/#per-trigger-model--effort) · [Webhook](/channels/webhook/#per-trigger-model--effort) | — |
| `runtime.permission-mode` | config | `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | [Execution, effort, permissions](/runtime/execution-effort-permissions/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `runtime.max-turns` | config | `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | [Backends](/runtime/backends/) | — |
| `runtime.workspace` | config | `runtime.workspace` | `MONO_AGENT_WORKSPACE` | [Backends](/runtime/backends/) | — |
| `runtime.provider-sessions` | config | `runtime.session.mode`, `runtime.session.idleTimeoutMs` | `MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS` | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.concurrency` | config | `concurrency.maxConcurrentRuns`, `concurrency.maxPendingRuns` | `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`, `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS` | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.local-providers` | config | `providers.local[]` | `MONO_AGENT_LOCAL_PROVIDERS_JSON`, `MONO_AGENT_LOCAL_PROVIDER_*` | [Local providers](/runtime/local-providers/) | [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) |
| `runtime.pi-oauth` | config | `providers.piAuthPath` | `MONO_AGENT_PI_AUTH_PATH` | [Local providers](/runtime/local-providers/) | — |
| `runtime.pi-native-tuning` | config | `providers.piNative.piMaxRetries`, `providers.piNative.maxRetryDelayMs`, `providers.piNative.piSessionsRoot` | `MONO_AGENT_PI_MAX_RETRIES`, `MONO_AGENT_MAX_RETRY_DELAY_MS`, `MONO_AGENT_PI_SESSIONS_ROOT` | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.tool-parallelism` | code | `runtimeOptions.piToolParallelismMode` | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.webfetch-retry` | auto | (built into WebFetch) | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.context-compaction` | provider + settings | `agent_compaction_*` (pi-native settings) | — | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.tool-bloat-guard` | auto | (artifacts land in `artifacts.dir`) | `MONO_AGENT_ARTIFACT_DIR` | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.cost-tracking` | auto | (recorded in JSONL artifacts) | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `runtime.builtin-tools` | config | `tools.allowedTools`, `tools.disallowedTools` | `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.structured-output` | code | `runtimeOptions.outputSchema` | — | [Approval & structured output](/programmatic/approval-and-structured-output/) | — |
| `runtime.live-input` | code | `runtimeOptions.liveInput` | — | [Composition](/programmatic/composition/) | — |
| `runtime.approval-gates` | code | `createMonoRuntime({ onToolApprovalRequest, ... })` (config posture: `runtime.permissionMode`) | `MONO_AGENT_PERMISSION_MODE` | [Approval & structured output](/programmatic/approval-and-structured-output/) | — |
| `runtime.custom` | code | `startMonoAgentApp({ runtime })` | — | [Composition](/programmatic/composition/) | — |

## Sandbox

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `sandbox.mode` | config | `sandbox.mode` | `MONO_AGENT_SANDBOX_MODE` | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.network-policy` | config | `sandbox.network.mode`, `sandbox.network.allowlist` | `MONO_AGENT_SANDBOX_NETWORK`, `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.filesystem-scopes` | config | `sandbox.readableRoots`, `sandbox.writableRoots`, `sandbox.denyWrite` | `MONO_AGENT_SANDBOX_READABLE_ROOTS`, `MONO_AGENT_SANDBOX_WRITABLE_ROOTS`, `MONO_AGENT_SANDBOX_DENY_WRITE` | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.fallback` | config | `sandbox.fallback`, `sandbox.unsafeAllowHostProcess` | `MONO_AGENT_SANDBOX_FALLBACK`, `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS` | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.monotonic-merge` | auto | (harness merges configured + request policies) | — | [Sandbox](/tools/sandbox/) | — |

## Memory

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `memory.lite` | config | `memory.mode: "lite"`, `memory.path`, `memory.maxBytes`, `memory.writeMode` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_WRITE_MODE` | [Capture & recall](/memory/capture-and-recall/) | — |
| `memory.journal` | config | `memory.mode: "journal"`, `memory.path`, `memory.embeddings.{provider,model,dim}` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_EMBEDDINGS_*` | [Embeddings](/memory/embeddings/) | — |
| `memory.bujo` | config | `memory.mode: "bujo"`, `memory.path`, `memory.embeddings.{provider,model,dim}`, `memory.llm.{provider,model,executionMode,endpoint}` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_EMBEDDINGS_*`, `MONO_AGENT_MEMORY_LLM_*` | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.bujo-reflection` | config | `memory.reflection.{enabled,cron}` | `MONO_AGENT_MEMORY_REFLECTION_CRON`, `MONO_AGENT_MEMORY_REFLECTION_ENABLED` | [Rituals](/memory/rituals/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.bujo-migration` | config | `memory.migration.{enabled,cron}` | `MONO_AGENT_MEMORY_MIGRATION_CRON`, `MONO_AGENT_MEMORY_MIGRATION_ENABLED` | [Rituals](/memory/rituals/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.bujo-cli` | cli | `memory-bujo rebuild\|recall\|index\|reflect\|migrate <root>` | `MONO_AGENT_MEMORY_EMBEDDINGS_*`, `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_ENDPOINT` | [Validation & CLI](/memory/validation-and-cli/) | — |
| `memory.validate` | cli | `mono-agent validate [--consumer] [--config]` | — | [Validation & CLI](/memory/validation-and-cli/) | — |
| `memory.write-mode` | config | `memory.writeMode` | `MONO_AGENT_MEMORY_WRITE_MODE` | [Capture & recall](/memory/capture-and-recall/) | — |
| `memory.per-turn-capture` | config | `memory.writeMode: "capture"` (requires `memory.mode: "bujo"`) | `MONO_AGENT_MEMORY_WRITE_MODE=capture`, `MONO_AGENT_MEMORY_MODE=bujo` | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.recall-tool` | config | `memory.recallTool.enabled` | `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.llm-timeout` | config | `memory.llm.timeoutMs` (in-app; 1000–600000, default 60000) | `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` (standalone CLI default 120000) | [Validation & CLI](/memory/validation-and-cli/#the-two-memory-llm-timeouts) | — |
| `memory.custom-store` | code | `createConfiguredAgentResponder({ memory })` | — | [Composition](/programmatic/composition/) | — |

:::note
The entity graph that BuJo capture maintains is documented separately in [Entity graph](/memory/entity-graph/).
:::

## Context & skills

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `context.identity` | config | `context.identityPath` | `MONO_AGENT_IDENTITY_PATH` | [Identity & soul](/context/identity-and-soul/) | — |
| `context.soul` | config | `context.soulPath` | `MONO_AGENT_SOUL_PATH` | [Identity & soul](/context/identity-and-soul/) | — |
| `context.history` | auto | (sized from `runtime.maxTurns`; custom store via `code`) | `MONO_AGENT_MAX_TURNS` | [Assembly](/context/assembly/) | — |
| `skills.selected-activation` | config | `context.skillsRoot`, `context.selectedSkills` | `MONO_AGENT_SKILLS_ROOT`, `MONO_AGENT_SELECTED_SKILLS` | [Skills](/context/skills/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `skills.byte-capping` | config | `context.skillMaxBytes` | `MONO_AGENT_SKILL_MAX_BYTES` | [Skills](/context/skills/) | — |

## Tools & MCP

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `tool-policy.fail-closed` | auto | (default when `tools` lists are empty) | — | [Tool policy](/tools/policy/) | — |
| `tool-policy.allowlist` / `tool-policy.denylist` | config | `tools.allowedTools`, `tools.disallowedTools` | `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` | [Tool policy](/tools/policy/) | — |
| `tool-policy.mcp-servers` | config | `tools.mcpConfigPath` | `MONO_AGENT_MCP_CONFIG_PATH` | [MCP](/tools/mcp/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `agent-app.adapter-send-tools` | config | `tools.allowedTools` (`slack_send_message`, `telegram_send_message`) + valid `slack.*` / `telegram.*` config | `MONO_AGENT_ALLOWED_TOOLS` | [Delivery & send tools](/channels/delivery-and-send-tools/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |

## Channels

All channels are independent JSON sections. Most are opt-in via an `enabled` flag (default off); `tui` and `live` are default-on loopback operator surfaces. An off channel reports `disabled`; an enabled channel with incomplete config reports `waiting_for_config`. Every field also has a `MONO_AGENT_<CHANNEL>_*` env var.

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `telegram.long-polling` | config | `telegram.enabled`, `telegram.botToken`, `telegram.allowedChatIds` / `telegram.allowAllChats`, `telegram.pollWatchdogMs` (poll-liveness watchdog, on by default; `0` disables), `telegram.transport.ipFamily` (opt-in IPv4/IPv6 pin) (+ a built-in self-healing long-poll auto-restart, on by default; code-only, no config/env key) | `MONO_AGENT_TELEGRAM_*` (incl. `MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS`, `MONO_AGENT_TELEGRAM_IP_FAMILY`) | [Telegram](/channels/telegram/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `telegram.interactive` | config | `telegram.commands[]`, `telegram.reactions`, `telegram.quietHours`; `telegram_ask` / `telegram_send_document` / `telegram_send_photo` in `tools.allowedTools` | `MONO_AGENT_TELEGRAM_REACTIONS` | [Telegram](/channels/telegram/) · [Evaluation](/reference/telegram-feature-evaluation/) | — |
| `slack.socket-mode` | config | `slack.enabled`, `slack.botToken`, `slack.appToken`, `slack.allowedChannelIds` / `slack.allowAllChannels`, `slack.botUserIds`, `slack.mentionTextAliases`, `slack.stripMentionText`; resilience tuning (all optional, on by default): `slack.heartbeatIntervalMs`, `slack.heartbeatTimeoutMs`, `slack.reconnectInitialBackoffMs`, `slack.reconnectMaxBackoffMs`, `slack.reconnectStabilityMs`, `slack.reconnectStartupGraceMs`, `slack.drainDeadlineMs` | `MONO_AGENT_SLACK_*` (incl. `MONO_AGENT_SLACK_HEARTBEAT_*`, `MONO_AGENT_SLACK_RECONNECT_*`, `MONO_AGENT_SLACK_DRAIN_DEADLINE_MS`) | [Slack](/channels/slack/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `whatsapp.baileys` | config | `whatsapp.enabled`, `whatsapp.allowedChatJids` / `whatsapp.allowAllChats`, `whatsapp.groupMode`, `whatsapp.botJids`, `whatsapp.mentionTextAliases`, `whatsapp.stripMentionText` | `MONO_AGENT_WHATSAPP_*` | [WhatsApp](/channels/whatsapp/) | — |
| `webhook.http-invoke` | config | `webhook.enabled`, `host`, `port`, `path`, `prompt`, `notify`, `notifyConversationId`, `defaultMode`, `allowNonLoopback`, `retentionMs`, `maxStoredRequests`, `maxRunMs`, `webhook.endpoints[]` (incl. per-endpoint `model`/`effort`; a request body may set `model`/`effort`, request winning over endpoint config), `webhook.dir` | `MONO_AGENT_WEBHOOK_*` (incl. `MONO_AGENT_WEBHOOK_MODEL`, `MONO_AGENT_WEBHOOK_EFFORT`, `MONO_AGENT_WEBHOOK_MAX_RUN_MS`), `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON`, `MONO_AGENT_WEBHOOK_DIR` | [Webhook](/channels/webhook/) | [Webhook automation (sync/async)](/playbooks/webhook-automation-sync-async/) |
| `openai-api.chat-completions` | config | `openaiApi.enabled`, `host`, `port`, `basePath`, `allowNonLoopback`, `apiKey`, `modelId` | `MONO_AGENT_OPENAI_API_*` | [OpenAI-compatible API](/channels/openai-api/) | [OpenAI endpoint + Open WebUI](/playbooks/openai-endpoint-open-webui/) |
| `a2a.provider` | config | `a2a.provider.*`, `a2a.agent.*`, `a2a.skill.*` | `MONO_AGENT_A2A_*` | [A2A](/channels/a2a/) | [A2A provider & consumer](/playbooks/a2a-provider-and-consumer/) |
| `a2a.consumer` | config + code | `a2a.consumer.{remoteAgentUrls,defaultRemoteAgentUrl,bearerToken,timeoutMs}`; invocation via `createA2AConsumerResponder` | `MONO_AGENT_A2A_*` | [A2A consumer](/programmatic/a2a-consumer/) | [A2A provider & consumer](/playbooks/a2a-provider-and-consumer/) |
| `tui.stream-endpoint` | config | `tui.{enabled,host,port,basePath,allowNonLoopback,apiKey}` — **on by default** (loopback operator surface) | `MONO_AGENT_TUI_*` | [TUI stream endpoint](/channels/tui/) | — |
| `live.event-relay` | config | `live.{enabled,host,port,basePath,allowNonLoopback,apiKey}` — **on by default** (read-only SSE relay for web) | `MONO_AGENT_LIVE_*` | [Live event relay](/channels/tui/#live-event-relay-for-web-pwa) | — |
| `cron.scheduled-prompts` | config | `cron.jobs[]: {id, enabled, expression, timezone, prompt, conversationId, maxRunMs, notify, notifyConversationId, notifyFailureCooldownHours, model, effort}`, `cron.dir` | `MONO_AGENT_CRON_JOBS_JSON`, `MONO_AGENT_CRON_*` (incl. `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS`, `MONO_AGENT_CRON_MODEL`, `MONO_AGENT_CRON_EFFORT`), `MONO_AGENT_CRON_DIR` | [Cron](/channels/cron/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |
| `cron.run-watchdog` | config + code | `jobs[].maxRunMs` or `maxRunMs` frontmatter; programmatic fallback via `startCronAdapter` | — | [Cron](/channels/cron/#run-watchdog-a-wedged-run-is-aborted-not-left-to-starve) | — |
| `channel.native-notify` | config | per cron job / webhook endpoint `notify` + optional `notifyConversationId`; cron failure notices require explicit `notifyConversationId` and may set `notifyFailureCooldownHours`; bounded by `telegram.allowedChatIds` / `slack.allowedChannelIds` or `allowAll*` | `MONO_AGENT_CRON_NOTIFY`, `MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID`, `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS` (+ webhook equivalents except cooldown) | [Delivery & send tools](/channels/delivery-and-send-tools/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |
| `channel.final-only-delivery` | code | Adapter `stream.finalOnly` (default `true` for telegram/slack) | — | [Delivery & send tools](/channels/delivery-and-send-tools/) | — |
| `channel.stream-tuning` | code | Adapter `stream` / `messages` options (`createTelegramChannelDriver` etc.) | — | [Custom channels](/programmatic/custom-channels/) | — |
| `channel.custom` | code | `startMonoAgentApp({ drivers })` (implement `ChannelDriver`) | — | [Custom channels](/programmatic/custom-channels/) | — |

## Observability

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `observability.jsonl-artifacts` | config | `artifacts.dir`, `artifacts.retention.{maxAgeDays,maxCount,dryRun}` | `MONO_AGENT_ARTIFACT_*` | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.latency-attribution` | auto | (emitted into run JSONL artifacts) | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.trace-registry` | config | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs}` | `MONO_AGENT_TRACE_*` | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.phoenix-exporter` | config | `observability.exporters[]: {type:"phoenix", endpoint, projectName, includeSensitiveData, headers, timeoutMs}` | `MONO_AGENT_OBSERVABILITY_EXPORTERS` | [Phoenix & backfill](/observability/phoenix-and-backfill/) | [Phoenix-observed agent](/playbooks/phoenix-observed-agent/) |
| `observability.backfill` | cli | `mono-agent backfill (--run <id> \| --all) [--since] [--until] [--dry-run]` | — | [Phoenix & backfill](/observability/phoenix-and-backfill/) | [Backfill historical runs](/playbooks/backfill-historical-runs/) |
| `observability.artifact-audit` | cli / code | `auditRecordedRuns(artifactDir, { staleAfterMs })`; `mono-agent audit-runs [--artifact-dir <path> \| --consumer <path>] [--json]` | — | [Artifacts & traces](/observability/artifacts-and-traces/#run-status-and-stale-run-reconciliation) | — |
| `observability.artifact-metrics` | cli / code | `summarizeRecordedRunMetrics({ artifactDir, since, until, groupBy })`; `mono-agent metrics [--artifacts] [--since] [--until] [--by] [--json]` | — | [Artifact metrics](/observability/artifact-metrics/) | — |
| `observability.rich-traces` | auto | (model / token counts / cost / duration on every span; system prompt gated by `includeSensitiveData`; memory runs get `span.kind=memory` + `memory.operation`) | — | [Phoenix & backfill](/observability/phoenix-and-backfill/#per-run-attributes) | — |
| `observability.stale-run-reconciliation` | auto | (`reconcileStaleRunArtifacts()` at startup over `artifacts.dir`; rewrites orphaned `running` → `interrupted`) | — | [Artifacts & traces](/observability/artifacts-and-traces/#run-status-and-stale-run-reconciliation) | — |
| `tui.chat` | cli | `mono-agent tui [--agent <label\|sourceId>] [--conversation <id>]`; low-level `mono-agent-tui [--responder \| --url]` | `MONO_AGENT_TUI_API_KEY` (connect key) | [TUI](/observability/tui/) | — |
| `session-web.pwa` | cli | `mono-agent web [--host <addr>] [--port <n>] [--no-open] [--allow-non-loopback] [--config <path>]` | `MONO_AGENT_LIVE_*` (agent-side relay) | [CLI reference](/observability/cli-reference/#web) | — |

## Execution & composition

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `app.cli-init` | cli | `mono-agent init [--model] [--fallback-models] [--memory]` | — | [Quickstart](/getting-started/quickstart/) | — |
| `app.cli-setup` | cli | `mono-agent setup [--recipe <id>] [--with <csv>] [--dry-run] [--model] [--fallback-models] [--memory lite\|journal\|bujo]` | — | [CLI reference](/observability/cli-reference/#setup) | — |
| `app.cli-recipes` | cli | `mono-agent recipes list \| show <id>` | — | [CLI reference](/observability/cli-reference/#recipes) | — |
| `app.cli-validate` | cli | `mono-agent validate [--consumer] [--config] [--env-file]` | — | [Blueprint](/config/blueprint/) | — |
| `app.provider-credentials-check` | cli | part of `mono-agent validate`; resolves Pi models against `providers.piAuthPath` + `models.json` | `MONO_AGENT_PI_AUTH_PATH` | [CLI reference](/observability/cli-reference/#provider-credentials) | — |
| `app.cli-start` | cli | `mono-agent start [--config] [--env-file] [--foreground\|-f]` | — | [Install](/getting-started/install/) | — |
| `app.cli-stop` | cli | `mono-agent stop [--config]` | — | [Install](/getting-started/install/) | — |
| `app.cli-logs` | cli | `mono-agent logs [--config] [--follow\|-f] [--lines <n>]` | — | [CLI reference](/observability/cli-reference/) | — |
| `app.cli-restart-clean` | cli | `mono-agent restart [--config] [--force]` | — | [CLI reference](/observability/cli-reference/) | — |
| `app.cli-install-skill` | cli | `mono-agent install-skill [--target claude\|codex\|both] [--force]` | — | [CLI reference](/observability/cli-reference/) | — |
| `app.env-file` | cli | automatic; `--env-file <path>` to override | — | [Env vars](/config/env-vars/) | — |
| `harness.failure-handling` | auto | (built into every run) | — | [Composition](/programmatic/composition/) | — |
| `harness.request-runtime-options` | code | `createConfiguredAgentResponder({ runtimeOptionsForRequest })` | — | [Composition](/programmatic/composition/) | — |
| `orchestrator.ask-collaborator` | code | `createCollaboratorToolRuntimeExtension` + `runtimeOptionsForRequest` | — | [Multi-agent](/programmatic/multi-agent/) | [Multi-agent orchestration](/playbooks/multi-agent-orchestration/) |
## Notes on coverage types

A `code`-only feature has no `mono-agent.config.json` key — you reach it through `startMonoAgentApp` options or lower-level packages. See [Programmatic API](/programmatic/) for the entry points referenced above (`createConfiguredAgentResponder`, `createMonoRuntime`, `createCollaboratorToolRuntimeExtension`, custom `ChannelDriver`/`runtime`/`memory`/`historyStore` injection).

:::note
Two registry rows carry a non-standard coverage label: `runtime.context-compaction` is `provider + settings` (driven by the pi bridge, tuned via `agent_compaction_*` pi-native settings) and `a2a.consumer` is `config + code` (settings live in config, but invoking remote agents is programmatic).
:::
