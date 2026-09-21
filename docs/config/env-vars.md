---
title: Operational environment variables
description: "Environment variables reserved for secrets, process plumbing, managed workers, and adapter compatibility."
---

Core agent configuration comes only from `mono-agent.config.json`, followed by
built-in defaults. `MONO_AGENT_*` variables that previously mapped to core
fields are silently ignored, including retired names. Move those values into
the corresponding JSON fields before upgrading.

Environment variables remain appropriate for values that are not core
configuration: credentials named by JSON, managed-process markers, and
parent-to-child runtime protocols. Adapter packages still document their own
environment inputs separately.

## Secret references

A JSON `apiKeyEnv`, `tokenEnv`, or similar field stores the **name** of an
environment variable, not its value. The process reads the named variable only
when it needs the credential. For example:

```json
{
  "providers": {
    "ollama": {
      "type": "ollama",
      "baseUrl": "https://ollama.com",
      "apiKeyEnv": "OLLAMA_API_KEY"
    }
  }
}
```

```bash
export OLLAMA_API_KEY="..."
```

Keep secret values outside committed JSON. The CLI may load an owner-private
`.env` file so these referenced credentials and adapter secrets reach the
process; dotenv values do not override core JSON configuration.

## Internal process protocols

The host injects reserved variables when it starts child tools or probes. They
are runtime protocol values, not operator configuration:

- `MONO_AGENT_INTERACTION_BRIDGE_URL`
- `MONO_AGENT_INTERACTION_BRIDGE_TOKEN`
- `MONO_AGENT_ASK_USER_TIMEOUT_MS`
- `MONO_AGENT_ADAPTER_TOOLS_*`
- `MONO_AGENT_CONTINUATION_*`
- `MONO_AGENT_CRON_*` firing identity (`JOB_ID`, `RUN_ID`, `SCHEDULED_AT`,
  `TRIGGER`)
- `MONO_AGENT_MCP_*`
- The Pi auth path when injected into a readiness-probe child

Values supplied by an operator under formerly supported core names are ignored
by core config resolution. Child readers consume only the explicit protocol
contract constructed by their parent.

## Managed-worker and operational controls

These variables control process supervision or machine-local discovery rather
than the resolved agent configuration:

- `MONO_AGENT_MANAGED_*` and `MONO_AGENT_SYSTEMD_*` worker markers
- `MONO_AGENT_WEB_ALLOWED_HOSTS` and `MONO_AGENT_WEB_PUSH_SUBJECT`
- `MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR` and `MONO_AGENT_TRACE_*` discovery roots

Managed launchers own these values. Do not copy them into
`mono-agent.config.json`.


## Interaction (AskUser + tool progress)

The interaction bridge starts automatically when `AskUser` is allowed (under the allow-all default, or listed in a specific `tools.allowedTools`), when the `interaction` block or any interaction env override is configured, or when `interaction.progress.enabled` resolves true and `tools.mcpRequestContextServers` names at least one opted project MCP server. `MONO_AGENT_INTERACTION_BRIDGE_URL` / `MONO_AGENT_INTERACTION_BRIDGE_TOKEN` are an app-owned master capability forwarded only to the trusted adapter-tool child; do not set or pass them to project tools. Only opted project stdio MCP children receive a separate run-scoped `MONO_AGENT_INTERACTION_PROGRESS_URL` / `MONO_AGENT_INTERACTION_PROGRESS_TOKEN` pair, and their master-capability env keys are overwritten with empty strings.

Opted project stdio MCPs also receive host-owned filesystem context after all MCP option layers are merged: `MONO_AGENT_MCP_RUN_OUTPUT_DIR`, `MONO_AGENT_MCP_ATTACHMENTS_ROOT`, `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS`, and `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES`. The path value is a JSON array containing only lexical paths saved successfully for the current request; the identity value contains matching `{ "path", "dev", "ino" }` objects captured from the writer descriptors. Empty arrays are authoritative and configured values cannot override them. These are runtime-injected context keys, not operator configuration variables.

