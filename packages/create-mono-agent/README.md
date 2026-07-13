# create-mono-agent

The unscoped npm-init installer for the mono-agent CLI. It ships two bins —
`create-mono-agent` and `mono-agent` — each of which delegates every command to
the CLI that lives in [`@mono-agent/agent-app`](https://www.npmjs.com/package/@mono-agent/agent-app).

Three equivalent entry points, one behaviour:

- `npm create mono-agent@latest` — npm's `create-*` convention resolves this package (no install).
- `npx create-mono-agent` — the same, spelled explicitly.
- `npm i -g create-mono-agent` — a global install that puts the natural `mono-agent` command on your `PATH`.

On macOS, a one-off `npm create`/npx wizard may start the finished agent in the
background. Before it does, `@mono-agent/agent-app` copies the exact executing
package through npm into a private, verified runtime under
`~/.mono-agent/runtimes/agent-app/`; launchd never keeps a disposable npm-cache
path. This does not install a global command or mutate `PATH`.

The bare `mono-agent` npm name is unavailable — npm rejects it as too similar to
an unrelated `monoagent` package — so this installer follows the `create-*`
convention while still exposing the ergonomic `mono-agent` bin.

## Category

Category: `app`

This is the catalog's sole `tier: "alias"` package: an unscoped publishable
installer, not a core package with its own responsibility. It is excluded from the
core/plugin package counts and carries no library API.

## Responsibility

Provide the discoverable, unscoped `create-mono-agent` name on npm so
`npm create mono-agent`/`npx create-mono-agent` and a global `mono-agent` command
work, and forward every invocation, unchanged, to `@mono-agent/agent-app`'s
`mono-agent` CLI. It owns no CLI behaviour of its own.

## Install / Usage

```bash
# One-off, no install (npm-init convention resolves create-mono-agent):
npm create mono-agent@latest init
npx create-mono-agent init

# Or install globally for the persistent `mono-agent` command:
npm i -g create-mono-agent
mono-agent init
mono-agent validate
mono-agent --version
```

Every command, flag, and exit code is exactly what `@mono-agent/agent-app`
provides — including interactive shutdown: Ctrl-C on `mono-agent start --foreground`
runs the same graceful teardown and yields the same exit status as calling
agent-app's bin directly (the bin forwards signals without double-signalling the
child; see `delegateSignals`). This package adds nothing but the names. Prefer
pinning the scoped host directly (`npm i -g @mono-agent/agent-app`) if you don't
need the installer.

## Public API

None. This package exports no library surface; it ships `create-mono-agent` and
`mono-agent` bins that both delegate to `@mono-agent/agent-app`.

## Dependency Boundary

Depends only on `@mono-agent/agent-app` (category `app`) at the same lockstep
version, resolved at runtime through its published `bin`. It must not depend on
runtime, communication, memory, observability, or operator-surface packages, and
it must not reimplement any CLI logic.

## What This Package Does Not Own

It does not parse args, load config, run models, scaffold files, or define any
command — all of that lives in `@mono-agent/agent-app`. It is metadata plus a
delegating bin, nothing more. If the installer ever needs behaviour, that
behaviour belongs in `@mono-agent/agent-app`, not here.

## Verification

```bash
pnpm --filter create-mono-agent run build
pnpm --filter create-mono-agent run typecheck
pnpm --filter create-mono-agent run test
```
