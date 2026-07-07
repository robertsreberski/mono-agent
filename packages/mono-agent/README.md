# mono-agent

The bare, unscoped npm alias for the mono-agent CLI. Install this to get `npx mono-agent` and `npm i -g mono-agent` working; it delegates every command to the CLI that ships in [`@mono-agent/agent-app`](https://www.npmjs.com/package/@mono-agent/agent-app).

## Category

Category: `app`

This is the catalog's sole `tier: "alias"` package: an unscoped publishable alias, not a core package with its own responsibility. It is excluded from the core/plugin package counts and carries no library API.

## Responsibility

Provide the discoverable, unscoped `mono-agent` name on npm so `npx mono-agent init` and `npm i -g mono-agent` work, and forward every invocation, unchanged, to `@mono-agent/agent-app`'s `mono-agent` CLI. It owns no CLI behaviour of its own.

## Install / Usage

```bash
# One-off, no install:
npx mono-agent init

# Or install the CLI globally:
npm i -g mono-agent
mono-agent init
mono-agent validate
mono-agent --version
```

Every command, flag, and exit code is exactly what `@mono-agent/agent-app` provides — including interactive shutdown: Ctrl-C on `mono-agent start --foreground` runs the same graceful teardown and yields the same exit status as calling agent-app's bin directly (the alias forwards signals without double-signalling the child; see the bin's `delegateSignals`). This package adds nothing but the name. Prefer pinning the scoped host directly (`npm i -g @mono-agent/agent-app`) if you don't need the bare alias.

> Note: the monorepo's root workspace project is also named `mono-agent` (private, unpublished). Inside this repo, select this package by path — `pnpm --filter "./packages/mono-agent" ...` — so the filter is unambiguous. Repo-wide `pnpm -r` scripts and the dir-based release lane are unaffected.

## Public API

None. This package exports no library surface; it ships a single `mono-agent` bin that delegates to `@mono-agent/agent-app`.

## Dependency Boundary

Depends only on `@mono-agent/agent-app` (category `app`) at the same lockstep version, resolved at runtime through its published `bin`. It must not depend on runtime, communication, memory, observability, or operator-surface packages, and it must not reimplement any CLI logic.

## What This Package Does Not Own

It does not parse args, load config, run models, scaffold files, or define any command — all of that lives in `@mono-agent/agent-app`. It is metadata plus a delegating bin, nothing more. If the alias ever needs behaviour, that behaviour belongs in `@mono-agent/agent-app`, not here.

## Verification

Select this package by path so it isn't confused with the root workspace project:

```bash
pnpm --filter "./packages/mono-agent" run build
pnpm --filter "./packages/mono-agent" run typecheck
pnpm --filter "./packages/mono-agent" run test
```