The bridge bind host and port, the `AskUser` timeout, and the tool-progress
toggle are JSON fields (`interaction.bridge.host`, `interaction.bridge.port`,
`interaction.askUser.timeoutMs`, `interaction.progress.enabled`) resolved from
`mono-agent.config.json`. They have no `MONO_AGENT_*` operator form; the
`MONO_AGENT_INTERACTION_BRIDGE_URL` / `MONO_AGENT_INTERACTION_BRIDGE_TOKEN`
pair above is the runtime-injected capability, not configuration.


## Channels

Most channels are opt-in via their `enabled` flag (default off). The compatibility-named `tui` operator endpoint defaults on so the web console and maintained operator clients work without per-agent edits. The tables below enumerate every channel environment variable. Structured JSON-only fields have no invented environment form and are identified beside the relevant channel; consult the [annotated config blueprint](/config/blueprint/) for the complete per-channel shape.

### Telegram

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_TELEGRAM_ENABLED` | `telegram.enabled` | |
| `MONO_AGENT_TELEGRAM_BOT_TOKEN` | `telegram.botToken` | Bot token. |
| `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS` | `telegram.allowedChatIds` | Or `allowAllChats`. See [Telegram channel configuration](/channels/telegram/). |
| `MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS` | `telegram.allowAllChats` | Allow any chat instead of requiring `allowedChatIds`; default `false`. |
| `MONO_AGENT_TELEGRAM_GROUP_MODE` | `telegram.groupMode` | `any` (default) runs every allowed group message; `mention` admits native bot mentions and replies to bot messages. Direct chats and commands are unaffected. |
| `MONO_AGENT_TELEGRAM_STRIP_MENTION_TEXT` | `telegram.stripMentionText` | Remove the matching native @mention before the responder sees the text; default `true`. |
| `MONO_AGENT_TELEGRAM_REACTIONS` | `telegram.reactions` | All-on/all-off boolean override for the lifecycle status reactions (👀 working / 👍 done / 👎 error). Granular per-state control (`{ working, done, error }`) is JSON-only. |
| `MONO_AGENT_TELEGRAM_IP_FAMILY` | `telegram.transport.ipFamily` | Pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`); omit for dual-stack. Workaround for a broken IPv6 route to `api.telegram.org`. |
| `MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS` | `telegram.pollWatchdogMs` | Poll-liveness watchdog window (ms); default `120000`, `0` disables. Force-restarts a runner that stops delivering updates without crashing. |
| `MONO_AGENT_TELEGRAM_API_ROOT` | `telegram.apiRoot` | Base URL of a self-hosted Bot API server (e.g. `http://127.0.0.1:8081`). Omit for `api.telegram.org`. See [Telegram channel configuration](/channels/telegram/). |
| `MONO_AGENT_TELEGRAM_ATTACHMENT_MAX_BYTES` | `telegram.attachments.maxBytes` | Inbound attachment download cap (bytes). Default 20 MiB (the hosted API's hard limit); raise it only with a self-hosted server. |
| `MONO_AGENT_TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `telegram.attachments.downloadTimeoutMs` | Per-file download timeout (ms) on the URL branch; default `30000`, `0` disables. |
| `MONO_AGENT_TELEGRAM_UPLOAD_MAX_BYTES` | `telegram.attachments.maxUploadBytes` | Upload cap (bytes) for `TelegramSendFile`; default 20 MiB. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT` | `telegram.transcription.endpoint` | Full HTTP(S) URL of an OpenAI-compatible `POST /v1/audio/transcriptions` route. Unset disables transcription. The built-in transcriber has no credential field and sends no `Authorization` header, so the endpoint must accept unauthenticated requests (typically from a local server). |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL` | `telegram.transcription.model` | Model name sent with each transcription request; required when the endpoint is set. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_LANGUAGE` | `telegram.transcription.language` | Optional ISO-639 language hint. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS` | `telegram.transcription.timeoutMs` | Per-call timeout in milliseconds (`1`–`3600000`); default `120000`, independent of the attachment download timeout. |

### Slack

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_SLACK_ENABLED` | `slack.enabled` | |
| `MONO_AGENT_SLACK_BOT_TOKEN` | `slack.botToken` | `xoxb-...` |
| `MONO_AGENT_SLACK_APP_TOKEN` | `slack.appToken` | `xapp-...` (Socket Mode). |
| `MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS` | `slack.allowedChannelIds` | Or `allowAllChannels`. See [Slack channel configuration](/channels/slack/). |
| `MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS` | `slack.allowAllChannels` | Allow any joined channel instead of requiring `allowedChannelIds`; default `false`. |
| `MONO_AGENT_SLACK_BOT_USER_IDS` | `slack.botUserIds` | Comma-separated bot user IDs used to recognize native mentions. |
| `MONO_AGENT_SLACK_MENTION_TEXT_ALIASES` | `slack.mentionTextAliases` | Comma-separated plain-text self identities recognized after admission; aliases do not admit shared-channel traffic without an `app_mention` event. |
| `MONO_AGENT_SLACK_STRIP_MENTION_TEXT` | `slack.stripMentionText` | When unset, preserves one readable authenticated self-mention marker; `true` restores legacy full stripping and `false` keeps raw mention forms. Operators using only `botUserIds` must set `true` to retain the previous implicit stripping behavior. |
| `MONO_AGENT_SLACK_UNFURL_LINKS` | `slack.unfurlLinks` | Optional native-agent `chat.postMessage` link-preview override. Omit to preserve Slack's current default behavior. |
| `MONO_AGENT_SLACK_UNFURL_MEDIA` | `slack.unfurlMedia` | Optional native-agent `chat.postMessage` media-preview override. Omit to preserve Slack's current default behavior. |
| `MONO_AGENT_SLACK_RESOLVE_USER_NAMES` | `slack.resolveUserNames` | Resolve the speaker's display name and handle via `users.info` so the agent knows who is talking; default `true`. Requires the `users:read` scope; a missing scope leaves turns unnamed. |
| `MONO_AGENT_SLACK_RESOLVE_CHANNEL_NAMES` | `slack.resolveChannelNames` | Resolve the channel's name via `conversations.info` so the agent knows which channel it is talking in; default `true`. Requires `channels:read`/`groups:read`; a missing scope leaves the surface named by kind and id only. |
| `MONO_AGENT_SLACK_THREAD_CONTEXT_ENABLED` | `slack.threadContext.enabled` | Send what was said in the conversation before the agent was triggered as untrusted background context; default `true`. Needs a `*:history` scope. |
| `MONO_AGENT_SLACK_THREAD_CONTEXT_MAX_MESSAGES` | `slack.threadContext.maxMessages` | Messages of context sent per turn, newest kept; default `15`, maximum `30`, `0` disables the read. |
| `MONO_AGENT_SLACK_THREAD_CONTEXT_REQUEST_LIMIT` | `slack.threadContext.requestLimit` | Objects requested from Slack per read; default `15`, matching Slack's cap for non-Marketplace apps. |
| `MONO_AGENT_SLACK_THREAD_CONTEXT_TIMEOUT_MS` | `slack.threadContext.timeoutMs` | Budget for the whole context phase including name resolution (ms); default `4000`. Exceeding it submits the turn with less context rather than delaying it. |
| `MONO_AGENT_SLACK_THREAD_CONTEXT_INCLUDE_BOT_MESSAGES` | `slack.threadContext.includeBotMessages` | Include other apps' messages, labelled as bots; default `true`. The agent's own posts are always excluded. |
| `MONO_AGENT_SLACK_HEARTBEAT_INTERVAL_MS` | `slack.heartbeatIntervalMs` | Socket Mode ping/silence probe interval (ms); default `30000`. |
| `MONO_AGENT_SLACK_HEARTBEAT_TIMEOUT_MS` | `slack.heartbeatTimeoutMs` | Silence budget before the watchdog force-recycles the socket (ms); default `90000`, `0` disables the watchdog. |
| `MONO_AGENT_SLACK_RECONNECT_INITIAL_BACKOFF_MS` | `slack.reconnectInitialBackoffMs` | First reconnect backoff after a non-graceful drop (ms); default `500`. |
| `MONO_AGENT_SLACK_RECONNECT_MAX_BACKOFF_MS` | `slack.reconnectMaxBackoffMs` | Backoff ceiling (ms); default `30000`. Jitter (ratio 0.2) is applied on by default. |
| `MONO_AGENT_SLACK_RECONNECT_STABILITY_MS` | `slack.reconnectStabilityMs` | A reconnect must stay open this long before the backoff resets (ms); default `30000` (not per-connect). |
| `MONO_AGENT_SLACK_RECONNECT_STARTUP_GRACE_MS` | `slack.reconnectStartupGraceMs` | Window (ms) to quietly retry a lingering prior-process socket instead of flagging `degraded`; default `10000`. |
| `MONO_AGENT_SLACK_DRAIN_DEADLINE_MS` | `slack.drainDeadlineMs` | Backstop (ms) to force a reconnect after a watchdog `terminate()` if the old socket emits no close; default `5000`. |

All Slack resilience vars are optional integers (`0`–`3600000`); omit to use the default. They tune the terminate-first, jittered, stability-gated reconnect loop and the silence watchdog. See [Slack channel configuration](/channels/slack/).

The structured Slack interaction fields are configured only in `mono-agent.config.json`:

- `slack.shortcuts` is JSON-only and has no environment-variable form.
- `slack.homeTab` is JSON-only and has no environment-variable form.

### WhatsApp

WhatsApp is loaded through `channels.plugins[]` with `package: "@mono-agent/whatsapp-adapter"`. These env vars override that plugin entry's `config` fields.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WHATSAPP_ENABLED` | plugin `config.enabled` | QR login; auth state in `.mono-agent/whatsapp-auth`. |
| `MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS` | plugin `config.allowedChatJids` | Or `allowAllChats`. |
| `MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS` | plugin `config.allowAllChats` | Allow any chat instead of requiring `allowedChatJids`; default `false`. |
| `MONO_AGENT_WHATSAPP_GROUP_MODE` | plugin `config.groupMode` | `mention` / `any`. See [WhatsApp channel configuration](/channels/whatsapp/). |
| `MONO_AGENT_WHATSAPP_BOT_JIDS` | plugin `config.botJids` | Comma-separated linked-account JIDs used to recognize native group mentions. |
| `MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES` | plugin `config.mentionTextAliases` | Comma-separated text aliases that count as group mentions. |
| `MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT` | plugin `config.stripMentionText` | Remove the matched mention or alias before the prompt reaches the agent. When unset, defaults to `true` only when `mentionTextAliases` is non-empty; `botJids` alone does not enable stripping, so otherwise it defaults to `false`. |

### Messenger

Messenger is loaded through `channels.plugins[]` with `package: "@mono-agent/messenger-adapter"`. These env vars override that plugin entry's `config` fields, except the three credentials, which are environment-only: `pageAccessToken`, `appSecret`, and `verifyToken` are rejected in JSON config with a typed `invalid_config` error.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_MESSENGER_ENABLED` | plugin `config.enabled` | Opt-in switch; default `false`. |
| `MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN` | env-only (no JSON key) | Page access token used for the Send API. Required when enabled. |
| `MONO_AGENT_MESSENGER_APP_SECRET` | env-only (no JSON key) | App secret used to verify `X-Hub-Signature-256` over the raw webhook body. Required when enabled. |
| `MONO_AGENT_MESSENGER_VERIFY_TOKEN` | env-only (no JSON key) | Token Meta echoes during webhook registration. Required when enabled. |
| `MONO_AGENT_MESSENGER_ALLOWED_USER_IDS` | plugin `config.allowedUserIds` | Comma-separated page-scoped user ids (PSIDs). Or `allowAllUsers`. |
| `MONO_AGENT_MESSENGER_ALLOW_ALL_USERS` | plugin `config.allowAllUsers` | Allow any sender instead of requiring `allowedUserIds`; default `false`. |
| `MONO_AGENT_MESSENGER_HOST` | plugin `config.host` | Bind host; default `127.0.0.1`. |
| `MONO_AGENT_MESSENGER_PORT` | plugin `config.port` | Bind port; default `8650`. |
| `MONO_AGENT_MESSENGER_WEBHOOK_PATH` | plugin `config.webhookPath` | Webhook route; default `/messenger/webhook`. `<path>/health` answers liveness checks. |
| `MONO_AGENT_MESSENGER_API_VERSION` | plugin `config.apiVersion` | Graph API version used for sends; default `v21.0`. |
| `MONO_AGENT_MESSENGER_ALLOW_NON_LOOPBACK` | plugin `config.allowNonLoopback` | Must be `true` for a non-loopback bind; enforced again immediately before `listen()`. |
| `MONO_AGENT_MESSENGER_PROACTIVE_MESSAGING_TYPE` | plugin `config.proactiveMessagingType` | `RESPONSE` / `UPDATE` / `MESSAGE_TAG` for proactive cron/webhook deliveries; default `RESPONSE`. See [Messenger channel configuration](/channels/messenger/). |
| `MONO_AGENT_MESSENGER_PROACTIVE_TAG` | plugin `config.proactiveTag` | Policy tag required with `MESSAGE_TAG`, e.g. `CONFIRMED_EVENT_UPDATE`. |

### Webhook

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WEBHOOK_ENABLED` | `webhook.enabled` | |
| `MONO_AGENT_WEBHOOK_HOST` | `webhook.host` | Bind host; default `127.0.0.1`. |
| `MONO_AGENT_WEBHOOK_PORT` | `webhook.port` | Bind port; default `0` selects a free port. |
| `MONO_AGENT_WEBHOOK_PATH` | `webhook.path` | Default single-endpoint path; default `/webhook/invoke`. |
| `MONO_AGENT_WEBHOOK_PROMPT` | `webhook.prompt` | Pre-instructions for the default single endpoint. |
| `MONO_AGENT_WEBHOOK_DEFAULT_MODE` | `webhook.defaultMode` | `sync` or `async`; default `sync`. |
| `MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK` | `webhook.allowNonLoopback` | Must be `true` for a non-loopback bind. |
| `MONO_AGENT_WEBHOOK_API_KEY` | `webhook.apiKey` | Optional on loopback; required for any enabled non-loopback bind. Clients send it as a bearer. |
| `MONO_AGENT_WEBHOOK_RETENTION_MS` | `webhook.retentionMs` | Async status retention in milliseconds; default `300000`. |
| `MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS` | `webhook.maxStoredRequests` | Maximum retained async statuses; default `100`. |
| `MONO_AGENT_WEBHOOK_MAX_ATTACHMENT_BYTES` | `webhook.maxAttachmentBytes` | Decoded-byte ceiling for one inbound audio upload; default `20971520`. Oversize uploads are rejected with HTTP `413`. |
| `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` | `webhook.endpoints[]` | JSON array of named endpoints. |
| `MONO_AGENT_WEBHOOK_NOTIFY` | `webhook.notify` | Single-endpoint native notification toggle. |
| `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID` | `webhook.notifyConversationId` | Single-endpoint native notification destination. |
| `MONO_AGENT_WEBHOOK_MODEL` | `webhook.model` | Single-endpoint model override (e.g. `claude:claude-opus-4-8`). A request body `model` wins. |
| `MONO_AGENT_WEBHOOK_EFFORT` | `webhook.effort` | Single-endpoint reasoning-effort override (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`), subject to model support. Reasoning-capable models map `ultra` to LOW; models without reasoning use OFF. `max` degrades to `xhigh` unless the resolved model advertises it. `mono-agent doctor` validates effort against the model's advertised levels and warns, naming the nearest supported level, when a configured value is outside that set. Ranking above `max` only prevents keyword downgrade. A request body `effort` wins. |
| `MONO_AGENT_WEBHOOK_DIR` | `webhook.dir` | Folder of `*.md` endpoint files. See [webhook channel configuration](/channels/webhook/). |
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
| `MONO_AGENT_OPENAI_API_MODEL_ID` | `openaiApi.modelId` | Advertised model id. See [OpenAI-compatible API configuration](/channels/openai-api/). |

