---
title: "Your First Agent"
description: "Create, validate, and start a first mono-agent, then hold your first browser conversation with the foreground console."
sidebar:
  order: 2
---

This page walks from an empty folder to a first conversation in the browser console: the guided `mono-agent init` wizard, the readiness checks it performs, the start path for each platform, and the foreground console. A real model reply still requires provider credentials or a configured local provider.

## The shortest working path

If Node.js and a model provider are already ready, start here:

```bash
npm i -g create-mono-agent
mkdir my-agent && cd my-agent
mono-agent init                    # guided setup: signs in and proves each selected route
mono-agent status                  # macOS guided setup already started the agent
mono-agent web run --loopback      # foreground browser console; keep this terminal open
```

Open `http://127.0.0.1:5050`, pick the agent, and send a message. Guided setup is authentic and not instant: it signs you in to the provider you choose and makes one real model request for every selected route to prove the route answers, which can take several minutes and counts as usage on your account. The [platform table](#how-the-agent-runs-on-your-platform) below says what to run instead of `status` on Linux and on hosts without a service manager; [Setup details](#setup-details-guided-init-flags-and-files) has the deadlines, flags, and generated files.

### How the agent runs on your platform

| Situation | The agent | The console |
| --- | --- | --- |
| macOS, guided `init` | Already started as a background service; `mono-agent status` confirms it | `mono-agent web run --loopback`, in its own terminal |
| Linux, guided `init` | `init` proves the routes, then asks you to start it: `mono-agent start` with a usable systemd **user** manager, otherwise `mono-agent start --foreground` | the same console command |
| Any other host, or no usable service manager | `mono-agent start --foreground` in terminal 1 | `mono-agent web run --loopback` in terminal 2 |
| Any flag, `--yes`, or non-TTY | `init` wrote the scaffold only: run `mono-agent validate`, then `mono-agent start` (or `--foreground`) | the same console command |

Bare `init` on a TTY is the only init mode that proves readiness. With flags or without a TTY it writes the scaffold only — no readiness proof and no started process — unless you pass `--auth`, which adds provider setup to that automated path. Linux is **not** a scaffold-only case: guided `init` runs the same route and configuration checks as macOS, then stops with a **Manual start required** handoff instead of installing the systemd user service for you.

## 1. Scaffold the folder (`cli`)

Run bare `init` inside an empty folder on a TTY:

```bash
mkdir my-agent
cd my-agent
mono-agent init
```

The wizard starts from a [preset](/reference/presets/) or custom answers, asks what the agent should be called, and labels the next answer as the exact Role text for `IDENTITY.md` → `## Role`. Creation review repeats both the destination and the exact text. If `IDENTITY.md` already exists, the wizard says it will remain unchanged and that the entered Role will not be written. It then walks the same model, channel, memory, runtime-appropriate tool/safety, and observability decisions either way, and proves every selected route before the readiness gate. The full walkthrough, the automated flag set, and the files it writes are in [Setup details](#setup-details-guided-init-flags-and-files).

## 2. Validate (`cli`)

Check the config section by section before starting:

```bash
mono-agent validate
```

`validate` (`app.cli-validate`) prints a per-section report — core, runtime, provenance and routes, provider credentials, context, memory, tools, sandbox, observability, runs health, the managed-service `Launchd logs` section (macOS), secret placement, and every channel — each tagged with a status. That logs section reports active, retained, and total bytes for every safely inspected stream, reports unsafe or unreadable inventory as unavailable, and never rotates or changes permissions:

| Status | Meaning | Action |
| --- | --- | --- |
| `[ok]` | Section is healthy. | None. |
| `[waiting]` | Enabled but missing a credential, process, or live dependency. | Resolve it before calling the selected capability ready. |
| `[disabled]` | Capability is off (not enabled in config). | None. |
| `[error]` | A real misconfiguration. | Fix before starting. |

Fix every `[error]` section. Standalone `validate` keeps `waiting` non-fatal for operators intentionally starting partial configurations, so exit `0` means structurally valid, not that every selected capability is live. The guided wizard's **Agent ready** gate is stricter: no selected expectation may be waiting, and every selected runtime route must have succeeded in its exact live check. Read-only credential detection (the Pi auth store and declared `apiKeyEnv` variables) is not a model-turn claim. Hidden memory and static-trigger dependencies are also validated.

Point validate at a non-default config or env file with `mono-agent validate --config ./other.config.json --env-file ./.env`. To check a downstream agent folder from elsewhere, use `mono-agent validate --consumer ../local-agent-alpha`; the consumer `.env` loads by default and relative `--config` / `--env-file` paths resolve inside that folder.

## 3. Start the agent (`cli`)

```bash
mono-agent start
```

Guided macOS init has already started this service before configuration mode. Run `mono-agent status` to inspect it; use `mono-agent start` when continuing from a scaffold, from Linux guided setup, or from a manually recovered setup. This boots the runtime and every enabled channel. The webhook channel listens on loopback (`127.0.0.1`) and, because the default `port` is `0`, picks a free port. `start` prints the resolved webhook **invoke URL** — copy it if you want the scriptable smoke test below.

`mono-agent start` installs a service: macOS `launchd`, or a Linux systemd **user** service. Where no usable service manager exists — and on any other platform — run the blocking foreground process in its own terminal instead:

```bash
mono-agent start --foreground
```

Keep that terminal open: closing it stops the agent. The console goes in a second terminal, because it is a separate process.

## 4. Open the browser console (`cli`)

Run the console in the foreground, bound to this computer, and open the URL it prints:

```bash
mono-agent web run --loopback
```

Open `http://127.0.0.1:5050` (unless `--port` changed it), select the running agent, and start typing. The console auto-discovers agents that are running on this machine, keeps conversations and in-flight turns in its own service, and keeps a separate transcript per conversation, so refreshing the page does not abort a turn. Leave this terminal open while you use the console; if the agent is in the foreground too, that is terminal 1 and this is terminal 2.

`web run` is the local-first mode: it never configures a Tailscale Serve route and never removes a route that an earlier managed start created. The managed alternative is `mono-agent web start`, which keeps the console running in the background. On macOS, managed startup also claims its own Serve HTTPS route while the service runs, so `--loopback` alone does not make a managed console local — and the console still has **no application login**, so anyone who can reach that route can operate every discovered agent. Bare `mono-agent web` prints the effective URLs and lifecycle state without changing anything; read the [web console guide](/observability/web-console/) for the security boundary, attachments, notifications, and service lifecycle, or [Install](/getting-started/install/#run-the-browser-console) for both startup modes.

## 5. Optional: drive it from a script or the terminal

The default scaffold also enables the loopback webhook channel — a channel that needs no credentials of its own and is the fastest way to drive the agent from a shell or script. The default endpoint path is `/webhook/invoke` and the default mode is `sync`, so the HTTP response carries the agent's reply directly:

```bash
PORT=3000 # Replace 3000 with the port printed by `mono-agent start`.
curl -s "http://127.0.0.1:${PORT}/webhook/invoke" \
  -H 'content-type: application/json' \
  -d '{"text": "Say hello and tell me what you are."}'
```

Replace `3000` with the port from the `start` output. A response means the runtime, model, identity, and webhook channel are all wired correctly. Without valid provider credentials or a reachable local provider, the webhook request should fail honestly rather than returning a fake model reply. The webhook channel binds to loopback by default; to accept non-loopback requests you must set both `webhook.allowNonLoopback: true` and `MONO_AGENT_WEBHOOK_API_KEY`, and callers send the key as a bearer. For async invocation, status polling, multiple named endpoints, and per-endpoint prompts, see [Webhook](/channels/webhook/).

Prefer a terminal chat to the browser? `mono-agent tui` connects to the same running agent from any directory and adds structured turn inspection and recorded-run replay; see [TUI](/observability/tui/).

:::note
How long this takes depends on provider authentication, network latency, model availability, and whether the CLI has to be installed or built first. Guided setup waits on real sign-in and route probes; the scaffold-only path is local, and `validate` is local config plus bounded live checks for the capabilities you enabled. There is no fixed promise for time-to-first-reply.
:::

## Make it yours

Now that the first reply works, change the agent in the same folder:

1. Edit `mono-agent.config.json` — model routes and fallbacks, context, channels, tools, memory, sandbox, observability. Start from the [Annotated config blueprint](/config/blueprint/).
2. Edit `IDENTITY.md` — the Role, boundaries, and knowledge sections the agent reads each turn. See [Identity & soul](/context/identity-and-soul/).
3. Apply the change and confirm it took effect. The commands depend on how the agent runs: `restart`, `status`, `stop`, and `logs` target the managed background instance, not a foreground process.

For a background service (macOS `launchd` or Linux systemd user service):

```bash
mono-agent validate
mono-agent restart
mono-agent status
```

For a foreground agent, stop it with Ctrl-C in the terminal that owns it, then start it again:

```bash
mono-agent validate
mono-agent start --foreground
```

Watch the new start output for errors. There is no foreground variant of `restart`, and `mono-agent status` does not track a foreground process. `validate` checks the edited configuration; the restart — or the new foreground start — is what actually loads it, and the agent keeps serving the previous config until then, so fix every `[error]` section first. The console is a separate process: leave its terminal open, and it reconnects to the agent once the agent is running again.

Do not put secrets in JSON or identity files: channel and provider credentials belong in an owner-only `.env` or the provider's auth store. `mono-agent auth login` writes that store, and your own manual edits can too — guided setup is one writer, not the only one. For the full config surface, see [Configuration](/config/) and the [CLI reference](/observability/cli-reference/).

## Setup details: guided init, flags, and files

Bare `mono-agent init` on a TTY is the readiness-proven path. It searches every bundled model for the Pi providers — Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go — plus discovered local models. Other hand-authored refs remain runtime-compatible but are outside guided cloud-provider setup. The provider-declared Codex default leads when discovery succeeds; curated `openai-codex:gpt-5.6-terra` is the offline fallback. The offline entry does not guess effort support and therefore offers only **Provider default** until live `model/list` metadata is available. The wizard keeps catalog availability, credential detection, and live verification separate. Type to search the primary and fallback catalogs; add as many fallbacks as you need and choose each route's supported effort or **Provider default**. Escape moves back one logical step, and Ctrl-C asks before exiting.

Credentials come from the app-owned Pi OAuth flow: `mono-agent auth login openai-codex` prints an auth URL to open in a browser, waits for the localhost callback, and a remote/headless machine can paste the returned redirect URL or authorization code into the live prompt instead. GPT-6 Astra is available as `openai-codex:gpt-6-astra`; `openai:gpt-6-astra` is the corresponding hand-authored OpenAI API-key route. GPT-5.6 Sol remains available as `openai-codex:gpt-5.6-sol`. See [Environment Variables](/config/env-vars/) for other providers, and [Local providers](/runtime/local-providers/) to run entirely on Ollama or LM Studio.

Journal and BuJo add a dedicated local-embeddings step. Choose Ollama or LM Studio,
confirm its service root, select a model from provider-native typed discovery, and let the
wizard prove and record the actual vector dimension. Ollama discovery checks `/api/show`
for the `embedding` capability; LM Studio accepts only `/api/v1/models` entries whose type
is `embedding`. If discovery is unavailable you may enter the model and a positive dimension
manually, but guided readiness still requires a real `/api/embed` or `/v1/embeddings` probe.
The selected provider never falls back to the other one. LM Studio is keyless by default;
when its server uses authentication, name the populated owner-only `.env` variable through
`apiKeyEnv` rather than putting a token in config.

**Allow all tools** is the default and includes shell, file, web, and enabled channel-send tools. A mixed chain requires explicit per-route acceptance after the wizard displays the concrete route matrix. Pi keeps mono-agent tools and optional managed SRT; provider-owned routes use their documented native contract. Unsupported capabilities are never silently dropped.

After the explicit **Creation review**, the wizard makes one disposable no-tool call for every selected route, sequentially, with a 90-second cloud or 240-second local deadline per route. A detected Pi auth-store entry or declared `apiKeyEnv` credential skips redundant authentication, but it is not called verified until the exact route succeeds. Escape or Ctrl-C interrupts safely. Recovery can resume routes already verified under the same non-secret plan fingerprint, restart all checks, edit choices, or cancel without writing. Choosing authentication repair clears all prior route proofs before the checks rerun. Provider failure, timeout, empty output, or any tool action fails that route. On macOS, **Agent ready** additionally requires the committed config and every selected credential, channel, sandbox, memory, and observability expectation to be ready. The managed background process must then prove its live identity, exact committed snapshot, durable environment, and reachable operator endpoint before the wizard prints its handoff. See [Setup security and managed runtime](/reference/setup-security/) for the closure-integrity, single-instance, frozen-input, and snapshot-commitment contracts behind that proof.

On Linux the wizard completes the same route and configuration checks, then stops with a **Manual start required** handoff instead of installing the systemd user service for you; the printed `mono-agent start` step needs a usable systemd **user** manager. Without one, keep `mono-agent start --foreground` in one terminal and `mono-agent web run --loopback` in a second.

Passing any flag or running without a TTY skips the wizard and writes a scaffold only. It never runs the readiness proof, starts a process, or labels the result ready. These flags remain useful for automation:

Optional flags:

| Flag | Purpose |
| --- | --- |
| `--name <display-name>` | Public agent name. Display metadata only; never used for paths/service/session ids. |
| `--model <ref>` | Primary runtime model. Format: `<provider>:<model>` (e.g. `openai-codex:gpt-5.6-terra`, `anthropic:claude-sonnet-4-6`, `ollama:gemma4:31b`). Defaults to `openai-codex:gpt-5.6-terra`. |
| `--fallback <ref>` | Repeatable canonical fallback route. Follow immediately with `--fallback-effort <provider-default\|level>` when needed. |
| `--auth` | Opt in to provider setup before writing: the app-owned Pi OAuth flows and local-provider preflight. Detected credentials are reused |
| `--memory lite\|journal\|bujo` | Adds a `memory` section with the chosen tier. Omit it and no memory is configured. See [Capture and Recall](/memory/capture-and-recall/). |

A fuller example:

```bash
mono-agent init \
  --name "Research Companion" \
  --model openai-codex:gpt-5.6-terra \
  --fallback anthropic:claude-sonnet-5 --fallback-effort xhigh \
  --fallback ollama:gemma4:31b --fallback-effort provider-default \
  --memory bujo
```

### What `init` scaffolds

`init` is non-destructive for scaffold/config files (`app.cli-init`): existing config, identity, and capability files are reported as unchanged. Guided secret setup is the explicit exception and may securely harden/update `.env` plus `.gitignore`. In a clean folder it creates:

- **`mono-agent.config.json`** — the single config file that declares the whole agent. It enables the **webhook channel** (`webhook.enabled: true`) as the zero-credential smoke channel so you can get a response immediately, and wires `artifacts`, `traceability`, and `context.identityPath` to the scaffolded paths.
- **`IDENTITY.md`** — the reviewed Role is stored only as the body of `## Role`, alongside boundaries and a Knowledge section that references any `AGENTS.md`, `CLAUDE.md`, `README.md`, or `SOUL.md` already present in the folder. An existing file is preserved byte-for-byte; in that case the entered Role is not written, and you add or edit its `## Role` section later. See [Identity and Soul](/context/identity-and-soul/).
- **`skills/mono-agent-memory`** — the versioned project-local memory skill selected with index disclosure. `ReadSkill` loads its body only when needed. `skills/.mono-agent-managed.json` records its hash for safe drift checks and updates.
- **`.mono-agent/`** — working directories: `.mono-agent/artifacts` (run output) and `.mono-agent/workspace`.

When a fresh init selects built-in Journal or BuJo memory, init also creates one empty managed generation without indexing content. Guided setup has already made its separate fixed, non-user readiness probe; flag/non-TTY scaffolding makes no provider call and no readiness claim. Init never adopts or changes a pre-existing memory root; stop the agent and use the explicit `mono-agent memory rebuild` path for an existing root. Fresh managed init rejects environment overrides for memory backend, mode, path, and embedding provider/model/dimension; put that identity in the generated config. Credential and endpoint environment values remain valid inputs.

The generated config (with canonical `--fallback` routes and `--memory bujo`) looks like this — note that `tools.allowedTools` defaults to allow-all (`["*"]`), and the `bujo` tier scaffolds its embeddings, capture LLM, and recall tool:

```json
{
  "agent": { "name": "Research Companion" },
  "runtime": {
    "model": "openai-codex:gpt-5.6-terra",
    "fallbacks": [
      { "model": "anthropic:claude-sonnet-5", "effort": "xhigh" },
      { "model": "ollama:gemma4:31b" }
    ],
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["mono-agent-memory"],
    "skillDisclosure": "index"
  },
  "tools": {
    "allowedTools": ["*"],
    "disallowedTools": []
  },
  "artifacts": {
    "dir": "./.mono-agent/artifacts"
  },
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceLabel": "Research Companion"
  },
  "webhook": {
    "enabled": true
  },
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    },
    "llm": { "provider": "agent-host", "model": "openai-codex:gpt-5.6-terra" },
    "recallTool": { "enabled": true }
  }
}
```

Every field documented with a `MONO_AGENT_*` mapping has an env override (env > JSON > defaults) — for example `MONO_AGENT_NAME`, `MONO_AGENT_MODEL`, and `MONO_AGENT_FALLBACKS_JSON`; JSON-only fields stay in the file. See the [generated config reference](/config/reference/) for which fields expose a mapping, and [Environment variables](/config/env-vars/) for the supported set. The scaffolder also adds an `artifacts.retention` block and a `$schema` reference, omitted here for brevity.

For selected channel secrets, the guided wizard never shows values in config, examples, review output, or logs. Existing non-empty dotenv assignments and comments are preserved, and a shell-only value cannot make a later background start appear durable. Automatic persistence fails closed when the agent folder, dotenv, ignore rules, or a concurrent update cannot be verified safely; unsupported platforms receive manual instructions. The complete ownership, locking, promotion, race-recovery, and provider-auth-store rules live in [Setup security and managed runtime](/reference/setup-security/). Never copy `.env.example` over an already populated `.env`.

:::tip
Source-build validation from a separate clean folder should use the worktree CLI explicitly:

```bash
repo=/absolute/path/to/mono-agent
agent_dir=$(mktemp -d)
cd "$agent_dir"
node "$repo/packages/agent-app/dist/cli.js" init --model openai-codex:gpt-5.6-terra
node "$repo/packages/agent-app/dist/cli.js" validate
```
:::

If you are testing unreleased source from a clone, replace `mono-agent` in every command above with the built CLI entry:

```bash
node /absolute/path/to/mono-agent/packages/agent-app/dist/cli.js
```

## Where to next

- Live in the console: [Always-on web console](/observability/web-console/) — threads, attachments, notifications, service lifecycle, and the trusted-network boundary.
- Turn this into a real assistant: add a credentialed channel like [Telegram](/channels/telegram/) or [Slack](/channels/slack/).
- Understand the moving parts: [Core Concepts](/getting-started/concepts/).
- See the full config surface: [Configuration](/config/) and the [Config Blueprint](/config/blueprint/).
- Build something end to end: the [Playbooks](/playbooks/) — e.g. [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) or [Telegram personal assistant](/playbooks/telegram-personal-assistant-bujo/).
- Embed the agent in your own code instead of the CLI: [Programmatic](/programmatic/).
