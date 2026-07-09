---
title: "Your First Agent"
sidebar:
  order: 2
---

# Your First Agent

This page walks the happy path: scaffold a config-first agent with `mono-agent init`, confirm it with `mono-agent validate`, run it with `mono-agent start`, and smoke-test it over the zero-credential webhook channel with a single `curl`. No bot tokens or channel credentials are needed, but a real model reply still requires provider credentials or a configured local provider.

## Prerequisites

You need Node.js installed, the `mono-agent` CLI available, and credentials for whatever model you point at before you ask for a model response. The quickest path is the `npm create mono-agent@latest` installer (equivalently `npx create-mono-agent`) with no global install, or `npm i -g create-mono-agent` for the persistent `mono-agent` command. The CLI itself ships inside `@mono-agent/agent-app` (the installer just delegates to it), so `npm i -g @mono-agent/agent-app` or `npm exec --package @mono-agent/agent-app -- mono-agent ...` are equivalent. The default model is direct `codex:gpt-5.6-terra`; the wizard also offers `pi:openai-codex:gpt-5.6-terra` as a selectable Pi candidate and can offer `mono-agent auth login <provider>` when its Pi auth store is missing. See [Install](/getting-started/install/) for the full setup and [Environment Variables](/config/env-vars/) for the keys each backend expects.

If you are testing unreleased source from a clone, replace `mono-agent` in the commands below with the built CLI entry:

```bash
node /absolute/path/to/mono-agent/packages/agent-app/dist/cli.js
```

## 1. Scaffold the folder (`cli`)

Run `init` inside an empty folder (or an existing project — it never overwrites your files):

```bash
mkdir my-agent
cd my-agent
mono-agent init --model codex:gpt-5.6-terra
```

:::tip
Prefer a guided first run? On a terminal, run `mono-agent init` **with no flags** to launch the step-by-step wizard: start from a [preset](/reference/recipes/) or go custom, then it walks you through the same model, channel, memory, tool, and sandbox choices either way. The default is direct `codex:gpt-5.6-terra`; Pi Terra remains an interactive discovered choice. Webhook is the ready local default; optional plugins are never presented as installed capabilities. Required selected-channel secrets are masked and merged into `.env` with mode `0600`, never into config JSON. Before it writes the agent folder, the wizard runs one disposable no-tool turn with the exact selected model and environment. A failed probe offers provider setup, model change, explicit incomplete save, or cancellation rather than claiming readiness. See the [`init` section of the CLI reference](/observability/cli-reference/#init) for the flags that skip the wizard, and [Presets & capability modules](/reference/recipes/) for what each preset seeds.
:::

Passing a flag like `--model` (as below) skips the wizard and writes the scaffold non-interactively — the composer defaults `tools.allowedTools` to allow-all (`["*"]`), so the agent can use every built-in and any enabled channel's send tools out of the box.

Optional flags:

| Flag | Purpose |
| --- | --- |
| `--model <ref>` | Primary runtime model. Format: `pi:<provider>:<model>`, `claude:*`, `codex:*`, or `opencode:*`. Defaults to `codex:gpt-5.6-terra`; `pi:openai-codex:gpt-5.6-terra` is a selectable Pi candidate. |
| `--fallback-models <csv>` | Ordered backup models tried on retryable provider failure. Written to `runtime.fallbackModels`. See [Fallback Chain](/runtime/fallback/). |
| `--memory lite\|journal\|bujo` | Adds a `memory` section with the chosen tier. Omit it and no memory is configured. See [Capture and Recall](/memory/capture-and-recall/). |

A fuller example:

```bash
mono-agent init \
  --model codex:gpt-5.6-terra \
  --fallback-models "pi:opencode-go:kimi-k2.6,pi:ollama:gemma4:31b" \
  --memory bujo
```

### What `init` scaffolds

`init` is a non-destructive scaffold (`app.cli-init`). Files that already exist are reported as skipped and left untouched. In a clean folder it creates:

- **`mono-agent.config.json`** — the single config file that declares the whole agent. It enables the **webhook channel** (`webhook.enabled: true`) as the zero-credential smoke channel so you can get a response immediately, and wires `artifacts`, `traceability`, and `context.identityPath` to the scaffolded paths.
- **`IDENTITY.md`** — role, boundaries, and a Knowledge section that references any `AGENTS.md`, `CLAUDE.md`, `README.md`, or `SOUL.md` already present in the folder. Edit this to describe what your agent is for. See [Identity and Soul](/context/identity-and-soul/).
- **`.mono-agent/`** — working directories: `.mono-agent/artifacts` (run output) and `.mono-agent/workspace`.

The generated config (with `--fallback-models` and `--memory bujo`) looks like this — note that `tools.allowedTools` defaults to allow-all (`["*"]`), and the `bujo` tier scaffolds its embeddings, capture LLM, and recall tool:

```json
{
  "runtime": {
    "model": "codex:gpt-5.6-terra",
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

## 2. Validate (`cli`)

Check the config section by section before starting:

```bash
mono-agent validate
```

`validate` (`app.cli-validate`) prints a per-section report — core, runtime, context, memory, tools, sandbox, and every channel — each tagged with a status:

| Status | Meaning | Action |
| --- | --- | --- |
| `[ok]` | Section is healthy. | None. |
| `[waiting]` | Enabled but missing a credential or input (e.g. a channel awaiting a token). | Fine for the quickstart — webhook needs nothing. |
| `[disabled]` | Capability is off (not enabled in config). | None. |
| `[error]` | A real misconfiguration. | Fix before starting. |

Fix every `[error]` section. A `[waiting]` is expected for channels you have not credentialed yet — it does not block `start`. If you added `--memory`, `validate` also runs a memory liveness check (root writable, and Ollama reachability only for components that use it).

For the default Claude model, `validate` reports the runtime shape and SDK route. It does not make a provider request or prove that `ANTHROPIC_API_KEY` is valid. Export credentials before `start` and the webhook smoke test so the first real turn can reach the model:

```bash
export ANTHROPIC_API_KEY=...
```

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
