# @mono-agent/openai-api-adapter

## Category

Category: `communication`

## Responsibility

OpenAI-compatible Chat Completions adapter for agent hosts. It starts a small HTTP server, exposes model discovery for OpenWebUI, maps `/v1/chat/completions` requests into structural `AgentResponder` calls, and returns OpenAI-shaped JSON or Server-Sent Event streaming responses.

## Install / Usage

```bash
pnpm --filter @mono-agent/openai-api-adapter run build
```

```ts
import { startOpenAIApiAdapter } from "@mono-agent/openai-api-adapter";

const adapter = await startOpenAIApiAdapter({
  host: "127.0.0.1",
  port: 4311,
  modelId: "agent",
  responder,
});
```

Point OpenWebUI at the printed base URL, for example `http://127.0.0.1:4311/v1`. If OpenWebUI runs in Docker while the host agent runs locally, use `http://host.docker.internal:4311/v1`. Configure the same API key in OpenWebUI when `openaiApi.apiKey` or `MONO_AGENT_OPENAI_API_KEY` is set. A non-loopback bind fails closed unless both `allowNonLoopback` and that key are present. Wildcard binds expose concrete usable loopback/private-LAN/Tailscale entries through `baseUrls`; `baseUrl` is the concrete loopback entry rather than `0.0.0.0`.

## Conversation Sessions (Open WebUI)

The adapter derives a stable `conversationId` so the agent harness can reuse provider sessions and history across requests. Candidates, in priority order: `metadata.conversation_id` / `metadata.conversationId` / `metadata.chat_id` / `metadata.chatId`, top-level `conversation_id` / `conversationId`, the `X-OpenWebUI-Chat-Id` header, the generic `X-Conversation-Id` header, then `user`. Without any of these, every request becomes a fresh conversation (`openai-api:<requestId>`).

Open WebUI strips `metadata` and other non-OpenAI fields from request bodies, so header forwarding is the path that works: set `ENABLE_FORWARD_USER_INFO_HEADERS=true` on the Open WebUI instance and it sends `X-OpenWebUI-Chat-Id` per chat. Other proxies can send `X-Conversation-Id`.

When a conversation id comes from body metadata, top-level fields, or headers, the adapter sends only the user message(s) after the last assistant message as the turn text — the harness already carries the rest of the transcript via its history store and provider sessions, so resending the full transcript would double the context. The first turn (no assistant message in the transcript yet) is still sent whole, role-prefixed, so a client system prompt is delivered once at conversation start. Requests whose only identity is `user` keep full-transcript flattening: `user` identifies a person, not a chat, and collapsing all of their chats into one latest-message conversation would lose context.

Behavior change note: clients that previously sent `metadata.conversation_id` together with full transcripts now get latest-message extraction. This is intentional — the harness owns per-conversation history. A client that mints a fresh "conversation id" per request while relying on transcript replay should stop sending an id; the fallback path preserves full-transcript semantics.

Open WebUI caveat: title and tag generation requests go to the same backend and can carry the same chat id header, landing as extra turns in the conversation's session. Point Open WebUI's Task Model (Admin Settings → Interface) at a separate lightweight model, or disable automatic title/tag generation.

Sampling parameter caveat: `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`, `logit_bias`, `presence_penalty`, and `frequency_penalty` are preserved in `metadata.openaiApi.parameters` for compatibility, but the adapter does not currently apply them to the configured runtime. Absent parameters and explicit OpenAI defaults are quiet. A supplied non-default value emits a `runtime_warning` containing only the ignored parameter names, then the request continues with the runtime's configured values. Streaming responses render it as a reasoning delta; non-stream JSON responses include the structured event in the additive `mono_agent.events` extension. Open WebUI sampling sliders are therefore currently inert.

Streaming responders may send structured stream events through `AgentMessageStream.event()`. Genuine assistant thoughts are emitted as `delta.reasoning_content` so OpenWebUI can render them separately from the final answer. Tool starts are not synthesized into reasoning text such as `Running Bash...`. Internally executed tools are rendered as OpenWebUI `<details type="tool_calls">` content blocks after completion. The adapter intentionally does not emit `delta.tool_calls` or `finish_reason: "tool_calls"` for host-owned tools because those fields ask the client to execute tools.

Tool-call argument and result previews each have a 128 KiB UTF-8 upper bound by
default. The adapter lowers the applied per-field bound when HTML/JSON escaping
would otherwise make the fully serialized OpenWebUI tool-details SSE frame
exceed 256 KiB. Truncated values become a valid JSON projection with
`__monoAgentTruncation` applied/original/retained/omitted byte counts plus a
code-point-safe `preview`.
Programmatic hosts can lower the preview boundary with `maxToolPayloadBytes`
(including `0` for metadata-only projections), but cannot raise it above the
default safety cap. Truncation does not replace fields on the source stream
event; payload serialization otherwise follows normal JavaScript JSON/string
conversion semantics, including any user-defined getters or `toJSON` hooks.
Whether a full event is retained in an artifact is a host-level persistence
decision.

