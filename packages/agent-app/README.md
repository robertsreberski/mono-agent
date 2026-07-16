# @mono-agent/agent-app

Config-first mono-agent host. Reads one `mono-agent.config.json` in a folder,
builds the configured responder, and starts every configured communication
channel plus traceability. Ships the
`mono-agent` CLI (`init`, `auth`, `sandbox`, `validate`, `memory`, `tui`, `start`) so an agent folder works without
hand-written composition code.

Setup has two deliberate wall-clock paths: flags or non-TTY input use the fast scaffold-only path (unless explicit `--auth` adds provider setup) and never claim readiness. Bare `mono-agent init` on a TTY makes one real no-tool model call per selected route before committing the scaffold, with timeouts of 90s for each cloud route and 240s for each local route.

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
- Preserve completed blocking `AskUser` / `TelegramAskButtons` question,
  options, and outcome in the assistant history copy so cold/stateless provider
  replay does not lose the out-of-band exchange.
- Expose the request-scoped read-only `RunHistory` tool for safe normalized
  evidence from completed prior runs in the current conversation bucket.
- Drive each channel through a uniform driver contract with per-channel
  `disabled` / `waiting_for_config` / `running` / `failed` status.
- Register the host as a traceability source. Config edits are made directly in
  `mono-agent.config.json`, or proposed through the OS-owner-managed macOS
  configuration TUI; direct edits take effect on the next `mono-agent restart`.
- Resolve and surface any configured `observability.exporters` (the Phoenix
  preset): `start`/`status` report the configured endpoint and a note that JSONL
  artifacts remain local; `validate` performs the live reachability probe. Export
  is best-effort and never changes a run outcome.
- Preview, strictly audit, and safely maintain the configured memory backend
  from the same config/env resolution path via `mono-agent memory` (including
  provider-free strict health and payload-free intake inspect/retry/resolve).
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
agent name plus exact Role text for `IDENTITY.md` → `## Role` and composes the capability selection before writing anything. An existing `IDENTITY.md` is preserved and the review says the entered Role will not be written. Escape
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
safety choices. Journal and BuJo open a dedicated local embeddings step: choose
Ollama or LM Studio, service root, exact model, actual dimension, and optional
`apiKeyEnv`. Ollama discovery filters `/api/tags` models through `/api/show`
`embedding` capabilities; LM Studio filters exact `type: "embedding"` entries
from `/api/v1/models` and uses their `key`. One fixed non-user request to
`/api/embed` or `/v1/embeddings` must return a non-empty finite vector of the
configured dimension before readiness. Manual model/dimension entry can author
the plan when discovery is inconclusive, but cannot fake readiness. Provider
failures never fall through to the other local service. Searchable
primary/fallback pickers combine every bundled model
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
interactive wizard can start the background agent it requires one disposable no-tool
response from every selected runtime route and a complete validation report with
every selected expectation ready. Cancellation, provider failure, timeout (90s
for each cloud route and 240s for each local route), empty output, or any tool
action fails the check.
Escape or Ctrl-C interrupts preflight; recovery can resume verified routes when
the non-secret plan fingerprint still matches, restart all checks, edit choices,
or cancel. Authentication repair clears every prior route proof because it can
replace credential bytes. Guided commit atomically creates the config and rechecks its exact snapshot after validation. On macOS it then creates or refreshes the canonical per-config launchd service, waits for a fresh `startup-complete` trace source, and opens `mono-agent tui --configure` remotely against that same background responder. A background-start failure preserves the committed files, skips the chat, and prints exact `start`, `status`, and `logs --follow` recovery commands plus log paths. Off macOS, conversational configuration is unavailable: the wizard preserves the files and gives manual edit/validate, foreground-start, and ordinary-TUI guidance without claiming readiness. Any flag or non-TTY invocation remains scaffold-only and never starts a process.

Every scaffold selects versioned `mono-agent-configure` and `mono-agent-memory`
skills from `./skills` with index disclosure. `ReadSkill` remains separate from
action-tool policy. `mono-agent install-skill --project --check|--update` reports
version/hash drift and refreshes only unchanged managed copies with backups; a
canonical owner-only non-symlink parent chain, per-project owner lock, and
compare-and-swap activation prevent outside or concurrent
operator edits from being overwritten, and a partial activation restores only
files that still equal the managed bytes it wrote.

