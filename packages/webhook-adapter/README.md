# @worklab-ai/webhook-adapter

## Category

Category: `communication`

## Responsibility

HTTP webhook invocation adapter for Mono Agent hosts. It starts a small HTTP server, validates JSON invocation requests, maps them into structural `AgentResponder` calls, and returns either a synchronous result or an in-memory async request status.

## Install / Usage

```bash
pnpm --filter @worklab-ai/webhook-adapter run build
```

```ts
import { startWebhookAdapter } from "@worklab-ai/webhook-adapter";

const webhook = await startWebhookAdapter({
  host: "127.0.0.1",
  port: 4310,
  path: "/webhook/invoke",
  responder,
});
```

Send a sync invocation:

```bash
curl -X POST "$WEBHOOK_URL/webhook/invoke" \
  -H 'content-type: application/json' \
  -d '{"text":"Run the agent","conversationId":"demo","mode":"sync"}'
```

Async mode returns `202` with `requestId` and `statusUrl`; status is process-local memory and is not durable across restarts.

## Public API

- `startWebhookAdapter`
- `WebhookAdapterError`
- `loadWebhookAdapterConfig`
- `redactWebhookAdapterConfig`
- `webhookFieldGroup`
- Webhook adapter, config, request metadata, invocation status, and logger types

## Dependency Boundary

This adapter depends on Express plus shared contracts/settings primitives. It must not depend on the agent harness, runtime adapter, operator surfaces, memory, observability, other communication adapters, or host/demo code. Hosts compose it with a structural responder.

## What This Package Does Not Own

It does not build prompts, run models, persist async status, authenticate external webhook providers, manage TLS, expose an operator UI, or own core Mono Agent settings. The adapter binds to loopback by default; public deployment safety is host or reverse-proxy responsibility.

## Verification

```bash
pnpm --filter @worklab-ai/webhook-adapter run build
pnpm --filter @worklab-ai/webhook-adapter run typecheck
pnpm --filter @worklab-ai/webhook-adapter run test
```
