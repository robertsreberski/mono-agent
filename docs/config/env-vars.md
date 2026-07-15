---
title: "Environment variables"
sidebar:
  order: 2
---

# Environment variables

Every field in `mono-agent.config.json` also has a `MONO_AGENT_*` environment variable that overrides it. This page is the exhaustive reference, grouped by domain, with the JSON key each variable overrides; CLI-only variables are marked explicitly. For the full annotated config see [blueprint.md](/config/blueprint/).

## Precedence and `.env` loading

The resolution order is **env > JSON > built-in defaults**. An environment variable always wins over the matching key in `mono-agent.config.json`, which wins over the framework default.

A `.env` file in the agent folder is loaded automatically by the CLI. Variables already exported in your shell take precedence over values in `.env` (exported shell vars win). Pass `--env-file <path>` to load an alternate file instead of `./.env`. For `mono-agent validate --consumer <path>`, the consumer folder's `.env` loads by default, and relative `--env-file` paths resolve inside that consumer folder.

:::caution
Secrets belong in `.env` (or exported shell vars), never in `mono-agent.config.json`, which is meant to be committed. Keep `.env` untracked. During guided `mono-agent init`, required selected-capability secrets are entered masked and values never appear in examples, review output, logs, or config JSON. Existing non-empty dotenv assignments and comments are preserved. A shell-only selected secret does not skip the prompt: because background start cannot inherit that shell, the entered value must match every non-empty shell/dotenv copy and is then persisted when the dotenv value is missing.

Guided readiness deliberately proves the durable worker environment, not arbitrary launching-shell state. It keeps operational host values such as `PATH` and `HOME`, then uses `.env`, entered selected secrets, and the resolved Pi auth path for provider/config input. A shell-only API key is therefore not readiness evidence. Non-secret `MONO_AGENT_*` overrides already persisted in `.env` are rejected during guided init because they would make the generated JSON differ from the configuration actually started; move the intended value into the wizard/config instead.

On POSIX, automatic persistence canonicalizes the target directory and requires it to be current-user-owned and not group/world-writable. Existing `.env` and `.gitignore` paths must be current-user-owned, single-link, regular, non-symlinked files; `.env` must be untracked, values must round-trip through the runtime dotenv parser, and exact root ignore rules cover `.env` plus transaction artifacts. It then uses an external owner-only lock, an exclusive same-directory temporary file, mode `0600`, flush, concurrent-change checks, and pathname no-clobber promotion. An owned permissive `.env` is tightened, and group/world write bits are removed from the `.gitignore` guard. A pathname competitor stays at the target. The claimed inode is rechecked before installation/cleanup; detected writes through an already-open descriptor are retained at a named owner-only recovery path. A non-cooperative POSIX write after the final check cannot be guaranteed. Tracked/symlinked/hard-linked/foreign-owned/malformed/conflicting paths, empty or unrepresentable secrets, stale locks, and unverifiable Git state fail closed. Windows refuses automatic secret persistence because owner-only access cannot be proven; follow the manual instructions without copying `.env.example` over a populated `.env`.

`mono-agent config` and `mono-agent validate` warn when a secret-marked field is resolved from committed JSON and name the matching `MONO_AGENT_*` variable to move it to. The warning is advisory and non-fatal.
:::

:::note
Provider API keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are **provider-native** variables, not `MONO_AGENT_*` ones. Reference them from config via `apiKeyEnv` (for local providers) rather than inlining a key. See [../runtime/local-providers.md](/runtime/local-providers/) and [../runtime/backends.md](/runtime/backends/).
:::

