# @mono-agent/agent-app

Config-first mono-agent host. Reads one `mono-agent.config.json` in a folder,
builds the configured responder, and starts every configured communication
channel plus traceability. Ships the
`mono-agent` CLI (`init`, `validate`, `memory`, `start`) so an agent folder works without
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
- Preview the configured memory backend from the same config/env resolution path
  via `mono-agent memory` (`stats`, `today`, `show`, `search`, `top`).
- Scaffold (`mono-agent init`) and validate (`mono-agent validate`) agent
  folders non-destructively.

## Install / Usage

```bash
# inside the workspace
pnpm --filter @mono-agent/agent-app run build

# guided, readiness-proven setup and run
cd /path/to/agent-folder
node <workspace>/packages/agent-app/dist/cli.js init
```

On an interactive terminal, bare `mono-agent init` (no flags) runs a colourful,
step-by-step wizard — powered by `@clack/prompts` — that composes the capability
selection before writing anything and can opt in to provider auth/preflight
commands before the scaffold is created. This is the readiness-proven path;
any flag or non-TTY invocation is scaffold-only and never claims the agent is
ready. Presets seed the same model, channel,
tool, and sandbox decisions as the custom path; they do not silently bypass
safety choices. The default model is
`codex:gpt-5.6-terra`; `pi:openai-codex:gpt-5.6-terra` remains a concrete selectable
Pi candidate. GPT-5.6 Sol is also selectable as `codex:gpt-5.6-sol` or
`pi:openai-codex:gpt-5.6-sol`; direct GPT-5.6 routes require Codex CLI 0.144.0 or newer.
OpenCode-Go Pi refs can save `OPENCODE_API_KEY` into
the Pi auth store, and optional fallback models are selected from the same
discovered choices one at a time before manual entry. Any flag (or a piped/non-TTY
invocation) takes the silent default/preset scaffold path instead; add `--auth`
to run supported provider setup in that non-interactive path. Required selected
channel secrets are masked and never enter config JSON, examples, review output,
or logs. Durable provider credentials already in `.env` are secured by the same
preflight. POSIX persistence is owner-only (`0600`), preserves existing dotenv
values/comments, and uses an external lock plus no-clobber promotion with exact
ignore rules for `.env` and transaction artifacts. The canonical agent directory
must be current-user-owned and not group/world-writable; existing `.env` and
`.gitignore` files must be current-user-owned with one link, and the ignore guard
loses group/world write access. Pathname competitors are
protected; the claimed inode is rechecked and detected open-descriptor writes are
retained in a reported recovery copy (writes after the final POSIX check remain
non-cooperative); unsafe/tracked/foreign-owned/multiply-linked
paths, stale locks, invalid dotenv, conflicts, and Windows fail closed to manual setup. Before the
interactive wizard offers immediate start it requires both a disposable no-tool
primary-model response and a complete validation report with every selected
expectation ready. Cancellation, provider failure, timeout (90s cloud / 240s local),
empty output, or any tool action fails the model check. Guided commit atomically
creates the config and rechecks its exact snapshot after validation and before
start. Saving after failure is explicitly incomplete and never auto-starts.

Guided readiness uses a worker-reproducible environment rather than the launching
shell: durable `.env` values, entered selected secrets, the resolved Pi auth path,
and operational values such as `PATH`/`HOME`. Shell-only provider credentials and
config overrides cannot create a success that launchd cannot reproduce; persisted
non-secret `MONO_AGENT_*` overrides are rejected by name.

The default direct Codex candidate is selected only after bounded executable and
login discovery. Missing Codex setup points to the official instructions at
<https://developers.openai.com/codex/cli/>; the app never auto-installs it. The
wizard keeps **Allow all tools** as its default. Pi/Claude flows disclose
shell/file/web/channel effects and reconfirm an unsandboxed choice. Direct Codex
fixes policy to exact allow-all, uses its native network-off workspace sandbox,
denies unattended escalations, and fails unexpected server requests promptly.
Direct Codex chains/trigger overrides cannot cross into Pi, Claude, or direct
OpenCode. Those non-direct runtimes may mix only without a native mono-agent
sandbox; when `srt` policy is configured, Claude/direct-OpenCode
primary/fallback/trigger routes are rejected because their provider-owned tools
cannot enforce those scopes. Pi `pi:opencode-go:*` remains compatible.
Direct OpenCode also requires exact allow-all; restrictive static policies fail
validation/runtime and an incompatible dynamic override is warned and ignored.

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
- `initMonoAgentFolder(options)` / `validateMonoAgentFolder(options)`. Init results
  expose precise `changes` and `secretPersistence` outcomes; the compatibility
  `secretsPersisted` flag is true only after a committed secret write.
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
