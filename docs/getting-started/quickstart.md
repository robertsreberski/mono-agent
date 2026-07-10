---
title: "Your First Agent"
sidebar:
  order: 2
---

# Your First Agent

This page walks the happy path: scaffold a config-first agent with `mono-agent init`, confirm it with `mono-agent validate`, run it with `mono-agent start`, and smoke-test it over the zero-credential webhook channel with a single `curl`. No bot tokens or channel credentials are needed, but a real model reply still requires provider credentials or a configured local provider.

## Prerequisites

You need Node.js installed, the `mono-agent` CLI available, and credentials for whatever model you choose. The quickest path is the `npm create mono-agent@latest` installer (equivalently `npx create-mono-agent`) with no global install, or `npm i -g create-mono-agent` for the persistent command. The CLI itself ships in `@mono-agent/agent-app`, so installing or invoking that scoped package is equivalent.

The first-run default is direct `codex:gpt-5.6-terra`. The wizard checks the Codex executable and sign-in state; it does not install or sign in silently. If needed, use only the [official Codex CLI instructions](https://developers.openai.com/codex/cli/): on macOS/Linux the standalone installer is `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, the first `codex` run prompts for sign-in, and `codex login` / `codex login status` manage it explicitly. Pi Terra remains selectable and uses `mono-agent auth login openai-codex` when its separate Pi auth store needs setup. GPT-5.6 Sol can be selected explicitly as `codex:gpt-5.6-sol` or `pi:openai-codex:gpt-5.6-sol`; direct GPT-5.6 routes require Codex CLI 0.144.0 or newer, and the selected-model readiness probe exercises the exact primary before setup reports **Agent ready**. See [Install](/getting-started/install/) and [Environment Variables](/config/env-vars/) for other backends.

If you are testing unreleased source from a clone, replace `mono-agent` in the commands below with the built CLI entry:

```bash
node /absolute/path/to/mono-agent/packages/agent-app/dist/cli.js
```

## 1. Scaffold the folder (`cli`)

Run bare `init` inside an empty folder on a TTY. This guided path is the only init mode that proves readiness:

```bash
mkdir my-agent
cd my-agent
mono-agent init
```

The wizard starts from a [preset](/reference/recipes/) or custom answers, then walks through the same model, channel, memory, runtime-appropriate tool/safety, and observability decisions either way. **Allow all tools** is the default and includes shell, file, web, and enabled channel-send tools. Pi/Claude flows disclose that scope and reconfirm an unsandboxed choice. Direct Codex fixes tool policy to allow-all and reports its own network-off workspace sandbox; it denies unattended escalations rather than prompting a channel worker. Claude and direct `opencode:*` cannot be combined with a native mono-agent `srt` policy; choose a Pi route (including `pi:opencode-go:*`) when those exact scopes are required.

The wizard first runs a **Primary model check**: a disposable no-tool turn against the exact primary and a worker-reproducible environment, with a 90-second cloud or 240-second local deadline. Cancellation — including Ctrl-C at the spinner — provider failure, timeout, empty output, or any tool action fails immediately. Shell-only provider credentials and `MONO_AGENT_*` config overrides are not allowed to make this proof pass and then disappear under launchd. **Agent ready** is a separate, stricter gate: the complete config must be valid and every selected credential, channel, sandbox, memory, and observability expectation must be ready. Only then is immediate start offered. Saving after a failed check produces an explicitly incomplete scaffold and never auto-starts.

Passing any flag or running without a TTY skips the wizard and writes a scaffold only. It never runs the readiness proof or labels the result ready. These flags remain useful for automation:

Optional flags:

| Flag | Purpose |
| --- | --- |
| `--model <ref>` | Primary runtime model. Format: `pi:<provider>:<model>`, `claude:*`, `codex:*`, or `opencode:*`. Defaults to `codex:gpt-5.6-terra`; selectable Sol refs are `codex:gpt-5.6-sol` and `pi:openai-codex:gpt-5.6-sol`. |
| `--fallback-models <csv>` | Ordered backup models tried on retryable provider failure. Written to `runtime.fallbackModels`. Direct Codex chains must remain all-direct; Pi, Claude, and direct OpenCode may mix only without a native mono-agent sandbox. See [Fallback Chain](/runtime/fallback/). |
| `--memory lite\|journal\|bujo` | Adds a `memory` section with the chosen tier. Omit it and no memory is configured. See [Capture and Recall](/memory/capture-and-recall/). |

A fuller example:

```bash
mono-agent init \
  --model pi:openai-codex:gpt-5.6-terra \
  --fallback-models "pi:opencode-go:kimi-k2.6,pi:ollama:gemma4:31b" \
  --memory bujo
```

### What `init` scaffolds

`init` is non-destructive for scaffold/config files (`app.cli-init`): existing config, identity, and capability files are reported as unchanged. Guided secret setup is the explicit exception and may securely harden/update `.env` plus `.gitignore`. In a clean folder it creates:

- **`mono-agent.config.json`** — the single config file that declares the whole agent. It enables the **webhook channel** (`webhook.enabled: true`) as the zero-credential smoke channel so you can get a response immediately, and wires `artifacts`, `traceability`, and `context.identityPath` to the scaffolded paths.
- **`IDENTITY.md`** — role, boundaries, and a Knowledge section that references any `AGENTS.md`, `CLAUDE.md`, `README.md`, or `SOUL.md` already present in the folder. Edit this to describe what your agent is for. See [Identity and Soul](/context/identity-and-soul/).
- **`.mono-agent/`** — working directories: `.mono-agent/artifacts` (run output) and `.mono-agent/workspace`.

The generated config (with `--fallback-models` and `--memory bujo`) looks like this — note that `tools.allowedTools` defaults to allow-all (`["*"]`), and the `bujo` tier scaffolds its embeddings, capture LLM, and recall tool:

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbackModels": ["pi:opencode-go:kimi-k2.6", "pi:ollama:gemma4:31b"],
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "selectedSkills": []
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
    "sourceLabel": "Mono Agent (my-folder)"
  },
  "webhook": {
    "enabled": true
  },
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text" },
    "llm": { "provider": "agent-host", "model": "pi:openai-codex:gpt-5.6-terra" },
    "recallTool": { "enabled": true }
  }
}
```

Every field has a `MONO_AGENT_*` env override (env > JSON > defaults) — for example `MONO_AGENT_MODEL`, `MONO_AGENT_FALLBACK_MODELS`. See [Configuration](/config/) for the annotated blueprint. The scaffolder also adds an `artifacts.retention` block and a `$schema` reference, omitted here for brevity.

For selected channel secrets, the guided wizard never shows values in config, examples, review output, or logs. Existing non-empty dotenv assignments/comments are preserved. A shell-only selected secret does not skip the masked prompt because a later background start cannot inherit that shell; the entered value must match any exported or persisted copy before the wizard writes a missing value. Durable provider keys already present in `.env` go through the same secure preflight even when the plan has no channel secret. On POSIX the canonical agent directory must be current-user-owned and not group/world-writable, while existing `.env` and `.gitignore` files must be current-user-owned single-link regular files. The env is written or tightened to owner-only (`0600`) under an external lock, the ignore guard loses group/world write access, and promotion is pathname no-clobber with exact rules for `.env` plus transaction artifacts. Pathname competitors stay at the target. The claimed inode is rechecked; detected writes through an already-open descriptor are retained at a printed owner-only recovery path, while a non-cooperative write after the final check remains outside the POSIX guarantee. Automatic persistence refuses tracked, symlinked, hard-linked, or foreign-owned files, malformed/conflicting dotenv, unrepresentable values, stale locks, concurrent changes, and platforms such as Windows where owner-only protection cannot be verified. Follow the printed manual instructions; never copy `.env.example` over an already populated `.env`.

## 2. Validate (`cli`)

Check the config section by section before starting:

```bash
mono-agent validate
```

`validate` (`app.cli-validate`) prints a per-section report — core, runtime, provider credentials, context, memory, tools, sandbox, observability, and every channel — each tagged with a status:

| Status | Meaning | Action |
| --- | --- | --- |
| `[ok]` | Section is healthy. | None. |
| `[waiting]` | Enabled but missing a credential, process, or live dependency. | Resolve it before calling the selected capability ready. |
| `[disabled]` | Capability is off (not enabled in config). | None. |
| `[error]` | A real misconfiguration. | Fix before starting. |

Fix every `[error]` section. Standalone `validate` keeps `waiting` non-fatal for operators intentionally starting partial configurations, so exit `0` means structurally valid, not that every selected capability is live. The guided wizard's **Agent ready** gate is stricter: no selected expectation may be waiting, and its successful primary-model check proves credentials for that exact model. For unprobed Codex or Claude fallbacks, agent-host memory models, and enabled static webhook/cron overrides, live validation uses bounded, read-only `codex login status` / `claude auth status --json` checks. Direct OpenCode scaffold/config refs are checked from the standard `auth.json` and native migration marker without launching auth middleware; live validation adds a bounded `opencode --version` check and requires stable CLI >=1.15.0. None is mislabelled as a model turn, and direct OpenCode remains outside guided readiness. If you added memory, hidden BuJo dependencies are included: agent-host capture needs its credential, while Ollama capture/embeddings need their local service and models.

:::tip
Source-build validation from a separate clean folder should use the worktree CLI explicitly:

```bash
repo=/absolute/path/to/mono-agent
agent_dir=$(mktemp -d)
cd "$agent_dir"
node "$repo/packages/agent-app/dist/cli.js" init --model codex:gpt-5.6-terra
node "$repo/packages/agent-app/dist/cli.js" validate
```
:::
Point validate at a non-default config or env file with `mono-agent validate --config ./other.config.json --env-file ./.env`. To check a downstream agent folder from elsewhere, use `mono-agent validate --consumer ../local-agent-alpha`; the consumer `.env` loads by default and relative `--config` / `--env-file` paths resolve inside that folder.

## 3. Start (`cli`)

```bash
mono-agent start
```

This boots the runtime and every enabled channel. The webhook channel listens on loopback (`127.0.0.1`) and, because the default `port` is `0`, picks a free port. `start` prints the resolved webhook **invoke URL** — copy it for the smoke test below.

On macOS, `mono-agent start` backgrounds the agent with launchd and returns. On other platforms, use `mono-agent start --foreground`.

## 4. Smoke-test with curl

Send a request to the printed webhook path. The default endpoint path is `/webhook/invoke` and the default mode is `sync`, so the HTTP response carries the agent's reply directly:

```bash
curl -s http://127.0.0.1:<PORT>/webhook/invoke \
  -H 'content-type: application/json' \
  -d '{"text": "Say hello and tell me what you are."}'
