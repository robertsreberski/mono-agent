---
title: "Your First Agent in 5 Minutes"
sidebar:
  order: 2
---

# Your First Agent in 5 Minutes

This page walks the happy path: scaffold a config-first agent with `mono-agent init`, confirm it with `mono-agent validate`, run it with `mono-agent start`, and smoke-test it over the zero-credential webhook channel with a single `curl`. No bot tokens or channel credentials are needed to get a first response.

## Prerequisites

You need Node.js installed, the `mono-agent` CLI available (`npx mono-agent ...` works too), and credentials for whatever model you point at. The default model is `claude:claude-sonnet-4-6`, which reads `ANTHROPIC_API_KEY` from the environment. See [Install](/getting-started/install/) for the full setup and [Environment Variables](/config/env-vars/) for the keys each backend expects.

## 1. Scaffold the folder (`cli`)

Run `init` inside an empty folder (or an existing project — it never overwrites your files):

```bash
mono-agent init --model claude:claude-sonnet-4-6
```

Optional flags:

| Flag | Purpose |
| --- | --- |
| `--model <ref>` | Primary runtime model. Format: `claude:*`, `codex:*`, or `pi:<provider>:<model>`. Defaults to `claude:claude-sonnet-4-6`. |
| `--fallback-models <csv>` | Ordered backup models tried on retryable provider failure. Written to `runtime.fallbackModels`. See [Fallback Chain](/runtime/fallback/). |
| `--memory lite\|journal\|bujo` | Adds a `memory` section with the chosen tier. Omit it and no memory is configured. See [Capture and Recall](/memory/capture-and-recall/). |

A fuller example:

```bash
mono-agent init \
  --model claude:claude-sonnet-4-6 \
  --fallback-models "pi:ollama:gemma4:31b,codex:gpt-5.5" \
  --memory bujo
```

### What `init` scaffolds

`init` is a non-destructive scaffold (`app.cli-init`). Files that already exist are reported as skipped and left untouched. It creates:

- **`mono-agent.config.json`** — the single config file that declares the whole agent. It enables the **webhook channel** (`webhook.enabled: true`) as the zero-credential smoke channel so you can get a response immediately, and wires `artifacts`, `traceability`, and `context.identityPath` to the scaffolded paths.
- **`IDENTITY.md`** — role, boundaries, and a Knowledge section that references any `AGENTS.md`, `CLAUDE.md`, `README.md`, or `SOUL.md` already present in the folder. Edit this to describe what your agent is for. See [Identity and Soul](/context/identity-and-soul/).
- **`.mono-agent/`** — working directories: `.mono-agent/artifacts` (run output) and `.mono-agent/workspace`.

The generated config (with `--fallback-models` and `--memory bujo`) looks like this:

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "fallbackModels": ["pi:ollama:gemma4:31b", "codex:gpt-5.5"],
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "selectedSkills": []
  },
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary"
  },
  "tools": {
    "allowedTools": [],
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
  }
}
```

Every field has a `MONO_AGENT_*` env override (env > JSON > defaults) — for example `MONO_AGENT_MODEL`, `MONO_AGENT_FALLBACK_MODELS`. See [Configuration](/config/) for the annotated blueprint.

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

If your model needs a key, export it before validating so the runtime section reports `[ok]`.

```bash
export ANTHROPIC_API_KEY=sk-...
```

:::tip
:::
Point validate at a non-default config or env file with `mono-agent validate --config ./other.config.json --env-file ./.env`. To check a downstream agent folder from elsewhere, use `mono-agent validate --consumer ../local-agent-alpha`; the consumer `.env` loads by default and relative `--config` / `--env-file` paths resolve inside that folder.

## 3. Start (`cli`)

```bash
mono-agent start
```

This boots the runtime and every enabled channel. The webhook channel listens on loopback (`127.0.0.1`) and, because the default `port` is `0`, picks a free port. `start` prints the resolved webhook **invoke URL** — copy it for the smoke test below.

## 4. Smoke-test with curl

Send a request to the printed webhook path. The default endpoint path is `/webhook/invoke` and the default mode is `sync`, so the HTTP response carries the agent's reply directly:

```bash
curl -s http://127.0.0.1:<PORT>/webhook/invoke \
  -H 'content-type: application/json' \
  -d '{"text": "Say hello and tell me what you are."}'
```

Replace `<PORT>` with the port from the `start` output. A response means the runtime, model, identity, and webhook channel are all wired correctly — you have a working agent.

:::note
:::
The webhook channel binds to loopback only. To accept non-loopback requests you must set `webhook.allowNonLoopback: true` (and ideally a non-zero `port`). For async invocation, status polling, multiple named endpoints, and per-endpoint prompts, see [Webhook](/channels/webhook/).

## Where to next

- Turn this into a real assistant: add a credentialed channel like [Telegram](/channels/telegram/) or [Slack](/channels/slack/).
- Understand the moving parts: [Core Concepts](/getting-started/concepts/).
- See the full config surface: [Configuration](/config/) and the [Config Blueprint](/config/blueprint/).
- Build something end to end: the [Playbooks](/playbooks/) — e.g. [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) or [Telegram personal assistant](/playbooks/telegram-personal-assistant-bujo/).
- Embed the agent in your own code instead of the CLI: [Programmatic](/programmatic/).
