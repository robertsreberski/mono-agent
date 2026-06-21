---
title: "Agent folder layout"
parent: "Configuration"
nav_order: 3
---

# Agent folder layout

A mono-agent lives in a single folder. One [`mono-agent.config.json`](blueprint.md) declares the whole agent; the rest of the tree is author-edited markdown (identity, skills, scheduled prompts) plus a `.mono-agent/` runtime directory the framework writes and manages for you. All paths in the config are relative to this folder, and every field also has a `MONO_AGENT_*` env var that overrides it (env > JSON > defaults).

## The tree

```text
my-agent/
  mono-agent.config.json   # the single agent declaration (runtime, channels, memory, tools...)
  IDENTITY.md              # role, boundaries, references to existing knowledge (required)
  SOUL.md                  # optional: voice/persona/values layered on top of IDENTITY
  skills/                  # optional: <skill-name>/SKILL.md per selected skill
  cron/                    # optional: <job-id>.md scheduled prompts (frontmatter + body)
  webhook/                 # optional: <name>.md per-endpoint webhook prompts (frontmatter + body)
  mcp.json                 # optional: MCP server definitions
  .env                     # optional: secrets; auto-loaded by the CLI, never committed
  .mono-agent/             # framework-managed runtime state (gitignore this)
    artifacts/             # JSONL run summaries + events (local traceability fallback)
    workspace/             # runtime working directory (when not ".")
    memory/                # journal/bujo memory root (daily notes, graph.jsonl, index/)
    whatsapp-auth/         # Baileys auth state (WhatsApp channel only)
    sessions/              # durable pi sessions → resume across restarts
    trace-sources/         # traceability registry (when kept folder-local)
```

Only `runtime.model` and `context.identityPath` are required; omit any other section to leave that capability off. Scaffold a new folder with `mono-agent init` (coverage: cli) and validate it with `mono-agent validate` (coverage: cli) — see [CLI reference](../observability/cli-reference.md).

## Author-edited files

These are the inputs you write by hand (or let an agent edit). They are the source of truth and belong in version control.

| Path | Holds | Config key | Coverage |
|------|-------|------------|----------|
| `mono-agent.config.json` | The entire agent declaration — runtime, channels, memory, tools, observability. | (the file itself) | config |
| `IDENTITY.md` | The agent's role, boundaries, and pointers to existing knowledge. Required. | `context.identityPath` | config |
| `SOUL.md` | Optional voice/persona/values layer assembled on top of identity. | `context.soulPath` | config |
| `skills/<name>/SKILL.md` | One folder per selected skill; each `SKILL.md` is progressively disclosed at runtime. | `context.skillsRoot` / `context.selectedSkills` | config |
| `cron/<id>.md` | A scheduled prompt: YAML frontmatter (schedule, timezone) plus the prompt body. | `cron.dir` (default `cron`) | config |
| `webhook/<name>.md` | A per-endpoint webhook prompt prepended to incoming request text: frontmatter plus body. | `webhook` | config |
| `mcp.json` | External MCP server definitions, referenced from the config. | `tools.mcpServers` / `mcpConfigPath` | config |
| `.env` | Secrets (tokens, API keys) auto-loaded by the CLI on `start`. | (env override layer) | config |

For what goes inside each, see [Identity & soul](../context/identity-and-soul.md), [Skills](../context/skills.md), [Cron](../channels/cron.md), [Webhook](../channels/webhook.md), and [MCP](../tools/mcp.md).

The `.env` file in the folder is loaded automatically on `start`; exported shell variables win over it, and `--env-file <path>` selects an alternate file. Keep tokens as placeholders here (`xoxb-...`, `sk-...`) and never commit real secrets.
{: .warning }

## The `.mono-agent/` runtime directory

The framework creates and writes everything under `.mono-agent/`. You generally do not edit these files; add the whole directory to `.gitignore`.

| Path | Holds | Config key |
|------|-------|------------|
| `.mono-agent/artifacts/` | JSONL run summaries and events — the always-on local traceability fallback. | `artifacts.dir` |
| `.mono-agent/workspace/` | The runtime working directory, when `runtime.workspace` is not `"."`. | `runtime.workspace` |
| `.mono-agent/memory/` | Memory substrate root: daily notes, `graph.jsonl`, and the search index. | `memory.path` |
| `.mono-agent/whatsapp-auth/` | Baileys auth state, written only when the WhatsApp channel is enabled. | (WhatsApp channel) |
| `.mono-agent/sessions/` | Durable pi sessions (JSONL) so conversations resume across restarts; unset = in-memory only. | `providers.piNative.piSessionsRoot` |
| `.mono-agent/trace-sources/` | The traceability registry, when kept folder-local. | `traceability.registryDir` |

`mono-agent restart --force` purges the persisted pi `sessions/` for a fresh start while keeping durable memory. See [Sessions & concurrency](../runtime/sessions-concurrency.md), [Artifacts & traces](../observability/artifacts-and-traces.md), and [Capture & recall](../memory/capture-and-recall.md).
{: .note }

## Applying changes

Config is JSON-first: edit `mono-agent.config.json` (or the markdown files) directly and run `mono-agent restart` to apply. There is no live re-apply — `start` prints the active traceability source and one status line per channel (`running`, `waiting_for_config` with the exact missing setting, `disabled`, or `failed`). For the full annotated config, see [Config blueprint](blueprint.md); for the override layer, see [Environment variables](env-vars.md). Behavior not expressible in config needs the [programmatic escape hatch](../programmatic/index.md).