### Always-on web console CLI

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WEB_ALLOWED_HOSTS` | — (CLI-only) | Comma-separated additional exact DNS names accepted by `mono-agent web`; suffix wildcards are rejected. Managed `start`/`restart` preserves these names and adds this node's exact Tailscale DNS name when available. This changes Host admission only; it does not add authentication or make an untrusted network safe. |
| `MONO_AGENT_WEB_PUSH_SUBJECT` | — (CLI-only) | VAPID contact subject for Web Push; defaults to `https://github.com/robertsreberski/mono-agent`. Accepts a `mailto:` address or a non-localhost HTTPS URL. Managed `web start`/`restart` passes it into the LaunchAgent; invalid values fail startup before notification delivery begins. |

### Operator stream endpoint

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_TUI_ENABLED` | `tui.enabled` | **Default `true`** — default-on loopback operator endpoint used by `mono-agent web`, ACP, and jobs clients. |
| `MONO_AGENT_TUI_HOST` | `tui.host` | Default `127.0.0.1`. |
| `MONO_AGENT_TUI_PORT` | `tui.port` | Default `0` (ephemeral; published to the trace-source registry). |
| `MONO_AGENT_TUI_BASE_PATH` | `tui.basePath` | Default `/gui`. |
| `MONO_AGENT_TUI_ALLOW_NON_LOOPBACK` | `tui.allowNonLoopback` | Required to bind a non-loopback host. |
| `MONO_AGENT_TUI_API_KEY` | `tui.apiKey` | Optional bearer the console must present. Put the value in `.env`; inline `tui.apiKey` remains accepted for compatibility but is not the documented source-config convention. See [operator stream configuration](/channels/tui/). |
| `MONO_AGENT_TUI_REQUEST_TOOL_ENVIRONMENT_ALLOWED_KEYS` | `tui.requestToolEnvironment.allowedKeys` | Comma-separated names an ACP turn may pass to Bash, Exec, and nested subagents. Disabled by default; dangerous loader, shell-startup, home, temp, and PATH keys are rejected. |
| `MONO_AGENT_TUI_REQUEST_TOOL_ENVIRONMENT_ALLOW_PATH_PREPEND` | `tui.requestToolEnvironment.allowPathPrepend` | Allows an ACP turn to prepend bounded absolute directories to process-tool PATH. Default `false`; request callers can never replace PATH. |

### A2A

The A2A provider is loaded through `channels.plugins[]` with `package: "@mono-agent/a2a-adapter"`. These env vars override that plugin entry's `config` fields.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_A2A_ENABLED` | plugin `config.enabled` | Canonical enable flag for the A2A provider, matching other channels. Wins over the legacy form below when both are set. |
| `MONO_AGENT_A2A_PROVIDER_ENABLED` | plugin `config.provider.enabled` | Legacy enable flag (still honored). Prefer `MONO_AGENT_A2A_ENABLED`. |
| `MONO_AGENT_A2A_HOST` | plugin `config.provider.host` | Provider bind host. Non-loopback values require `allowNonLoopback`. |
| `MONO_AGENT_A2A_PORT` | plugin `config.provider.port` | Provider listen port. |
| `MONO_AGENT_A2A_PUBLIC_BASE_URL` | plugin `config.provider.publicBaseUrl` | Public base URL advertised in the Agent Card when fronted by a proxy. |
| `MONO_AGENT_A2A_ALLOW_NON_LOOPBACK` | plugin `config.provider.allowNonLoopback` | Explicit opt-in for a non-loopback bind or public base URL. |
| `MONO_AGENT_A2A_REQUIRE_BEARER` | plugin `config.provider.requireBearer` | Requires bearer authentication on message/task endpoints. |
| `MONO_AGENT_A2A_BEARER_TOKEN` | plugin `config.provider.bearerToken` | Used when `requireBearer` is set. See [A2A channel configuration](/channels/a2a/). |
| `MONO_AGENT_A2A_MAX_REQUEST_BYTES` | plugin `config.provider.maxRequestBytes` | Optional JSON request-body ceiling for JSON-RPC and REST; 1024–100000000 bytes. |
| `MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE` | plugin `config.provider.idempotency.namespace` | Explicitly enables durable keyed dispatch and defines its stable authenticated-principal boundary. |
| `MONO_AGENT_A2A_IDEMPOTENCY_STATE_DIR` | plugin `config.provider.idempotency.stateDir` | Optional durable receipt directory; a namespace-derived owner-only path is used when omitted. |
| `MONO_AGENT_A2A_IDEMPOTENCY_RETENTION_MS` | plugin `config.provider.idempotency.retentionMs` | Full terminal-result replay horizon; defaults to 30 days. |
| `MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS` | plugin `config.provider.idempotency.maxRecords` | Hard lifetime unique-key capacity; existing bindings are never evicted. |
| `MONO_AGENT_A2A_AGENT_NAME` | plugin `config.agent.name` | Public Agent Card name; wins over the root agent name. |
| `MONO_AGENT_A2A_AGENT_DESCRIPTION` | plugin `config.agent.description` | Agent Card description. |
| `MONO_AGENT_A2A_AGENT_VERSION` | plugin `config.agent.version` | Agent Card version string. |
| `MONO_AGENT_A2A_PROVIDER_ORGANIZATION` | plugin `config.agent.providerOrganization` | Provider organization advertised only when `providerUrl` is also set. |
| `MONO_AGENT_A2A_PROVIDER_URL` | plugin `config.agent.providerUrl` | Provider organization URL advertised only when `providerOrganization` is also set. |
| `MONO_AGENT_A2A_SKILL_ID` | plugin `config.skill.id` | Advertised skill identifier. |
| `MONO_AGENT_A2A_SKILL_NAME` | plugin `config.skill.name` | Advertised skill name. |
| `MONO_AGENT_A2A_SKILL_DESCRIPTION` | plugin `config.skill.description` | Advertised skill description. |
| `MONO_AGENT_A2A_SKILL_TAGS` | plugin `config.skill.tags` | Comma-separated advertised skill tags. |
| `MONO_AGENT_A2A_REMOTE_AGENT_URLS` | plugin `config.consumer.remoteAgentUrls` | Comma-separated allowlist of remote A2A agent base URLs. |
| `MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL` | plugin `config.consumer.defaultRemoteAgentUrl` | Default remote A2A agent base URL. |
| `MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN` | plugin `config.consumer.bearerToken` | Bearer token sent by the programmatic consumer. Keep it in `.env`. |
| `MONO_AGENT_A2A_TIMEOUT_MS` | plugin `config.consumer.timeoutMs` | Per-request consumer timeout in milliseconds. |

