# @mono-agent/agent-app

Config-first mono-agent host. Reads one `mono-agent.config.json` in a folder,
builds the configured responder, and starts every configured communication
channel plus traceability. Ships the
`mono-agent` CLI (`init`, `validate`, `start`) so an agent folder works without
hand-written composition code.

## Category

Category: `app`

## Responsibility

Turn a folder's `mono-agent.config.json` into a running agent host:

- Aggregate the adapter-neutral core config and every channel section
  (`telegram`, `slack`, `webhook`, `openaiApi`, `cron`) plus configured
  external channel plugins from `channels.plugins[]`.
- Build the shared runtime/responder/memory stack through app-owned configured
  composition
  (including `runtime.fallbackModels` backup chains).
- Drive each channel through a uniform driver contract with per-channel
  `disabled` / `waiting_for_config` / `running` / `failed` status.
- Register the host as a traceability source. Config edits are made directly in
  `mono-agent.config.json` and take effect on the next `mono-agent restart`.
- Resolve and surface any configured `observability.exporters` (the Phoenix
  preset): `start`/`status` report the configured endpoint and a note that JSONL
  artifacts remain local; `validate` performs the live reachability probe. Export
  is best-effort and never changes a run outcome.
- Scaffold (`mono-agent init`) and validate (`mono-agent validate`) agent
  folders non-destructively.

## Install / Usage

```bash
# inside the workspace
pnpm --filter @mono-agent/agent-app run build

# scaffold and run an agent folder
cd /path/to/agent-folder
node <workspace>/packages/agent-app/dist/cli.js init --model claude:claude-sonnet-4-6
node <workspace>/packages/agent-app/dist/cli.js validate
node <workspace>/packages/agent-app/dist/cli.js start
```

Programmatic:

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({ cwd: "/path/to/agent-folder" });
console.log(app.channelStatuses());
await app.stop();
```

## Public API

- `startMonoAgentApp(options)` → `MonoAgentApp` (statuses, `applyConfigChange`,
  `startChannelIfConfigured`, `stop`).
- `defaultChannelDrivers(overrides)` plus built-in per-channel
  `create<Channel>ChannelDriver(overrides)` factories with test seams.
- `createConfiguredAgentRuntime`, `createConfiguredAgentHarness`,
  `createConfiguredAgentResponder`, and `createConfiguredMemory` for
  transport-free programmatic composition from a loaded `MonoAgentConfig`.
- `createBroadcastRunRecorder` for publishing recorder lifecycle events to a
  live run-event sink.
- `initMonoAgentFolder(options)` / `validateMonoAgentFolder(options)`.
- `MONO_AGENT_APP_FIELD_GROUPS` and the `resolveApp*` traceability/artifact
  resolvers.
- `runCli(argv)` / `parseCliArgs(argv)` backing the `mono-agent` bin.

## Dependency Boundary

Depends on `core`, `runtime`, `execution`, `observability`, `communication`,
and `operator-surface` packages. It is the only publishable package allowed to
compose communication adapters; adapters never depend on it.

## What This Package Does Not Own

- Adapter transports, credentials, or allowlists (owned by each
  `*-adapter` package).
- Core config schema and loading (owned by `@mono-agent/config`).
- Low-level prompt/session/tool execution internals (owned by
  `@mono-agent/agent-harness` and `@mono-agent/runtime-adapter`).
- Multi-agent orchestration (owned by `@mono-agent/agent-orchestrator`).

## Verification

```bash
pnpm --filter @mono-agent/agent-app run typecheck
pnpm --filter @mono-agent/agent-app run test
pnpm run check:architecture
```

Smoke path: `mono-agent init` in a temp folder, `mono-agent validate`, then
`mono-agent start` and a `curl` POST against the printed webhook invoke URL.