## Agent and runtime

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_NAME` | `agent.name` | Public display name. It may seed human-facing trace/A2A labels but never paths, service ids, sessions, or provider identity. |
| `MONO_AGENT_MODEL` | `runtime.model` | Backend-prefixed model, e.g. `codex:gpt-5.6-terra`, `pi:openai-codex:gpt-5.6-terra`, `pi:opencode-go:kimi-k2.6`. Required. |
| `MONO_AGENT_EXECUTION_MODE` | `runtime.executionMode` | `sdk` vs `cli`; default inferred from model. |
| `MONO_AGENT_FALLBACKS_JSON` | `runtime.fallbacks` | Canonical JSON array of `{ "model": "...", "effort"?: "..." }`; ordered and uncapped. Omitted effort means that route's provider default. Mutually exclusive with the legacy CSV variable. |
| `MONO_AGENT_FALLBACK_MODELS` | `runtime.fallbackModels` | Legacy CSV compatibility surface. Entries inherit `runtime.effort`; prefer `MONO_AGENT_FALLBACKS_JSON`. See [../runtime/fallback.md](/runtime/fallback/). |
| `MONO_AGENT_ROUTE_SAFETY` | `runtime.routeSafety` | `uniform` (default common monotonic contract) or explicit `per-route-native` mixed-provider contracts. |
| `MONO_AGENT_EFFORT` | `runtime.effort` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`; the selected model may support only a subset. See [../runtime/execution-effort-permissions.md](/runtime/execution-effort-permissions/). |
| `MONO_AGENT_PERMISSION_MODE` | `runtime.permissionMode` | `default` / `plan` / `acceptEdits` / `bypassPermissions` (CLI backends). |
| `MONO_AGENT_MAX_TURNS` | `runtime.maxTurns` | Turn cap per run; omitted or `0` means unlimited. |
| `MONO_AGENT_WORKSPACE` | `runtime.workspace` | Working directory for runtime tools. |
| `MONO_AGENT_SESSION_MODE` | `runtime.session.mode` | Continuous provider session mode per conversation. |
| `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS` | `runtime.session.idleTimeoutMs` | Idle eviction window for sessions. See [../runtime/sessions-concurrency.md](/runtime/sessions-concurrency/). |
| `MONO_AGENT_SESSION_ISOLATE_PROACTIVE` | `runtime.session.isolateProactive` | When `true`, proactive (cron/webhook) runs use a session separate from the conversation. |
| `MONO_AGENT_SESSION_ROLLOVER` | `runtime.session.rollover` | `none` or `daily`; daily buckets conversation ids by local day. |
| `MONO_AGENT_SESSION_ROLLOVER_TIMEZONE` | `runtime.session.rolloverTimezone` | IANA timezone used for daily rollover buckets. |
| `MONO_AGENT_SESSION_ROLLOVER_NOTICE` | `runtime.session.rolloverNotice` | When `true`, streams a one-line adapter-visible notice on the first turn of a new daily rollover bucket. Default off / unset; does not add an IPC path. |
| `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS` | `concurrency.maxConcurrentRuns` | Runs executing against the provider at once (**per-channel**). |
| `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS` | `concurrency.maxPendingRuns` | Runs admitted before the provider step (**per-channel**). |

```json
{
  "agent": { "name": "Research Companion" },
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [{ "model": "pi:opencode-go:kimi-k2.6", "effort": "medium" }],
    "routeSafety": "uniform",
    "session": { "mode": "continuous", "idleTimeoutMs": 600000, "rollover": "daily", "rolloverTimezone": "UTC", "rolloverNotice": false }
  },
  "concurrency": { "maxConcurrentRuns": 4, "maxPendingRuns": 8 }
}
```

```bash
MONO_AGENT_MODEL=pi:openai-codex:gpt-5.6-terra
MONO_AGENT_EFFORT=high
MONO_AGENT_FALLBACKS_JSON='[{"model":"pi:opencode-go:kimi-k2.6","effort":"medium"}]'
MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS=4
```