### Cron

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_CRON_JOBS_JSON` | `cron.jobs[]` | Full JSON array of jobs. |
| `MONO_AGENT_CRON_OPERATOR_ACTIONS_ENABLED` | `cron.operatorActions.enabled` | Permit API-key-authenticated, explicitly confirmed run-now and runtime enable/disable actions; default `false`. |
| `MONO_AGENT_CRON_ENABLED` | `cron.enabled` | Enable the legacy/default single-job form; default `false`. |
| `MONO_AGENT_CRON_EXPRESSION` | `cron.expression` | Five-field expression for the default single job. |
| `MONO_AGENT_CRON_TIMEZONE` | `cron.timezone` | IANA timezone for the default single job; default `UTC`. |
| `MONO_AGENT_CRON_PROMPT` | `cron.prompt` | Prompt for the default single job. |
| `MONO_AGENT_CRON_CONVERSATION_ID` | `cron.conversationId` | Optional stable conversation id for the default single job. |
| `MONO_AGENT_CRON_NOTIFY` | `cron.notify` | Deliver the default job's successful result natively; default `false`. |
| `MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID` | `cron.notifyConversationId` | Explicit native-notification destination for the default job. |
| `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS` | `cron.notifyFailureCooldownHours` | Single-job cooldown, in hours, for all-models-failed error notices on `notify: true` cron jobs; default `6`. |
| `MONO_AGENT_CRON_MODEL` | `cron.model` | Runtime model override for the default single job. |
| `MONO_AGENT_CRON_EFFORT` | `cron.effort` | Reasoning-effort override for the default single job, subject to model support. |
| `MONO_AGENT_CRON_PREFLIGHT_JSON` | `cron.preflight` | Explicit argv array (one-line JSON) evaluated before the model responder for the default single job; `{"run":false}` ends the firing as `skipped_gate`, and every gate failure fails open. |
| `MONO_AGENT_CRON_PREFLIGHT_TIMEOUT_MS` | `cron.preflightTimeoutMs` | Bound, in milliseconds, for one preflight evaluation before it is killed and fails open; default `5000`, max `60000`, separate from `maxRunMs`. |
| `MONO_AGENT_CRON_DIR` | `cron.dir` | Folder of per-job `*.md` files; default `cron/`. Folder and config jobs merge; duplicate ids error. See [cron channel configuration](/channels/cron/). |
