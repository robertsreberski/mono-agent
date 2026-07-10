---
title: "Your First Agent"
sidebar:
  order: 2
---

# Your First Agent

This page walks the happy path: complete the single guided `mono-agent init` wizard, then continue directly in the current folder's local TUI. A background service and webhook smoke remain available later, but neither is required for the first conversation. A real model reply still requires provider credentials or a configured local provider.

## Prerequisites

You need Node.js installed, the `mono-agent` CLI available, and credentials for whatever model you choose. The quickest path is the `npm create mono-agent@latest` installer (equivalently `npx create-mono-agent`) with no global install, or `npm i -g create-mono-agent` for the persistent command. The CLI itself ships in `@mono-agent/agent-app`, so installing or invoking that scoped package is equivalent.

Guided init searches every bundled model for Pi Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go; the live Codex account catalog when available; the Claude SDK catalog; and discovered local models. Other hand-authored Pi refs and `providers.local[]` remain runtime-compatible but are outside guided cloud-provider setup. The provider-declared Codex default leads when discovery succeeds; curated `codex:gpt-5.6-terra` is the offline fallback. The offline entry does not guess effort support and therefore offers only **Provider default** until live `model/list` metadata is available. The wizard keeps catalog availability, credential detection, and live verification separate. It does not install Codex silently; use only the [official Codex CLI instructions](https://developers.openai.com/codex/cli/). Browser login runs `codex login`; a remote/headless machine can select `codex login --device-auth`. GPT-5.6 Sol is available as `codex:gpt-5.6-sol` or `pi:openai-codex:gpt-5.6-sol`. See [Install](/getting-started/install/) and [Environment Variables](/config/env-vars/) for other backends.

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

The wizard starts from a [preset](/reference/recipes/) or custom answers, asks what the agent should be called and one concise sentence describing its purpose, then walks through the same model, channel, memory, runtime-appropriate tool/safety, and observability decisions either way. Type to search the primary and fallback catalogs; add as many fallbacks as you need and choose each route's supported effort or **Provider default**. Escape moves back one logical step. Ctrl-C asks before exiting.

**Allow all tools** is the default and includes shell, file, web, and enabled channel-send tools. `runtime.routeSafety: "uniform"` keeps one common fail-closed contract. A mixed Pi/Claude/Codex/OpenCode chain requires explicit `per-route-native` acceptance after the wizard displays the concrete route matrix. Pi keeps mono-agent tools and optional managed SRT; provider-owned routes use their documented native contract. Unsupported capabilities are never silently dropped.

After the explicit **Creation review**, the wizard makes one disposable no-tool call for every selected route, sequentially, with a 90-second cloud or 240-second local deadline per route. A detected Codex/Claude sign-in or Pi auth-store entry skips redundant authentication, but it is not called verified until the exact route succeeds. Escape or Ctrl-C interrupts safely. Recovery can resume routes already verified under the same non-secret plan fingerprint, restart all checks, edit choices, or cancel without writing. Choosing authentication repair clears all prior route proofs before the checks rerun. Provider failure, timeout, empty output, or any tool action fails that route. **Agent ready** additionally requires the committed config and every selected credential, channel, sandbox, memory, and observability expectation to be ready.

Passing any flag or running without a TTY skips the wizard and writes a scaffold only. It never runs the readiness proof or labels the result ready, and it prints the exact continuation command: `mono-agent tui --local --configure`. These flags remain useful for automation:

Optional flags:

| Flag | Purpose |
| --- | --- |
| `--name <display-name>` | Public agent name. Display metadata only; never used for paths/service/session ids. |
| `--model <ref>` | Primary runtime model. Format: `pi:<provider>:<model>`, `claude:*`, `codex:*`, or `opencode:*`. Defaults to `codex:gpt-5.6-terra`; selectable Sol refs are `codex:gpt-5.6-sol` and `pi:openai-codex:gpt-5.6-sol`. |
| `--fallback <ref>` | Repeatable canonical fallback route. Follow immediately with `--fallback-effort <provider-default\|level>` when needed. |
| `--fallback-models <csv>` | Legacy compatibility form; entries inherit global effort. Do not combine with `--fallback`. |
| `--route-safety uniform\|per-route-native` | Common monotonic contract (default) or explicit isolated provider-native route contracts. |
| `--codex-auth browser\|device` | Direct Codex login mode when `--auth` runs; `device` is for headless hosts. |
| `--memory lite\|journal\|bujo` | Adds a `memory` section with the chosen tier. Omit it and no memory is configured. See [Capture and Recall](/memory/capture-and-recall/). |

A fuller example:

```bash
mono-agent init \
  --name "Research Companion" \
  --model pi:openai-codex:gpt-5.6-terra \
  --fallback claude:claude-sonnet-5 --fallback-effort xhigh \
  --fallback pi:ollama:gemma4:31b --fallback-effort provider-default \
  --route-safety per-route-native \
  --memory bujo
```

### What `init` scaffolds

`init` is non-destructive for scaffold/config files (`app.cli-init`): existing config, identity, and capability files are reported as unchanged. Guided secret setup is the explicit exception and may securely harden/update `.env` plus `.gitignore`. In a clean folder it creates:

- **`mono-agent.config.json`** — the single config file that declares the whole agent. It enables the **webhook channel** (`webhook.enabled: true`) as the zero-credential smoke channel so you can get a response immediately, and wires `artifacts`, `traceability`, and `context.identityPath` to the scaffolded paths.
- **`IDENTITY.md`** — the purpose-derived Role, boundaries, and a Knowledge section that references any `AGENTS.md`, `CLAUDE.md`, `README.md`, or `SOUL.md` already present in the folder. See [Identity and Soul](/context/identity-and-soul/).
- **`skills/mono-agent-configure` and `skills/mono-agent-memory`** — versioned project-local skills selected with index disclosure. `ReadSkill` loads their bodies only when needed. `skills/.mono-agent-managed.json` records their hashes for safe drift checks and updates.
- **`.mono-agent/`** — working directories: `.mono-agent/artifacts` (run output) and `.mono-agent/workspace`.

The generated config (with canonical `--fallback` routes and `--memory bujo`) looks like this — note that `tools.allowedTools` defaults to allow-all (`["*"]`), and the `bujo` tier scaffolds its embeddings, capture LLM, and recall tool:

```json
{
  "agent": { "name": "Research Companion" },
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbacks": [
      { "model": "claude:claude-sonnet-5", "effort": "xhigh" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "per-route-native",
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["mono-agent-configure", "mono-agent-memory"],
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
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5" },
    "llm": { "provider": "agent-host", "model": "pi:openai-codex:gpt-5.6-terra" },
    "recallTool": { "enabled": true }
  }
}
```

Every field has a `MONO_AGENT_*` env override (env > JSON > defaults) — for example `MONO_AGENT_NAME`, `MONO_AGENT_MODEL`, and `MONO_AGENT_FALLBACKS_JSON`. See [Configuration](/config/) for the annotated blueprint. The scaffolder also adds an `artifacts.retention` block and a `$schema` reference, omitted here for brevity.

For selected channel secrets, the guided wizard never shows values in config, examples, review output, or logs. Existing non-empty dotenv assignments/comments are preserved. A shell-only selected secret does not skip the masked prompt because a later background start cannot inherit that shell; the entered value must match any exported or persisted copy before the wizard writes a missing value. Durable provider keys already present in `.env` go through the same secure preflight even when the plan has no channel secret. On POSIX the canonical agent directory must be current-user-owned and not group/world-writable, while existing `.env` and `.gitignore` files must be current-user-owned single-link regular files. The env is written or tightened to owner-only (`0600`) under an external lock, the ignore guard loses group/world write access, and promotion is pathname no-clobber with exact rules for `.env` plus transaction artifacts. Pathname competitors stay at the target. The claimed inode is rechecked; detected writes through an already-open descriptor are retained at a printed owner-only recovery path, while a non-cooperative write after the final check remains outside the POSIX guarantee. Automatic persistence refuses tracked, symlinked, hard-linked, or foreign-owned files, malformed/conflicting dotenv, unrepresentable values, stale locks, concurrent changes, and platforms such as Windows where owner-only protection cannot be verified. Follow the printed manual instructions; never copy `.env.example` over an already populated `.env`.

## 2. Continue in the local TUI (`cli`)

After a successful guided readiness proof, init opens this mode automatically:

```bash
mono-agent tui --local --configure
```

`--local` builds the current folder's responder in-process; it does not discover a daemon or create launchd state. The first recorded agent turn asks how you would like to configure it further. The bundled skills can prepare one minimal RFC 6902 proposal, but the model cannot apply it: the host validates the candidate against the effective environment, shows a separate approval card, and writes only after your TUI confirmation. `/configure` re-enters this mode later. Giving an ordinary task consumes and exits the pending configuration invitation.

The conversational patch surface is intentionally small: public name; effort, turn/session UX; selected project skills and disclosure; memory size or MemoryRecall enablement; semantic tool-policy tightening; and the separately validated Role body. Paths, memory tier/capture behavior, secrets, model/provider or runtime-permission changes, external MCP servers/plugins, channels and cron/proactive jobs, exporters or embeddings/LLM endpoints, sandbox/network policy, and unknown future fields are refused here and handed to the existing explicit setup flow. Approved changes run under an owner-only transaction lock, stage and fsync replacements before a final non-yielding source comparison plus rename, reject symlink-parent escapes, retain a local rollback change id, reload after the response settles, and start a fresh provider conversation.

## 3. Validate (`cli`)

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

Fix every `[error]` section. Standalone `validate` keeps `waiting` non-fatal for operators intentionally starting partial configurations, so exit `0` means structurally valid, not that every selected capability is live. The guided wizard's **Agent ready** gate is stricter: no selected expectation may be waiting, and every selected runtime route must have succeeded in its exact live check. Read-only `codex login status` / `claude auth status --json` is credential detection, not a model-turn claim. Hidden memory and static-trigger dependencies are also validated.

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

## 4. Start (`cli`, optional)

```bash
mono-agent start
```

This boots the runtime and every enabled channel. The webhook channel listens on loopback (`127.0.0.1`) and, because the default `port` is `0`, picks a free port. `start` prints the resolved webhook **invoke URL** — copy it for the smoke test below.

On macOS, `mono-agent start` backgrounds the agent with launchd and returns. On other platforms, use `mono-agent start --foreground`.

## 5. Smoke-test with curl

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
