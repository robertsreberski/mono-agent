---
title: "Feature matrix"
description: "Scan mono-agent capabilities by coverage type, config key, environment variable, guide, and playbook."
sidebar:
  order: 2
---

A scannable projection of every mono-agent capability for non-linear readers: each feature id mapped to its coverage type, the config key(s) and env var(s) that reach it, the prose page that explains it, and any playbook that puts it to work.

[`docs/reference/feature-registry.md`](/reference/feature-registry/) is the canonical long-form source of truth — when this matrix and the registry disagree, the registry wins. This page projects the same rows into a grid for quick lookup.

## Coverage legend

| Code | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json`; an env override exists only where one is listed (`--` means JSON-only / no env form) |
| `cli` | Reached through a `mono-agent` CLI flag/command |
| `auto` | Always active when the app runs; needs no declaration |
| `code` | Programmatic escape hatch only — see [Programmatic API](/programmatic/) |
| `dev` | Development/test-time tooling, not part of a running agent |

Core precedence: `mono-agent.config.json` > built-in defaults. Adapter-owned environment inputs remain documented by their packages.

## Runtime

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `runtime.multi-backend` | config | `runtime.model` | — | [Pi runtime](/runtime/backends/) | [Multi-model fallback](/playbooks/multi-model-fallback-chain/) |
| `runtime.fallback-models` | config | `runtime.fallbacks[].{model,effort?}`; CLI uses repeated `--fallback` (legacy `--fallback-models` flag removed) | — | [Fallback](/runtime/fallback/) | [Multi-model fallback](/playbooks/multi-model-fallback-chain/) |
| `runtime.effort` | config | `runtime.effort`, `runtime.fallbacks[].effort` | — | [Execution, effort, permissions](/runtime/execution-effort-permissions/) | — |
| `runtime.per-trigger-model` | config + code | `cron.jobs[].{model,effort}`; `webhook.endpoints[].{model,effort}` + request body `{model,effort}`; Telegram built-ins `/model` and `/effort`; Slack Block Kit selectors through thread-local `@agent /model` / `@agent /effort` and channel-wide workspace commands `/<bot>-model` / `/<bot>-effort`, all over configured primary/fallback models | — | [Cron](/channels/cron/#per-trigger-model--effort) · [Webhook](/channels/webhook/#per-trigger-model--effort) · [Telegram](/channels/telegram/#runtime-model-and-effort-controls-built-in) · [Slack](/channels/slack/#runtime-model-and-effort-controls-built-in) | — |
| `runtime.max-turns` | config | `runtime.maxTurns` | — | [Pi runtime](/runtime/backends/) | — |
| `runtime.workspace` | config | `runtime.workspace` | — | [Pi runtime](/runtime/backends/) | — |
| `runtime.provider-sessions` | config | `runtime.session.mode`, `runtime.session.idleTimeoutMs`, `runtime.session.rollover`, `runtime.session.rolloverTimezone`, `runtime.session.rolloverNotice` | — | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.concurrency` | config | `concurrency.maxConcurrentRuns`, `concurrency.maxPendingRuns` | — | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.local-providers` | config | `providers.local[]` | — | [Local providers](/runtime/local-providers/) | [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) |
| `runtime.providers` | config | `providers.<providerId>`, `providers.local[]`, `providers.piAuthPath`, `providers.piNative.*` | — | [Providers](/runtime/providers/) | — |
| `runtime.pi-credentials` | config | `providers.piAuthPath` (OAuth/account and API-key credentials such as OpenCode-Go) | — | [Local providers](/runtime/local-providers/) | — |
| `runtime.pi-native-tuning` | config | `providers.piNative.transport`, `providers.piNative.piMaxRetries`, `providers.piNative.maxRetryDelayMs`, `providers.piNative.piSessionsRoot` | — | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.tool-parallelism` | code | `runtimeOptions.piToolExecutionMode` | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.web-research` | config + auto | `tools.web.search.*`, `tools.web.fetch.*` | — | [Local-first web research](/tools/web-research/) | [Local-first web research agent](/playbooks/local-web-research/) |
| `runtime.webfetch-retry` | auto | (built into WebFetch) | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.context-compaction` | config + provider | `runtime.compaction.*` | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.tool-bloat-guard` | auto | (artifacts land in `artifacts.dir`) | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.cost-tracking` | auto | (recorded in JSONL artifacts) | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `runtime.builtin-tools` | config | `tools.allowedTools`, `tools.disallowedTools` | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.structured-output` | code | `runtimeOptions.outputSchema` (every Pi runtime route) | — | [Approval & structured output](/programmatic/approval-and-structured-output/) | — |
| `runtime.live-input` | auto + code | Slack/Telegram active-turn steering plus the web console's single server-authoritative Send path, with exact host-operation ownership, separate native acceptance, exact transcript consumption, uncertainty/no automatic retry, durable UUID receipts, and confirmed safe-preview `Steered` activity; custom `runtimeOptions.liveInput` | — | [Approval & structured output](/programmatic/approval-and-structured-output/#live-input-steering) | — |
| `runtime.approval-gates` | code | `createMonoRuntime({ onToolApprovalRequest, ... })` | — | [Approval & structured output](/programmatic/approval-and-structured-output/) | — |
| `runtime.custom` | code | `startMonoAgentApp({ runtime })` | — | [Composition](/programmatic/composition/) | — |

## Sandbox

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `sandbox.mode` | config | `sandbox.mode` | — | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.network-policy` | config | `sandbox.network.mode`, `sandbox.network.allowlist` | — | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.filesystem-scopes` | config | `sandbox.readableRoots`, `sandbox.writableRoots`, `sandbox.denyWrite` | — | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.fallback` | config | `sandbox.fallback`, `sandbox.unsafeAllowHostProcess` | — | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.monotonic-merge` | auto | (harness merges configured + request policies) | — | [Sandbox](/tools/sandbox/) | — |
| `sandbox.managed-srt` | cli + auto | `mono-agent sandbox status\| — |check`; automatic managed runtime resolution | — | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |

## Memory

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `memory.lite` | config | `memory.mode: "lite"`, `memory.path`, `memory.maxBytes`, `memory.writeMode` | — | [Capture & recall](/memory/capture-and-recall/) | — |
| `memory.journal` | config | `memory.mode: "journal"`, `memory.path`, `memory.embeddings.{provider,model,dim}` | — | [Embeddings](/memory/embeddings/) | — |
| `memory.bujo` | config | `memory.mode: "bujo"`, `memory.path`, `memory.embeddings.{provider,model,dim}`, `memory.llm.{provider,model,endpoint}` | — | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.bujo-consolidation` | config | `memory.consolidation.{enabled,cron}` | — | [Consolidation](/memory/rituals/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.bujo-cli` | cli | **Removed** — use config-aware `mono-agent memory <subcommand>` from the agent folder | — | [Validation & CLI](/memory/validation-and-cli/#memory-bujo-cli--removed) | — |
| `memory.preview-cli` | cli | `mono-agent memory stats\| — |show <date>\|search <query>\|top\|audit\|rebuild\|rollback [--limit <n>] [--json]`; owner-only `forget prepare\|apply\|restore` | — | [Validation & CLI](/memory/validation-and-cli/) | — |
| `memory.validate` | cli | `mono-agent validate [--consumer] [--config]` | — | [Validation & CLI](/memory/validation-and-cli/) | — |
| `memory.write-mode` | config | `memory.writeMode` | — | [Capture & recall](/memory/capture-and-recall/) | — |
| `memory.per-turn-capture` | config | `memory.writeMode: "capture"` (requires `memory.mode: "bujo"`) | — | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.recall-tool` | config | `memory.recallTool.enabled` | — | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.journal-browse` | config + auto | Shared `memory.recallTool.enabled`; local Lite/Journal/BuJo capability; policy-gated `MemoryJournal`; no new key | — | [Capture & recall](/memory/capture-and-recall/#the-memoryjournal-chronological-tool) | — |
| `memory.remember-tool` | config | `memory.rememberTool.enabled`; allowlist-gated `Remember`; bujo backend only | — | [Capture & recall](/memory/capture-and-recall/) | — |
| `memory.llm-timeout` | config | `memory.llm.timeoutMs` (in-app; 1000–600000, default 60000) | — | [Validation & CLI](/memory/validation-and-cli/#the-memory-llm-timeout) | — |
| `memory.custom-store` | code | `createConfiguredAgentResponder({ memory })` | — | [Composition](/programmatic/composition/) | — |

:::note
The entity graph that BuJo capture maintains is part of the BuJo capture pipeline; see [Capture & recall](/memory/capture-and-recall/#entity-graph-bujo-auto).
:::

## Context & skills

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `agent.public-name` | config | `agent.name` | — | [Identity & soul](/context/identity-and-soul/#public-agent-name) | — |
| `context.identity` | config | `context.identityPath` | — | [Identity & soul](/context/identity-and-soul/) | — |
| `context.soul` | config | `context.soulPath` | — | [Identity & soul](/context/identity-and-soul/) | — |
| `context.history` | auto | (owner-only disk-backed store; 64 messages per exact conversation id independent of `runtime.maxTurns`; aggregate committed defaults 256 MiB / 10,000 conversations / 365 inactive days plus an independent 256 MiB live-stage cap; staged atomic publication, immediate markerless-stage recovery, exact-key cross-process claims in fixed registry shards, bounded pre-provider dirty-fence retirement journals, provider epoch/revision coordination, exact-id durable transcript retirement, and post-commit pruning; custom store via `code`; completed blocking asks retain a bounded interaction transcript) | — | [Assembly](/context/assembly/) | — |
| `skills.selected-activation` | config | `context.skillsRoot`, `context.selectedSkills` | — | [Skills](/context/skills/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `skills.byte-capping` | config | `context.skillMaxBytes` | — | [Skills](/context/skills/) | — |

## Tools & MCP

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `tool-policy.allow-all` | config | omitted / `["*"]` = all tools (default; risk disclosed and reconfirmed unsandboxed in guided init) | — | [Tool policy](/tools/policy/) | — |
| `tool-policy.allowlist` / `tool-policy.denylist` | config | Pi runtime reports `tool_policy` as `projected` on every route; custom structural bridges without the field should be treated conservatively | — | [Tool policy](/tools/policy/) | — |
| `tool-policy.mcp-servers` | config | `tools.mcpConfigPath` | — | [MCP](/tools/mcp/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `agent-app.rich-replies` | config + auto | `PublishReplyFile` under allow-all, or name it in a restrictive `tools.allowedTools`; MCP Apps are capability-gated to an all-Pi-native route chain; retention follows `artifacts.retention.maxAgeDays` | — | [Reply files and MCP Apps](/tools/rich-replies/) | [Interactive transcription and large media](/playbooks/interactive-transcription-large-media/) |
| `agent-app.durable-continuations` | config + code | `tools.continuationServers`, `continuations.{enabled,host,port,stateDir,namedRoutes,detachedServices}` | `MONO_AGENT_CONTINUATION_SERVERS`; detached bearer env names are operator-selected | [Durable continuations](/tools/durable-continuations/) | — |
| `agent-app.run-history-tool` | auto | Guided settled-run recovery/list/ranked search plus compact, cursor-paged inspect over one logical conversation, including an exact SessionHistory handoff for cancelled/interrupted evidence; daily rollover-independent. `RunHistory` under allow-all; restrictive policy explicitly lists `RunHistory` (legacy policy alias `run_history`); no new config key | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `agent-app.session-history-tool` | auto | Crash-safe managed-tool invocation/result sidecar plus bounded `SessionHistory` search/get for the current logical conversation, with trusted navigation from invocation/result ids to exact isolated 8 KiB record reads; daily-rollover-independent. Automatic cold projection fails soft, while explicit reads fail closed. `SessionHistory` under allow-all; restrictive policy explicitly lists `SessionHistory` (legacy policy alias `session_history`); no new config key | — | [MCP](/tools/mcp/#sessionhistory-retained-tool-lifecycles) | — |
| `agent-app.memory-journal-tool` | config + auto | Request-scoped `MemoryJournal` over a frozen bounded local curated-memory snapshot. Shares the memory-read enablement, needs affirmative Lite/Journal/BuJo capability, and is normal-policy-gated; no config key or legacy alias | — | [MCP](/tools/mcp/#memoryjournal-curated-chronology) | — |
| `agent-app.web-conversation-title` | auto | Request-scoped `SetConversationTitle` for writable interactive web threads; names the conversation as a whole and is refined whenever a better whole-thread name emerges, never used as a status line; proposal-only result, with permanent user-rename precedence and no trigger/archive writes. Allow-all exposes it on compatible routes; restrictive policy explicitly lists it; direct OpenCode suppresses it; no new config key | — | [MCP](/tools/mcp/#setconversationtitle-web-conversation-naming) | — |
| `agent-app.adapter-send-tools` | config | auto-available under allow-all once the channel is enabled; a specific `tools.allowedTools` needs the exact names (`SlackSendMessage`, `TelegramSendMessage`) + valid `slack.*` / `telegram.*` config; confirmed posts are idempotently recorded in destination history | — | [Delivery & send tools](/channels/delivery-and-send-tools/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |
| `interaction.bridge` | config + auto | `interaction.bridge.{host,port}`, `interaction.askUser.timeoutMs` (default 600000; `null` disables automatic expiry), `interaction.progress.enabled`, `tools.mcpRequestContextServers`; auto-starts for configured send tools, allowed structured `AskUser`, configured interaction JSON/env, or enabled opted project-MCP progress | `MONO_AGENT_INTERACTION_BRIDGE_HOST`, `MONO_AGENT_INTERACTION_BRIDGE_PORT`, `MONO_AGENT_ASK_USER_TIMEOUT_MS` (`none` disables automatic expiry), `MONO_AGENT_PROGRESS_ENABLED`, `MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS` | [Delivery & send tools](/channels/delivery-and-send-tools/) | [Interactive transcription](/playbooks/interactive-transcription-large-media/) |
| `tool-policy.filesystem-roots` | config | `tools.filesystem.{readableRoots,writableRoots}`; extra managed file-tool roots while `sandbox.mode: "off"`, with write roots also readable and lexical plus realpath containment | — | [Sandbox](/tools/sandbox/) | — |

## Channels

Built-in channels are independent JSON sections: `telegram`, `slack`, `webhook`, `openaiApi`, `cron`, `tui`, and `live`. External channel packages are declared under `channels.plugins[]` and return the same `ChannelDriver` shape; the current cataloged channel extras are `@mono-agent/a2a-adapter`, `@mono-agent/whatsapp-adapter`, and `@mono-agent/messenger-adapter`. Most are opt-in via an `enabled` flag (default off); `tui` and `live` are default-on loopback operator surfaces. An off channel reports `disabled`; an enabled channel with incomplete config reports `waiting_for_config`. Adapter fields can also have `MONO_AGENT_<CHANNEL>_*` env vars.

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `telegram.long-polling` | config | `telegram.enabled`, `telegram.botToken`, `telegram.allowedChatIds` / `telegram.allowAllChats`, `telegram.groupMode` / `telegram.stripMentionText`, `telegram.pollWatchdogMs`, `telegram.transport.ipFamily` (+ built-in self-healing restart) | `MONO_AGENT_TELEGRAM_BOT_TOKEN`, `MONO_AGENT_TELEGRAM_*` | [Telegram](/channels/telegram/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `telegram.interactive` | config + code | built-in `/new`, plus `/model` and `/effort` via adapter `runtimeControls`; `telegram.commands[]`, `telegram.reactions`, `telegram.quietHours`; structured `AskUser` buttons/custom replies, non-blocking `TelegramSendMessage.reply_options`, and `TelegramSendFile` | `MONO_AGENT_TELEGRAM_REACTIONS`; runtime controls have no env key | [Telegram](/channels/telegram/) | — |
| `slack.ask-user` | auto + code | structured `AskUser` renders one Block Kit question at a time with option buttons, Other/custom thread reply, and multi-select Done; no Slack-specific config | — | [Slack](/channels/slack/#askuser-buttons-and-custom-replies) | — |
| `slack.socket-mode` | config | `slack.enabled`, `slack.botToken`, `slack.appToken`, `slack.allowedChannelIds` / `slack.allowAllChannels`, `slack.botUserIds`, `slack.mentionTextAliases`, `slack.stripMentionText`, `slack.unfurlLinks`, `slack.unfurlMedia`. When unset, preserves one readable authenticated self-mention marker; `true` restores legacy full stripping and `false` keeps raw mention forms. Omitted unfurl settings preserve Slack's current native-message defaults. Resilience tuning (all optional, on by default): `slack.heartbeatIntervalMs`, `slack.heartbeatTimeoutMs`, `slack.reconnectInitialBackoffMs`, `slack.reconnectMaxBackoffMs`, `slack.reconnectStabilityMs`, `slack.reconnectStartupGraceMs`, `slack.drainDeadlineMs` | `MONO_AGENT_SLACK_*` (incl. `MONO_AGENT_SLACK_UNFURL_LINKS`, `MONO_AGENT_SLACK_UNFURL_MEDIA`, `MONO_AGENT_SLACK_HEARTBEAT_*`, `MONO_AGENT_SLACK_RECONNECT_*`, `MONO_AGENT_SLACK_DRAIN_DEADLINE_MS`) | [Slack](/channels/slack/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `slack.speaker-names` | config | `slack.resolveUserNames` (default `true`); requires the `users:read` bot scope | `MONO_AGENT_SLACK_RESOLVE_USER_NAMES` | [Speaker names](/channels/slack/#speaker-names) | — |
| `channels.surface-awareness` | config | Always on for Slack and Telegram; `slack.resolveChannelNames` (default `true`) adds the Slack channel name and requires `channels:read`/`groups:read` | `MONO_AGENT_SLACK_RESOLVE_CHANNEL_NAMES` | [Surface awareness](/context/assembly/#surface-awareness) | — |
| `slack.thread-context` | config | `slack.threadContext.{enabled,maxMessages,requestLimit,timeoutMs,includeBotMessages}`; defaults `true`/`15`/`15`/`4000`/`true`; requires a `*:history` scope | `MONO_AGENT_SLACK_THREAD_CONTEXT_*` | [Thread and channel context](/channels/slack/#thread-and-channel-context) | — |
| `slack.shortcuts` | config | `slack.shortcuts[]: {callbackId, prompt, channelId?, ackText?, threadReply?}` | — (JSON-only; no environment-variable form) | [Slack shortcuts](/channels/slack/#shortcuts) | — |
| `slack.app-home` | config | `slack.homeTab: {enabled?, headerText?, buttons?:[{actionId, label, prompt, channelId?, ackText?, threadReply?}]}`; `enabled` defaults `false`, `buttons` defaults `[]` | — (JSON-only; no environment-variable form) | [Slack App Home](/channels/slack/#app-home) | — |
| `channel.plugins` | config | `channels.plugins[]: { package, id?, label?, config? }` | — | [Write your own channel adapter](/programmatic/custom-channels/) | — |
| `whatsapp.baileys` | config | `channels.plugins[].package: "@mono-agent/whatsapp-adapter"` plus plugin `config.{enabled,allowedChatJids,allowAllChats,groupMode,botJids,mentionTextAliases,stripMentionText}`. When unset, defaults to `true` only when `mentionTextAliases` is non-empty; `botJids` alone does not enable stripping, so otherwise it defaults to `false`. | `MONO_AGENT_WHATSAPP_*` | [WhatsApp](/channels/whatsapp/) | — |
| `messenger.graph` | config | `channels.plugins[].package: "@mono-agent/messenger-adapter"` plus plugin `config.{enabled,allowedUserIds,allowAllUsers,host,port,webhookPath,apiVersion,allowNonLoopback,proactiveMessagingType,proactiveTag}`; secrets via `MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN`, `MONO_AGENT_MESSENGER_APP_SECRET`, `MONO_AGENT_MESSENGER_VERIFY_TOKEN`. | `MONO_AGENT_MESSENGER_*` | [Messenger](/channels/messenger/) | — |
| `webhook.http-invoke` | config | `webhook.enabled`, `host`, `port`, `path`, `prompt`, `notify`, `notifyConversationId`, `defaultMode`, `allowNonLoopback`, `apiKey`, `retentionMs`, `maxStoredRequests`, `maxRunMs`, `webhook.endpoints[]` (incl. per-endpoint `model`/`effort`/`maxRunMs`; a request body may set `model`/`effort`, request winning over endpoint config; endpoint `maxRunMs` wins over the adapter fallback), `webhook.dir`; a non-loopback bind requires opt-in + bearer key | `MONO_AGENT_WEBHOOK_*` (incl. `MONO_AGENT_WEBHOOK_API_KEY`, `MONO_AGENT_WEBHOOK_MODEL`, `MONO_AGENT_WEBHOOK_EFFORT`, `MONO_AGENT_WEBHOOK_MAX_RUN_MS`), `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON`, `MONO_AGENT_WEBHOOK_DIR` | [Webhook](/channels/webhook/) | [Webhook automation (sync/async)](/playbooks/webhook-automation-sync-async/) |
| `openai-api.chat-completions` | config | `openaiApi.enabled`, `host`, `port`, `basePath`, `allowNonLoopback`, `apiKey`, `modelId`; non-loopback requires opt-in + key and wildcard binds report concrete client URLs | `MONO_AGENT_OPENAI_API_{ENABLED,HOST,PORT,BASE_PATH,ALLOW_NON_LOOPBACK,KEY,MODEL_ID}` | [OpenAI-compatible API](/channels/openai-api/) | [OpenAI endpoint + Open WebUI](/playbooks/openai-endpoint-open-webui/) |
| `a2a.provider` | config | `channels.plugins[].package: "@mono-agent/a2a-adapter"` plus plugin `config.provider.*` (including `maxRequestBytes`; durable identity: `provider.idempotency.{namespace,stateDir,retentionMs,maxRecords}`), `config.agent.*`, `config.skill.*` | `MONO_AGENT_A2A_*` | [A2A](/channels/a2a/) | [A2A provider & consumer](/playbooks/a2a-provider-and-consumer/) |
| `a2a.consumer` | config + code | plugin `config.consumer.{remoteAgentUrls,defaultRemoteAgentUrl,bearerToken,timeoutMs}`; `sendA2AMessage({idempotencyKey})` or `createA2AConsumerResponder({idempotencyKeyForRequest})` | `MONO_AGENT_A2A_*` | [A2A consumer](/programmatic/a2a-consumer/) | [A2A provider & consumer](/playbooks/a2a-provider-and-consumer/) |
| `tui.stream-endpoint` | config | `tui.{enabled,host,port,basePath,allowNonLoopback,apiKey}` — **on by default** (loopback web/ACP/jobs operator surface; `/v1/info` separately advertises additive attachment, legacy verbatim-history, canonical v1 context import, exact structured AskUser, and agent-owned cron capabilities without a wire-schema bump) | `MONO_AGENT_TUI_*` | [Operator stream endpoint](/channels/tui/) | — |
| `acp.worklab-bridge` | cli + code | `mono-agent bridge acp --discover`; `mono-agent bridge acp --source-id <id>`; `discoverAcpBridgeAgents()` | — | [ACP bridge](/programmatic/acp-bridge/) | — |
| `cron.scheduled-prompts` | config | `cron.jobs[]: {id, enabled, expression, timezone, prompt, conversationId, maxRunMs, notify, notifyConversationId, notifyFailureCooldownHours, model, effort}`, `cron.dir`; durable agent-owned run history; opt-in confirmed/idempotent/audited operator API controls via `cron.operatorActions.enabled` (default off; runtime enable state never rewrites config) | `MONO_AGENT_CRON_JOBS_JSON`, `MONO_AGENT_CRON_*` (incl. `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS`, `MONO_AGENT_CRON_MODEL`, `MONO_AGENT_CRON_EFFORT`, `MONO_AGENT_CRON_OPERATOR_ACTIONS_ENABLED`), `MONO_AGENT_CRON_DIR` | [Cron](/channels/cron/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |
| `cron.run-watchdog` | config + code | `jobs[].maxRunMs` or `maxRunMs` frontmatter; programmatic fallback via `startCronAdapter` | — | [Cron](/channels/cron/#run-watchdog-a-wedged-run-is-aborted-not-left-to-starve) | — |
| `cron.preflight-gate` | config + code | `cron.jobs[].preflight` (explicit argv; frontmatter takes one single-line JSON array) and `cron.jobs[].preflightTimeoutMs` (default 5000, cap 60000); programmatic `startCronAdapter({ preflight, onPreflight, preflightTimeoutMs })` | `MONO_AGENT_CRON_PREFLIGHT_JSON`, `MONO_AGENT_CRON_PREFLIGHT_TIMEOUT_MS` | [Cron](/channels/cron/#preflight-gates-skip-work-not-ticks) | — |
| `channel.native-notify` | config | per cron job / webhook endpoint `notify`; explicit `notifyConversationId` wins, including exact `web:new` for one new marked web thread per result; web is never inferred and other `web:*` values reject; otherwise infer only with exactly one notify-capable Telegram/Slack candidate; 0 or 2+ candidates skip with a warning; cron model-exhaustion notices require explicit `notifyConversationId`, never infer, and may set `notifyFailureCooldownHours`; Telegram/Slack stay bounded by channel allowlists, while web requires the running local console and is one-attempt/no-outbox | `MONO_AGENT_CRON_NOTIFY`, `MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID`, `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS` (+ webhook equivalents except cooldown) | [Delivery & send tools](/channels/delivery-and-send-tools/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |
| `channel.final-only-delivery` | code | Adapter `stream.finalOnly` (default `true` for telegram/slack; answer deltas stay hidden while a transient tool ledger may be visible) | — | [Delivery & send tools](/channels/delivery-and-send-tools/) | — |
| `channel.transient-tool-activity` | code | `ResilientMessageStream({ finalOnly: true, showHints: true })`; terminal subagent groups remove child tool lines but retain metrics plus an optional bounded `Result`/`Reason`; proactive delivery forces `showHints: false`; Telegram and Slack post the answer separately then best-effort delete progress; optional transport deletion also supports `/cancel` cleanup | — | [Delivery & send tools](/channels/delivery-and-send-tools/) | — |
| `channel.stream-tuning` | code | Adapter `stream` / `messages` options (`createTelegramChannelDriver` etc.) | — | [Write your own channel adapter](/programmatic/custom-channels/) | — |
| `channel.custom` | config + code | `channels.plugins[]` package loading or `startMonoAgentApp({ drivers })` (implement `ChannelDriver`) | — | [Write your own channel adapter](/programmatic/custom-channels/) | — |

## Observability

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `observability.jsonl-artifacts` | config | `artifacts.dir`, `artifacts.retention.{maxAgeDays,maxCount,dryRun}`, `artifacts.memoryRetention.{maxAgeDays,maxCount,dryRun}` | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.latency-attribution` | auto | (emitted into run JSONL artifacts) | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.trace-registry` | config | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs}` | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.artifact-audit` | cli / code | `auditRecordedRuns(artifactDir, { staleAfterMs })`; `mono-agent runs audit [--artifacts <path> \| — | — | [Artifacts & traces](/observability/artifacts-and-traces/#run-status-and-stale-run-reconciliation) | — |
| `observability.artifact-metrics` | cli / code | `summarizeRecordedRunMetrics({ artifactDir, since, until, groupBy })`; `mono-agent runs report [--artifacts] [--since] [--until] [--by] [--json]` | — | [Artifacts & traces](/observability/artifacts-and-traces/#artifact-metrics) | — |
| `observability.stale-run-reconciliation` | auto | (`reconcileStaleRunArtifacts()` at startup over `artifacts.dir`; rewrites orphaned `running` → `interrupted`) | — | [Artifacts & traces](/observability/artifacts-and-traces/#run-status-and-stale-run-reconciliation) | — |
| `web.console` | cli | `mono-agent web [start|restart|stop|status|logs|run|reset]`; OS-hostname header/title/PWA identity overridable by persisted `--name <label>`; `--name -` restores the hostname default; persisted `--theme evergreen|ocean|plum|terracotta`; fresh default `127.0.0.1:5050` with explicit `--host <addr>` widening; `--loopback`; macOS `--share-tailnet` for a new owned Tailscale route (existing exact routes re-verified); `status --json` reports listener and owned route separately; persistent source-bound threads, requested/attempted/executed route attribution and remembered host-wake selection, server-side full-text conversation search over titles and message prose (FTS5; archived included, reasoning and tool payloads excluded), clustered activity timeline with per-tool durations, exact durable structured AskUser controls, stable read-only cron channels with bounded keyset history and a quiet cadence/next-run header (operator API actions remain available), ephemeral capability-gated provider-auth status/login in Agent settings, archive/reset, browser-device attachments, per-conversation `message.delta` subscription with conditional revalidation, service-boundary transcript shaping with on-demand full bodies, origin-local device cache with **Clear cached data**, browser-local Auto/Lean/Full data mode and session byte meter, conflict-safe Tailscale Serve HTTPS | — (no application auth; trusted LAN/tailnet boundary; provider-auth routes require exact origin plus agent operator authentication; cron mutations additionally require agent operator authentication and opt-in) | [Web console](/observability/web-console/) | — |

## Execution & composition

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `app.cli-init` | cli | `--name`, exact `IDENTITY.md` → `## Role` prompt/outcome, managed project skills, `--preset` (legacy `--recipe` removed), canonical repeated `--fallback`/`--fallback-effort` (legacy `--fallback-models` removed), `--auth`; any flag/non-TTY remains scaffold-only | — | [Quickstart](/getting-started/quickstart/) | — |
| `app.cli-setup` | cli | bare TTY `mono-agent init`: searchable catalogs, Escape-back, optional-capabilities gate (channels/memory, default No for the custom journey), concrete review, all-route proof, interrupt resume/restart; macOS starts the background agent and prints the browser-first handoff (`status` → `mono-agent web run --loopback` → `http://127.0.0.1:5050`), while unsupported platforms print the manual start plus the same console command | — | [CLI reference](/observability/cli-reference/#init) | — |
| `app.secure-secret-persistence` | cli | fail-closed owner-only `.env` merge + external lock + pathname no-clobber/recovery checks; Windows manual only | channel/provider-native secret vars | [Env vars](/config/env-vars/) | — |
| `app.provider-auth` | cli | `mono-agent auth login <provider> [--pi-auth-path] [--api-key-stdin]`; Agent settings honest passive status, explicit bounded live checks, plus Pi-native GitHub/OpenAI device code, Anthropic paste-back, and masked provider API-key prompts; shared owner-only locked/no-clobber Pi-store write | — | [CLI reference](/observability/cli-reference/#auth-login), [Providers](/runtime/providers/#provider-authentication-in-agent-settings) | — |
| `app.cli-presets` | cli | `mono-agent presets list \| show <id>` (old `recipes` alias removed) | — | [Presets & modules](/reference/presets/) | — |
| `app.cli-no-tools-guardrail` | cli | part of `mono-agent validate` / `doctor`; the tools step of `mono-agent init` | — | [Presets & modules](/reference/presets/#the-tools-step-and-the-no-tools-guardrail) | — |
| `app.cli-validate` | cli | `mono-agent validate [--consumer] [--config] [--env-file]` | — | [Blueprint](/config/blueprint/) | — |
| `app.provider-credentials-check` | cli | part of `mono-agent validate`; primary/fallback/memory/enabled static trigger refs; exact Pi built-in model + `providers.piAuthPath`, or custom model/key contract through `providers.local[]` | — | [CLI reference](/observability/cli-reference/#provider-credentials) | — |
| `app.cli-start` | cli | `mono-agent start [--config] [--env-file] [--foreground]` | — | [Install](/getting-started/install/) | — |
| `app.cli-stop` | cli | `mono-agent stop [--config]` | — | [Install](/getting-started/install/) | — |
| `app.cli-logs` | cli | `mono-agent logs [--config] [--follow\|-f] [--lines <n>]` | — | [CLI reference](/observability/cli-reference/) | — |
| `app.cli-restart-clean` | cli | `mono-agent restart [--config] [--clear-sessions]` | — | [CLI reference](/observability/cli-reference/) | — |
| `app.managed-project-skills` | cli + config | generated `mono-agent-memory`; retired `mono-agent-configure` is ignored at runtime and reported as waiting until `mono-agent install-skill --project --update` safely removes exact managed legacy state | — | [Skills](/context/skills/) | — |
| `app.docs-mcp-companion` | cli + code | `mono_agent_docs({action: "search", query, limit?, scope?})`; `mono_agent_docs({action: "read", target})`; expanded `mono-agent-docs://chunk/{chunkId}` resources | — | [Documentation MCP companion](/tools/documentation-mcp/) | — |
| `app.cli-install-skill` | cli | `mono-agent install-skill [--target claude\|codex\|both] [--force] [--no-docs-mcp]`; `--project --check` reports four active and four retirement states; `--project --update` transactionally updates active state and retires only exact managed legacy state | — | [CLI reference](/observability/cli-reference/) | — |
| `app.cli-web` | cli | bare read-only status/help; `web start\|restart\|stop\|status\|logs\|run\|reset`; `--host <addr> \| --loopback`, `--port <n>`, `--theme <name>` on start/restart/run; restart retains the stored theme; status reports it; reset requires `--all --yes` | — | [Web console](/observability/web-console/) | — |
| `app.env-file` | cli | automatic; `--env-file <path>` to override | — | [Env vars](/config/env-vars/) | — |
| `harness.failure-handling` | auto | (built into every run) | — | [Composition](/programmatic/composition/) | — |
| `harness.external-summary-safety` | auto | public harness/webhook summaries exclude `systemPrompt`; private artifacts retain it | — | [Artifacts & traces](/observability/artifacts-and-traces/) | [Webhook automation](/playbooks/webhook-automation-sync-async/) |
| `agent-app.blocking-ask-history` | auto | app interaction journal + configured harness history commit; no config key | — | [Assembly](/context/assembly/#conversation-history) | [Interactive long jobs](/playbooks/interactive-transcription-large-media/) |
| `harness.request-runtime-options` | code | `createConfiguredAgentResponder({ runtimeOptionsForRequest })` | — | [Composition](/programmatic/composition/) | — |
| `orchestrator.ask-collaborator` | code | `createCollaboratorToolRuntimeExtension` + `runtimeOptionsForRequest` | — | [Multi-agent](/programmatic/multi-agent/) | [Multi-agent orchestration](/playbooks/multi-agent-orchestration/) |
## Notes on coverage types

A `code`-only feature has no `mono-agent.config.json` key — you reach it through `startMonoAgentApp` options or lower-level packages. See [Programmatic API](/programmatic/) for the entry points referenced above (`createConfiguredAgentResponder`, `createMonoRuntime`, `createCollaboratorToolRuntimeExtension`, custom `ChannelDriver`/`runtime`/`memory`/`historyStore` injection).

:::note
Two registry rows carry a non-standard coverage label: `runtime.context-compaction` is `config + provider` (configured through `runtime.compaction.*`, executed by the pi bridge) and `a2a.consumer` is `config + code` (settings live in plugin config, but invoking remote agents is programmatic).
:::
