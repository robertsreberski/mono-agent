---
title: "Feature matrix"
parent: "Reference"
nav_order: 1
---

# Feature matrix

A scannable projection of every mono-agent capability for non-linear readers: each feature id mapped to its coverage type, the config key(s) and env var(s) that reach it, the prose page that explains it, and any playbook that puts it to work.

[`docs/feature-registry.md`](../feature-registry.md) is the canonical long-form source of truth — when this matrix and the registry disagree, the registry wins. This page projects the same rows into a grid for quick lookup.

## Coverage legend

| Code | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json` (env var override always available) |
| `cli` | Reached through a `mono-agent` CLI flag/command |
| `auto` | Always active when the app runs; needs no declaration |
| `code` | Programmatic escape hatch only — see [Programmatic API](../programmatic/index.md) |
| `dev` | Development/test-time tooling, not part of a running agent |

Env precedence everywhere: process env > `mono-agent.config.json` > built-in defaults.

## Runtime

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `runtime.multi-backend` | config | `runtime.model` | `MONO_AGENT_MODEL` | [Backends](../runtime/backends.md) | [Multi-model fallback](../playbooks/multi-model-fallback-chain.md) |
| `runtime.execution-modes` | config | `runtime.executionMode` | `MONO_AGENT_EXECUTION_MODE` | [Backends](../runtime/backends.md) | — |
| `runtime.fallback-models` | config | `runtime.fallbackModels` | `MONO_AGENT_FALLBACK_MODELS` | [Fallback](../runtime/fallback.md) | [Multi-model fallback](../playbooks/multi-model-fallback-chain.md) |
| `runtime.effort` | config | `runtime.effort` | `MONO_AGENT_EFFORT` | [Execution, effort, permissions](../runtime/execution-effort-permissions.md) | — |
| `runtime.permission-mode` | config | `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | [Execution, effort, permissions](../runtime/execution-effort-permissions.md) | [Sandboxed code agent](../playbooks/sandboxed-code-agent.md) |
| `runtime.reasoning-summary` | config | `runtime.reasoningSummary` | `MONO_AGENT_REASONING_SUMMARY` | [Execution, effort, permissions](../runtime/execution-effort-permissions.md) | — |
| `runtime.max-turns` | config | `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | [Backends](../runtime/backends.md) | — |
| `runtime.workspace` | config | `runtime.workspace` | `MONO_AGENT_WORKSPACE` | [Backends](../runtime/backends.md) | — |
| `runtime.provider-sessions` | config | `runtime.session.mode`, `runtime.session.idleTimeoutMs` | `MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS` | [Sessions & concurrency](../runtime/sessions-concurrency.md) | — |
| `runtime.concurrency` | config | `concurrency.maxConcurrentRuns`, `concurrency.maxPendingRuns` | `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`, `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS` | [Sessions & concurrency](../runtime/sessions-concurrency.md) | — |
| `runtime.local-providers` | config | `providers.local[]` | `MONO_AGENT_LOCAL_PROVIDERS_JSON`, `MONO_AGENT_LOCAL_PROVIDER_*` | [Local providers](../runtime/local-providers.md) | [Local-only Ollama agent](../playbooks/local-only-ollama-agent.md) |
| `runtime.pi-oauth` | config | `providers.piAuthPath` | `MONO_AGENT_PI_AUTH_PATH` | [Local providers](../runtime/local-providers.md) | — |
| `runtime.pi-native-tuning` | config | `providers.piNative.piMaxRetries`, `providers.piNative.maxRetryDelayMs`, `providers.piNative.piSessionsRoot` | `MONO_AGENT_PI_MAX_RETRIES`, `MONO_AGENT_MAX_RETRY_DELAY_MS`, `MONO_AGENT_PI_SESSIONS_ROOT` | [Sessions & concurrency](../runtime/sessions-concurrency.md) | — |
| `runtime.tool-parallelism` | code | `runtimeOptions.piToolParallelismMode` | — | [Tools & guards](../runtime/tools-and-guards.md) | — |
| `runtime.webfetch-retry` | auto | (built into WebFetch) | — | [Tools & guards](../runtime/tools-and-guards.md) | — |
| `runtime.context-compaction` | provider + settings | `agent_compaction_*` (pi-native settings) | — | [Sessions & concurrency](../runtime/sessions-concurrency.md) | — |
| `runtime.tool-bloat-guard` | auto | (artifacts land in `artifacts.dir`) | `MONO_AGENT_ARTIFACT_DIR` | [Tools & guards](../runtime/tools-and-guards.md) | — |
| `runtime.cost-tracking` | auto | (recorded in JSONL artifacts) | — | [Artifacts & traces](../observability/artifacts-and-traces.md) | [Eval suite: trajectory & cost](../playbooks/eval-suite-trajectory-cost.md) |
| `runtime.builtin-tools` | config | `tools.allowedTools`, `tools.disallowedTools` | `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` | [Tools & guards](../runtime/tools-and-guards.md) | — |
| `runtime.structured-output` | code | `runtimeOptions.outputSchema` | — | [Approval & structured output](../programmatic/approval-and-structured-output.md) | — |
| `runtime.live-input` | code | `runtimeOptions.liveInput` | — | [Composition](../programmatic/composition.md) | — |
| `runtime.approval-gates` | code | `createMonoRuntime({ onToolApprovalRequest, ... })` (config posture: `runtime.permissionMode`) | `MONO_AGENT_PERMISSION_MODE` | [Approval & structured output](../programmatic/approval-and-structured-output.md) | — |
| `runtime.custom` | code | `startMonoAgentApp({ runtime })` | — | [Composition](../programmatic/composition.md) | — |

## Sandbox

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `sandbox.mode` | config | `sandbox.mode` | `MONO_AGENT_SANDBOX_MODE` | [Sandbox](../tools/sandbox.md) | [Sandboxed code agent](../playbooks/sandboxed-code-agent.md) |
| `sandbox.network-policy` | config | `sandbox.network.mode`, `sandbox.network.allowlist` | `MONO_AGENT_SANDBOX_NETWORK`, `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` | [Sandbox](../tools/sandbox.md) | [Sandboxed code agent](../playbooks/sandboxed-code-agent.md) |
| `sandbox.filesystem-scopes` | config | `sandbox.readableRoots`, `sandbox.writableRoots`, `sandbox.denyWrite` | `MONO_AGENT_SANDBOX_READABLE_ROOTS`, `MONO_AGENT_SANDBOX_WRITABLE_ROOTS`, `MONO_AGENT_SANDBOX_DENY_WRITE` | [Sandbox](../tools/sandbox.md) | [Sandboxed code agent](../playbooks/sandboxed-code-agent.md) |
| `sandbox.fallback` | config | `sandbox.fallback`, `sandbox.unsafeAllowHostProcess` | `MONO_AGENT_SANDBOX_FALLBACK`, `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS` | [Sandbox](../tools/sandbox.md) | [Sandboxed code agent](../playbooks/sandboxed-code-agent.md) |
| `sandbox.monotonic-merge` | auto | (harness merges configured + request policies) | — | [Sandbox](../tools/sandbox.md) | — |

## Memory

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `memory.lite` | config | `memory.mode: "lite"`, `memory.path`, `memory.maxBytes`, `memory.writeMode` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_WRITE_MODE` | [Capture & recall](../memory/capture-and-recall.md) | — |
| `memory.journal` | config | `memory.mode: "journal"`, `memory.path`, `memory.embeddings.{provider,model,dim}` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_EMBEDDINGS_*` | [Embeddings](../memory/embeddings.md) | — |
| `memory.bujo` | config | `memory.mode: "bujo"`, `memory.path`, `memory.embeddings.{provider,model,dim}`, `memory.llm.{provider,model,executionMode,endpoint}` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_EMBEDDINGS_*`, `MONO_AGENT_MEMORY_LLM_*` | [Capture & recall](../memory/capture-and-recall.md) | [Telegram BuJo assistant](../playbooks/telegram-personal-assistant-bujo.md) |
| `memory.bujo-reflection` | config | `memory.reflection.{enabled,cron}` | `MONO_AGENT_MEMORY_REFLECTION_CRON`, `MONO_AGENT_MEMORY_REFLECTION_ENABLED` | [Rituals](../memory/rituals.md) | [Telegram BuJo assistant](../playbooks/telegram-personal-assistant-bujo.md) |
| `memory.bujo-migration` | config | `memory.migration.{enabled,cron}` | `MONO_AGENT_MEMORY_MIGRATION_CRON`, `MONO_AGENT_MEMORY_MIGRATION_ENABLED` | [Rituals](../memory/rituals.md) | [Telegram BuJo assistant](../playbooks/telegram-personal-assistant-bujo.md) |
| `memory.bujo-cli` | cli | `memory-bujo rebuild\|recall\|index\|reflect\|migrate <root>` | `MONO_AGENT_MEMORY_EMBEDDINGS_*`, `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_ENDPOINT` | [Validation & CLI](../memory/validation-and-cli.md) | — |
| `memory.validate` | cli | `mono-agent validate [--config]` | — | [Validation & CLI](../memory/validation-and-cli.md) | — |
| `memory.write-mode` | config | `memory.writeMode` | `MONO_AGENT_MEMORY_WRITE_MODE` | [Capture & recall](../memory/capture-and-recall.md) | — |
| `memory.per-turn-capture` | config | `memory.writeMode: "capture"` (requires `memory.mode: "bujo"`) | `MONO_AGENT_MEMORY_WRITE_MODE=capture`, `MONO_AGENT_MEMORY_MODE=bujo` | [Capture & recall](../memory/capture-and-recall.md) | [Telegram BuJo assistant](../playbooks/telegram-personal-assistant-bujo.md) |
| `memory.recall-tool` | config | `memory.recallTool.enabled` | `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | [Capture & recall](../memory/capture-and-recall.md) | [Telegram BuJo assistant](../playbooks/telegram-personal-assistant-bujo.md) |
| `memory.custom-store` | code | `createConfiguredAgentResponder({ memory })` | — | [Composition](../programmatic/composition.md) | — |

The entity graph that BuJo capture maintains is documented separately in [Entity graph](../memory/entity-graph.md).
{: .note }

## Context & skills

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `context.identity` | config | `context.identityPath` | `MONO_AGENT_IDENTITY_PATH` | [Identity & soul](../context/identity-and-soul.md) | — |
| `context.soul` | config | `context.soulPath` | `MONO_AGENT_SOUL_PATH` | [Identity & soul](../context/identity-and-soul.md) | — |
| `context.history` | auto | (sized from `runtime.maxTurns`; custom store via `code`) | `MONO_AGENT_MAX_TURNS` | [Assembly](../context/assembly.md) | — |
| `skills.selected-activation` | config | `context.skillsRoot`, `context.selectedSkills` | `MONO_AGENT_SKILLS_ROOT`, `MONO_AGENT_SELECTED_SKILLS` | [Skills](../context/skills.md) | [Slack team bot + MCP tools](../playbooks/slack-team-bot-mcp-tools.md) |
| `skills.byte-capping` | config | `context.skillMaxBytes` | `MONO_AGENT_SKILL_MAX_BYTES` | [Skills](../context/skills.md) | — |

## Tools & MCP

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `tool-policy.fail-closed` | auto | (default when `tools` lists are empty) | — | [Tool policy](../tools/policy.md) | — |
| `tool-policy.allowlist` / `tool-policy.denylist` | config | `tools.allowedTools`, `tools.disallowedTools` | `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` | [Tool policy](../tools/policy.md) | — |
| `tool-policy.mcp-servers` | config | `tools.mcpConfigPath` | `MONO_AGENT_MCP_CONFIG_PATH` | [MCP](../tools/mcp.md) | [Slack team bot + MCP tools](../playbooks/slack-team-bot-mcp-tools.md) |
| `agent-app.adapter-send-tools` | config | `tools.allowedTools` (`slack_send_message`, `telegram_send_message`) + valid `slack.*` / `telegram.*` config | `MONO_AGENT_ALLOWED_TOOLS` | [Delivery & send tools](../channels/delivery-and-send-tools.md) | [Cron digest + proactive notify](../playbooks/cron-digest-proactive-notify.md) |

## Channels

All channels are independent JSON sections and opt-in via an `enabled` flag (default off). An off channel reports `disabled`; an enabled channel with incomplete config reports `waiting_for_config`. Every field also has a `MONO_AGENT_<CHANNEL>_*` env var.

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `telegram.long-polling` | config | `telegram.enabled`, `telegram.botToken`, `telegram.allowedChatIds` / `telegram.allowAllChats` | `MONO_AGENT_TELEGRAM_*` | [Telegram](../channels/telegram.md) | [Telegram BuJo assistant](../playbooks/telegram-personal-assistant-bujo.md) |
| `slack.socket-mode` | config | `slack.enabled`, `slack.botToken`, `slack.appToken`, `slack.allowedChannelIds` / `slack.allowAllChannels`, `slack.botUserIds`, `slack.mentionTextAliases`, `slack.stripMentionText` | `MONO_AGENT_SLACK_*` | [Slack](../channels/slack.md) | [Slack team bot + MCP tools](../playbooks/slack-team-bot-mcp-tools.md) |
| `whatsapp.baileys` | config | `whatsapp.enabled`, `whatsapp.allowedChatJids` / `whatsapp.allowAllChats`, `whatsapp.groupMode`, `whatsapp.botJids`, `whatsapp.mentionTextAliases`, `whatsapp.stripMentionText` | `MONO_AGENT_WHATSAPP_*` | [WhatsApp](../channels/whatsapp.md) | — |
| `webhook.http-invoke` | config | `webhook.enabled`, `host`, `port`, `path`, `prompt`, `defaultMode`, `allowNonLoopback`, `retentionMs`, `maxStoredRequests`, `webhook.endpoints[]`, `webhook.dir` | `MONO_AGENT_WEBHOOK_*`, `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON`, `MONO_AGENT_WEBHOOK_DIR` | [Webhook](../channels/webhook.md) | [Webhook automation (sync/async)](../playbooks/webhook-automation-sync-async.md) |
| `openai-api.chat-completions` | config | `openaiApi.enabled`, `host`, `port`, `basePath`, `allowNonLoopback`, `apiKey`, `modelId` | `MONO_AGENT_OPENAI_API_*` | [OpenAI-compatible API](../channels/openai-api.md) | [OpenAI endpoint + Open WebUI](../playbooks/openai-endpoint-open-webui.md) |
| `a2a.provider` | config | `a2a.provider.*`, `a2a.agent.*`, `a2a.skill.*` | `MONO_AGENT_A2A_*` | [A2A](../channels/a2a.md) | [A2A provider & consumer](../playbooks/a2a-provider-and-consumer.md) |
| `a2a.consumer` | config + code | `a2a.consumer.{remoteAgentUrls,defaultRemoteAgentUrl,bearerToken,timeoutMs}`; invocation via `createA2AConsumerResponder` | `MONO_AGENT_A2A_*` | [A2A consumer](../programmatic/a2a-consumer.md) | [A2A provider & consumer](../playbooks/a2a-provider-and-consumer.md) |
| `cron.scheduled-prompts` | config | `cron.jobs[]: {id, enabled, expression, timezone, prompt, conversationId}`, `cron.dir` | `MONO_AGENT_CRON_JOBS_JSON`, `MONO_AGENT_CRON_*`, `MONO_AGENT_CRON_DIR` | [Cron](../channels/cron.md) | [Cron digest + proactive notify](../playbooks/cron-digest-proactive-notify.md) |
| `channel.final-only-delivery` | code | Adapter `stream.finalOnly` (default `true` for telegram/slack) | — | [Delivery & send tools](../channels/delivery-and-send-tools.md) | — |
| `channel.stream-tuning` | code | Adapter `stream` / `messages` options (`createTelegramChannelDriver` etc.) | — | [Custom channels](../programmatic/custom-channels.md) | — |
| `channel.custom` | code | `startMonoAgentApp({ drivers })` (implement `ChannelDriver`) | — | [Custom channels](../programmatic/custom-channels.md) | — |

## Observability

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `observability.jsonl-artifacts` | config | `artifacts.dir` | `MONO_AGENT_ARTIFACT_DIR` | [Artifacts & traces](../observability/artifacts-and-traces.md) | — |
| `observability.latency-attribution` | auto | (emitted into run JSONL artifacts) | — | [Artifacts & traces](../observability/artifacts-and-traces.md) | — |
| `observability.trace-registry` | config | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs}` | `MONO_AGENT_TRACE_*` | [Artifacts & traces](../observability/artifacts-and-traces.md) | — |
| `observability.phoenix-exporter` | config | `observability.exporters[]: {type:"phoenix", endpoint, projectName, includeSensitiveData, headers, timeoutMs}` | `MONO_AGENT_OBSERVABILITY_EXPORTERS` | [Phoenix & backfill](../observability/phoenix-and-backfill.md) | [Phoenix-observed agent](../playbooks/phoenix-observed-agent.md) |
| `observability.backfill` | cli | `mono-agent backfill (--run <id> \| --all) [--since] [--until] [--dry-run]` | — | [Phoenix & backfill](../observability/phoenix-and-backfill.md) | [Backfill historical runs](../playbooks/backfill-historical-runs.md) |
| `tui.chat` | cli | `mono-agent-tui --config ./mono-agent.config.json` | — | [TUI](../observability/tui.md) | — |

