---
title: "OpenAI-compatible API"
sidebar:
  order: 5
---

# OpenAI-compatible API

This channel exposes your agent over an OpenAI-compatible HTTP surface: `GET /v1/models` and `POST /v1/chat/completions` with SSE token streaming. Any client that speaks the OpenAI Chat Completions protocol — Open WebUI, the `openai` SDKs, LangChain, `curl` — can drive the agent without a bespoke adapter.

Coverage: `config` (the entire surface is enabled and tuned from the `openaiApi` section of `mono-agent.config.json`).

## Configuration

```json
{
  "openaiApi": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4040,
    "basePath": "/v1",
    "allowNonLoopback": false,
    "modelId": "my-agent",
    "apiKey": "sk-..."
  }
}
```

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Opt-in. When `false` the HTTP server is not started. |
| `host` | string | `127.0.0.1` | Bind address. Loopback by default. |
| `port` | integer | `4040` | TCP port (0–65535). |
| `basePath` | string | `/v1` | Path prefix; serves `<basePath>/models` and `<basePath>/chat/completions`. Must be an absolute path with no query or hash. |
| `allowNonLoopback` | boolean | `false` | Required guard before binding a non-loopback `host`. See the warning below. |
| `modelId` | string | `agent` | The model id advertised in `/v1/models` and accepted in the request `model` field. |
| `apiKey` | string | _unset_ | Optional bearer token clients must present as `Authorization: Bearer <apiKey>`. When unset, no auth is enforced. |

:::caution
:::
Binding to a non-loopback `host` (anything other than `127.0.0.1`/`localhost`) requires both `allowNonLoopback: true` and a non-empty `apiKey`. Startup fails closed if either guard is missing. Prefer a reverse proxy with TLS when the endpoint crosses an untrusted network.

## Environment variables

Every key has a matching `MONO_AGENT_*` override, applied on top of the JSON config:

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_OPENAI_API_ENABLED` | `openaiApi.enabled` |
| `MONO_AGENT_OPENAI_API_HOST` | `openaiApi.host` |
| `MONO_AGENT_OPENAI_API_PORT` | `openaiApi.port` |
| `MONO_AGENT_OPENAI_API_BASE_PATH` | `openaiApi.basePath` |
| `MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK` | `openaiApi.allowNonLoopback` |
| `MONO_AGENT_OPENAI_API_MODEL_ID` | `openaiApi.modelId` |
| `MONO_AGENT_OPENAI_API_KEY` | `openaiApi.apiKey` |

See [Environment variables](/config/env-vars/) for precedence rules across config layers.

## Endpoints

### `GET /v1/models`

Returns a single model entry whose `id` is your configured `modelId`. Clients use this to populate model pickers.

```bash
curl http://127.0.0.1:4040/v1/models \
  -H "Authorization: Bearer sk-..."
```

### `POST /v1/chat/completions`

Standard Chat Completions request. The endpoint always streams token-by-token over SSE for streaming-capable clients, regardless of the final-only delivery default that Telegram and Slack use.

```bash
curl http://127.0.0.1:4040/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-agent",
    "stream": true,
    "messages": [{ "role": "user", "content": "Summarize today’s standup." }]
  }'
```

Common sampling parameters (`temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`, …) are accepted and forwarded to the runtime where the backend supports them.

## Session continuity

The OpenAI protocol is stateless — clients resend the whole transcript on every call. mono-agent instead keys a persistent agent conversation off a stable id and forwards **only the latest user turn** for that conversation, so the agent's own memory and session history are the source of truth (not the client-supplied transcript).

The conversation id is resolved from the first present of these, in order:

1. `metadata.conversation_id` / `metadata.conversationId` / `metadata.chat_id` / `metadata.chatId` in the request body
2. `conversation_id` / `conversationId` at the top level of the request body
3. The `X-OpenWebUI-Chat-Id` request header
4. The `X-Conversation-Id` request header

Open WebUI strips metadata from the bodies it forwards but, when `ENABLE_FORWARD_USER_INFO_HEADERS` is enabled, sends the chat id as `X-OpenWebUI-Chat-Id` — which is why the header fallbacks exist. `X-Conversation-Id` is the generic equivalent for other proxies.

:::note
:::
If no id can be resolved, each request is treated as a fresh conversation. For multi-turn continuity, make sure your client forwards a stable id via body metadata or one of the headers above.

Because only the latest turn is forwarded, the agent's [memory](/memory/capture-and-recall/) and [sessions](/runtime/sessions-concurrency/) handle history. The same [Tool Policy](/tools/policy/) and runtime guards apply to API turns as to any other channel.

## Open WebUI integration

1. Start your agent with `openaiApi.enabled: true` (e.g. `host: 127.0.0.1`, `port: 4040`).
2. In Open WebUI, go to **Settings → Connections → OpenAI API** and add a connection:
   - **API Base URL**: `http://127.0.0.1:4040/v1`
   - **API Key**: the value of `openaiApi.apiKey` (any non-empty string if you left `apiKey` unset).
3. Save. Open WebUI calls `/v1/models` and your `modelId` appears in the model picker — select it.
4. To preserve multi-turn continuity, enable `ENABLE_FORWARD_USER_INFO_HEADERS=true` in Open WebUI so it forwards `X-OpenWebUI-Chat-Id`. Each Open WebUI chat then maps to one persistent agent conversation.

If Open WebUI and the agent run on different hosts, set `allowNonLoopback: true`, bind a reachable `host`, and protect the port with an `apiKey` (and ideally a TLS-terminating proxy).

For an end-to-end walkthrough, see the playbook [OpenAI endpoint with Open WebUI](/playbooks/openai-endpoint-open-webui/).

## Related

- [Channels overview](/channels/)
- [Delivery and send tools](/channels/delivery-and-send-tools/)
- [Sessions and concurrency](/runtime/sessions-concurrency/)
- [Capture and recall](/memory/capture-and-recall/)
