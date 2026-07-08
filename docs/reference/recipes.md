---
title: "Presets & capability modules"
sidebar:
  order: 5
---

# Presets & capability modules

`mono-agent init` builds an agent by composing **capability modules** — a channel here, a memory tier there, an optional sandbox — and walking you through the settings that matter. Crucially it walks you through the **tool allowlist**, so you don't end up with an agent that can technically run but can't actually _do_ anything. On a terminal with no flags, `init` is a step-by-step wizard; with `--yes` or any flag (or when stdin is not a TTY) it writes a scaffold non-interactively. Existing files are never overwritten.

**Presets** are saved answer-sets for common shapes. A preset seeds the model, channels, memory, sandbox, and observability choices; the composer fills the rest and recomputes the recommended tool selection, so a preset is just a faster starting point on the same single config-generation path.

## Commands

```bash
mono-agent init                              # interactive wizard (preset or custom), then validate
mono-agent init --preset <id> --yes          # scaffold from a preset, non-interactively
mono-agent presets list                      # the built-in presets with risk levels
mono-agent presets show <id>                 # generated config + .env.example + checklist
mono-agent validate --preset <id>            # completeness report against the preset's promises
```

The wizard first asks whether to start from a preset or go fully custom, then prompts for model, channels (multiselect), memory, **tools** (multiselect, pre-checked with a safe default and your channels' send tools), sandbox (only when shell/file tools are in play), observability, and a final review before writing. `--dry-run` previews the files without writing them.

## Presets

Each preset maps to a copy-paste [playbook](/playbooks/) that walks the same setup end-to-end with credentials and a smoke test.

| Preset | What you get | Risk | Playbook |
| --- | --- | --- | --- |
| `starter` | Webhook loopback, no credentials, no memory — the lowest-friction smoke agent. | low | [Webhook automation](/playbooks/webhook-automation-sync-async/) |
| `telegram-assistant` | A Telegram bot with daily-log capture + semantic recall (BuJo memory). | medium | [Telegram personal assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `telegram-supermemory` | A Telegram bot backed by an external Supermemory server. | medium | [Telegram + Supermemory](/playbooks/telegram-supermemory-memory/) |
| `slack-bot` | A Socket-Mode Slack bot scoped to a channel allowlist, with the send tool. | medium | [Slack team bot](/playbooks/slack-team-bot-mcp-tools/) |
| `local-private` | Runs entirely on a local Ollama provider with journal memory — no remote calls. Light 8B default for a fast first turn. | low | [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) |
| `code-sandbox` | Native `srt` sandbox with workspace-only filesystem and code tools; fails closed without `srt`. | medium | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |

Risk levels reflect blast radius, not difficulty: `low` presets expose nothing beyond loopback and need at most a model key; `medium` presets talk to external services, hold channel credentials, or run shell/file tools you should read before running.

## Capability modules

The wizard composes an agent from these modules. Selecting one auto-checks its recommended tools in the tools step (see below), so the agent can actually use the capability. Module ids are what `--with`, presets, and the composer reference internally.

| Module | What it adds | Recommends tools |
| --- | --- | --- |
| `channel:webhook` | HTTP loopback endpoint — the zero-credential smoke channel. | — |
| `channel:telegram` | Chat with your agent via a Telegram bot (chat-id allowlist). | `TelegramSendMessage`, `TelegramAskButtons` |
| `channel:slack` | Socket-Mode Slack bot scoped to a channel allowlist. | `SlackSendMessage` |
| `channel:openai-api` | Expose the runtime as an OpenAI-compatible loopback endpoint. | — |
| `channel:cron` | Run the agent on a schedule; scaffolds `cron/digest.md`. | — |
| `channel:a2a` | Expose the agent over A2A (Agent Card + provider endpoint). | — |
| `memory:lite` | SQLite full-text recall, zero external dependencies. | — |
| `memory:journal` | Semantic recall via local Ollama embeddings. | — |
| `memory:bujo` | Daily-log capture plus semantic recall (needs Ollama). | — |
| `memory:supermemory` | External Supermemory instance for server-side extraction + recall. | — |
| `sandbox` | Native `srt` sandbox: workspace-only FS, localhost network, fails closed. | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash` |
| `observability:phoenix` | Best-effort Phoenix OTLP export, sensitive data excluded. | — |

### The tools step and the no-tools guardrail

The tools multiselect is the step that keeps you out of the "no-tools trap". It is pre-checked with a safe read-only default (`Read`, `Glob`, `Grep`) plus every selected module's recommended tools — for example a Telegram channel pre-checks `TelegramSendMessage`/`TelegramAskButtons`, and the sandbox pre-checks the code tools. Two kinds of tools are **not** gated by this list and are never shown: memory recall (auto-provisioned from `memory.recallTool.enabled`) and MCP-server tools (`mcp__…`, owned by their servers).

Deselect everything and the wizard warns loudly — "⚠ Zero tools selected — the agent will be chat-only" — and makes you confirm before continuing. The same guardrail runs after the fact: an empty `tools.allowedTools` reports `waiting` in [`validate`/`doctor`](/observability/cli-reference/#validate) (never a silent `ok`) with:

```text
No tools allowed — the agent can chat but cannot read files, run commands, or send
proactive messages. Add names to tools.allowedTools (e.g. Read, Glob, Grep), or re-run
`mono-agent init` in an empty folder to pick tools interactively.
```

`validate`/`doctor` also flag an **unknown tool name** with a "did you mean" hint (e.g. `read` → `Read`; pi silently drops unknown names), and cross-check adapter **send tools against channels** — a `TelegramSendMessage` in the allowlist with Telegram disabled downgrades the tools section to `waiting` with a note; the reverse — a channel enabled with no matching send tool — is a non-fatal hint (the section stays `ok`: replies still work, but the agent can't send proactively).

## Sandbox

The `sandbox` module (and the `code-sandbox` preset) generate `"sandbox": { "mode": "native" }`, which requires `srt` on `PATH`. Check the engine before trusting the sandbox:

```bash
command -v srt
srt --version
mono-agent validate --preset code-sandbox
```

The composed sandbox sets `fallback: "fail-closed"`. If `srt` is unavailable, sandboxed commands stop with `sandbox_unavailable`; they do not quietly run as normal host processes. `mono-agent validate --preset code-sandbox` checks the preset's sandbox promise against the doctor report — a missing `srt` engine shows the `Sandbox` section as `waiting` and the preset block as incomplete.

`mono-agent start` and `mono-agent status` surface the effective sandbox state (`native`, `blocked`, `unsafe-host-process`, or `off`), the engine availability, the fallback, and whether the fallback is active. The intentionally-unsafe `unsafe-host-process` fallback (roots/denyWrite inert, commands run unsandboxed when `srt` is missing) is not a wizard choice — set `sandbox.fallback` explicitly in the JSON if you accept that consequence for a trusted local operator profile. Existing configs are never rewritten.

## How presets relate to the config

A preset is not a separate format — `mono-agent presets show <id>` prints the exact `mono-agent.config.json` it would write, plus the `.env.example` and follow-up checklist. Everything a preset (or the wizard) configures can be edited afterwards like any hand-written config, and [`mono-agent config`](/observability/cli-reference/#config) shows the resolved result field-by-field with provenance. The preset catalog lives in `packages/agent-app/src/wizard/presets.ts` and the module catalog in `packages/agent-app/src/modules/catalog.ts`; a parity test (`presets-docs-parity.test.ts`) keeps this page in sync with them.

## Deprecations

The old recipe surface still works, mapped forward:

- `mono-agent recipes list | show <id>` → alias of `mono-agent presets list | show <id>`.
- `mono-agent setup` → alias of `mono-agent init`.
- `mono-agent init --recipe <id>` and `mono-agent validate --recipe <id>` → the deprecated `--recipe` flag maps to the preset that replaced the recipe (with a deprecation notice), so `minimal-webhook` → `starter`, `personal-telegram-bujo` → `telegram-assistant`, `personal-telegram-supermemory` → `telegram-supermemory`, `slack-team-bot` → `slack-bot`, `local-ollama-private` → `local-private`, and `sandboxed-code-agent` → `code-sandbox`. The `local-lmstudio-private` recipe is retired (mapping it onto the Ollama-based `local-private` preset would silently swap the engine and memory tier); reach LM Studio via `mono-agent init --model pi:lmstudio:<id>`, which auto-adds the `provider:lmstudio` module, or the wizard's "Other…" model choice.

The fully-retired blueprints — `full-safe`, `full-local-power`, `openai-api-gateway`, `cron-digest`, `a2a-provider`, and `phoenix-observed` — have no replacement preset. `--recipe` errors with a pointer to the wizard, because each is now either a single wizard choice (enable the `channel:openai-api`, `channel:cron`, `channel:a2a`, or `observability:phoenix` module) or a hand-assembled config the [composer skill](/context/skills/) builds from the capability modules and [playbooks](/playbooks/).
