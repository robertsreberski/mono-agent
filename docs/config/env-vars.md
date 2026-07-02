---
title: "Environment variables"
sidebar:
  order: 2
---

# Environment variables

Every field in `mono-agent.config.json` also has a `MONO_AGENT_*` environment variable that overrides it. This page is the exhaustive reference, grouped by domain, with the JSON key each variable overrides. For the full annotated config see [blueprint.md](/config/blueprint/).

## Precedence and `.env` loading

The resolution order is **env > JSON > built-in defaults**. An environment variable always wins over the matching key in `mono-agent.config.json`, which wins over the framework default.

A `.env` file in the agent folder is loaded automatically by the CLI. Variables already exported in your shell take precedence over values in `.env` (exported shell vars win). Pass `--env-file <path>` to load an alternate file instead of `./.env`. For `mono-agent validate --consumer <path>`, the consumer folder's `.env` loads by default, and relative `--env-file` paths resolve inside that consumer folder.

:::caution
Secrets belong in `.env` (or exported shell vars), never in `mono-agent.config.json`, which is meant to be committed. Keep `.env` untracked.

`mono-agent config` and `mono-agent validate` warn when a secret-marked field is resolved from committed JSON and name the matching `MONO_AGENT_*` variable to move it to. The warning is advisory and non-fatal.
:::

:::note
Provider API keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are **provider-native** variables, not `MONO_AGENT_*` ones. Reference them from config via `apiKeyEnv` (for local providers) rather than inlining a key. See [../runtime/local-providers.md](/runtime/local-providers/) and [../runtime/backends.md](/runtime/backends/).
:::

## Runtime

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_MODEL` | `runtime.model` | Backend-prefixed model, e.g. `claude:claude-sonnet-4-6`, `codex:gpt-5.5`, `pi:openai:gpt-5.5`. Required. |
| `MONO_AGENT_EXECUTION_MODE` | `runtime.executionMode` | `sdk` vs `cli`; default inferred from model. |
| `MONO_AGENT_FALLBACK_MODELS` | `runtime.fallbackModels` | Ordered backup models on retryable failure. See [../runtime/fallback.md](/runtime/fallback/). |
| `MONO_AGENT_EFFORT` | `runtime.effort` | `none` / `low` / `medium` / `high` / `xhigh` / `max`. See [../runtime/execution-effort-permissions.md](/runtime/execution-effort-permissions/). |
| `MONO_AGENT_PERMISSION_MODE` | `runtime.permissionMode` | `default` / `plan` / `acceptEdits` / `bypassPermissions` (CLI backends). |
| `MONO_AGENT_MAX_TURNS` | `runtime.maxTurns` | Turn cap per run; omitted or `0` means unlimited. |
| `MONO_AGENT_WORKSPACE` | `runtime.workspace` | Working directory for runtime tools. |
| `MONO_AGENT_SESSION_MODE` | `runtime.session.mode` | Continuous provider session mode per conversation. |
| `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS` | `runtime.session.idleTimeoutMs` | Idle eviction window for sessions. See [../runtime/sessions-concurrency.md](/runtime/sessions-concurrency/). |
| `MONO_AGENT_SESSION_ISOLATE_PROACTIVE` | `runtime.session.isolateProactive` | When `true`, proactive (cron/webhook) runs use a session separate from the conversation. |
| `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS` | `concurrency.maxConcurrentRuns` | Runs executing against the provider at once (**per-channel**). |
| `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS` | `concurrency.maxPendingRuns` | Runs admitted before the provider step (**per-channel**). |

```json
{
  "runtime": {
    "model": "pi:openai:gpt-5.5",
    "effort": "high",
    "fallbackModels": ["claude:claude-sonnet-4-6"],
    "session": { "mode": "continuous", "idleTimeoutMs": 600000 }
  },
  "concurrency": { "maxConcurrentRuns": 4, "maxPendingRuns": 8 }
}
```

```bash
MONO_AGENT_MODEL=pi:openai:gpt-5.5
MONO_AGENT_EFFORT=high
MONO_AGENT_FALLBACK_MODELS=claude:claude-sonnet-4-6
MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS=4
```

## Providers

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_LOCAL_PROVIDERS_JSON` | `providers.local[]` | Full JSON array of local providers (id, type, baseUrl, apiKey/apiKeyEnv, models). |
| `MONO_AGENT_LOCAL_PROVIDER_*` | `providers.local[]` | Single-provider field overrides. |
| `MONO_AGENT_PI_AUTH_PATH` | `providers.piAuthPath` | Pi OAuth credential file; default `~/.pi/agent/auth.json`. |
| `MONO_AGENT_PI_MAX_RETRIES` | `providers.piNative.piMaxRetries` | Pi-native transport retries, 0-8, default 2. |
| `MONO_AGENT_MAX_RETRY_DELAY_MS` | `providers.piNative.maxRetryDelayMs` | Default 60000. |
| `MONO_AGENT_PI_SESSIONS_ROOT` | `providers.piNative.piSessionsRoot` | Durable JSONL session storage (e.g. `.mono-agent/sessions`); unset = in-memory. |