## Providers

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_LOCAL_PROVIDERS_JSON` | `providers.local[]` | Full JSON array of local providers (id, type, baseUrl, apiKey/apiKeyEnv, models). |
| `MONO_AGENT_LOCAL_PROVIDER_*` | `providers.local[]` | Single-provider field overrides. |
| `MONO_AGENT_PI_AUTH_PATH` | `providers.piAuthPath` | Pi credential file; a non-empty value wins over JSON and loses only to `auth login --pi-auth-path`. Default `~/.pi/agent/auth.json`; `~` expands to home and relative paths resolve from the agent/invocation working directory. |
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
| `MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER` | `memory.supermemory.exposeMcpServer` | Also inject Supermemory's official MCP server alongside the in-app `MemoryRecall` tool. Default `false`. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` | `ollama`, `lmstudio`, or `openai`. The configured provider is exclusive; there is no cross-provider fallback. See [../memory/embeddings.md](/memory/embeddings/). |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` | Embedding model string. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` | Embedding dimension. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT` | `memory.embeddings.endpoint` | Service root: defaults to `http://localhost:11434` for Ollama, `http://localhost:1234` for LM Studio, or `https://api.openai.com/v1` for OpenAI. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV` | `memory.embeddings.apiKeyEnv` | Name of the variable holding the key. LM Studio is keyless when omitted; when declared, a missing/empty named variable reports `waiting` rather than silently retrying keyless. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY` | `memory.embeddings.apiKey` | Direct key override. Prefer `_API_KEY_ENV` so config stores only a variable name. |
| `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | `memory.recallTool.enabled` | Auto-provisioned read-only `MemoryRecall`; default on for every configured tier, explicit false opts out. |
| `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED` | `memory.consolidation.enabled` | Scheduled BuJo consolidation; default on. |
| `MONO_AGENT_MEMORY_CONSOLIDATION_CRON` | `memory.consolidation.cron` | Default `0 */2 * * *`. See [../memory/rituals.md](/memory/rituals/). |
| `MONO_AGENT_MEMORY_LLM_PROVIDER` | `memory.llm.provider` | `ollama` or `agent-host`. Strictly required for BuJo capture and tier selection; projection-only consolidation itself makes no model call. Missing prerequisites fail instead of downshifting tiers. |
| `MONO_AGENT_MEMORY_LLM_MODEL` | `memory.llm.model` | Chat model for capture and legacy manual `migrate`; read-only `reflect` needs no model. |
| `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE` | `memory.llm.executionMode` | `sdk` for `agent-host` refs. |
| `MONO_AGENT_MEMORY_LLM_ENDPOINT` | `memory.llm.endpoint` | Ollama-only endpoint override. |
| `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` | `memory.llm.timeoutMs` | In-app per-call memory-LLM timeout (`1000`–`600000`, **default `60000`**). The standalone CLI reads the same var but defaults to `120000`; see [the two memory-LLM timeouts](/memory/validation-and-cli/#the-two-memory-llm-timeouts). |

:::note
The standalone `memory-bujo` maintenance CLI reads `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` / `_MODEL` / `_DIM` for optional semantic recall and strict-tier rebuild identity, and `MONO_AGENT_MEMORY_LLM_MODEL` / `MONO_AGENT_MEMORY_LLM_ENDPOINT` / `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` for `migrate`. Read-only `reflect` needs none of the LLM variables. Standalone rebuild/rollback also require `--tier`; first activation uses config-aware `mono-agent memory rebuild`. See [../memory/validation-and-cli.md](/memory/validation-and-cli/).
:::

:::note
`MONO_AGENT_MEMORY_REFLECTION_ENABLED`, `MONO_AGENT_MEMORY_REFLECTION_CRON`,
`MONO_AGENT_MEMORY_MIGRATION_ENABLED`, and `MONO_AGENT_MEMORY_MIGRATION_CRON` are retired.
They are tolerated so stale environments do not break startup, but they are ignored and
`mono-agent validate` reports a warning.
:::

## Tools

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_ALLOWED_TOOLS` | `tools.allowedTools` | Allowlist. **Unset** keeps the allow-all default; `*` is allow-all; an empty value (`""`) is the explicit chat-only `[]`. See [../tools/policy.md](/tools/policy/). |
| `MONO_AGENT_DISALLOWED_TOOLS` | `tools.disallowedTools` | Denylist (deny wins; overlap rejected). |
| `MONO_AGENT_MCP_CONFIG_PATH` | `tools.mcpConfigPath` | Path to `mcp.json`. See [../tools/mcp.md](/tools/mcp/). |
| `MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS` | `tools.mcpRequestContextServers` | Comma-separated stdio MCP server names that receive trusted request-scoped context and progress capabilities. |
| `MONO_AGENT_CONTINUATION_SERVERS` | `tools.continuationServers` | Comma-separated stdio or loopback-HTTP MCP server names that receive trusted request-bound continuation claim capabilities. See [durable continuations](/tools/durable-continuations/). |
| `MONO_AGENT_MCP_CALL_TIMEOUT_MS` | `tools.mcpCallTimeoutMs` | Inactivity timeout per MCP tool call; tool progress notifications reset it. Default 120000. |
| `MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS` | `tools.mcpCallMaxTotalTimeoutMs` | Hard wall clock per MCP tool call that progress cannot extend. Default 2700000 (45 min). |

### Durable continuations

The host service itself is configured through the `continuations` JSON block. `continuations.detachedServices[].tokenEnv` names an operator-chosen environment variable containing that service's bearer; there is deliberately no fixed environment variable that accepts a raw detached token. Selected MCP servers receive reserved run-scoped `MONO_AGENT_CONTINUATION_CLAIM_*` variables or `x-mono-agent-continuation-claim-*` headers from the host. Those values are runtime capabilities, not operator overrides, and configured spoof values are replaced.

See [Durable continuations](/tools/durable-continuations/) for the complete configuration and protocol.