```

Replace `<PORT>` with the port from the `start` output. A response means the runtime, model, identity, and webhook channel are all wired correctly — you have a working agent. Without valid provider credentials or a reachable local provider, the webhook request should fail honestly rather than returning a fake model reply.

:::note
Time-to-first-validated-folder is usually under a minute when Node is installed and the CLI package or source build is already available: `mkdir`, `init`, and `validate` are local filesystem/config checks. Time-to-first-reply is not a fixed promise; it depends on provider auth, network latency, model availability, and whether dependencies need to be installed or built first.
:::
The webhook channel binds to loopback only. To accept non-loopback requests you must set `webhook.allowNonLoopback: true` (and ideally a non-zero `port`). For async invocation, status polling, multiple named endpoints, and per-endpoint prompts, see [Webhook](/channels/webhook/).

## Where to next

- Turn this into a real assistant: add a credentialed channel like [Telegram](/channels/telegram/) or [Slack](/channels/slack/).
- Understand the moving parts: [Core Concepts](/getting-started/concepts/).
- See the full config surface: [Configuration](/config/) and the [Config Blueprint](/config/blueprint/).
- Build something end to end: the [Playbooks](/playbooks/) — e.g. [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) or [Telegram personal assistant](/playbooks/telegram-personal-assistant-bujo/).
- Embed the agent in your own code instead of the CLI: [Programmatic](/programmatic/).