See [../runtime/local-providers.md](/runtime/local-providers/) for the local provider shape and [../runtime/backends.md](/runtime/backends/) for Pi auth.

## Context

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_IDENTITY_PATH` | `context.identityPath` | Identity markdown loaded into every prompt. Required. See [../context/identity-and-soul.md](/context/identity-and-soul/). |
| `MONO_AGENT_SOUL_PATH` | `context.soulPath` | Optional secondary voice/guardrail doc. |
| `MONO_AGENT_SKILLS_ROOT` | `context.skillsRoot` | Root folder for `<name>/SKILL.md` skills. See [../context/skills.md](/context/skills/). |
| `MONO_AGENT_SELECTED_SKILLS` | `context.selectedSkills` | Explicitly selected skill names. |
| `MONO_AGENT_SKILL_MAX_BYTES` | `context.skillMaxBytes` | Per-skill instruction byte cap; default 48000. |
| `MONO_AGENT_SKILL_DISCLOSURE` | `context.skillDisclosure` | `index` (names only) or `full` (full bodies); default `full`. |

## Memory

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_MEMORY_BACKEND` | `memory.backend` | Memory engine: `bujo` (default, homegrown SQLite) or `supermemory` (external). External backends ignore `mode`/`embeddings`/`llm`. |
| `MONO_AGENT_MEMORY_MODE` | `memory.mode` | `lite` / `journal` / `bujo` (bujo backend only). |
| `MONO_AGENT_MEMORY_WRITE_MODE` | `memory.writeMode` | `disabled` / `append-host-summary` / `capture` (`capture` requires `mode: bujo` for the bujo backend, or an external backend that extracts server-side). See [../memory/capture-and-recall.md](/memory/capture-and-recall/). |
| `MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL` | `memory.supermemory.baseUrl` | Required when `backend: supermemory`. REST base URL of the local OSS binary or hosted cloud. |
| `MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY` | `memory.supermemory.apiKey` | Inline API key (optional for no-auth local). Prefer `_API_KEY_ENV`. |
| `MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV` | `memory.supermemory.apiKeyEnv` | Name of the env var holding the key; only the name is persisted in resolved config. |
| `MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER` | `memory.supermemory.container` | Container/namespace tag scoping this agent's memories. Defaults to the trace `sourceId`. |
| `MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS` | `memory.supermemory.timeoutMs` | Per-call HTTP timeout (`1`–`600000`, default `10000`). |
| `MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER` | `memory.supermemory.exposeMcpServer` | Also inject Supermemory's official MCP server alongside the in-app `memory_recall` tool. Default `false`. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` | `ollama` or `openai`. See [../memory/embeddings.md](/memory/embeddings/). |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` | Embedding model string. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` | Embedding dimension. |
| `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | `memory.recallTool.enabled` | Auto-provisioned `memory_recall` tool; default on for journal/bujo with embeddings, and for the supermemory backend. |
| `MONO_AGENT_MEMORY_REFLECTION_ENABLED` | `memory.reflection.enabled` | Nightly BuJo reflection pass. |
| `MONO_AGENT_MEMORY_REFLECTION_CRON` | `memory.reflection.cron` | Default `0 3 * * *`. See [../memory/rituals.md](/memory/rituals/). |
| `MONO_AGENT_MEMORY_MIGRATION_ENABLED` | `memory.migration.enabled` | Monthly BuJo migration pass. |
| `MONO_AGENT_MEMORY_MIGRATION_CRON` | `memory.migration.cron` | Default `0 4 1 * *`. |
| `MONO_AGENT_MEMORY_LLM_PROVIDER` | `memory.llm.provider` | `ollama` or `agent-host`. Required for BuJo capture/rituals. |
| `MONO_AGENT_MEMORY_LLM_MODEL` | `memory.llm.model` | Chat model for capture/reflection/migration. |
| `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE` | `memory.llm.executionMode` | `sdk` for `agent-host` refs. |
| `MONO_AGENT_MEMORY_LLM_ENDPOINT` | `memory.llm.endpoint` | Ollama-only endpoint override. |
| `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` | `memory.llm.timeoutMs` | In-app per-call memory-LLM timeout (`1000`–`600000`, **default `60000`**). The standalone CLI reads the same var but defaults to `120000`; see [the two memory-LLM timeouts](/memory/validation-and-cli/#the-two-memory-llm-timeouts). |

:::note
The standalone `memory-bujo` maintenance CLI reads `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` / `_MODEL` / `_DIM` to enable semantic recall, and `MONO_AGENT_MEMORY_LLM_MODEL` / `MONO_AGENT_MEMORY_LLM_ENDPOINT` / `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` for `reflect`/`migrate`. See [../memory/validation-and-cli.md](/memory/validation-and-cli/).
:::

## Tools

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_ALLOWED_TOOLS` | `tools.allowedTools` | Allowlist. See [../tools/policy.md](/tools/policy/). |
| `MONO_AGENT_DISALLOWED_TOOLS` | `tools.disallowedTools` | Denylist (deny wins; overlap rejected). |
| `MONO_AGENT_MCP_CONFIG_PATH` | `tools.mcpConfigPath` | Path to `mcp.json`. See [../tools/mcp.md](/tools/mcp/). |
| `MONO_AGENT_MCP_CALL_TIMEOUT_MS` | `tools.mcpCallTimeoutMs` | Inactivity timeout per MCP tool call; tool progress notifications reset it. Default 120000. |
| `MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS` | `tools.mcpCallMaxTotalTimeoutMs` | Hard wall clock per MCP tool call that progress cannot extend. Default 2700000 (45 min). |

