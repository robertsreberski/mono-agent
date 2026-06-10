# @mono-agent/openai-api-adapter

## Category

Category: `communication`

## Responsibility

OpenAI-compatible Chat Completions adapter for Mono Agent hosts. It starts a small HTTP server, exposes model discovery for OpenWebUI, maps `/v1/chat/completions` requests into structural `AgentResponder` calls, and returns OpenAI-shaped JSON or Server-Sent Event streaming responses.

## Install / Usage

```bash
pnpm --filter @mono-agent/openai-api-adapter run build
```

```ts
import { startOpenAIApiAdapter } from "@mono-agent/openai-api-adapter";

const adapter = await startOpenAIApiAdapter({
  host: "127.0.0.1",
  port: 4311,
  modelId: "mono-agent",
  responder,
});
```

Point OpenWebUI at the printed base URL, for example `http://127.0.0.1:4311/v1`. If OpenWebUI runs in Docker while Mono Agent runs on the host, use `http://host.docker.internal:4311/v1`. Configure an API key in OpenWebUI only when `openaiApi.apiKey` or `MONO_AGENT_OPENAI_API_KEY` is set.

Streaming responders may send structured stream events through `AgentMessageStream.event()`. Assistant thoughts are emitted as `delta.reasoning_content` so OpenWebUI can render them separately from the final answer. Internally executed tools are rendered as OpenWebUI `<details type="tool_calls">` content blocks after completion. The adapter intentionally does not emit `delta.tool_calls` or `finish_reason: "tool_calls"` for host-owned tools because those fields ask the client to execute tools.

## Public API

- `startOpenAIApiAdapter`
- `OpenAIApiAdapterError`
- `loadOpenAIApiAdapterConfig`
- `redactOpenAIApiAdapterConfig`
- `openAIApiFieldGroup`
- OpenAI API adapter config, request metadata, start result, and logger types

## Dependency Boundary

This adapter depends on Express plus shared contracts/settings primitives. It must not depend on the agent harness, runtime adapter, operator surfaces, memory, observability, other communication adapters, or host/demo code. Hosts compose it with a structural responder.

## What This Package Does Not Own

It does not build prompts, run models, persist conversations, implement the Responses API, embeddings, images, audio, OpenAI tool/function calling, TLS, or public deployment policy. The adapter binds to loopback by default; public deployment safety is host or reverse-proxy responsibility.

## Verification

```bash
pnpm --filter @mono-agent/openai-api-adapter run build
pnpm --filter @mono-agent/openai-api-adapter run typecheck
pnpm --filter @mono-agent/openai-api-adapter run test
```
