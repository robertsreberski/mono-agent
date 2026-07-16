# @mono-agent/operator-adapter

## Category

Category: `communication`

## Responsibility

Loopback operator endpoints for local mono-agent surfaces:

- the TUI NDJSON turn endpoint, which lets `mono-agent tui` chat with a running
  agent through structured `AgentStreamEvent` frames. Serialized event frames
  crossing 256 KiB trigger field-level reduction with a truncation marker; this
  is not a strict maximum for every frame.
- the live SSE event relay, which streams the host's in-process run-event bus to
  read-only operator surfaces such as `mono-agent web`.

Both endpoints keep their existing wire contracts, routes, env vars, defaults,
auth behavior, and error behavior.

## Install / Usage

```bash
pnpm --filter @mono-agent/operator-adapter run build
```

```ts
import {
  createLiveEventBus,
  startLiveAdapter,
  startTuiAdapter,
} from "@mono-agent/operator-adapter";

const tui = await startTuiAdapter({
  responder,
  info: { label: "personal-agent", model: "claude-fable-5" },
});

const bus = createLiveEventBus();
const live = await startLiveAdapter({ bus, host: "127.0.0.1", port: 0 });

await tui.stop();
await live.stop();
```

### TUI Endpoints

- `GET {basePath}/v1/info` - `{ schema, pid, label?, model?, effort? }`.
- `POST {basePath}/v1/turns` - body `{ conversationId, text, metadata? }`;
  responds with chunked `application/x-ndjson` frames
  (`status | append | replace | event | finish | error`). Closing the socket
  aborts the in-flight turn.
- `POST {basePath}/v1/conversations/:id/cancel` - explicit cancel (202; 501
  when the responder has no `cancel`).

### Live Endpoints

- `GET {basePath}/v1/info` - `{ schema, pid, label? }`.
- `GET {basePath}/v1/events` - `text/event-stream` replaying recent
  `RunEventFrame` values and streaming future frames.

## Public API

- TUI: `startTuiAdapter`, `loadTuiAdapterConfig`,
  `redactTuiAdapterConfig`, `TUI_CONFIG_FIELDS`, `MAX_FRAME_BYTES`,
  `DEFAULT_TUI_BASE_PATH`, `TUI_WIRE_SCHEMA`, `TuiAdapterError`, and the TUI
  option/config/result/error types.
- Live: `startLiveAdapter`, `loadLiveAdapterConfig`,
  `redactLiveAdapterConfig`, `LIVE_CONFIG_FIELDS`, `DEFAULT_LIVE_BASE_PATH`,
  `LIVE_ADAPTER_INFO_SCHEMA`, `LiveAdapterError`, and the live
  option/config/result/error types.
- Live bus/contracts re-exported from `@mono-agent/agent-contracts`:
  `createLiveEventBus`, `LIVE_EVENT_SCHEMA`, `RunEventBus`, `RunEventFrame`,
  `RunEventSink`, and `CreateLiveEventBusOptions`.

## Dependency Boundary

This adapter depends on Express plus shared `@mono-agent/agent-contracts`
primitives. It must not depend on the agent harness, runtime adapter, operator
surfaces, memory, observability, other communication adapters, or host/demo
code. Hosts compose it with structural responders and an optional run-event bus.

## What This Package Does Not Own

It does not build prompts, run models, persist conversations, discover running
agents, render operator UIs, interpret live events, implement replay/config
views, or own TLS/public deployment policy. Both servers bind loopback-only by
default; exposing either endpoint beyond loopback is a host decision guarded by
`allowNonLoopback`.

## Verification

```bash
pnpm --filter @mono-agent/operator-adapter run build
pnpm --filter @mono-agent/operator-adapter run typecheck
pnpm --filter @mono-agent/operator-adapter run test
```
