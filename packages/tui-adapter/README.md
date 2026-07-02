# @mono-agent/tui-adapter

## Category

Category: `communication`

## Responsibility

Loopback NDJSON stream endpoint that lets the mono-agent TUI (`mono-agent tui`)
chat with a running agent at full `AgentStreamEvent` fidelity — thinking,
tool calls with arguments/progress/results/timing, token usage, cost, provider
lifecycle and failover, warnings.

Unlike the OpenAI-compatible adapter (which flattens events into Chat
Completions chunks), this adapter serializes every `AgentMessageStream`
callback as one NDJSON frame (`@mono-agent/agent-contracts` `stream-wire`), so
a remote client can reconstruct the exact in-process stream.

## Install / Usage

```bash
pnpm --filter @mono-agent/tui-adapter run build
```

```ts
import { startTuiAdapter } from "@mono-agent/tui-adapter";

const adapter = await startTuiAdapter({
  responder,
  info: { label: "personal-agent", model: "claude-fable-5" },
});
// adapter.baseUrl → published to the trace-source registry by agent-app
```

## Endpoints

- `GET {basePath}/v1/info` — `{ schema, pid, label?, model? }`
- `POST {basePath}/v1/turns` — body `{ conversationId, text, metadata? }`;
  responds with chunked `application/x-ndjson` frames
  (`status | append | replace | event | finish | error`). Closing the socket
  aborts the in-flight turn.
- `POST {basePath}/v1/conversations/:id/cancel` — explicit cancel (202; 501
  when the responder has no `cancel`).

## Configuration (`tui` section / `MONO_AGENT_TUI_*` env)

| Field | Default | Notes |
|---|---|---|
| `enabled` | **`true`** | Deliberate deviation from the channels-off convention: operator surface, loopback-only, no secrets required — `mono-agent tui` must reach any running agent without a config edit. Set `false` to opt out. |
| `host` | `127.0.0.1` | Non-loopback binds require `allowNonLoopback`. |
| `port` | `0` | Ephemeral; the bound port is published to the trace-source registry (`metadata.channels.tui.baseUrl`). |
| `basePath` | `/tui` | |
| `allowNonLoopback` | `false` | |
| `apiKey` | unset | Optional bearer token. `mono-agent tui` resolves it from the agent's config file (`tui.apiKey`) — the registry never carries secrets. |

## Public API

- `startTuiAdapter`
- `TuiAdapterError`
- `loadTuiAdapterConfig`
- `redactTuiAdapterConfig`
- `TUI_CONFIG_FIELDS`
- `TUI_WIRE_SCHEMA`, `MAX_FRAME_BYTES`, default host/port/basePath constants
- TUI adapter config, options, start result, info, and logger types

## Dependency Boundary

This adapter depends on Express plus shared contracts/settings primitives. It
must not depend on the agent harness, runtime adapter, operator surfaces
(including `@mono-agent/tui` — the client speaks the shared wire contract, not
this package), memory, observability, other communication adapters, or
host/demo code. Hosts compose it with a structural responder.

## What This Package Does Not Own

It does not build prompts, run models, persist conversations, discover running
agents (the trace-source registry is `@mono-agent/observability` + agent-app),
render anything, implement replay/config views, or own TLS/public deployment
policy. It binds loopback-only by default; tool arguments and results stream
verbatim to connected clients by design, so exposure beyond loopback is a host
decision guarded by `allowNonLoopback`.

## Verification

```bash
pnpm --filter @mono-agent/tui-adapter run build
pnpm --filter @mono-agent/tui-adapter run typecheck
pnpm --filter @mono-agent/tui-adapter run test
```