## Execution & composition

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `app.cli-init` | cli | `mono-agent init [--model] [--fallback-models] [--memory]` | — | [Quickstart](../getting-started/quickstart.md) | — |
| `app.cli-validate` | cli | `mono-agent validate [--config] [--env-file]` | — | [Blueprint](../config/blueprint.md) | — |
| `app.cli-start` | cli | `mono-agent start [--config] [--env-file] [--foreground\|-f]` | — | [Install](../getting-started/install.md) | — |
| `app.cli-stop` | cli | `mono-agent stop [--config]` | — | [Install](../getting-started/install.md) | — |
| `app.cli-logs` | cli | `mono-agent logs [--config] [--follow\|-f] [--lines <n>]` | — | [CLI reference](../observability/cli-reference.md) | — |
| `app.cli-restart-clean` | cli | `mono-agent restart [--config] [--force]` | — | [CLI reference](../observability/cli-reference.md) | — |
| `app.cli-install-skill` | cli | `mono-agent install-skill [--target claude\|codex\|both] [--force]` | — | [CLI reference](../observability/cli-reference.md) | — |
| `app.env-file` | cli | automatic; `--env-file <path>` to override | — | [Env vars](../config/env-vars.md) | — |
| `harness.failure-handling` | auto | (built into every run) | — | [Composition](../programmatic/composition.md) | — |
| `harness.request-runtime-options` | code | `createConfiguredAgentResponder({ runtimeOptionsForRequest })` | — | [Composition](../programmatic/composition.md) | — |
| `orchestrator.ask-collaborator` | code | `createCollaboratorToolRuntimeExtension` + `runtimeOptionsForRequest` | — | [Multi-agent](../programmatic/multi-agent.md) | [Multi-agent orchestration](../playbooks/multi-agent-orchestration.md) |
| `evals.scenarios` | dev | `@mono-agent/agent-evals` (`defineAgentEvalScenario`, `runAgentEvalSuite`) | `MONO_AGENT_EVAL_LIVE=1` | [Evals](../evals/index.md) | [Eval suite: trajectory & cost](../playbooks/eval-suite-trajectory-cost.md) |

## Notes on coverage types

A `code`-only feature has no `mono-agent.config.json` key — you reach it through `startMonoAgentApp` options or lower-level packages. See [Programmatic API](../programmatic/index.md) for the entry points referenced above (`createConfiguredAgentResponder`, `createMonoRuntime`, `createCollaboratorToolRuntimeExtension`, custom `ChannelDriver`/`runtime`/`memory`/`historyStore` injection).

Two registry rows carry a non-standard coverage label: `runtime.context-compaction` is `provider + settings` (driven by the pi bridge, tuned via `agent_compaction_*` pi-native settings) and `a2a.consumer` is `config + code` (settings live in config, but invoking remote agents is programmatic).
{: .note }