In the separate **Temporary post-wizard configuration mode** only, the background app injects proposal-only
`ProposeAgentConfiguration`. The opening message says to discuss the agent's Role,
behavior, memory, skills, tools, or channels; never enter secrets; and expect a
separate host approval before anything changes. Reply `done` or `no changes` to
finish without edits. It also says ordinary chat starts
after the reply and any approval or rejection, while `/quit` closes only the console
and leaves the background agent running. The host accepts only a fail-closed low-risk
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
evidence, a successful managed restart, and a fresh ready trace source remain mandatory. Configuration turns replace
the ordinary tool/MCP policy with `ReadSkill`, `MemoryRecall`, and the proposal
tool only. Pure direct-Codex chains use its native read-only plan posture;
mixed chains keep the finite proposal surface so a route that cannot represent
it cannot widen authority. Direct OpenCode cannot receive the host-owned MCP
proposal capability: a direct-OpenCode primary is routed through a configured
proposal-capable fallback, while a direct-OpenCode fallback makes temporary
configuration unavailable with explicit remediation. The approval card shows
every full, untruncated JSON patch value and pages through the exact Role body
while keeping Reject/Approve reachable, and rejects
terminal-control or bidi-control review text before displaying it. Fast follow-ups wait through responder rotation.
Ordinary chat uses a different conversation id. A proposal-free finish, rejection, successful approval, or recovered rollback ends the temporary mode and activates ordinary chat; `/quit` closes only the console while the daemon keeps running. Remote/proactive channels never receive this tool.

Before the first macOS background launch, the CLI copies the exact package and
already-resolved dependency closure it is currently executing—including configured
channel plugins and the optional Supermemory backend—into an owner-only,
version/Node-ABI/CLI/closure-digest runtime under `~/.mono-agent/runtimes/agent-app/`.
It does not invoke npm or lifecycle scripts, so provider secrets never reach an
installer and pnpm `workspace:` links do not require registry resolution. A
relative-path/type/mode/content-hash manifest and the complete source-closure
digest are bound into the runtime marker and verified on every reuse. The LaunchAgent always points there, never at an
`npm create`/npx cache. Existing verified runtime snapshots are reused and
retained because another agent may still reference them. A loaded job is fully
booted out and bootstrapped again so rewritten arguments and environment are
adopted. Launchd enters Node through `/usr/bin/env -i`, so inherited variables
such as `NODE_OPTIONS` cannot execute before the worker's allowlisted environment
is established. Every foreground worker holds one owner-only lifetime lease for its
canonical config, so a managed and manual host cannot run together. A per-config
256-bit key in owner-only `~/.mono-agent/background-snapshot-keys/` commits exact
file bytes without exposing plaintext or offline-testable hashes in argv/traces.
A managed worker freezes the proven config, Identity, optional Soul, and MCP authority
file into private read-only copies before app/channel loading, while trace metadata continues to
name the canonical config. Readiness requires one live launchd-owned trace PID,
the exact durable snapshot, and, for configuration, a reachable TUI endpoint.
Stop succeeds only after both launchd unload and worker death are proven.

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

`RunHistory` requires no config key. It is automatically available under
allow-all on MCP-capable routes; a restrictive `tools.allowedTools` must name
`RunHistory` explicitly (`run_history` remains a deprecated input alias), and
`disallowedTools` can remove it. Direct OpenCode and other MCP-incompatible
routes suppress it. Its `list` and `inspect` actions can read only completed
prior runs in the exact current conversation bucket and return bounded,
redacted, normalized evidence. They exclude the current/running run, other
conversations or rollover buckets, system prompts, reasoning, recalled memory,
turn-context payloads, and raw artifact paths; historical text is marked
untrusted.

For missing context, the agent should use active conversation history first,
`MemoryRecall` for intentionally captured durable facts, and `RunHistory` for
exact prior-run/tool evidence. Completed blocking `AskUser` and
`TelegramAskButtons` exchanges are written into the assistant history copy
before the final response, explicitly labelled as untrusted historical data and
bounded by newest whole interactions, without changing the outward message or
long-term memory capture. `TelegramAskButtons` with `wait: false` continues to produce a
synthetic next turn when the user taps later.

The app publishes a cached, content-free `memoryHealth` snapshot in the primary
trace-source heartbeat and any enabled best-effort global mirror. Built-in
health is computed through a dynamic memory import so a native SQLite ABI
failure becomes sanitized `unknown` health
instead of crashing unrelated CLI startup. Concurrent refreshes coalesce; in
steady state, ordinary trace events and the completion-based timer never run a
full audit less than 30 seconds after the prior completion. Startup and reload
make one explicit post-lifecycle exception so the registered snapshot reflects
the newly started store. The timer is unreferenced and invalidated at
stop/reconfigure entry, and the same
snapshot is used for both registries. The shape is limited to backend/mode,
closed status and issue vocabularies, ISO check time, and eight whitelisted
counts—never paths, ids, content, payloads, or raw errors.

