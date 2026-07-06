---
title: "Getting Started"
sidebar:
  order: 0
---

# Getting Started

This section takes you from an empty folder to a validated agent folder, then to a real model reply once you provide provider credentials. mono-agent is config-first: you describe one agent in a `mono-agent.config.json`, then drive it with the `mono-agent` CLI. Work through the three pages below in order.

## The path

1. **Install** — get the published CLI or build the source CLI.
2. **Quickstart** — scaffold a clean folder, run `mono-agent validate`, then start and smoke-test it when model auth is available.
3. **Concepts** — understand the moving parts so the rest of the docs make sense.

## Pages

| Page | What it covers |
| --- | --- |
| [Install](/getting-started/install/) | Install the `mono-agent` CLI, scaffold a new project with `mono-agent init`, and confirm your toolchain is ready. |
| [Quickstart](/getting-started/quickstart/) | Scaffold a minimal `mono-agent.config.json`, validate it, and run your first agent turn when model auth is available. |
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
