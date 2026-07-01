---
title: "Install & Prerequisites"
sidebar:
  order: 1
---

# Install & Prerequisites

This page covers how to install the `mono-agent` CLI and the `mono-agent-tui` console, the runtime prerequisites you need, and how to run an unreleased build straight from a clone of the repo.

The shipped command line lives in `@mono-agent/agent-app` (the config-first host that reads one `mono-agent.config.json`), and the terminal chat console lives in `@mono-agent/tui`. Both publish under the `@mono-agent/*` scope on npm.

## Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `>=20` | Runtime for the CLI, host, and TUI. |
| pnpm | `>=10` | Only needed to build the workspace from source (the published packages install with plain `npm`/`npm exec`). |

:::note
You do **not** need pnpm to use the published packages — `npm i -g` and `npm exec` are enough. pnpm is only required for the "run an unreleased build" path below, which builds the workspace from source.
:::

## Install the CLI

Install `@mono-agent/agent-app` globally to get the `mono-agent` command on your `PATH`:

```bash
npm i -g @mono-agent/agent-app
```

This also installs the `mono-agent-memory-recall` helper bin used by the memory recall tool. Prefer not to install globally? Run any command through `npm exec` instead:

```bash
npm exec --package @mono-agent/agent-app -- mono-agent --help
```

## Scaffold without installing

If you only want to create an agent folder, run `init` through a package runner instead of installing the CLI globally:

```bash
npm exec --package @mono-agent/agent-app -- mono-agent init
```

This downloads and runs the published CLI for that one scaffold command. It does not require a global install or the source-build workspace setup.

## Install the TUI console

The terminal chat + transcript + redacted-config console ships separately in `@mono-agent/tui`, which provides the `mono-agent-tui` bin (coverage type: `cli`):

```bash
npm i -g @mono-agent/tui
```

Point it at the same config the host uses:

```bash
mono-agent-tui --config ./mono-agent.config.json
```

See [TUI](/observability/tui/) for the console walkthrough.

## Verify the install

Confirm both binaries resolve and print their help:

```bash
mono-agent --help
mono-agent-tui --help
```

The CLI exposes these commands (more detail in the [CLI Reference](/observability/cli-reference/)):

| Command | Purpose |
| --- | --- |
| `init` | Non-destructive scaffold of a config, `IDENTITY.md`, and `.mono-agent/`. |
| `setup` | Guided, terminal-native recipe setup (recipe chooser, non-secret prompts, auto-validate, and a secrets checklist) when attached to a TTY; falls back to flag-driven `init` in non-TTY contexts. |
| `recipes` | List executable setup recipes (`list`) or show a recipe's generated config, `.env.example`, and checklist (`show <id>`). |
| `validate` | Validate `mono-agent.config.json` (and resolved secrets) before starting. |
| `start` | Start the host for every configured channel (backgrounds on macOS; use `--foreground`/`-f` elsewhere). |
| `restart` / `stop` / `status` / `logs` | Manage the backgrounded instance (macOS). |
| `install-skill` | Install a skill into the agent folder. |
| `backfill` | Replay historical runs into observability. |

## Next: scaffold your first agent

Once the binaries are verified, scaffold a project folder:

```bash
mono-agent init
```

On a TTY, prefer `mono-agent setup` as the guided alternative: it lets you pick a recipe, answer non-secret prompts (model, fallbacks, channel add-ons), then auto-validates and prints a secrets checklist. It falls back to flag-driven `init` when stdin is not a TTY.

```bash
mono-agent setup
```

Then continue with the [Quickstart](/getting-started/quickstart/). For the full key reference, see [Config Blueprint](/config/blueprint/) and [Environment Variables](/config/env-vars/).

## Updating

Update global installs with npm:

```bash
npm update -g @mono-agent/agent-app
npm update -g @mono-agent/tui
```

Published `@mono-agent/*` packages release in lockstep at one version. Keep `@mono-agent/agent-app`, `@mono-agent/tui`, and any other pinned `@mono-agent/*` package references on the same version; the current package metadata in this repo is `0.4.0`.

For reproducible installs or one-shot scaffolds, pin the version explicitly:

```bash
npm i -g @mono-agent/agent-app@0.4.0 @mono-agent/tui@0.4.0
npm exec --package @mono-agent/agent-app@0.4.0 -- mono-agent init
```

Review published version notes in [GitHub Releases](https://github.com/robertsreberski/mono-agent/releases).

## Run an unreleased build

To run against unreleased changes (e.g. a feature branch), build the workspace from source and point `mono-agent` at the built CLI entry. This is the only path that needs pnpm `>=10`.

```bash
git clone https://github.com/robertsreberski/mono-agent.git
cd mono-agent
pnpm install --frozen-lockfile
pnpm run build
```

`pnpm run build` builds every package (and the demos) in dependency order. After the build, the CLI entry point is `packages/agent-app/dist/cli.js`. Alias `mono-agent` to it so you can run the local build from anywhere:

```bash
alias mono-agent="node /absolute/path/to/mono-agent/packages/agent-app/dist/cli.js"
mono-agent --help
```

For the TUI bin from the same clone, alias `mono-agent-tui` to `packages/tui/dist/bin/mono-agent-tui.js`:

```bash
alias mono-agent-tui="node /absolute/path/to/mono-agent/packages/tui/dist/bin/mono-agent-tui.js"
```

:::caution
Rebuild (`pnpm run build`) after pulling new changes — the alias points at compiled output in `dist/`, not the TypeScript sources, so edits are not picked up until you rebuild. Cross-package types and tests resolve against built `dist/`, so a stale build can mask or surface errors that do not match `src`.
:::

:::tip
Editable global link instead of an alias? After `pnpm run build`, run `npm link` from `packages/agent-app` (and `packages/tui`) to put the local bins on your `PATH`. You still rebuild after each change.
:::
