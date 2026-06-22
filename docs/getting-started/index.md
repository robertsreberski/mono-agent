---
title: "Getting Started"
sidebar:
  order: 0
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
| [Install](/getting-started/install/) | Install the `mono-agent` CLI, scaffold a new project with `mono-agent init`, and confirm your toolchain is ready. |
| [Quickstart](/getting-started/quickstart/) | Author a minimal `mono-agent.config.json`, validate it, and run your first agent turn end to end. |
| [Concepts](/getting-started/concepts/) | The core model — agent, runtime, channels, tools, memory, and context — and how config maps onto them. |

## Where to go next

Once your agent runs, branch out by topic:

- [Configuration](/config/) — the full annotated config blueprint, environment variables, and folder layout.
- [Runtime](/runtime/) — model backends, fallback chains, sessions, and execution effort.
- [Channels](/channels/) — connect Telegram, Slack, WhatsApp, webhooks, the OpenAI-compatible API, A2A, and cron.
- [Programmatic](/programmatic/) — for capabilities that are code-only rather than config-driven.

:::note
Every capability in mono-agent carries a coverage type — **config**, **cli**, **auto**, **code**, or **dev** — so you always know whether to reach for the config file, a CLI command, or the SDK. The [feature matrix](/reference/feature-matrix/) is the canonical map.
:::
