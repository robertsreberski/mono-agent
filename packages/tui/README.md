# @mono-agent/tui

## Category

Category: `operator-surface`

## Responsibility

pi-tui operator console for mono-agent: live chat with structured insight into the
agent's thinking process — reasoning blocks, tool calls with
arguments/progress/results/timing, token usage, cost, provider lifecycle and
failover — plus recorded-run replay and a read-only source-annotated config
view. Built on `@earendil-works/pi-tui` differential rendering (no React/Ink).

It connects to agents two ways:

- **Remote (primary)**: `mono-agent tui` from any directory discovers running
  agents via the trace-source registry (`~/.mono-agent/trace-sources`) and
  chats over the agent's `tui` channel (NDJSON stream served by
  `@mono-agent/operator-adapter`). One running agent connects directly; several
  open a picker.
- **In-process (embedded)**: hosts pass an `AgentResponder` to
  `startMonoAgentTui({ responder, … })`, or
  run the `mono-agent-tui` bin with `--responder <module>`.

Temporary post-wizard configuration is deliberately attached to the managed
remote agent, not an embedded responder. From the agent project, `mono-agent
tui --configure` connects to the ready background process that owns the
current config. The first agent message explains that this is a short
configuration exchange, identifies the Role destination (the configured
identity document's `## Role`, normally `IDENTITY.md → ## Role`), warns against
entering secrets, says `done` or `no changes` finishes without edits, and asks
for one configuration reply.

If the agent proposes a change, the host shows a separate approve/reject card,
validates any config or Role edit, and writes only after approval. It then
restarts the managed background agent, proves the fresh endpoint ready, and
switches the console to it; a failed restart restores the previous files and
attempts to recover the prior agent. After approval, rejection, or a no-change
reply, the console hands off to ordinary chat. `/quit` closes only this console
while the background agent keeps running; if an approval/restart transaction is
already active, closing waits until that transaction settles. Long Role bodies
are paged with the decision controls still visible; unsafe terminal or bidi
control characters are rejected before review text is rendered.

## Install / Usage

```bash
pnpm --filter @mono-agent/tui run build
```

Open the managed agent's temporary post-wizard configuration exchange from its
project directory:

```bash
mono-agent tui --configure
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
| replay | Recorded runs from the agent's artifact dir; open any run for the key-redacted, bounded events that reached terminal JSONL persistence. Non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; free text is not content-scanned. Recorder-capped payload tails and RAM-buffered events lost to a crash cannot be replayed. |
| config | Redacted, source-annotated resolved config (same builder as `mono-agent config`). |
| agents | Running-instance picker over the trace-source registry. |

Keys: `f2..f5` switch views (`tab` cycles outside chat) · `esc` cancels the
in-flight turn / goes back · `ctrl+t` thinking · `ctrl+c ×2` quits. Slash
commands: `/help /agents /replay /config /configure /cancel /thinking /quit`.

## Public API

- `startMonoAgentTui`, `MonoAgentTuiApp`
- `TuiConfigurationController`, `ConfigurationProposalCard` (UI contract for an authoritative host-owned remote configuration lifecycle)
- `RemoteAgentResponder` (AgentResponder over the operator-adapter TUI NDJSON wire)
- `discoverInstances` / `resolveInstanceApiKey` / `defaultTraceRegistryDir`
- `listReplayRuns` / `readReplayRun`
- `TurnPresenter` (AgentMessageStream → transcript cells)
- `createInMemoryTuiHistory`, `buildTuiConfigSummary`, cancelled-error helpers

## Dependency Boundary

Depends on `@earendil-works/pi-tui` plus `@mono-agent/agent-contracts`,
`@mono-agent/config`, and `@mono-agent/observability` (replay + discovery
readers). It must not depend on the agent harness, runtime adapter, memory,
communication adapters (`@mono-agent/operator-adapter` is a **dev**-only dependency
for wire round-trip tests — the runtime client speaks the shared
`stream-wire` contract from agent-contracts), or host/demo code.

## What This Package Does Not Own

It does not boot a harness, run models, persist conversations (its history
store is display-only), serve the stream endpoint (that is
`@mono-agent/operator-adapter`), write run artifacts/config, validate proposals,
or register agents in the trace-source registry. The config view remains
read-only. `@mono-agent/agent-app` owns the managed configuration capability,
proposal validation, atomic writes, approval consequences, background restart,
readiness check, and rollback; the supplied controller only lets this package
render and sequence that host-owned lifecycle. Ordinary turns submitted during
that boundary remain gated until a fresh or recovered endpoint is proven; an
unrecovered error cancels them and disconnects the unverified endpoint.

## Verification

```bash
pnpm --filter @mono-agent/tui run build
pnpm --filter @mono-agent/tui run typecheck
pnpm --filter @mono-agent/tui run test
```
