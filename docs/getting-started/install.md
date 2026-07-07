---
title: "Install & Prerequisites"
sidebar:
  order: 1
---

# Install & Prerequisites

This page covers how to install the `mono-agent` CLI (which includes the `mono-agent tui` operator console), the runtime prerequisites you need, and how to run an unreleased build straight from a clone of the repo.

The shipped command line lives in `@mono-agent/agent-app` (the config-first host that reads one `mono-agent.config.json`), and the terminal chat console lives in `@mono-agent/tui`. Both publish under the `@mono-agent/*` scope on npm. For convenience there is also an unscoped **`create-mono-agent`** installer: run it with `npm create mono-agent@latest`, and a global install of it puts the natural `mono-agent` command on your `PATH`. Its bins just delegate to `@mono-agent/agent-app`.

:::note
The bare `mono-agent` npm name isn't ours — npm rejects it as too similar to an unrelated `monoagent` package — so the installer follows npm's `create-*` convention (`create-mono-agent`), which `npm create mono-agent` resolves natively.
:::

## Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `>=20` | Runtime for the CLI, host, and TUI. |
| pnpm | `>=10` | Only needed to build the workspace from source (the published packages install with plain `npm`/`npm exec`). |

:::note
You do **not** need pnpm to use the published packages — `npm i -g` and `npm exec` are enough. pnpm is only required for the "run an unreleased build" path below, which builds the workspace from source.
:::

## Install the CLI

Install the `create-mono-agent` installer globally to get the `mono-agent` command on your `PATH`:

```bash
npm i -g create-mono-agent
```

`create-mono-agent` ships both a `create-mono-agent` and a `mono-agent` bin, each forwarding every command to `@mono-agent/agent-app` (installed alongside it); behaviour is identical. Prefer the scoped host directly? It also puts `mono-agent` on your `PATH` and additionally installs the `mono-agent-memory-recall` helper bin used by the memory recall tool:

```bash
npm i -g @mono-agent/agent-app
```

Not installing globally? Run any command through `npm exec` with either name:

```bash
npm exec --package create-mono-agent -- mono-agent --help
npm exec --package @mono-agent/agent-app -- mono-agent --help
```

## Scaffold without installing

If you only want to create an agent folder, run `init` with `npm create` (or the equivalent `npx`) — no global install needed:

```bash
npm create mono-agent@latest init
# equivalently:
npx create-mono-agent init
```

This downloads and runs the published CLI for that one scaffold command. It does not require a global install or the source-build workspace setup. The scoped equivalent is `npm exec --package @mono-agent/agent-app -- mono-agent init`.

## The TUI console

The operator console is built into the CLI — once an agent is running (`mono-agent start`), open it from **any directory**:

```bash
mono-agent tui
```

It discovers running agents on the machine and gives you live chat with full thinking/tool/telemetry insight, recorded-run replay, and a config view. The underlying `@mono-agent/tui` package also ships a low-level `mono-agent-tui` bin for custom hosts (`--responder` embedded mode, `--url` direct connect):

```bash
npm i -g @mono-agent/tui   # only needed for the standalone bin
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
| `validate` | Validate `mono-agent.config.json` and live checks that can be tested safely before starting. |
| `start` | Start the host for every configured channel (backgrounds on macOS; use `--foreground`/`-f` elsewhere). |
| `restart` / `stop` / `status` / `logs` | Manage the backgrounded instance (macOS). |
| `tui` | Open the operator console and connect to any running agent. |
| `install-skill` | Install a skill into the agent folder. |
| `backfill` | Replay historical runs into observability. |

## Next: scaffold your first agent

Once the binaries are verified, scaffold and validate a clean project folder:

```bash
mkdir my-agent
cd my-agent
mono-agent init
mono-agent validate
```

On a TTY, prefer `mono-agent setup` as the guided alternative: it lets you pick a recipe, answer non-secret prompts (model, fallbacks, channel add-ons), then auto-validates and prints a secrets checklist. It falls back to flag-driven `init` when stdin is not a TTY.

```bash
mono-agent setup
```

Then continue with the [Quickstart](/getting-started/quickstart/) to start the agent and send a webhook request. For the full key reference, see [Config Blueprint](/config/blueprint/) and [Environment Variables](/config/env-vars/).

## Updating

Update global installs with npm:

```bash
npm update -g create-mono-agent     # (or @mono-agent/agent-app)
npm update -g @mono-agent/tui
```

The `create-mono-agent` installer, `@mono-agent/agent-app`, `@mono-agent/tui`, and every other `@mono-agent/*` package release in lockstep at one version — keep any pinned references (scoped or the `create-mono-agent` installer) on the same version.

For reproducible installs or one-shot scaffolds, pin the version explicitly to a published release — use the same version across every `@mono-agent/*` package (pick one from [GitHub Releases](https://github.com/robertsreberski/mono-agent/releases)):

```bash
version=<published-version>
npm i -g "@mono-agent/agent-app@$version" "@mono-agent/tui@$version"
npm exec --package "@mono-agent/agent-app@$version" -- mono-agent init
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

`pnpm run build` builds every package (and the demos) in dependency order. After the build, the CLI entry point is `packages/agent-app/dist/cli.js`. For a literal source-build smoke test from a clean folder, call that entry directly:

```bash
repo=/absolute/path/to/mono-agent
agent_dir=$(mktemp -d)
cd "$agent_dir"
node "$repo/packages/agent-app/dist/cli.js" init --model claude:claude-sonnet-4-6
node "$repo/packages/agent-app/dist/cli.js" validate
```

You can also alias `mono-agent` to the built entry so you can run the local build from anywhere:

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
