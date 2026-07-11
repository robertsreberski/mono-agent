# @mono-agent/agent-app

Config-first mono-agent host. Reads one `mono-agent.config.json` in a folder,
builds the configured responder, and starts every configured communication
channel plus traceability. Ships the
`mono-agent` CLI (`init`, `auth`, `sandbox`, `validate`, `memory`, `tui`, `start`) so an agent folder works without
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
  (including canonical `runtime.fallbacks` routes and legacy
  `runtime.fallbackModels` compatibility).
- Drive each channel through a uniform driver contract with per-channel
  `disabled` / `waiting_for_config` / `running` / `failed` status.
- Register the host as a traceability source. Config edits are made directly in
  `mono-agent.config.json`, or proposed through the OS-owner-local configuration
  TUI; direct edits take effect on the next `mono-agent restart`.
- Resolve and surface any configured `observability.exporters` (the Phoenix
  preset): `start`/`status` report the configured endpoint and a note that JSONL
  artifacts remain local; `validate` performs the live reachability probe. Export
  is best-effort and never changes a run outcome.
- Preview the configured memory backend from the same config/env resolution path
  via `mono-agent memory` (`stats`, `today`, `show`, `search`, `top`, metadata-only `audit`).
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
step-by-step wizard — powered by `@clack/prompts` — that asks for the public
agent name plus a concise purpose and composes the capability selection before writing anything. Escape
moves back one logical step; Ctrl-C asks for exit confirmation. The final
**Creation review** names the agent, routes/efforts, route safety, provider/SRT
actions, exact files, secret destinations, and number of real model calls before
offering **Run setup and readiness checks, then create agent** when setup is
needed, or **Run readiness checks, then create agent** when credentials are
already detected, alongside **Edit choices** and **Cancel without writing**.
Status, sandbox, and route preflights accept Escape or Ctrl-C and enter the same
resume/restart recovery flow without writing agent files. Interactive provider
authentication uses Ctrl-C only so the parent never competes with the provider
child for terminal input. This is the readiness-proven path;
any flag or non-TTY invocation is scaffold-only and never claims the agent is
ready. Presets seed the same model, channel,
tool, and sandbox decisions as the custom path; they do not silently bypass
safety choices. Searchable primary/fallback pickers combine every bundled model
for the guided Pi providers (Anthropic, GitHub Copilot, OpenAI Codex, and
OpenCode-Go), Codex's live account catalog, the Claude SDK catalog, and local
discovery. The live Codex provider default leads when available; offline setup
falls back to curated `codex:gpt-5.6-terra` without guessing effort metadata, so
only **Provider default** is offered until live `model/list` succeeds. GPT-5.6 Sol is selectable as
`codex:gpt-5.6-sol` or `pi:openai-codex:gpt-5.6-sol`.
OpenCode-Go Pi refs can save `OPENCODE_API_KEY` into
the Pi auth store or remain environment-provided, and any number of fallback
models are selected from the same discovered choices one at a time. Each route
offers only its advertised effort values plus **Provider default**. Standalone
`mono-agent auth login anthropic` keeps its localhost callback active while
also reading a pasted final redirect URL through Pi's code/state-validating
OAuth implementation. `mono-agent auth login opencode-go` uses a masked TTY prompt; headless callers
must opt in to one-line redirected input with `--api-key-stdin`. Any flag (or a piped/non-TTY
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
interactive wizard opens the local TUI it requires one disposable no-tool
response from every selected runtime route and a complete validation report with
every selected expectation ready. Cancellation, provider failure, timeout (90s
cloud / 240s local per route), empty output, or any tool action fails the check.
Escape or Ctrl-C interrupts preflight; recovery can resume verified routes when
the non-secret plan fingerprint still matches, restart all checks, edit choices,
or cancel. Authentication repair clears every prior route proof because it can
replace credential bytes. Guided commit atomically
creates the config and rechecks its exact snapshot after validation and before
opening `mono-agent tui --local --configure`. This builds the current-folder
responder in-process and never creates launchd state. Saving after failure is
explicitly incomplete and never auto-starts.

Every scaffold selects versioned `mono-agent-configure` and `mono-agent-memory`
skills from `./skills` with index disclosure. `ReadSkill` remains separate from
action-tool policy. `mono-agent install-skill --project --check|--update` reports
version/hash drift and refreshes only unchanged managed copies with backups; a
canonical owner-only non-symlink parent chain, per-project owner lock, and
compare-and-swap activation prevent outside or concurrent
operator edits from being overwritten, and a partial activation restores only
files that still equal the managed bytes it wrote.

In a marked local configuration turn only, the app injects proposal-only
`ProposeAgentConfiguration`. The host accepts only a fail-closed low-risk
allowlist: public name; effort, turn/session UX; selected project skills and
disclosure; memory size or MemoryRecall enablement; semantic tool-policy
tightening; and the separately validated Role body. Every path, memory-tier or
capture-cost change, runtime/provider route, channel/proactive/plugin, MCP,
exporter, embeddings/LLM endpoint, sandbox/network field, secret, and unknown
future field is handed to the explicit guided flow. It canonicalizes
config/Identity/state paths without following symlink parents, stages and
fsyncs replacements, then performs the final source comparison and rename as
one non-yielding commit step under an owner-only transaction lock. Separate TUI
confirmation, failure-atomic config/Role rollback compensation, rollback
evidence, and a fresh responder remain mandatory. Configuration turns replace
the ordinary tool/MCP policy with `ReadSkill`, `MemoryRecall`, and the proposal
tool only; direct providers that cannot project a finite list run in their
native read-only plan posture. Fast follow-ups wait through responder rotation.
Remote/proactive channels never receive this tool.

Guided readiness uses a worker-reproducible environment rather than the launching
shell: durable `.env` values, entered selected secrets, the resolved Pi auth path,
and operational values such as `PATH`/`HOME`. Shell-only provider credentials and
config overrides cannot create a success that launchd cannot reproduce; persisted
non-secret `MONO_AGENT_*` overrides are rejected by name.

Direct Codex discovery checks the executable, login status, and live app-server
model catalog without equating catalog availability with authentication or a
verified turn. Missing Codex setup points to the official instructions at
<https://developers.openai.com/codex/cli/>; the app never auto-installs it. The
wizard offers browser callback and headless device-code login. Detected credentials
skip redundant authentication but remain unverified until the exact route call
successfully runs. Guided Pi setup covers Anthropic, GitHub Copilot, OpenAI Codex,
and OpenCode-Go; other hand-authored Pi and local-provider configs remain compatible
without being advertised as guided cloud integrations. Supported OAuth methods and
the OpenCode-Go key flow come from the bundled upstream catalog;
stale auth locks are repaired only when the recorded process is securely proven
gone. The
wizard keeps **Allow all tools** as its default. Pi/Claude flows disclose
shell/file/web/channel effects and reconfirm an unsandboxed choice. Direct Codex
fixes policy to exact allow-all, uses its native network-off workspace sandbox,
denies unattended escalations, and fails unexpected server requests promptly.
Mixed chains are unrestricted only under explicit `runtime.routeSafety:
"per-route-native"`, which isolates provider runtimes and applies a documented
route-local contract. The default `uniform` mode keeps one common monotonic
contract and rejects/skips routes that cannot represent it. Pi keeps mono-agent
tool policy and optional SRT; Claude uses representable provider-native controls;
direct Codex/OpenCode use provider-native safety plus exact allow-all. No route
silently drops a required capability. Pi `pi:opencode-go:*` remains a Pi route.
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
- Local configuration CLI lifecycle: `mono-agent tui --local [--configure]` and
  managed project-skill drift/update through `install-skill --project`.
- Managed SRT lifecycle: `sandboxRuntimeStatus`, `setupManagedSrt`, and
  `checkSandboxRuntime` (also exposed as `mono-agent sandbox status|setup|check`).

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
