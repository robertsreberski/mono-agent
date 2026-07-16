# @mono-agent/webhook-adapter

## Category

Category: `communication`

## Responsibility

HTTP webhook invocation adapter for agent hosts. It starts a small HTTP server, validates JSON invocation requests, maps them into structural `AgentResponder` calls, and returns either a synchronous result or an in-memory async request status. One server can serve **multiple named endpoints**, each with its own path, mode, and optional `prompt`.

## Port ownership

The adapter binds **its own** HTTP port — it is *not* inherited from a parent mono-agent process (mono-agent is not itself an HTTP server; each HTTP-bearing channel binds its own port). `port: 0` (the default) asks the OS for a random free port, so the resolved URL is unpredictable. **Set an explicit port** (e.g. `4310`) when you need a stable URL that skills or webhook `prompt`s can reference. The resolved invoke URL(s) are reported in the channel `summary` (visible via `mono-agent status` and logs).

## Install / Usage

```bash
pnpm --filter @mono-agent/webhook-adapter run build
```

```ts
import { startWebhookAdapter } from "@mono-agent/webhook-adapter";

const apiKey = process.env.MONO_AGENT_WEBHOOK_API_KEY;
const webhook = await startWebhookAdapter({
  host: "127.0.0.1",
  port: 4310,
  ...(apiKey === undefined ? {} : { apiKey }),
  responder,
  endpoints: [
    { name: "invoke", path: "/webhook/invoke" },
    { name: "deep-research", path: "/webhook/deep-research", mode: "async", prompt: "Check deep-research/requests/*.md, match the incoming payload, address it, then move the file to deep-research/researched/." },
  ],
});
```

A single legacy endpoint still works (`path`/`defaultMode` are folded into a one-element `endpoints` list):

```ts
await startWebhookAdapter({ host: "127.0.0.1", port: 4310, path: "/webhook/invoke", responder });
```

For programmatic native-notify composition, an endpoint can set an explicit `notifyConversationId`, a pre-resolved `notifyFallbackConversationId`, or the adapter options can provide `resolveNotifyFallbackConversationId`. The resolver runs once per invocation after explicit and deliverable request destinations are considered. Its selected route is attached to the responder-facing request's host-only `replyTo`, retained privately by the run, and reconstructed on a separate completion request for `onResult`; responder mutation therefore cannot redirect, suppress, or inject final delivery. The resolver receives the request's optional `AbortSignal`, and the adapter also races its promise against that signal so disconnect/stop can reclaim the slot even when resolver code does not cooperate.

`NATIVE_NOTIFY_CALLBACK_CHANNEL_IDS` is the exact request-conversation policy: Telegram and Slack are eligible, while WhatsApp remains excluded until its plugin driver exposes a native notify hook.

Send a sync invocation (omit the `authorization` header when `apiKey` is not configured):

```bash
curl -X POST "$WEBHOOK_URL/webhook/invoke" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MONO_AGENT_WEBHOOK_API_KEY" \
  -d '{"text":"Run the agent","conversationId":"demo","mode":"sync"}'
```

Async mode returns `202` with `requestId` and `statusUrl`; status is process-local memory and is not durable across restarts.

`apiKey` is optional for loopback-only use. When configured, every invocation and async status lookup requires `Authorization: Bearer <key>`; authentication runs before invocation-body parsing, so malformed, missing, and incorrect credentials receive the same `401` response without decoding the JSON body. Any non-loopback bind requires both `allowNonLoopback: true` and a non-empty key. Host config reads the key from `webhook.apiKey` / `MONO_AGENT_WEBHOOK_API_KEY`, redacts it from config views, and should normally keep it in the environment rather than committed JSON.

Webhook response metadata contains channel-safe run diagnostics such as the run id and status. Compiled system prompts are retained only in local run artifacts and are never returned by this external HTTP API. As defense in depth, the adapter removes `metadata.summary.systemPrompt` even when a custom responder supplies it; sibling summary fields and unrelated metadata are preserved.

## Per-webhook prompt

Each endpoint may carry a `prompt` (pre-instructions, same role as a cron job's prompt). When set, the adapter forms the agent's user message as `prompt` + `\n\n` + the posted `text`. The webhook imposes no correlation scheme of its own: it forwards the request's `conversationId` and arbitrary `metadata` through unchanged, so a `prompt` plus filesystem/skill conventions can drive any workflow (e.g. matching incoming results to request files on disk).

> Loopback note: a webhook is request/response — the resumed turn's output is returned on the POST's own HTTP response (sync) or status endpoint (async). `createConfiguredAgentResponder` keeps the latest 64 messages for each exact conversation bucket in owner-only durable storage and applies auto-compaction + daily session rollover. The async request-status table itself remains in memory, and provider sessions may still compact or rotate, so workflows that need correlation beyond the bounded history should record it in long-term memory or their own durable state.

## Configuring multiple endpoints (host config)

`loadWebhookAdapterConfig` reads endpoints from, in precedence order: `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON`, the `webhook.endpoints` array, then the legacy single `webhook.path`/`webhook.prompt` fields. Endpoints can also be authored as `*.md` files in the `webhook` folder (override via `webhook.dir` / `MONO_AGENT_WEBHOOK_DIR`), mirroring cron jobs — frontmatter is routing, the body is the `prompt`:

```markdown
---
path: /webhook/deep-research
mode: async
---
Check deep-research/requests/*.md, match the incoming payload to an existing
request, address it, then move that file to deep-research/researched/.
```

Folder endpoints are merged with config endpoints; a duplicate `name` or `path` is a hard error.

## Public API

<!-- public-api-inventory:start -->
<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->

Every symbol exported by each public code entrypoint is listed below.

**`@mono-agent/webhook-adapter`**

```text
LoadWebhookAdapterConfigInput
NATIVE_NOTIFY_CALLBACK_CHANNEL_IDS
RedactedWebhookAdapterConfig
WEBHOOK_CONFIG_FIELDS
WebhookAdapterConfig
WebhookAdapterError
WebhookAdapterErrorCode
WebhookAdapterErrorDetails
WebhookAdapterLogger
WebhookAdapterOptions
WebhookAdapterStartResult
WebhookBusyResponse
WebhookEndpointConfig
WebhookEndpointOption
WebhookEndpointSummary
WebhookInvocationMode
WebhookInvocationRequest
WebhookInvocationStatus
WebhookRequestMetadata
loadWebhookAdapterConfig
loadWebhookEndpointsFromDirectory
normalizePath
parseWebhookEndpointMarkdown
redactWebhookAdapterConfig
startWebhookAdapter
```

<!-- public-api-inventory:end -->

## Dependency Boundary

This adapter depends on Express plus shared `@mono-agent/agent-contracts` primitives. It must not depend on the agent harness, runtime adapter, operator surfaces, memory, observability, other communication adapters, or host/demo code. Hosts compose it with a structural responder.

## What This Package Does Not Own

It does not build prompts, run models, persist async status, verify provider-specific webhook signatures, manage TLS, expose an operator UI, or own core agent settings. The adapter binds to loopback by default and provides optional static bearer authentication; TLS, key rotation, rate limiting, and reverse-proxy policy remain host responsibilities.

## Verification

```bash
pnpm --filter @mono-agent/webhook-adapter run build
pnpm --filter @mono-agent/webhook-adapter run typecheck
pnpm --filter @mono-agent/webhook-adapter run test
```