## Interaction (AskUser + tool progress)

The interaction bridge starts automatically when `AskUser` is allowed (under the allow-all default, or listed in a specific `tools.allowedTools`) or the `interaction` block is present. `MONO_AGENT_INTERACTION_BRIDGE_URL` / `MONO_AGENT_INTERACTION_BRIDGE_TOKEN` are an app-owned master capability forwarded only to the trusted adapter-tool child; do not set or pass them to project tools. Opted project stdio MCPs receive a separate run-scoped `MONO_AGENT_INTERACTION_PROGRESS_URL` / `MONO_AGENT_INTERACTION_PROGRESS_TOKEN` pair, and their master-capability env keys are overwritten with empty strings.

Opted project stdio MCPs also receive host-owned filesystem context after all MCP option layers are merged: `MONO_AGENT_MCP_RUN_OUTPUT_DIR`, `MONO_AGENT_MCP_ATTACHMENTS_ROOT`, `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS`, and `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES`. The path value is a JSON array containing only lexical paths saved successfully for the current request; the identity value contains matching `{ "path", "dev", "ino" }` objects captured from the writer descriptors. Empty arrays are authoritative and configured values cannot override them. These are runtime-injected context keys, not operator configuration variables.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_INTERACTION_BRIDGE_HOST` | `interaction.bridge.host` | Loopback bind host. Default `127.0.0.1`. |
| `MONO_AGENT_INTERACTION_BRIDGE_PORT` | `interaction.bridge.port` | Bridge port. Default `0` (ephemeral — consumers get the URL via env). |
| `MONO_AGENT_ASK_USER_TIMEOUT_MS` | `interaction.askUser.timeoutMs` | Max wait per `AskUser` question (also the per-ask ceiling). Default 600000 (10 min). |
| `MONO_AGENT_PROGRESS_ENABLED` | `interaction.progress.enabled` | Route tool progress posts to channel status messages. Default true. |

## Sandbox

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_SANDBOX_MODE` | `sandbox.mode` | `native` (srt-wrapped) vs `off`. See [../tools/sandbox.md](/tools/sandbox/). |
| `MONO_AGENT_SANDBOX_NETWORK` | `sandbox.network.mode` | `none` / `localhost` / `allowlist`. `all` is rejected because pinned SRT cannot enforce it exactly; use `sandbox.mode=off` explicitly instead. |
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
| `MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS` | `artifacts.retention.maxAgeDays` | Delete terminal run artifacts older than this many days (default `365`; bounds `1..3650`). |
| `MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT` | `artifacts.retention.maxCount` | Keep at most this many newest terminal run artifacts (default `50000`; bounds `1..1000000`). |
| `MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN` | `artifacts.retention.dryRun` | Log what retention would delete without unlinking files. |
| `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS` | `artifacts.memoryRetention.maxAgeDays` | Delete terminal memory-run artifacts older than this many days (default `7`; bounds `1..3650`). |
| `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT` | `artifacts.memoryRetention.maxCount` | Keep at most this many newest terminal memory runs (default `5000`; bounds `1..1000000`). |
| `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN` | `artifacts.memoryRetention.dryRun` | Log what memory retention would delete without unlinking files. Defaults to `artifacts.retention.dryRun` when unset. |
| `MONO_AGENT_TRACE_*` | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs,globalDiscovery}` | Heartbeat manifest for dashboard discovery. |
| `MONO_AGENT_OBSERVABILITY_EXPORTERS` | `observability.exporters[]` | JSON array; Phoenix OTLP exporter entries. See [../observability/phoenix-and-backfill.md](/observability/phoenix-and-backfill/). |

## Channels

Most channels are opt-in via their `enabled` flag (default off). The operator surfaces `tui` and `live` default on so `mono-agent tui` and `mono-agent web` can discover running agents without per-agent edits. Every field has a `MONO_AGENT_<CHANNEL>_*` env var. The tables below cover the commonly overridden keys; consult [blueprint.md](/config/blueprint/) for the complete per-channel shape.

### Telegram

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_TELEGRAM_ENABLED` | `telegram.enabled` | |
| `MONO_AGENT_TELEGRAM_BOT_TOKEN` | `telegram.botToken` | Bot token. |
| `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS` | `telegram.allowedChatIds` | Or `allowAllChats`. See [../channels/telegram.md](/channels/telegram/). |
| `MONO_AGENT_TELEGRAM_REACTIONS` | `telegram.reactions` | All-on/all-off boolean override for the lifecycle status reactions (👀 working / 👍 done / 👎 error). Granular per-state control (`{ working, done, error }`) is JSON-only. |
| `MONO_AGENT_TELEGRAM_IP_FAMILY` | `telegram.transport.ipFamily` | Pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`); omit for dual-stack. Workaround for a broken IPv6 route to `api.telegram.org`. |
| `MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS` | `telegram.pollWatchdogMs` | Poll-liveness watchdog window (ms); default `120000`, `0` disables. Force-restarts a runner that stops delivering updates without crashing. |
| `MONO_AGENT_TELEGRAM_API_ROOT` | `telegram.apiRoot` | Base URL of a self-hosted Bot API server (e.g. `http://127.0.0.1:8081`). Omit for `api.telegram.org`. See [../channels/telegram.md](/channels/telegram/). |
| `MONO_AGENT_TELEGRAM_ATTACHMENT_MAX_BYTES` | `telegram.attachments.maxBytes` | Inbound attachment download cap (bytes). Default 20 MiB (the hosted API's hard limit); raise it only with a self-hosted server. |
| `MONO_AGENT_TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `telegram.attachments.downloadTimeoutMs` | Per-file download timeout (ms) on the URL branch; default `30000`, `0` disables. |
| `MONO_AGENT_TELEGRAM_UPLOAD_MAX_BYTES` | `telegram.attachments.maxUploadBytes` | Upload cap (bytes) for `TelegramSendFile`; default 20 MiB. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT` | `telegram.transcription.endpoint` | Full HTTP(S) URL of an OpenAI-compatible `POST /v1/audio/transcriptions` route. Unset disables transcription. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL` | `telegram.transcription.model` | Model name sent with each transcription request; required when the endpoint is set. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_LANGUAGE` | `telegram.transcription.language` | Optional ISO-639 language hint. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS` | `telegram.transcription.timeoutMs` | Per-call timeout in milliseconds (`1`–`3600000`); default `120000`, independent of the attachment download timeout. |

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

WhatsApp is loaded through `channels.plugins[]` with `package: "@mono-agent/whatsapp-adapter"`. These env vars override that plugin entry's `config` fields.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WHATSAPP_ENABLED` | plugin `config.enabled` | QR login; auth state in `.mono-agent/whatsapp-auth`. |
| `MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS` | plugin `config.allowedChatJids` | Or `allowAllChats`. |
| `MONO_AGENT_WHATSAPP_GROUP_MODE` | plugin `config.groupMode` | `mention` / `any`. See [../channels/whatsapp.md](/channels/whatsapp/). |

### Webhook

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WEBHOOK_ENABLED` | `webhook.enabled` | |
| `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` | `webhook.endpoints[]` | JSON array of named endpoints. |
| `MONO_AGENT_WEBHOOK_NOTIFY` | `webhook.notify` | Single-endpoint native notification toggle. |
| `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID` | `webhook.notifyConversationId` | Single-endpoint native notification destination. |
| `MONO_AGENT_WEBHOOK_MODEL` | `webhook.model` | Single-endpoint model override (e.g. `claude:claude-opus-4-8`). A request body `model` wins. |
| `MONO_AGENT_WEBHOOK_EFFORT` | `webhook.effort` | Single-endpoint reasoning-effort override (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`), subject to model support. A request body `effort` wins. |
| `MONO_AGENT_WEBHOOK_DIR` | `webhook.dir` | Folder of `*.md` endpoint files. See [../channels/webhook.md](/channels/webhook/). |
| `MONO_AGENT_WEBHOOK_MAX_RUN_MS` | `webhook.maxRunMs` | Wall-clock bound (ms) per webhook run; default 20 min, `0` disables. Reclaims a hung run's slot (esp. async, which has no client disconnect). |

