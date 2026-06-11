# @mono-agent/agent-app

Config-first mono-agent host. Reads one `mono-agent.config.json` in a folder,
builds the configured responder, and starts every configured communication
channel plus the local operator console and traceability. Ships the
`mono-agent` CLI (`init`, `validate`, `start`) so an agent folder works without
hand-written composition code.

## Category

Category: `app`

## Responsibility

Turn a folder's `mono-agent.config.json` into a running agent host:

- Aggregate the adapter-neutral core config and every channel section
  (`telegram`, `slack`, `a2a`, `webhook`, `openaiApi`, `cron`, `whatsapp`).
- Build the shared runtime/responder through `@mono-agent/agent-host`
  (including `runtime.fallbackModels` backup chains).
- Drive each channel through a uniform driver contract with per-channel
  `disabled` / `waiting_for_config` / `running` / `failed` status.
- Start the operator console first and re-apply config writes in-process.
- Register the host as a traceability source.
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
console.log(app.operatorConsole?.appUrl, app.channelStatuses());
await app.stop();
```

## Public API

- `startMonoAgentApp(options)` → `MonoAgentApp` (statuses, `applyConfigChange`,
  `startChannelIfConfigured`, `stop`).
- `defaultChannelDrivers(overrides)` plus per-channel
  `create<Channel>ChannelDriver(overrides)` factories with test seams.
- `initMonoAgentFolder(options)` / `validateMonoAgentFolder(options)`.
- `MONO_AGENT_APP_FIELD_GROUPS` and the `resolveApp*` traceability/artifact
  resolvers for operator-console wiring.
- `runCli(argv)` / `parseCliArgs(argv)` backing the `mono-agent` bin.

## Dependency Boundary

Depends on `core`, `runtime`, `execution`, `observability`, `communication`,
and `operator-surface` packages. It is the only publishable package allowed to
compose communication adapters; adapters never depend on it.

## What This Package Does Not Own

- Adapter transports, credentials, or allowlists (owned by each
  `*-adapter` package).
- Core config schema and loading (owned by `@mono-agent/config`).
- Harness/runtime composition internals (owned by `@mono-agent/agent-host`).
- Multi-agent orchestration (owned by `@mono-agent/agent-orchestrator`).

## Verification

```bash
pnpm --filter @mono-agent/agent-app run typecheck
pnpm --filter @mono-agent/agent-app run test
pnpm run check:architecture
```

Smoke path: `mono-agent init` in a temp folder, `mono-agent validate`, then
`mono-agent start` and a `curl` POST against the printed webhook invoke URL.
