---
title: "TUI stream endpoint"
sidebar:
  order: 8
---

# TUI stream endpoint

This channel serves the loopback NDJSON stream the [`mono-agent tui`](/observability/tui/) operator console connects to. Unlike the [OpenAI-compatible API](/channels/openai-api/) (which flattens events into Chat Completions chunks), it preserves structured `AgentStreamEvent` kinds — thinking deltas, tool calls with arguments/progress/results/timing, token usage, cost, provider lifecycle and failover, warnings — subject to the serialized event-frame cap described below.

Coverage: `config` (the `tui` section of `mono-agent.config.json`).

:::note
**This operator surface is ON by default.** `tui` and the read-only `live` event relay are the two default-on channels: both bind loopback with ephemeral ports and need no credentials by default, so `mono-agent tui` and `mono-agent web` can reach any running agent without a per-agent config edit. Set `"tui": { "enabled": false }` to opt out of the TUI endpoint; everything else about the channel lifecycle (status lines, `degraded`/`failed` reporting) matches the other channels.
:::

## Configuration

```json
{
  "tui": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 0,
    "basePath": "/tui",
    "allowNonLoopback": false,
    "apiKey": "optional-bearer"
  }
}
```

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | **`true`** | Deliberate exception to the channels-off convention (see the note above). |
| `host` | string | `127.0.0.1` | Bind address. Loopback by default. |
| `port` | integer | `0` | `0` = ephemeral. The bound port is published to the trace-source registry, so nothing needs to be fixed. |
| `basePath` | string | `/tui` | Path prefix for all endpoints. |
| `allowNonLoopback` | boolean | `false` | Required guard before binding a non-loopback `host`. |
| `apiKey` | string | _unset_ | Optional bearer token. `mono-agent tui` resolves it from this config file automatically (the registry never carries secrets). |

## Environment variables

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_TUI_ENABLED` | `tui.enabled` |
| `MONO_AGENT_TUI_HOST` | `tui.host` |
| `MONO_AGENT_TUI_PORT` | `tui.port` |
| `MONO_AGENT_TUI_BASE_PATH` | `tui.basePath` |
| `MONO_AGENT_TUI_ALLOW_NON_LOOPBACK` | `tui.allowNonLoopback` |
| `MONO_AGENT_TUI_API_KEY` | `tui.apiKey` |

## Live event relay for web PWA

The `live` channel is the sibling default-on operator surface consumed by `mono-agent web`. It is read-only: it exposes run lifecycle frames over SSE, never accepts turns, and lets the web PWA show sub-run updates before the on-disk recorder flushes the final summary.

```json
{
  "live": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 0,
    "basePath": "/live",
    "allowNonLoopback": false,
    "apiKey": "optional-bearer"
  }
}
```

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | **`true`** | Default-on read-only operator relay for `mono-agent web`; set `false` to opt out. |
| `host` | string | `127.0.0.1` | Bind address. Loopback by default. |
| `port` | integer | `0` | `0` = ephemeral. The bound `baseUrl` is published to the trace-source registry. |
| `basePath` | string | `/live` | Path prefix for `/v1/events` and `/v1/info`. |
| `allowNonLoopback` | boolean | `false` | Required guard before binding a non-loopback `host`. |
| `apiKey` | string | _unset_ | Optional bearer token. `mono-agent web` resolves it from the agent config file; the registry never carries secrets. |

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_LIVE_ENABLED` | `live.enabled` |
| `MONO_AGENT_LIVE_HOST` | `live.host` |
| `MONO_AGENT_LIVE_PORT` | `live.port` |
| `MONO_AGENT_LIVE_BASE_PATH` | `live.basePath` |
| `MONO_AGENT_LIVE_ALLOW_NON_LOOPBACK` | `live.allowNonLoopback` |
| `MONO_AGENT_LIVE_API_KEY` | `live.apiKey` |

`mono-agent web` trusts live relay URLs only when they resolve to loopback, and it only sends a live API key to those trusted URLs. If you deliberately expose `live` beyond loopback, put it behind a trusted network boundary; the stream contains run prompts, tool events, usage, and terminal summaries.

## Endpoints & wire protocol

| Endpoint | Purpose |
| --- | --- |
| `GET {basePath}/v1/info` | `{ schema, pid, label?, model?, effort? }` — identity + wire-schema version for skew detection. `effort` is the statically configured reasoning-effort level; per-run overrides arrive via the `run_config` runtime_telemetry event instead. |
| `POST {basePath}/v1/turns` | Body `{ conversationId, text, metadata? }`. Responds with chunked `application/x-ndjson`, one frame per stream callback: `status`, `append`, `replace`, `event` (any `AgentStreamEvent`), then a terminal `finish` (final text + response metadata) or `error` (`cancelled` flagged). Closing the socket aborts the in-flight turn. |
| `POST {basePath}/v1/conversations/:id/cancel` | Explicit cancel (`202`; `501` if the responder has no cancel). |

Frames are defined in `@mono-agent/agent-contracts` (`stream-wire`); parsing is tolerant in both directions, so version-skewed console/agent pairs keep talking (unknown frame kinds and event types pass through). A serialized event frame is capped at 256 KiB for its complete UTF-8 NDJSON line, including the newline. Above that cap, `assistant_thought` and `tool_call_started`/`tool_call_progress`/`tool_call_completed` payload fields are reduced, marked truncated, and remeasured. Any other oversized event variant — including `runtime_warning` or `runtime_telemetry` — and any reducible event whose minimal form still does not fit because of metadata or invariant fields becomes a small `oversized_event` marker instead. Other frame kinds do not use this cap. Replay does not restore the omitted tail: the JSONL recorder separately redacts and caps each event string at 4,096 bytes by default, buffers events in RAM, and replaces the events file only at terminal `finish()`/`fail()`. A crash before that boundary can therefore leave no in-flight events to replay. The tool-bloat guard may separately save oversized tool-result blocks under `tool-output/` when its persistence callback succeeds; those files are not the run's JSONL event stream and do not recover arbitrary streamed payloads. See the [artifact write-boundary contract](/observability/artifacts-and-traces/).

How the endpoint is discovered: the running channel's summary (`baseUrl`) is folded into the agent's trace-source manifest at `metadata.channels.tui.baseUrl`, which `mono-agent tui` reads from the registry.

## Concurrency & security

- A console conversation uses its own `conversationId`, so it runs concurrently with every other channel; reusing an existing id (e.g. a Telegram conversation's) is possible and queues behind that conversation's in-flight turn.
- Managed macOS configuration uses a separate opaque configuration conversation id and never reuses the ordinary chat id. The proposal-only extension is scoped to that request; after the proposal/review outcome, the console moves to a fresh ordinary conversation while the background endpoint stays authoritative.
- Loopback-only by default; binding further requires `allowNonLoopback` **and** should always pair with `apiKey`. Remember this endpoint streams tool arguments and results: the event-frame cap reduces oversized payloads but is not a redaction boundary, so this remains an operator surface by design.

## Related

- [Terminal UI](/observability/tui/) — the console that consumes this endpoint.
- [Channels overview](/channels/) — shared lifecycle and status lines.
- [OpenAI-compatible API](/channels/openai-api/) — the lossy-but-standard HTTP alternative for third-party clients.