### OpenAI-compatible API

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_OPENAI_API_ENABLED` | `openaiApi.enabled` | |
| `MONO_AGENT_OPENAI_API_HOST` | `openaiApi.host` | Bind host; default `127.0.0.1`. |
| `MONO_AGENT_OPENAI_API_PORT` | `openaiApi.port` | Bind port; default `0` selects a free port. |
| `MONO_AGENT_OPENAI_API_BASE_PATH` | `openaiApi.basePath` | API prefix; default `/v1`. |
| `MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK` | `openaiApi.allowNonLoopback` | Must be `true` for an enabled non-loopback bind. |
| `MONO_AGENT_OPENAI_API_KEY` | `openaiApi.apiKey` | Optional on loopback; required for any enabled non-loopback bind. Clients send it as a bearer (`sk-...`). |
| `MONO_AGENT_OPENAI_API_MODEL_ID` | `openaiApi.modelId` | Advertised model id. See [../channels/openai-api.md](/channels/openai-api/). |

### Session web CLI

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WEB_AUTH_TOKEN` | — (CLI-only) | Stable bearer honored on loopback and non-loopback binds. It is required for non-interactive non-loopback startup; an interactive non-loopback command may generate a one-run token. Configured values stay redacted unless `--show-auth-url` is explicitly used in an interactive terminal. Store this secret in the CLI invocation folder's owner-only `.env` or the file selected by `--env-file`. |

