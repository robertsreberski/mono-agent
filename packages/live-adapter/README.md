# @mono-agent/live-adapter

Loopback SSE adapter that relays an agent's in-process **live run-event bus** to
read-only operator surfaces (the `mono-agent web` PWA) at sub-run granularity.

The on-disk run recorder only flushes at run start and finish, so mid-run
visibility requires an in-process tap. The host feeds a `RunEventBus`
(`@mono-agent/agent-contracts`) from a broadcast recorder; this adapter exposes
that bus over a passive, loopback-only `text/event-stream` endpoint. It is
observe-only — there is no turn-driving endpoint and no reference to a responder.

## Category

Category: `communication`

A transport adapter. It owns one loopback HTTP server; it does not interpret,
persist, or aggregate events, and it never mutates the agent.

## Responsibility

- Serve `GET /live/v1/events` (SSE): replay the bus ring buffer to a joining
  subscriber, then stream every subsequent `RunEventFrame` as one JSON line.
- Serve `GET /live/v1/info`: schema, pid, and label for discovery probes.
- Bind loopback-only (`assertSafeBind`), optional bearer auth, clean shutdown.

## Install / Usage

```ts
import { createLiveEventBus, startLiveAdapter } from "@mono-agent/live-adapter";

const bus = createLiveEventBus();
const adapter = await startLiveAdapter({ bus, host: "127.0.0.1", port: 0 });
// publish frames to `bus` from a broadcast recorder; adapter.baseUrl is the SSE root.
await adapter.stop();
```

## Public API

- `createLiveEventBus(options?)` → `RunEventBus` (in-process pub/sub + ring buffer).
- `startLiveAdapter(options)` → `{ baseUrl, stop() }`.
- `LiveAdapterError`, constants, and option/result types.

## Configuration (`live` section / `MONO_AGENT_LIVE_*` env)

The app starts this channel by default on loopback so `mono-agent web` can
observe any running agent without per-agent edits. Set `"live": { "enabled":
false }` to opt out.

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | Default-on read-only operator relay. |
| `host` | `127.0.0.1` | Non-loopback binds require `allowNonLoopback`. |
| `port` | `0` | Ephemeral; published in the trace-source manifest. |
| `basePath` | `/live` | Serves `/v1/info` and `/v1/events`. |
| `allowNonLoopback` | `false` | Guard before exposing the relay off-host. |
| `apiKey` | unset | Optional bearer token for both routes. |

## Dependency Boundary

Depends only on `core` packages: `@mono-agent/agent-contracts` (frame/bus types,
HTTP-neutral opaque payloads, safe bind/listen/close/bearer). Plus `express`. No dependency on `@mono-agent/observability` — the
frame payloads are opaque here; interpretation belongs to the consumer.

## What This Package Does Not Own

- The bus's producers (the broadcast recorder lives in the host/agent-host).
- Event interpretation, run→session mapping, or persistence.
- Instance discovery, aggregation, or the browser UI (that is `session-web`).
- Any ability to drive the agent (read-only by construction).

## Verification

```sh
pnpm --filter @mono-agent/live-adapter run build
pnpm --filter @mono-agent/live-adapter run test
```
