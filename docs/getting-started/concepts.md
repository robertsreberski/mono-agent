---
title: "Core Concepts"
parent: "Getting Started"
nav_order: 3
---

# Core Concepts

This page defines the mental model behind mono-agent: one config file, one responder, many channels, opt-in everything, and fail-closed defaults. Read it once and the rest of the docs will line up.

## Config-first

A mono-agent is fully described by a single `mono-agent.config.json` in the agent folder. There is no admin UI and no live re-apply: you (or an agent) edit the JSON, then run `mono-agent restart` to load the new config.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  }
}
```

```bash
mono-agent restart          # apply config edits
mono-agent restart --force  # apply AND purge persisted pi sessions (fresh start; durable memory kept)
```

Because the config is plain JSON, agents can edit their own config and restart themselves. Most capabilities are coverage type **config** — set a key, restart, done. A few are **cli** (run a command), **auto** (default behavior), **code** (only available programmatically — see [Programmatic](../programmatic/index.md)), or **dev** (test-time tooling).

The full annotated config lives in [Configuration → Blueprint](../config/blueprint.md), and folder conventions in [Folder Layout](../config/folder-layout.md).

## One responder, many channels

There is exactly one agent responder — the thing that turns an incoming prompt into a reply using your `runtime` model, tools, context, and memory. Channels are independent transports that feed prompts into that same responder and deliver its output:

| Channel | Section | Transport |
| --- | --- | --- |
| Telegram | `telegram` | long-polling bot |
| Slack | `slack` | Socket Mode bot |
| WhatsApp | `whatsapp` | Baileys socket (QR login) |
| Webhook | `webhook` | HTTP POST, sync/async |
| OpenAI API | `openaiApi` | OpenAI-compatible `/v1/chat/completions` |
| A2A | `a2a` | Agent-to-Agent provider |
| Cron | `cron` | scheduled prompts |

Each channel is its own JSON section and runs independently — one failing or waiting on config never blocks the others. See [Channels](../channels/index.md) for per-channel setup.

## Opt-in `enabled` and the four channel statuses

Every channel is **off by default**. You turn one on with its `enabled` flag:

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "123456:ABC-...",
    "allowedChatIds": ["123456789"]
  }
}
```

When you run `mono-agent start`, each channel prints exactly one status line:

| Status | Meaning |
| --- | --- |
| `disabled` | `enabled` is false (or unset). The channel does nothing. |
| `waiting_for_config` | Enabled but a required setting is missing. The start line names the exact missing field. |
| `running` | Enabled and configured; the line shows its endpoint facts. |
| `failed` | Enabled and configured but it could not start; the line shows the reason. |

An enabled-but-incomplete channel reports `waiting_for_config` rather than crashing the process — the rest of the agent keeps serving.

{: .note }
There is no "off but configured" trap: a channel with `enabled: false` reports `disabled` even if every other field is filled in.

## Fail-closed defaults

mono-agent ships locked down. You opt into capability; nothing dangerous is on by default.

- **No tools.** An empty `tools.allowedTools` means the agent has zero tools. You list the built-ins you want explicitly (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`). Deny wins over allow.

  ```json
  {
    "tools": {
      "allowedTools": ["Read", "Grep"],
      "disallowedTools": ["Bash"]
    }
  }
  ```

  See [Tools → Policy](../tools/policy.md).

- **No memory writes.** `memory.writeMode` defaults to `disabled` — the agent records nothing until you choose `append-host-summary` or (bujo only) `capture`. See [Memory → Capture and Recall](../memory/capture-and-recall.md).

- **Loopback-only network.** HTTP channels (`webhook`, `openaiApi`, `a2a`) bind to localhost and refuse non-loopback callers until you set `allowNonLoopback: true`. The native sandbox likewise starts with network `mode: "none"` and a deny-by-default filesystem (`.env*`, `.git/config`, `.git/hooks/**` are denied even when you widen the roots). See [Tools → Sandbox](../tools/sandbox.md).

{: .warning }
Channels and tools also enforce their own destination allowlists (e.g. `telegram.allowedChatIds`, `slack.allowedChannelIds`). An empty allowlist with `allowAll*` left off means the agent will not act on anyone — that is the intended fail-closed behavior, not a bug.

## Configuration precedence: env > JSON > defaults

Every config key has a matching `MONO_AGENT_*` environment variable. Resolution order, everywhere:

1. **Process environment** (`MONO_AGENT_*`) — highest priority.
2. **`mono-agent.config.json`** — the JSON value.
3. **Built-in default** — used when neither is set.

So `MONO_AGENT_MODEL=pi:openai:gpt-5.5` overrides `runtime.model` in the JSON for that process. A `.env` file in the agent folder is loaded automatically (exported shell variables still win); use `--env-file <path>` for an alternate file.

| Config key | Env var |
| --- | --- |
| `runtime.model` | `MONO_AGENT_MODEL` |
| `tools.allowedTools` | `MONO_AGENT_ALLOWED_TOOLS` |
| `memory.writeMode` | `MONO_AGENT_MEMORY_WRITE_MODE` |
| `telegram.enabled` | `MONO_AGENT_TELEGRAM_*` |

The complete key → env mapping is in [Configuration → Env Vars](../config/env-vars.md).

## Where to go next

- [Configuration](../config/index.md) — the keys and their defaults.
- [Channels](../channels/index.md) — turn on a transport.
- [Reference → Glossary](../reference/glossary.md) — terms used across these docs.
