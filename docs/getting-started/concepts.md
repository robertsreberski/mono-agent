---
title: "Core Concepts"
sidebar:
  order: 3
---

# Core Concepts

This page defines the mental model behind mono-agent: one config file, one responder, many channels, opt-in everything, and safe defaults (an open tool surface, but locked-down side effects). Read it once and the rest of the docs will line up.

## Config-first

A mono-agent is fully described by a single `mono-agent.config.json` in the agent folder. There is no admin UI and no live re-apply: you (or an agent) edit the JSON, then run `mono-agent restart` to load the new config.

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.5"
  }
}
```

```bash
mono-agent restart          # apply config edits
mono-agent restart --force  # apply AND purge persisted pi sessions (fresh start; durable memory kept)
```

Because the config is plain JSON, agents can edit their own config and restart themselves. Most capabilities are coverage type **config** — set a key, restart, done. A few are **cli** (run a command), **auto** (default behavior), **code** (only available programmatically — see [Programmatic](/programmatic/)), or **dev** (test-time tooling).

The full annotated config lives in [Configuration → Blueprint](/config/blueprint/), and folder conventions in [Folder Layout](/config/folder-layout/).

## One responder, many channels

There is exactly one agent responder — the thing that turns an incoming prompt into a reply using your `runtime` model, tools, context, and memory. Channels are independent transports that feed prompts into that same responder and deliver its output:

| Channel | Section | Transport |
| --- | --- | --- |
| Telegram | `telegram` | long-polling bot |
| Slack | `slack` | Socket Mode bot |
| WhatsApp | `channels.plugins[]` (`@mono-agent/whatsapp-adapter`) | Baileys socket (QR login) |
| Webhook | `webhook` | HTTP POST, sync/async |
| OpenAI API | `openaiApi` | OpenAI-compatible `/v1/chat/completions` |
| A2A | `channels.plugins[]` (`@mono-agent/a2a-adapter`) | Agent-to-Agent provider |
| Cron | `cron` | scheduled prompts |

Each channel is its own JSON section and runs independently — one failing or waiting on config never blocks the others. See [Channels](/channels/) for per-channel setup.

## Opt-in `enabled` and the five channel statuses

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
| `degraded` | Was running, but the live transport hit a transient failure (e.g. the Telegram poller crashed on a network switch / `ENETUNREACH`). The channel owns its own recovery, so the responder/harness stays alive and keeps serving while the transport restarts; the line shows `degraded: <reason>` with a warning badge. It flips back to `running` once the restarted transport stays up. |
| `failed` | Enabled and configured but it could not start (or hit a fatal error); the line shows the reason. Unlike `degraded`, this is terminal — the responder is disposed and there is no auto-restart. |

An enabled-but-incomplete channel reports `waiting_for_config` rather than crashing the process — the rest of the agent keeps serving. A `degraded` channel is non-fatal too: it is still serving and self-recovering, distinct from a `failed` channel.

:::note
There is no "off but configured" trap: a channel with `enabled: false` reports `disabled` even if every other field is filled in.
:::

## Safe defaults

mono-agent ships with an open tool surface but locked-down side effects: the model can *use* tools, but it can't persist memory, reach the network, or message anyone until you opt in.

- **Allow-all tools, deny-wins.** Omit `tools.allowedTools` (or set `["*"]`) and the agent can call every built-in (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`) and every enabled channel's send tools. Narrow with a specific list, subtract a single tool with `disallowedTools` (deny wins), or go chat-only with an explicit `tools.allowedTools: []`.

  ```json
  {
    "tools": {
      "allowedTools": ["*"],
      "disallowedTools": ["Bash"]
    }
  }
  ```

  See [Tools → Policy](/tools/policy/).

- **No memory writes.** `memory.writeMode` defaults to `disabled` — the agent records nothing until you choose `append-host-summary` or (bujo only) `capture`. See [Memory → Capture and Recall](/memory/capture-and-recall/).

- **Loopback-only network.** HTTP channels (`webhook`, `openaiApi`, and the A2A plugin) bind to localhost and refuse non-loopback callers until you set `allowNonLoopback: true`. The native sandbox likewise starts with network `mode: "none"` and a deny-by-default filesystem (`.env*`, `.git/config`, `.git/hooks/**` are denied even when you widen the roots). See [Tools → Sandbox](/tools/sandbox/).

:::caution
:::
Channels and tools also enforce their own destination allowlists (e.g. `telegram.allowedChatIds`, `slack.allowedChannelIds`). An empty allowlist with `allowAll*` left off means the agent will not act on anyone — that is the intended fail-closed behavior, not a bug.

## Configuration precedence: env > JSON > defaults

Every config key has a matching `MONO_AGENT_*` environment variable. Resolution order, everywhere:

1. **Process environment** (`MONO_AGENT_*`) — highest priority.
2. **`mono-agent.config.json`** — the JSON value.
3. **Built-in default** — used when neither is set.

So `MONO_AGENT_MODEL=pi:opencode-go:kimi-k2.6` overrides `runtime.model` in the JSON for that process. A `.env` file in the agent folder is loaded automatically (exported shell variables still win); use `--env-file <path>` for an alternate file.

| Config key | Env var |
| --- | --- |
| `runtime.model` | `MONO_AGENT_MODEL` |
| `tools.allowedTools` | `MONO_AGENT_ALLOWED_TOOLS` |
| `memory.writeMode` | `MONO_AGENT_MEMORY_WRITE_MODE` |
| `telegram.enabled` | `MONO_AGENT_TELEGRAM_*` |

The complete key → env mapping is in [Configuration → Env Vars](/config/env-vars/).

## Where to go next

- [Configuration](/config/) — the keys and their defaults.
- [Channels](/channels/) — turn on a transport.
- [Reference → Glossary](/reference/glossary/) — terms used across these docs.