## OpenWebUI Upload Support

OpenWebUI photo uploads arrive at OpenAI-compatible backends as standard Chat Completions content parts:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is in this picture?" },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,...",
        "detail": "high"
      }
    }
  ]
}
```

The adapter accepts `image_url` parts and exposes the **full** structural list on
`OpenAIApiChatRequest.imageAttachments` (every accepted part: base64 `data:`,
remote `http(s)`, and `file-` URLs). Base64 `data:` images are **also** bridged
into the shared `AgentRequestBase.attachments` contract (decoded mime + base64
data), so they reach the generic app/harness path automatically. Remote/file URL
images are **not** downloaded here, so they appear only on `imageAttachments`
(and as a `metadata.openaiApi.attachments` summary) — a vision host that wants
them must read `imageAttachments` and fetch/handle the URLs itself. The text
content still feeds `request.text`, so text-only responders keep working.

The adapter does not fetch remote image URLs, validate image bytes, or claim
model-level vision support. `metadata.openaiApi.attachments` contains only a
small summary, excluding full image URLs and data payloads.

### OpenWebUI Feature Triage

| OpenWebUI feature | Possible to port here? | Worth porting now? | Decision |
| --- | --- | --- | --- |
| Photo/image upload in chat | Yes | Yes | Supported via Chat Completions `image_url` content parts and `request.attachments`. |
| Multiple images in one message | Yes | Yes | Supported by preserving each `image_url` part as a separate attachment. |
| Document/RAG file upload | Partly | No | OpenWebUI owns file ingestion with `/api/v1/files/`, file processing status, and knowledge collections. This Chat Completions bridge should consume the resulting prompt/context rather than reimplement OpenWebUI storage and retrieval. |
| OpenAI Files API | Technically possible | No | Requires storage, lifecycle, purpose validation, and retrieval semantics outside this adapter's transport boundary. |
| Image generation or editing | No, not in this API surface | No | This adapter serves Chat Completions; image generation/editing belongs to Images or Responses API support. |
| Audio input/output | Possible later | No | The current shared responder contract is text-first plus optional image attachments; audio needs a separate contract decision. |
| Client-executed OpenAI tool/function calls | Possible later | No | Host-owned tools already stream as OpenWebUI details blocks; emitting OpenAI tool calls would ask the client to execute tools and is intentionally unsupported. |

## Public API

<!-- public-api-inventory:start -->
<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->

Every symbol exported by each public code entrypoint is listed below.

**`@mono-agent/openai-api-adapter`**

```text
DEFAULT_MAX_TOOL_PAYLOAD_BYTES
LoadOpenAIApiAdapterConfigInput
MAX_TOOL_SSE_FRAME_BYTES
OPENAI_API_CONFIG_FIELDS
OpenAIApiAdapterConfig
OpenAIApiAdapterError
OpenAIApiAdapterErrorCode
OpenAIApiAdapterErrorDetails
OpenAIApiAdapterLogger
OpenAIApiAdapterOptions
OpenAIApiAdapterStartResult
OpenAIApiAttachment
OpenAIApiAttachmentMetadata
OpenAIApiAttachmentUrlKind
OpenAIApiChatRequest
OpenAIApiImageAttachment
OpenAIApiImageAttachmentMetadata
OpenAIApiImageDetail
OpenAIApiRequestMetadata
RedactedOpenAIApiAdapterConfig
loadOpenAIApiAdapterConfig
redactOpenAIApiAdapterConfig
startOpenAIApiAdapter
```

<!-- public-api-inventory:end -->

## Dependency Boundary

This adapter depends on Express plus shared `@mono-agent/agent-contracts` primitives. It must not depend on the agent harness, runtime adapter, operator surfaces, memory, observability, other communication adapters, or host/demo code. Hosts compose it with a structural responder.

## What This Package Does Not Own

It does not build prompts, run models, persist conversations, implement the Responses API, embeddings, image generation/editing, audio, OpenAI Files API storage, OpenAI tool/function calling, TLS, or public deployment policy. The adapter binds to loopback by default; public deployment safety is host or reverse-proxy responsibility.

## Verification

```bash
pnpm --filter @mono-agent/openai-api-adapter run build
pnpm --filter @mono-agent/openai-api-adapter run typecheck
pnpm --filter @mono-agent/openai-api-adapter run test
```
