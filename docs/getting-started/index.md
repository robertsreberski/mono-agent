---
title: "Getting Started"
nav_order: 2
has_children: true
---

# Getting Started

This section takes you from an empty folder to a running agent. mono-agent is config-first: you describe one agent in a `mono-agent.config.json`, then drive it with the `mono-agent` CLI. Work through the three pages below in order.

## The path

1. **Install** — get the CLI and scaffold a project.
2. **Quickstart** — write a minimal config and run your first turn.
3. **Concepts** — understand the moving parts so the rest of the docs make sense.

## Pages

| Page | What it covers |
| --- | --- |
| [Install](install.md) | Install the `mono-agent` CLI, scaffold a new project with `mono-agent init`, and confirm your toolchain is ready. |
| [Quickstart](quickstart.md) | Author a minimal `mono-agent.config.json`, validate it, and run your first agent turn end to end. |
| [Concepts](concepts.md) | The core model — agent, runtime, channels, tools, memory, and context — and how config maps onto them. |

## Where to go next

Once your agent runs, branch out by topic:

- [Configuration](../config/index.md) — the full annotated config blueprint, environment variables, and folder layout.
- [Runtime](../runtime/index.md) — model backends, fallback chains, sessions, and execution effort.
- [Channels](../channels/index.md) — connect Telegram, Slack, WhatsApp, webhooks, the OpenAI-compatible API, A2A, and cron.
- [Programmatic](../programmatic/index.md) — for capabilities that are code-only rather than config-driven.

Every capability in mono-agent carries a coverage type — **config**, **cli**, **auto**, **code**, or **dev** — so you always know whether to reach for the config file, a CLI command, or the SDK. The [feature matrix](../reference/feature-matrix.md) is the canonical map.
{: .note }
