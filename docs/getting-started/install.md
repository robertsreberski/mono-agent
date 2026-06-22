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
| pnpm | `>=10` | Only needed to build the workspace from source (the published packages install with plain `npm`/`npx`). |

:::note
:::
You do **not** need pnpm to use the published packages — `npm i -g` and `npx` are enough. pnpm is only required for the "run an unreleased build" path below, which builds the workspace from source.

## Install the CLI

Install `@mono-agent/agent-app` globally to get the `mono-agent` command on your `PATH`:

```bash
npm i -g @mono-agent/agent-app
```

This also installs the `mono-agent-memory-recall` helper bin used by the memory recall tool. Prefer not to install globally? Run any command through `npx` instead:

```bash
npx @mono-agent/agent-app --help
```

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

Then continue with the [Quickstart](/getting-started/quickstart/). For the full key reference, see [Config Blueprint](/config/blueprint/) and [Environment Variables](/config/env-vars/).

## Run an unreleased build

To run against unreleased changes (e.g. a feature branch), build the workspace from source and point `mono-agent` at the built CLI entry. This is the only path that needs pnpm `>=10`.

```bash
git clone https://github.com/<owner>/mono-agent.git
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
:::
Rebuild (`pnpm run build`) after pulling new changes — the alias points at compiled output in `dist/`, not the TypeScript sources, so edits are not picked up until you rebuild. Cross-package types and tests resolve against built `dist/`, so a stale build can mask or surface errors that do not match `src`.

:::tip
:::
Editable global link instead of an alias? After `pnpm run build`, run `npm link` from `packages/agent-app` (and `packages/tui`) to put the local bins on your `PATH`. You still rebuild after each change.