## Sandbox

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_SANDBOX_MODE` | `sandbox.mode` | `native` (srt-wrapped) vs `off`. See [../tools/sandbox.md](/tools/sandbox/). |
| `MONO_AGENT_SANDBOX_NETWORK` | `sandbox.network.mode` | `none` / `localhost` / `allowlist` / `all`. |
| `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` | `sandbox.network.allowlist` | Domain allowlist. |
| `MONO_AGENT_SANDBOX_READABLE_ROOTS` | `sandbox.readableRoots` | Readable filesystem roots. |
| `MONO_AGENT_SANDBOX_WRITABLE_ROOTS` | `sandbox.writableRoots` | Writable filesystem roots. |
| `MONO_AGENT_SANDBOX_DENY_WRITE` | `sandbox.denyWrite` | Deny-write globs (`.env*`, `.git/config`, `.git/hooks/**` denied by default). |
| `MONO_AGENT_SANDBOX_FALLBACK` | `sandbox.fallback` | fail-closed vs unsafe-host-process when srt is unavailable. |
| `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS` | `sandbox.unsafeAllowHostProcess` | Runs commands on the host without srt. |

## Observability and traceability

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_ARTIFACT_DIR` | `artifacts.dir` | Append-only run JSONL + summaries. See [../observability/artifacts-and-traces.md](/observability/artifacts-and-traces/). |
| `MONO_AGENT_TRACE_*` | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs}` | Heartbeat manifest for dashboard discovery. |
| `MONO_AGENT_OBSERVABILITY_EXPORTERS` | `observability.exporters[]` | JSON array; Phoenix OTLP exporter entries. See [../observability/phoenix-and-backfill.md](/observability/phoenix-and-backfill/). |

## Channels

Every channel is opt-in via its `enabled` flag (default off) and every field has a `MONO_AGENT_<CHANNEL>_*` env var. The tables below cover the commonly overridden keys; consult [blueprint.md](/config/blueprint/) for the complete per-channel shape.

### Telegram

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_TELEGRAM_ENABLED` | `telegram.enabled` | |
| `MONO_AGENT_TELEGRAM_BOT_TOKEN` | `telegram.botToken` | Bot token. |
| `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS` | `telegram.allowedChatIds` | Or `allowAllChats`. See [../channels/telegram.md](/channels/telegram/). |
| `MONO_AGENT_TELEGRAM_REACTIONS` | `telegram.reactions` | All-on/all-off boolean override for the lifecycle status reactions (👀 working / 👍 done / 👎 error). Granular per-state control (`{ working, done, error }`) is JSON-only. |
| `MONO_AGENT_TELEGRAM_IP_FAMILY` | `telegram.transport.ipFamily` | Pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`); omit for dual-stack. Workaround for a broken IPv6 route to `api.telegram.org`. |
| `MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS` | `telegram.pollWatchdogMs` | Poll-liveness watchdog window (ms); default `120000`, `0` disables. Force-restarts a runner that stops delivering updates without crashing. |

### Slack

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_SLACK_ENABLED` | `slack.enabled` | |
| `MONO_AGENT_SLACK_BOT_TOKEN` | `slack.botToken` | `xoxb-...` |
| `MONO_AGENT_SLACK_APP_TOKEN` | `slack.appToken` | `xapp-...` (Socket Mode). |
| `MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS` | `slack.allowedChannelIds` | Or `allowAllChannels`. See [../channels/slack.md](/channels/slack/). |
| `MONO_AGENT_SLACK_HEARTBEAT_INTERVAL_MS` | `slack.heartbeatIntervalMs` | Socket Mode ping/silence probe interval (ms); default `30000`. |
| `MONO_AGENT_SLACK_HEARTBEAT_TIMEOUT_MS` | `slack.heartbeatTimeoutMs` | Silence budget before the watchdog force-recycles the socket (ms); default `90000`, `0` disables the watchdog. |
| `MONO_AGENT_SLACK_RECONNECT_INITIAL_BACKOFF_MS` | `slack.reconnectInitialBackoffMs` | First reconnect backoff after a non-graceful drop (ms); default `500`. |
| `MONO_AGENT_SLACK_RECONNECT_MAX_BACKOFF_MS` | `slack.reconnectMaxBackoffMs` | Backoff ceiling (ms); default `30000`. Jitter (ratio 0.2) is applied on by default. |
| `MONO_AGENT_SLACK_RECONNECT_STABILITY_MS` | `slack.reconnectStabilityMs` | A reconnect must stay open this long before the backoff resets (ms); default `30000` (not per-connect). |
| `MONO_AGENT_SLACK_RECONNECT_STARTUP_GRACE_MS` | `slack.reconnectStartupGraceMs` | Window (ms) to quietly retry a lingering prior-process socket instead of flagging `degraded`; default `10000`. |
| `MONO_AGENT_SLACK_DRAIN_DEADLINE_MS` | `slack.drainDeadlineMs` | Backstop (ms) to force a reconnect after a watchdog `terminate()` if the old socket emits no close; default `5000`. |

All Slack resilience vars are optional integers (`0`–`3600000`); omit to use the default. They tune the terminate-first, jittered, stability-gated reconnect loop and the silence watchdog. See [../channels/slack.md](/channels/slack/).

### WhatsApp

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WHATSAPP_ENABLED` | `whatsapp.enabled` | QR login; auth state in `.mono-agent/whatsapp-auth`. |
| `MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS` | `whatsapp.allowedChatJids` | Or `allowAllChats`. |
| `MONO_AGENT_WHATSAPP_GROUP_MODE` | `whatsapp.groupMode` | `mention` / `any`. See [../channels/whatsapp.md](/channels/whatsapp/). |

### Webhook

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WEBHOOK_ENABLED` | `webhook.enabled` | |
| `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` | `webhook.endpoints[]` | JSON array of named endpoints. |
| `MONO_AGENT_WEBHOOK_NOTIFY` | `webhook.notify` | Single-endpoint native notification toggle. |
| `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID` | `webhook.notifyConversationId` | Single-endpoint native notification destination. |
| `MONO_AGENT_WEBHOOK_MODEL` | `webhook.model` | Single-endpoint model override (e.g. `claude:claude-opus-4-8`). A request body `model` wins. |
| `MONO_AGENT_WEBHOOK_EFFORT` | `webhook.effort` | Single-endpoint reasoning-effort override (`none`/`low`/`medium`/`high`/`xhigh`/`max`). A request body `effort` wins. |
| `MONO_AGENT_WEBHOOK_DIR` | `webhook.dir` | Folder of `*.md` endpoint files. See [../channels/webhook.md](/channels/webhook/). |
| `MONO_AGENT_WEBHOOK_MAX_RUN_MS` | `webhook.maxRunMs` | Wall-clock bound (ms) per webhook run; default 20 min, `0` disables. Reclaims a hung run's slot (esp. async, which has no client disconnect). |

### OpenAI-compatible API

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_OPENAI_API_ENABLED` | `openaiApi.enabled` | |
| `MONO_AGENT_OPENAI_API_KEY` | `openaiApi.apiKey` | Optional bearer required from clients (`sk-...`). |
| `MONO_AGENT_OPENAI_API_MODEL_ID` | `openaiApi.modelId` | Advertised model id. See [../channels/openai-api.md](/channels/openai-api/). |

### A2A

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_A2A_ENABLED` | `a2a.enabled` | Canonical enable flag for the A2A provider, matching every other channel. Wins over the legacy form below when both are set. |
| `MONO_AGENT_A2A_PROVIDER_ENABLED` | `a2a.provider.enabled` | Legacy enable flag (still honored). Prefer `a2a.enabled`. |
| `MONO_AGENT_A2A_BEARER_TOKEN` | `a2a.provider.bearerToken` | Used when `requireBearer` is set. See [../channels/a2a.md](/channels/a2a/). |

### Cron

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_CRON_JOBS_JSON` | `cron.jobs[]` | Full JSON array of jobs. |
| `MONO_AGENT_CRON_*` | `cron.jobs[]` | Single-job field overrides (id, expression, timezone, prompt, conversationId, notify, notifyConversationId, model, effort). |
| `MONO_AGENT_CRON_DIR` | `cron.dir` | Folder of per-job `*.md` files; default `cron/`. Folder and config jobs merge; duplicate ids error. See [../channels/cron.md](/channels/cron/). |

## Evals

The eval harness is dev/code coverage, not a runtime channel. Live eval runs are gated by an env flag:

| Env var | Notes |
| --- | --- |
| `MONO_AGENT_EVAL_LIVE` | Set to `1` to run live eval scenarios via `@mono-agent/agent-evals`. See [../evals/index.md](/evals/). |
