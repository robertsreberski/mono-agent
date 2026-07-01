---
title: "Configuration"
sidebar:
  order: 0
---

# Configuration

A mono-agent is declared by a single `mono-agent.config.json` in the agent folder. This page covers how that file is structured, what is required versus optional, and how environment variables override it. The full annotated config lives in [Blueprint](/config/blueprint/); the canonical key map is the [Feature Matrix](/reference/feature-matrix/).

## The one config file

Everything about an agent — its model, channels, memory, tools, sandbox, and observability — is declared in one JSON file. Paths inside it are resolved relative to the folder that contains it. Scaffold one with the CLI:

```bash
mono-agent init --model claude:claude-sonnet-4-6
```

A minimal valid config has exactly two fields:

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "context": { "identityPath": "./IDENTITY.md" }
}
```

`runtime.model` selects the backend (`claude:*`, `codex:*`, `pi:<provider>:<model>`, `opencode:*`) and `context.identityPath` points at the agent's identity markdown. **Every other section is optional and opt-in** — omit a section and that capability is simply off. See [Runtime](/runtime/) and [Identity & Soul](/context/identity-and-soul/) for these two.

## Precedence: env > JSON > defaults

Resolution order is fixed everywhere:

1. **Process environment** — a `MONO_AGENT_*` variable always wins.
2. **`mono-agent.config.json`** — the declared value.
3. **Built-in default** — used when neither of the above is set.

Every config key has a matching `MONO_AGENT_*` override. For example `runtime.model` is overridden by `MONO_AGENT_MODEL`, and `runtime.effort` by `MONO_AGENT_EFFORT`:

```json
{ "runtime": { "model": "claude:claude-sonnet-4-6", "effort": "medium" } }
```

```bash
# Overrides both fields above without editing the file
export MONO_AGENT_MODEL="pi:openai:gpt-5.5"
export MONO_AGENT_EFFORT="high"
```

A `.env` file in the agent folder is loaded automatically on `start` (exported shell variables still win); use `--env-file <path>` for an alternate file. The full variable list is on [Environment Variables](/config/env-vars/).

:::note
Config is JSON-first: there is no live browser re-apply. Edit the file (agents can edit it themselves) and run `mono-agent restart` to apply changes.
:::

## Sections at a glance

Each top-level key maps to one capability area. All are optional except the two required fields noted above.

| Section | Purpose | Page |
| --- | --- | --- |
| `runtime` | Model, execution mode, effort, sessions, concurrency | [Runtime](/runtime/) |
| `providers` | Local/self-hosted providers, Pi OAuth, pi-native tuning | [Local Providers](/runtime/local-providers/) |
| `context` | Identity, soul, selected skills | [Context Assembly](/context/assembly/) |
| `memory` | Tiered memory (lite/journal/bujo), embeddings, rituals | [Capture & Recall](/memory/capture-and-recall/) |
| `tools` | Fail-closed allow/deny policy, MCP servers | [Tool Policy](/tools/policy/), [MCP](/tools/mcp/) |
| `sandbox` | Filesystem/network sandboxing for runtime commands | [Sandbox](/tools/sandbox/) |
| `artifacts`, `traceability`, `observability` | JSONL run artifacts, trace registry, Phoenix exporter | [Observability](/observability/) |
| `telegram`, `slack`, `whatsapp` | Chat channels (opt-in via `enabled`) | [Channels](/channels/) |
| `webhook`, `openaiApi`, `a2a`, `cron` | HTTP, OpenAI-compatible, agent-to-agent, scheduled | [Channels](/channels/) |

Every channel section is independent. An unconfigured channel reports `waiting_for_config` (or `disabled` when `enabled` is false) and never blocks the others.

## Coverage types

The [Feature Registry](/reference/feature-matrix/) tags each capability so you know how to reach it:

| Type | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json` (env override always available) |
| `cli` | Reached through a `mono-agent` CLI flag/command |
| `auto` | Always active when the app runs; needs no declaration |
| `code` | Programmatic escape hatch only — intentional |
| `dev` | Development/test tooling, not part of a running agent |

:::tip
A handful of capabilities are `code`-only — for example structured output schemas, tool approval gates, live input steering, and custom runtimes/channels. These are not expressible in JSON; reach them through `startMonoAgentApp` / `createConfiguredAgentResponder`. See [Programmatic Composition](/programmatic/).
:::

## Validate before you run

`mono-agent validate` prints a per-section report — **secret placement**, runtime, **provider credentials** (Pi OAuth token presence/expiry for every referenced model), context, memory, tools, sandbox, observability, and every channel — and exits 0 only when the config is ready to start. The provider-credentials check is static and read-only, flagging a keyless or expired-OAuth provider as `waiting` with a `pi auth login <provider>` hint; see [CLI reference → Provider credentials](/observability/cli-reference/#provider-credentials):

```bash
mono-agent validate
mono-agent start     # traceability + every configured channel
```

On `start`, each channel prints one status line: `running` with its endpoint facts, `waiting_for_config` with the exact missing setting, `disabled`, or `failed` with the reason.

:::note
The **secret placement** section is advisory and non-fatal: it surfaces a `waiting` warning when a secret-marked field is resolved from the committed `mono-agent.config.json` instead of `.env`, naming the `MONO_AGENT_*` variable to move it to. It covers core secrets (e.g. `memory.embeddings.apiKey`) and every channel credential (`telegram.botToken`, `slack.botToken`/`slack.appToken`, `openaiApi.apiKey`, the A2A bearer tokens). The secret value is never printed, and the warning never blocks `start`. The same warnings are also emitted by `mono-agent config`, which additionally shows every channel section field-by-field with the same `[env]`/`[json]`/`[default]` provenance as the core sections. See [Environment Variables](/config/env-vars/) for the variable map.
:::

## Related pages

- [Blueprint](/config/blueprint/) — the full annotated `mono-agent.config.json`.
- [Environment Variables](/config/env-vars/) — the complete `MONO_AGENT_*` map.
- [Folder Layout](/config/folder-layout/) — files and directories around the config.
- [Feature Matrix](/reference/feature-matrix/) — canonical capability → config key reference.