### TUI stream endpoint

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_TUI_ENABLED` | `tui.enabled` | **Default `true`** — default-on loopback operator surface for `mono-agent tui`. |
| `MONO_AGENT_TUI_HOST` | `tui.host` | Default `127.0.0.1`. |
| `MONO_AGENT_TUI_PORT` | `tui.port` | Default `0` (ephemeral; published to the trace-source registry). |
| `MONO_AGENT_TUI_BASE_PATH` | `tui.basePath` | Default `/tui`. |
| `MONO_AGENT_TUI_ALLOW_NON_LOOPBACK` | `tui.allowNonLoopback` | Required to bind a non-loopback host. |
| `MONO_AGENT_TUI_API_KEY` | `tui.apiKey` | Optional bearer the console must present. See [../channels/tui.md](/channels/tui/). |

### Live event relay

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_LIVE_ENABLED` | `live.enabled` | **Default `true`** — default-on read-only SSE relay for `mono-agent web`. |
| `MONO_AGENT_LIVE_HOST` | `live.host` | Default `127.0.0.1`. |
| `MONO_AGENT_LIVE_PORT` | `live.port` | Default `0` (ephemeral; published to the trace-source registry). |
| `MONO_AGENT_LIVE_BASE_PATH` | `live.basePath` | Default `/live`. |
| `MONO_AGENT_LIVE_ALLOW_NON_LOOPBACK` | `live.allowNonLoopback` | Required to bind a non-loopback host. |
| `MONO_AGENT_LIVE_API_KEY` | `live.apiKey` | Optional bearer token for `/v1/info` and `/v1/events`. `mono-agent web` reads it from the agent config and only sends it to trusted loopback live URLs. |

### A2A

The A2A provider is loaded through `channels.plugins[]` with `package: "@mono-agent/a2a-adapter"`. These env vars override that plugin entry's `config` fields.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_A2A_ENABLED` | plugin `config.enabled` | Canonical enable flag for the A2A provider, matching other channels. Wins over the legacy form below when both are set. |
| `MONO_AGENT_A2A_PROVIDER_ENABLED` | plugin `config.provider.enabled` | Legacy enable flag (still honored). Prefer `MONO_AGENT_A2A_ENABLED`. |
| `MONO_AGENT_A2A_BEARER_TOKEN` | plugin `config.provider.bearerToken` | Used when `requireBearer` is set. See [../channels/a2a.md](/channels/a2a/). |
| `MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE` | plugin `config.provider.idempotency.namespace` | Explicitly enables durable keyed dispatch and defines its stable authenticated-principal boundary. |
| `MONO_AGENT_A2A_IDEMPOTENCY_STATE_DIR` | plugin `config.provider.idempotency.stateDir` | Optional durable receipt directory; a namespace-derived owner-only path is used when omitted. |
| `MONO_AGENT_A2A_IDEMPOTENCY_RETENTION_MS` | plugin `config.provider.idempotency.retentionMs` | Full terminal-result replay horizon; defaults to 30 days. |
| `MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS` | plugin `config.provider.idempotency.maxRecords` | Hard lifetime unique-key capacity; existing bindings are never evicted. |

### Cron

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_CRON_JOBS_JSON` | `cron.jobs[]` | Full JSON array of jobs. |
| `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS` | `cron.notifyFailureCooldownHours` | Single-job cooldown, in hours, for all-models-failed error notices on `notify: true` cron jobs; default `6`. |
| `MONO_AGENT_CRON_*` | `cron.jobs[]` | Single-job field overrides (id, expression, timezone, prompt, conversationId, notify, notifyConversationId, notifyFailureCooldownHours, model, effort). |
| `MONO_AGENT_CRON_DIR` | `cron.dir` | Folder of per-job `*.md` files; default `cron/`. Folder and config jobs merge; duplicate ids error. See [../channels/cron.md](/channels/cron/). |
