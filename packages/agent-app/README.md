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
- Optionally expose guarded self-capability tools so the running agent can
  propose, or explicitly create, local skills and markdown cron jobs.

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

## Self-Capability Authoring

`selfCapabilities` is off by default. When enabled, the app injects a
request-scoped stdio MCP server into every app-served run. In `propose` mode it
only previews skill/cron files and config patches. In `apply` mode it can also
expose write tools, but only when the host process has
`MONO_AGENT_SELF_CAPABILITIES_CONFIRMATION_TOKEN` set; every write tool call
must include that operator-provided token. Successful writes create local
files, write an audit record under `.mono-agent/self-capabilities/`, and
request an app reload after the current response finishes.

```jsonc
{
  "selfCapabilities": {
    "enabled": true,
    "mode": "propose",          // propose | apply
    "skillsRoot": "./skills",   // defaults to context.skillsRoot or ./skills
    "cronDir": "./cron",        // defaults to cron.dir or ./cron
    "auditDir": "./.mono-agent/self-capabilities"
  }
}
```

The write path stays agent-folder-local. Generated skills are normal
`<skillsRoot>/<name>/SKILL.md` files and can be added to
`context.selectedSkills`; generated cron jobs are normal markdown jobs in the
cron folder. Feature-specific env vars win first, then active runtime env such
as `MONO_AGENT_SKILLS_ROOT` / `MONO_AGENT_CRON_DIR`, then JSON defaults. The
tool reports warnings when env vars would hide a JSON patch.

## Public API

- `startMonoAgentApp(options)` → `MonoAgentApp` (statuses, `applyConfigChange`,
  `startChannelIfConfigured`, `stop`).
- `defaultChannelDrivers(overrides)` plus per-channel
  `create<Channel>ChannelDriver(overrides)` factories with test seams.
- `initMonoAgentFolder(options)` / `validateMonoAgentFolder(options)`.
- `MONO_AGENT_APP_FIELD_GROUPS` and the `resolveApp*` traceability/artifact
  resolvers for operator-console wiring.
- `runCli(argv)` / `parseCliArgs(argv)` backing the `mono-agent` bin.
- Self-capability helpers (`proposeSelfSkill`, `applySelfSkill`,
  `proposeSelfCron`, `applySelfCron`) plus the
  `mono-agent-self-capabilities` MCP stdio bin.

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