Unexpected built-in audit failures use the stable `health_check_failed` issue,
while durable work that exceeds its ownership grace uses `work_stalled`; both
are fixed metadata-only classifications.

Operator automation should use:

```bash
# One prose/ANSI-free {ok:boolean, sections, ...} object; exit 0 iff ok.
mono-agent validate --json

# Provider-free closed health; healthy/in_progress/not_configured exit 0.
mono-agent memory audit --strict --json

# Payload-free inventory; mutations require the matching agent to be stopped.
mono-agent memory inspect --json
mono-agent memory retry --json
mono-agent memory retry <64-character-id> --json
mono-agent memory resolve <64-character-id> <reason-slug> --json

# Explicit BuJo cleanup: prepare is read-only; apply/restore require stop.
mono-agent memory forget prepare --ids-file ./forget-ids.txt --reason noise_cleanup --plan ./forget-plan.json --json
mono-agent memory forget apply --plan ./forget-plan.json --json
mono-agent memory forget restore --backup /path/returned/by/apply --json
```

Journal and BuJo always require a valid managed `.index/manifest.json`; only
Lite may remain unmanaged. Missing/corrupt authority, active/configured
tier-provider-model-dimension mismatch, and native-module/ABI failure are validation
errors with stop/rebuild/revalidate remediation. Provider reachability remains
an operational `waiting` state. LM Studio is keyless when `apiKeyEnv` is omitted;
a declared but missing variable stays `waiting` and never retries keyless.
Changing provider, model, or dimension on an existing root requires a stopped,
config-aware `mono-agent memory rebuild --json`. BuJo uses the selected
embeddings service independently from its explicit capture LLM (`agent-host` in
generated configs, or an authored Ollama block). The advanced standalone
`memory-bujo migrate` command remains Ollama-only and outside guided init.
`retry` makes dead/delayed intake due for the
next store start; `resolve` explicitly abandons one item without claiming
capture succeeded, keeps permanent duplicate protection, and refuses a retained
semantic plan. `forget prepare` accepts at most 32 ids and writes an owner-only,
single-link, content-free explicit-id plan. Stopped-store `forget apply` owns the
authoritative writer lease plus a durable sibling recovery fence, creates a
fsync-verified full backup, commits each id through durable migration-forget,
and rebuilds the managed generation. Failure restores automatically; process
death blocks normal writers until recovery resumes. Explicit restore refuses to
overwrite any durable change made after cleanup and atomically consumes the
verified sibling snapshot without constructing a third full copy.

For launchd fleet verification, invoke the deployed CLI with each plist's exact
`ProgramArguments[0]` Node, `[1]` CLI, absolute `--config`/`--env-file`, and
managed `PATH`. Probe children retain only launchd-safe operational environment
values; shell-only `MONO_AGENT_*`, provider credentials, `NODE_OPTIONS`, and
proxy overrides are not fleet evidence. The current fleet contract is Node
`24.15.0`, modules ABI `137`; an ambient shell Node or environment is not
evidence that the service can load the native memory modules.

Programmatic:

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({ cwd: "/path/to/agent-folder" });
console.log(app.channelStatuses());
await app.stop();
```

## Public API

- `startMonoAgentApp(options)` → `MonoAgentApp` (statuses, cached typed
  `memoryHealth`, `applyConfigChange`, `startChannelIfConfigured`, `stop`).
- `defaultChannelDrivers(overrides)` plus built-in per-channel
  `create<Channel>ChannelDriver(overrides)` factories with test seams.
- `createConfiguredAgentRuntime`, `createConfiguredAgentHarness`,
  `createConfiguredAgentResponder`, and `createConfiguredMemory` for
  transport-free programmatic composition from a loaded `MonoAgentConfig`.
- `createBroadcastRunRecorder` for publishing recorder lifecycle events to a
  live run-event sink.
- `initMonoAgentFolder(options)` / `validateMonoAgentFolder(options)`. Init results
  expose precise `changes`, `secretPersistence`, and canonical `identityRole`
  created/preserved/planned outcomes; the compatibility `secretsPersisted` flag
  is true only after a committed secret write.
- `MONO_AGENT_APP_FIELD_GROUPS` and the `resolveApp*` traceability/artifact
  resolvers.
- `runCli(argv)` / `parseCliArgs(argv)` backing the `mono-agent` bin.
- Managed configuration CLI lifecycle: macOS `mono-agent tui --configure`
  against the background agent (`--local` is ordinary chat only), plus managed
  project-skill drift/update through `install-skill --project`.
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
