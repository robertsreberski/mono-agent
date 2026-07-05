# @mono-agent/tui

## Category

Category: `operator-surface`

## Responsibility

pi-tui operator console for mono-agent: live chat with **full insight into the
agent's thinking process** — reasoning blocks, tool calls with
arguments/progress/results/timing, token usage, cost, provider lifecycle and
failover — plus recorded-run replay and a read-only source-annotated config
view. Built on `@earendil-works/pi-tui` differential rendering (no React/Ink).

It connects to agents two ways:

- **Remote (primary)**: `mono-agent tui` from any directory discovers running
  agents via the trace-source registry (`~/.mono-agent/trace-sources`) and
  chats over the agent's `tui` channel (NDJSON stream served by
  `@mono-agent/tui-adapter`). One running agent connects directly; several
  open a picker.
- **In-process (embedded)**: hosts pass an `AgentResponder` to
  `startMonoAgentTui({ responder, … })`, or
  run the `mono-agent-tui` bin with `--responder <module>`.

## Install / Usage

```bash
pnpm --filter @mono-agent/tui run build
```

```ts
import { startMonoAgentTui } from "@mono-agent/tui";

// Embedded host:
const handle = startMonoAgentTui({ responder, title: "My Agent", conversationId: "local" });
await handle.waitUntilExit();

// Remote client:
startMonoAgentTui({ connection: { baseUrl: "http://127.0.0.1:52341/tui" } });

// Discovery (agent picker):
startMonoAgentTui({ discovery: {} });
```

Exactly one of `responder` | `connection` | `discovery` is required. Replay
and config views activate when `instance`/`config` provide the agent's
`artifactDir`/`configPath` (both are read directly from disk — the manifest
carries the paths).

## Views & keys

| View | Content |
| --- | --- |
| chat | Streaming markdown answer, collapsed thinking cells (`ctrl+t` expands), tool panels (pending → success/error with args/progress/result/duration), warnings/failover notices, status bar (model · tokens · cost · hints). |
| replay | Recorded runs from the agent's artifact dir; open any run for its full coalesced event timeline (any channel's turns, nothing dropped). |
| config | Redacted, source-annotated resolved config (same builder as `mono-agent config`). |
| agents | Running-instance picker over the trace-source registry. |

Keys: `f2..f5` switch views (`tab` cycles outside chat) · `esc` cancels the
in-flight turn / goes back · `ctrl+t` thinking · `ctrl+c ×2` quits. Slash
commands: `/help /agents /replay /config /cancel /thinking /quit`.

## Public API

- `startMonoAgentTui`, `MonoAgentTuiApp`
- `RemoteAgentResponder` (AgentResponder over the tui-adapter NDJSON wire)
- `discoverInstances` / `resolveInstanceApiKey` / `defaultTraceRegistryDir`
- `listReplayRuns` / `readReplayRun`
- `TurnPresenter` (AgentMessageStream → transcript cells)
- `createInMemoryTuiHistory`, `buildTuiConfigSummary`, cancelled-error helpers

## Dependency Boundary

Depends on `@earendil-works/pi-tui` plus `@mono-agent/agent-contracts`,
`@mono-agent/config`, and `@mono-agent/observability` (replay + discovery
readers). It must not depend on the agent harness, runtime adapter, memory,
communication adapters (`@mono-agent/tui-adapter` is a **dev**-only dependency
for wire round-trip tests — the runtime client speaks the shared
`stream-wire` contract from agent-contracts), or host/demo code.

## What This Package Does Not Own

It does not boot a harness, run models, persist conversations (its history
store is display-only), serve the stream endpoint (that is
`@mono-agent/tui-adapter`), write run artifacts, or register agents in the
trace-source registry. Editing config is out of scope — the config view is
read-only.

## Verification

```bash
pnpm --filter @mono-agent/tui run build
pnpm --filter @mono-agent/tui run typecheck
pnpm --filter @mono-agent/tui run test
```
