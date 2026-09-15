---
title: "Install & Prerequisites"
description: "Install the mono-agent CLI, start the browser console, or run an unreleased build from source."
sidebar:
  order: 1
---

This page covers the recommended way to install the `mono-agent` CLI, what the browser console needs, and how to run an unreleased build straight from a clone of the repo.

The shipped command line lives in `@mono-agent/agent-app`: the config-first host that reads one `mono-agent.config.json` and hosts every channel. The always-on browser console lives in `@mono-agent/web`, and the optional terminal console lives in `@mono-agent/tui`. For convenience there is an unscoped **`create-mono-agent`** installer that puts the natural `mono-agent` command on your `PATH`; both installer bins delegate to `@mono-agent/agent-app`, and only the `create-mono-agent` name adds the npm-init routing described below. All publish under the `@mono-agent/*` scope on npm.

:::note
The bare `mono-agent` npm name isn't ours — npm rejects it as too similar to an unrelated `monoagent` package — so the installer follows npm's `create-*` convention (`create-mono-agent`), which `npm create mono-agent` resolves natively.
:::

:::caution[These docs describe `main`, not the latest release]
The npm packages publish in lockstep, and the latest published release does not include every capability documented in this site. [Release status](/reference/release-status/) names the current published version, lists the source-only capability groups, and points at the [source build](#run-an-unreleased-build) when you need one before the next release.
:::

## Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `>=24.15.0` | Runtime for the CLI, host, and consoles. This matches the minimum required by the bundled Pi runtime. |
| pnpm | `>=10.16.0` | Only needed to build the workspace from source (the published packages install with plain `npm`/`npm exec`). |
| Provider sign-in | Provider account, or a local model server | Anthropic, GitHub Copilot, and OpenAI Codex sign in through the Pi runtime's bundled OAuth flow (`mono-agent auth login <provider>`); OpenCode-Go uses `OPENCODE_API_KEY`; Ollama and LM Studio need no account. No external CLI install is required. |

The default `openai-codex:gpt-5.6-terra` runtime signs in through the bundled Pi OAuth flow rather than a separate Codex CLI. `mono-agent auth login openai-codex` prints an auth URL to open in a browser, waits for the localhost callback, and accepts a pasted redirect URL / authorization code on remote or headless machines:

```bash
mono-agent auth login openai-codex
```

If you would rather not use a hosted provider, [Local providers](/runtime/local-providers/) covers Ollama and LM Studio, including which model refs and embeddings to configure.

:::note
You do **not** need pnpm to use the published packages — `npm i -g` and `npm exec` are enough. pnpm is only required for the [source build](#run-an-unreleased-build) at the end of this page.

The repository includes `.nvmrc`, so source contributors using nvm can run `nvm use` to select the exact minimum version exercised in CI. Newer Node releases remain supported by the `>=24.15.0` package engine range.
:::

## Install the CLI

Install the `create-mono-agent` installer globally to get the `mono-agent` command on your `PATH`:

```bash
npm i -g create-mono-agent
```

`create-mono-agent` ships both a `create-mono-agent` and a `mono-agent` bin. The persistent `mono-agent` name forwards arguments unchanged to `@mono-agent/agent-app` (installed alongside it). The installer name treats a bare invocation or any invocation whose first argument is a flag as `init`, except that singleton `--help`/`-h` prints the `init` help topic and singleton `--version`/`-v` prints the shared `mono-agent <version>` identity. Explicit subcommands pass through.

Prefer the scoped host directly? It also puts `mono-agent` on your `PATH` and additionally installs the `mono-agent-memory-recall` helper bin used by the memory recall tool:

```bash
npm i -g @mono-agent/agent-app
```

### Without a global install

If you only want to create an agent folder, use the bare npm-init form or spell `init` explicitly — no global install needed:

```bash
npm create mono-agent@latest
# explicit equivalent:
npm create mono-agent@latest init
# equivalently:
npx create-mono-agent init
```

This downloads and runs the published CLI for that one command. `create-mono-agent --help` and `-h` show init-specific help without scaffolding; `--version` and `-v` print the exact shared CLI version without writing anything. To keep using the CLI afterwards without a global install, run every command through `npm exec`:

```bash
npm exec --package create-mono-agent -- mono-agent validate
npm exec --package create-mono-agent -- mono-agent start
```

`npm exec` needs to resolve the package on each invocation and should not be relied on for a long-lived background process; install globally (or pin the version) when you are ready to run an agent every day.

## Start the browser console

The browser console is a separate always-on service, so start it once from any directory and leave it running. Managed start is available on macOS (`launchd`) and Linux (systemd user service); `--loopback` keeps the listener on this computer:

```bash
mono-agent web start --loopback
mono-agent web            # status, effective theme/name, and the exact URLs
```

Open the printed URL — with `--loopback` that is `http://127.0.0.1:5050` — and choose any agent that is running on the machine. On a host with no usable service manager, run the foreground service instead and keep it in its own terminal:

```bash
mono-agent web run --loopback
```

Bare `mono-agent web` is read-only: it prints service status, the usable URLs, and lifecycle help, and never starts, stops, or rewrites the service. Without `--loopback` the console binds `0.0.0.0:5050` for local, LAN, and tailnet use — and because it has **no application login**, anyone who can reach that port can operate the discovered agents. Read the [web console guide](/observability/web-console/) for persistent threads, attachments, notifications, service lifecycle, and the full security boundary, or [Linux services](/observability/linux-services/) for the systemd lifecycle.

## The terminal console (optional)

The operator console is built into the CLI. Once an agent is running (`mono-agent start`), open it from **any directory**:

```bash
mono-agent tui
```

It discovers running agents on the machine and gives you live chat with structured thinking/tool/telemetry insight, bounded recorded-run replay, and a config view. Use it alongside the browser console, or instead of it on a headless host. The underlying `@mono-agent/tui` package also ships a low-level `mono-agent-tui` bin for custom hosts (`--responder` embedded mode, `--url` direct connect):

```bash
npm i -g @mono-agent/tui   # only needed for the standalone bin
```

See [TUI](/observability/tui/) for the console walkthrough.

## Verify the install

Confirm the CLI resolves and prints its help:

```bash
mono-agent --help
```

The CLI exposes these commands (more detail in the [CLI Reference](/observability/cli-reference/)):

| Command | Purpose |
| --- | --- |
| `init` | Non-destructive scaffold of a config, `IDENTITY.md`, and `.mono-agent/`. A fresh built-in Journal/BuJo selection also gets one empty provider-free managed generation; pre-existing memory roots are never changed. On a TTY with no flags it runs the step-by-step **wizard** (preset or custom; walks you through model, channels, memory, tools, sandbox, observability); any flag or a non-TTY writes the scaffold silently. `setup` is an alias. |
| `presets` | List the built-in setup presets (`list`) or show a preset's generated config, `.env.example`, and checklist (`show <id>`). Replaces the removed `recipes` command. |
| `validate` | Validate `mono-agent.config.json` and live checks that can be tested safely before starting. |
| `start` | Start the host for every configured channel as a macOS `launchd` or Linux systemd user service; use `--foreground` where no service manager exists. |
| `restart` / `stop` / `status` / `logs` | Manage the managed instance (macOS launchd; Linux systemd user service). |
| `web` | Manage or run the always-on browser console; bare `web` only reports status. |
| `tui` | Open the terminal operator console and connect to any running agent. |
| `sessions` (removed) | Removed — use `mono-agent tui` (recorded-run replay) or `mono-agent web` (live console). |
| `install-skill` | Install the authoring composer and its documentation MCP companion, or maintain managed project skills. |
| `backfill` | Replay historical runs into observability. |

## Next: scaffold your first agent

Once the CLI is verified, scaffold a clean project folder:

```bash
mkdir my-agent
cd my-agent
mono-agent init
```

On a terminal with no flags, `mono-agent init` is the **readiness-proven** step-by-step wizard: name the agent, enter the exact Role destined for `IDENTITY.md` → `## Role`, search the Pi/Codex/Claude catalogs, configure any number of fallbacks and their exact efforts, then choose capabilities. The review says whether that Role will be written or an existing identity preserved. Escape goes back. A concrete creation review precedes provider/SRT mutations.

Bare `init` behaves differently per platform and input mode, and the docs do not hide it:

- **macOS, interactive**: it proves every selected route sequentially, prepares the private managed runtime, starts or refreshes the single canonical per-config `launchd` agent, waits for a fresh exact-snapshot ready trace source, then prints the edit → `validate` → `restart` → console handoff. Interrupted preflight can resume fingerprint-matching successes or restart all checks.
- **Linux, interactive**: the wizard still runs and proves the routes, but it does not start the systemd user service for you. It prints the manual `validate` → `start` steps, and those require a usable systemd **user** manager; without one, keep `mono-agent start --foreground` in its own terminal, or use `mono-agent web run --loopback` for the console.
- **Any flag, `--yes`, or a non-TTY**: init is scaffold-only. It never runs the readiness proof, never starts a process, and never labels the result ready.

Off macOS, edit the preserved scaffold manually, validate, start the service or foreground process, and open the browser console or `mono-agent tui`. See [Setup security and managed runtime](/reference/setup-security/) for the closure, environment, single-instance, and snapshot-integrity contracts behind the managed path.

```bash
mono-agent init --preset telegram-assistant --yes   # scaffold from a preset
mono-agent presets list                             # browse the built-in presets first
```

Then continue with the [Quickstart](/getting-started/quickstart/) to start the agent and hold your first conversation. For the full key reference, see [Config Blueprint](/config/blueprint/) and [Environment Variables](/config/env-vars/).

## Updating

:::caution[One-time managed-SRT upgrade to 0.9]
When upgrading from 0.8 or earlier to 0.9 or later on macOS, treat the
managed-SRT lock-protocol transition as offline. Before replacing packages,
stop every background and foreground mono-agent process for this OS user and
wait for any older `mono-agent init` or `mono-agent sandbox setup` command to
exit. Keep old processes stopped until the new-version packages are installed
and the first new-version `mono-agent sandbox setup` completes. Versions 0.8
and earlier do not acquire the permanent OS-level guard introduced in 0.9, so
old and new setup or repair must never overlap.
:::

Update global installs with npm:

```bash
npm update -g create-mono-agent     # (or @mono-agent/agent-app)
npm update -g @mono-agent/tui       # only if you installed the standalone TUI bin
```

The `create-mono-agent` installer, `@mono-agent/agent-app`, `@mono-agent/web`, and every other `@mono-agent/*` package release in lockstep at one version — keep any pinned references (scoped or the installer) on the same version. To see what the current npm release actually contains relative to these docs, read [Release status](/reference/release-status/).

For reproducible installs or one-shot scaffolds, pin the version explicitly to a published release — use the same version across every `@mono-agent/*` package (pick one from the [published npm versions](https://www.npmjs.com/package/@mono-agent/agent-app?activeTab=versions)):

```bash
version='<published-version>' # Replace with the published version you want to install.
npm i -g "@mono-agent/agent-app@$version"
npm exec --package "@mono-agent/agent-app@$version" -- mono-agent init
```

Source collaborators can review each version's notes in the repository
`CHANGELOG.md` and match them to its immutable source tag. Public installers can
confirm every published package version through npm metadata.
For the Product v1 line, first published to npm as 0.8.0, follow the complete [existing-agent cutover checklist](/memory/validation-and-cli/#enable-v1-on-an-existing-agent) after updating the binaries.

## Run an unreleased build

To run against unreleased changes (e.g. a feature branch) or a source-only capability, build the workspace from source and point `mono-agent` at the built CLI entry. This is the only path that needs pnpm.

```bash
git clone https://github.com/robertsreberski/mono-agent.git
cd mono-agent
pnpm install --frozen-lockfile
pnpm run build
```

`pnpm run build` builds every package in dependency order. On supported POSIX/macOS
hosts it first acquires the ignored exclusive `.mono-agent-build.lock`, removes the prior
`.mono-agent-build.json`, finalizes the required CLI/TUI executable modes, syncs the completed deploy
outputs, and atomically publishes a canonical
owner-only marker. The marker records the full source SHA and state, Node version and ABI, completion
time, a deterministic digest of the actual deploy outputs, and a separate digest of the installed root
and workspace `node_modules` topology, modes, and file bytes (including native addons). Fleet deployment checks
require the checkout to remain clean on both reads, recompute both digests, and bind every running
instance to the full expected SHA. The marker and lock are operational state, not files to commit or
copy between checkouts. A concurrent build fails closed; remove a stale lock only after proving no
root build is still active, then rerun the complete build. Windows and unsupported hosts still run the
normal build commands but do not publish this POSIX/macOS deploy proof. On a managed launchd fleet,
`--expect-labels <csv>` additionally pins the exact host topology; the checker revalidates each selected
canonical plist after its expensive probes, while auto-discovery alone cannot detect a plist that was
removed before the run began. Current managed plists execute an owner-private copied runtime under
`~/.mono-agent/runtimes`, so pass `--repo <deploy-checkout>` to select the source checkout whose build
marker and SHA are being proved. The checker also requires the copied CLI to occupy the canonical
content-addressed path and verifies its v4 marker, complete closure manifest, package bytes,
configured-plugin closure, and install-time execution-filesystem proof (including every resolution-path
directory inside the private install root) against that source checkout at both ends of the probe;
canonical ancestors above that root are separately required to remain owner-private. The running
process must start after the conservative finalized-runtime boundary.

After the build, the source CLI entry point is
`packages/agent-app/dist/cli.js`. For a literal source-build smoke test from a clean folder, call that
entry directly:

```bash
repo=/absolute/path/to/mono-agent
agent_dir=$(mktemp -d)
cd "$agent_dir"
node "$repo/packages/agent-app/dist/cli.js" init --model openai-codex:gpt-5.6-terra
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

A source build is an evaluation path, not a published artifact: other agents that pin a version cannot reproduce it, and the managed runtime proofs above assume you keep the checkout clean.
:::

:::tip
Editable global link instead of an alias? After `pnpm run build`, run `npm link` from `packages/agent-app` (and `packages/tui`) to put the local bins on your `PATH`. You still rebuild after each change.
:::
