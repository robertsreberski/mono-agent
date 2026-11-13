---
title: "Install & Prerequisites"
description: "Install the mono-agent CLI, start the browser console, or run an unreleased build from source."
sidebar:
  order: 1
---

This page covers the recommended way to install the `mono-agent` CLI, what the browser console needs, and how to run an unreleased build straight from a clone of the repo.

The shipped command line lives in `@mono-agent/app`: the config-first host that reads one `mono-agent.config.json` and hosts every channel. The always-on browser console lives in `@mono-agent/web`. For convenience there is an unscoped **`create-mono-agent`** installer that puts the natural `mono-agent` command on your `PATH`; both installer bins delegate to `@mono-agent/app`, and only the `create-mono-agent` name adds the npm-init routing described below. All publish under the `@mono-agent/*` scope on npm.

:::note
The bare `mono-agent` npm name isn't ours — npm rejects it as too similar to an unrelated `monoagent` package — so the installer follows npm's `create-*` convention (`create-mono-agent`), which `npm create mono-agent` resolves natively.
:::

:::note[Published release: 0.26.0]
All 20 current catalog packages have npm `latest` set to `0.26.0` (registry checked 2026-10-20). Current `main` carries unreleased package behavior after `v0.26.0`: an early Node-version guard and `mono-agent preflight`, shipping in the next package release. [Release status](/reference/release-status/) covers the package renames, deprecated-but-installable old npm names, and the upgrade boundary. Use a [source build](#run-an-unreleased-build) only when evaluating later unreleased changes.
:::

## Prerequisites

The shell installer below supplies its own Node on supported macOS/Linux hosts.
The Node requirement in this table applies when managing your own npm install.

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `>=24.15.0` | Runtime for the CLI, host, and consoles. This matches the minimum required by the bundled Pi runtime. |
| pnpm | `>=10.16.0` | Only needed to build the workspace from source (the published packages install with plain `npm`/`npm exec`). |
| Provider sign-in | Provider account, or a local model server | Anthropic, GitHub Copilot, OpenAI Codex, and `openai` with ChatGPT sign in through the Pi runtime's bundled OAuth flow (`mono-agent auth login <provider>`); OpenCode-Go uses `OPENCODE_API_KEY`; Ollama and LM Studio need no account. No external CLI install is required. |

The default `openai-codex:gpt-5.6-terra` runtime signs in through the bundled Pi OAuth flow rather than a separate Codex CLI. `mono-agent auth login openai-codex` prints an auth URL to open in a browser, waits for the localhost callback, and accepts a pasted redirect URL / authorization code on remote or headless machines:

```bash
mono-agent auth login openai-codex
```

If you would rather not use a hosted provider, [Local providers](/runtime/local-providers/) covers Ollama and LM Studio, including which model refs and embeddings to configure.

:::note
You do **not** need pnpm to use the published packages — `npm i -g` and `npm exec` are enough. pnpm is only required for the [source build](#run-an-unreleased-build) at the end of this page.

The repository includes `.nvmrc`, so source contributors using nvm can run `nvm use` to select the exact minimum version exercised in CI. Newer Node releases remain supported by the `>=24.15.0` package engine range.
:::

Both shipped CLI entry points reject unsupported Node **before** importing the
runtime or loading native modules. The error names the found/required versions
and gives alternatives: `nvm install 24.15.0 && nvm use 24.15.0`,
`fnm install 24.15.0 && fnm use 24.15.0`, `volta install node@24.15.0`, or the
[official Node installer](https://nodejs.org/en/download). Selecting Node does
not rebuild an existing native dependency: after switching Node, stop affected
agents and reinstall/rebuild with that same Node before restarting them.

## Install the CLI

### Private Node installer (macOS and Linux)

```sh
curl -fsSL https://mono-agent.dev/install.sh | sh
```

Supports macOS and **glibc Linux (glibc >=2.28)** on x64/arm64, subject to the
[official Node platform requirements](https://github.com/nodejs/node/blob/v24.15.0/BUILDING.md#platform-list).
Real official-Node/published-CLI/native-dependency smoke has been run on
**macOS arm64** and **glibc Linux arm64 (Docker)**. macOS/Linux **x64 mappings
are fixture-tested only**, not live-proven installations. The macOS/Ubuntu
installer CI jobs run offline fixtures with mocked platform commands and Node
archives; they do not prove a real bootstrap on either runner's architecture.
Refuses root, Windows-like shells, musl/Alpine, and unknown architectures. Requires
curl, tar/gzip, standard POSIX tools and `sha256sum` or `shasum`. No existing Node,
npm or pnpm is needed. Native dependencies may still require a compiler and
system libraries if prebuilds are unavailable; the installer never uses sudo or
installs system prerequisites.

**Inspect first (recommended):** download the script and its checksum before
executing it. Both files share the same hosting trust boundary: this checksum
detects corruption, **not an independent signature**. The script verifies the
exact official Node archive against `nodejs.org`'s HTTPS checksum manifest before
extracting or executing it. npm package integrity follows npm's registry trust
model; dependency lifecycle scripts are enabled for native builds.

```sh
curl -fsSLO https://mono-agent.dev/install.sh
curl -fsSLO https://mono-agent.dev/install.sh.sha256
# Linux:
sha256sum -c install.sh.sha256
# macOS alternative:
shasum -a 256 -c install.sh.sha256
less install.sh
sh install.sh --non-interactive
```

Installation is private and generation-based under `~/.mono-agent/cli`:
`releases/<generation>/runtime` holds official Node, `npm` holds the published
`create-mono-agent`, and `install.json` records versions, ABI and the archive
checksum. `current` switches atomically only after CLI version/help checks.
`bin/mono-agent` resolves one generation and always executes its matching Node,
regardless of host Node. After successful publication, only current and previous generations remain,
plus generations referenced by detected service definitions. Older unreferenced
generations are pruned; finish long-running foreground CLI commands before
upgrading repeatedly. The installer does not stop, restart or update services
or external managed runtimes.
The prefix is fixed, not configurable.

**Activate PATH:** the installer prints an absolute CLI path and a safely quoted
`export PATH=…` command for your current shell. Run that printed command, then
`mono-agent init`. A piped child shell cannot change its parent's environment.
By default no shell startup file is edited. `--add-to-path` explicitly opts in
to one marked block in macOS Bash `~/.bash_profile`, Linux Bash `~/.bashrc`, or Zsh `~/.zshrc`; other shells get
instructions only. Existing shells still need the printed export or a restart.
A warning identifies an older `mono-agent` that takes precedence on PATH.

| Option | Behavior |
| --- | --- |
| `--version latest` or `--version 0.26.0` | Choose latest (default) or an exact published CLI version. Node remains pinned by the installer. |
| `--non-interactive` | Never prompt; installs are already unattended. |
| `--add-to-path` | Opt in to the marked Bash/Zsh PATH block. |
| `--uninstall --yes` | Remove the CLI subtree and unchanged marked PATH blocks; refuse if detected service definitions reference it. |
| `--force-uninstall` | With `--uninstall`, override service-reference/inspection refusal; those services may break. |
| `--help` | Show options without mutation. |

Environment equivalents: `MONO_AGENT_VERSION`, `MONO_AGENT_NONINTERACTIVE=0|1`,
`MONO_AGENT_ADD_TO_PATH=0|1`. Corresponding flags override environment values. Uninstall ignores the version
and PATH environment preferences; explicit `--version`/`--add-to-path` flags
remain incompatible with uninstall.
Pass options to a piped install with `sh -s -- --non-interactive`, or use the
inspected local script. Re-run to upgrade; a failed staged install preserves
`current`. An interrupted installer may leave `~/.mono-agent/.cli-install-lock`; inspect for an
active installer before manually removing that lock and re-running.

npm runs with isolated HOME/configuration, an explicit public registry, and
private prefix/cache; project/user `.npmrc`, curl startup config, inherited npm settings and Node
preloads do not override the target runtime. Standard `HTTPS_PROXY`,
`HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` (or lowercase equivalents), `SSL_CERT_FILE`
and `NODE_EXTRA_CA_CERTS` are supported for proxy/custom-CA environments. For
npm, `SSL_CERT_FILE` supplies `NODE_EXTRA_CA_CERTS` only when the latter is unset.
Downloads stop after 60 seconds below 1 KiB/s, with a generous 900-second total
cap per attempt for healthy slow transfers. No
registry/mirror override or checksum bypass is offered.

The installer invokes `mono-agent preflight --json` with a bounded timeout.
Host preflight is on `main` and ships with the next package release; published
0.26.0 does not provide it. Recognized host errors return nonzero **but leave the CLI
installed** and show remediation. Published versions without this command warn
“host preflight unavailable in this version”; that is not a readiness pass. No
provider calls, project creation or services are started by installation.
The shim does not prepend private Node/npm to child PATH: user project commands
keep their own toolchain. Optional docs-MCP pairing expects `npx` on the host PATH.

Uninstall with the downloaded script:

```sh
sh install.sh --uninstall --yes --non-interactive
```

Without `--yes`, uninstall requires an interactive confirmation. It preserves
projects, credentials, `~/.mono-agent/runtimes` and separately npm-installed CLIs.
Before removal it scans `~/Library/LaunchAgents` and
`${XDG_CONFIG_HOME:-~/.config}/systemd/user` for runtime references to the CLI
prefix (`releases/`, `current/`, or `bin/mono-agent`), including XML/systemd
escaping. A PATH entry alone does not block removal. If found, run `mono-agent stop` from each agent config folder and
`mono-agent web stop`, then retry. No services are stopped automatically.
`--force-uninstall` explicitly overrides this safeguard and may leave services
unable to start; definitions are not deleted. This is a definition scan, not a
universal live-process detector.

Modified, unsafe or symlinked shell files are preserved with a warning rather
than blocking CLI removal. If the private Node cannot run or its generation directory is missing, PATH cleanup is
skipped and the CLI subtree is still removed; remove its PATH block manually.
An installer-created shell file is removed only if empty after cleanup. Existing
file bytes and modes are preserved, but atomic replacement does not retain
hard-link identity, ACLs or extended attributes. Unsafe CLI paths or unrecognized
ownership markers are refused.

### Manage Node yourself (including Windows)

With Node.js >=24.15.0 already installed, install the `create-mono-agent` package
globally to get the `mono-agent` command on your `PATH`:

```bash
npm i -g create-mono-agent
```

`create-mono-agent` ships both a `create-mono-agent` and a `mono-agent` bin. The persistent `mono-agent` name forwards arguments unchanged to `@mono-agent/app` (installed alongside it). The installer name treats a bare invocation or any invocation whose first argument is a flag as `init`, except that singleton `--help`/`-h` prints the `init` help topic and singleton `--version`/`-v` prints the shared `mono-agent <version>` identity. Explicit subcommands pass through.

Prefer the scoped host directly? It also puts `mono-agent` on your `PATH`; the memory recall tool is provided directly by the host:

```bash
npm i -g @mono-agent/app
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

## Run the browser console

The browser console is a separate service from the agent. The local-first way to run it is the foreground command, in its own terminal:

```bash
mono-agent web run --loopback
```

Open the printed URL — with `--loopback` that is `http://127.0.0.1:5050` — and choose any agent that is running on the machine. Foreground `web run` configures no proxy route and removes none: it stops when the terminal closes or you press Ctrl-C, and it never touches an existing Tailscale Serve route. If the agent itself runs in the foreground, that is terminal 1 and this is terminal 2.

To keep the console running in the background, install the managed service instead (macOS `launchd`, Linux systemd user service):

```bash
mono-agent web start --loopback
mono-agent web            # read-only status, effective URLs, and lifecycle help
```

Two differences matter before you use the managed path:

- **macOS**: managed `start`/`restart` re-verifies an existing mono-agent-owned Tailscale Serve HTTPS route and creates a new one only with `--share-tailnet`. The bind narrows only the local HTTP listener, so a console with an owned route can still be reachable from the tailnet, and other proxies/routes are not inspected — because there is **no application login**, anyone who can reach it can operate the discovered agents. `mono-agent web` prints the effective URLs; `mono-agent web status --json` separates the listener from the owned route; `tailscale serve status` shows the route.
- **Linux**: `start` uses the systemd user service and HTTPS routes are managed externally. See [Linux services](/observability/linux-services/).

Where no usable service manager exists, the foreground command above is the supported path. Read the [web console guide](/observability/web-console/) for persistent threads, attachments, notifications, service lifecycle, and the full security boundary.

## Verify the install

Confirm the CLI resolves with `mono-agent --help`. The following host checks
are available from a source build now and ship with the next published release
(not 0.26.0). Run them from any folder, even an empty one:

```bash
mono-agent --help
mono-agent preflight
mono-agent preflight --json          # versioned scripting report
mono-agent preflight --port 5051     # check an alternative console port
```

`preflight` never loads agent config, `.env`, credentials, or providers, and
creates no scaffold. It checks Node/ABI, actually loads better-sqlite3/sqlite-vec
and sharp in isolated processes, inspects the user service manager and sandbox,
checks local model-list endpoints, and briefly binds/closes the console port.
Model probes use only literal loopback defaults, never proxy variables or
redirects, and perform no inference. Missing optional capabilities are not
installation requirements: exit `0` means **no errors**, not all capabilities
available. Every non-ok check includes commands and prerequisites; nothing is
repaired automatically. `doctor` remains an alias of the config-aware `validate`.
See the [preflight report contract](/observability/cli-reference/#host-preflight)
for IDs, statuses, bounds, and exit codes.

For native failures, select supported Node and stop affected running agents
first. Source installs get a shell-quoted rebuild command derived from the
executing checkout (not your current folder). Unknown npm layouts get two
**labelled alternatives**, not a guessed repair: uninstall/reinstall either
`create-mono-agent` or `@mono-agent/app` at the installed version, using the same
Node, then rerun preflight. Choose only the alternative matching your install.

The CLI exposes these commands (more detail in the [CLI Reference](/observability/cli-reference/)):

| Command | Purpose |
| --- | --- |
| `init` | Non-destructive scaffold of a config, `IDENTITY.md`, and `.mono-agent/`. A fresh built-in Journal/BuJo selection also gets one empty provider-free managed generation; pre-existing memory roots are never changed. On a TTY with no flags it runs the step-by-step **wizard** (preset or custom; name/Role, model routes, an optional-capabilities gate for channels/memory that defaults to No, then tools and sandbox); any flag or a non-TTY writes the scaffold silently. `setup` is an alias. |
| `presets` | List the built-in setup presets (`list`) or show a preset's generated config, `.env.example`, and checklist (`show <id>`). Replaces the removed `recipes` command. |
| `preflight` | Config-independent host capabilities and native-load checks; accepts `--json` and `--port <n>`. |
| `validate` | Validate `mono-agent.config.json` and live checks that can be tested safely before starting. |
| `start` | Start the host for every configured channel as a macOS `launchd` or Linux systemd user service; use `--foreground` where no service manager exists. |
| `restart` / `stop` / `status` / `logs` | Manage the managed instance (macOS launchd; Linux systemd user service). |
| `web` | Manage or run the always-on browser console; bare `web` only reports status. |
| `runs list` / `runs show` | Inspect bounded, redacted local run evidence without loading providers. |
| `tui` / `sessions` (removed) | Removed — use `mono-agent web run --loopback` for live operation, `runs list` / `runs show` for prior-run diagnostics, and `mono-agent config` for resolved configuration. |
| `install-skill` | Install the authoring composer and its documentation MCP companion, or maintain managed project skills. |
| `backfill` (removed) | Fails with pre-upgrade migration guidance; retained artifacts remain available through `runs`. |

## Next: scaffold your first agent

Once the CLI is verified, scaffold a clean project folder:

```bash
mkdir my-agent
cd my-agent
mono-agent init
```

On a terminal with no flags, `mono-agent init` is the **readiness-proven** step-by-step wizard: name the agent, enter the exact Role destined for `IDENTITY.md` → `## Role`, search the Pi/Codex/Claude catalogs, configure any number of fallbacks and their exact efforts, then decide whether to add optional capabilities (channels and memory — default No for a custom start; seeded presets open the gate at Yes) and confirm the tool/access and sandbox choices. The review says whether that Role will be written or an existing identity preserved. Escape goes back. A concrete creation review precedes provider/SRT mutations.

Bare `init` behaves differently per platform and input mode, and the docs do not hide it:

- **macOS, interactive**: it proves every selected route sequentially, prepares the private managed runtime, starts or refreshes the single canonical per-config `launchd` agent, waits for a fresh exact-snapshot ready trace source, then prints the browser-first handoff: confirm the running agent with `status`, run `mono-agent web run --loopback` in a second terminal, and open `http://127.0.0.1:5050`. Interrupted preflight can resume fingerprint-matching successes or restart all checks.
- **Linux, interactive**: the wizard still runs and proves the routes, but it does not start the systemd user service for you. It prints the manual start handoff — terminal 1 `mono-agent start` (which requires a usable systemd **user** manager) or `mono-agent start --foreground` without one, then terminal 2 `mono-agent web run --loopback`, because the console needs that agent process to stay alive.
- **Any flag, `--yes`, or a non-TTY**: init is scaffold-only. It never runs the readiness proof, never starts a process, and never labels the result ready.

Off macOS, edit the preserved scaffold manually, validate, start the service or foreground process, and open the browser console. See [Setup security and managed runtime](/reference/setup-security/) for the closure, environment, single-instance, and snapshot-integrity contracts behind the managed path.

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

For the private installer, re-run the one-liner (or the freshly downloaded,
inspected script) to upgrade. Existing services keep their own runtime and are
not restarted. For npm-managed global installs, update with npm:

```bash
npm update -g create-mono-agent     # (or @mono-agent/app)
```

The `create-mono-agent` installer, `@mono-agent/app`, `@mono-agent/web`, and every other `@mono-agent/*` package release in lockstep at one version — keep any pinned references (scoped or the installer) on the same version. To see what the current npm release actually contains relative to these docs, read [Release status](/reference/release-status/).

For reproducible installs or one-shot scaffolds, pin the version explicitly to a published release — use the same version across every `@mono-agent/*` package (pick one from the [published npm versions](https://www.npmjs.com/package/@mono-agent/app?activeTab=versions)):

```bash
version='<published-version>' # Replace with the published version you want to install.
npm i -g "@mono-agent/app@$version"
npm exec --package "@mono-agent/app@$version" -- mono-agent init
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
`.mono-agent-build.json`, finalizes the required CLI executable mode, syncs the completed deploy
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
`packages/app/dist/cli.js`. For a literal source-build smoke test from a clean folder, call that
entry directly:

```bash
repo=/absolute/path/to/mono-agent
agent_dir=$(mktemp -d)
cd "$agent_dir"
node "$repo/packages/app/dist/cli.js" init --model openai-codex:gpt-5.6-terra
node "$repo/packages/app/dist/cli.js" validate
```

You can also alias `mono-agent` to the built entry so you can run the local build from anywhere:

```bash
alias mono-agent="node /absolute/path/to/mono-agent/packages/app/dist/cli.js"
mono-agent --help
```

:::caution
Rebuild (`pnpm run build`) after pulling new changes — the alias points at compiled output in `dist/`, not the TypeScript sources, so edits are not picked up until you rebuild. Cross-package types and tests resolve against built `dist/`, so a stale build can mask or surface errors that do not match `src`.

A source build is an evaluation path, not a published artifact: other agents that pin a version cannot reproduce it, and the managed runtime proofs above assume you keep the checkout clean.
:::

:::tip
Editable global link instead of an alias? After `pnpm run build`, run `npm link` from `packages/app` to put the local bin on your `PATH`. You still rebuild after each change.
:::
