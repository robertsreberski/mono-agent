---
name: verify-green
description: Run the mono-agent verification gate — full repo green or fast single-package iteration. Use before claiming any change works, before committing, before PRs, or when asked to "verify", "run the gate", "make it green", or "check architecture".
---

# Verify green

"Green" means the exact CI sequence passes (`.github/workflows/ci.yml`), in this order. Nothing is green because it "looks fine".

## Full gate (CI order)

```bash
pnpm run check:secrets
pnpm run check:oss-hygiene
pnpm run check:codex-discoverability  # skills/agents Codex parity (wired into CI + verify:all by PR #142)
pnpm run check:architecture     # catalog + README sections + dependency categories
pnpm run build                  # packages + demos, then strict deploy-output marker on POSIX/macOS
pnpm run typecheck
pnpm test                       # includes release:test + scripts:test + all packages + demos
pnpm run test:demo
git diff --check                # whitespace — CI runs this too
```

One-shot equivalent (adds alpha/beta consumer verification):

```bash
pnpm run verify:all
```

On supported POSIX/macOS hosts, the root build holds an exclusive ignored build
lock, clears any prior marker, builds packages and demos, syncs the output tree,
and atomically publishes an owner-only marker containing the full source SHA,
source state, Node/ABI, completion time, and deterministic output digest. A
concurrent build fails closed. Windows and unsupported hosts still run the
normal build commands but do not publish this deploy proof. If a crash leaves a
lock, remove it only after confirming no root build is still active, then rerun
the whole build.

Release-relevant tarball sanity (CI runs both on every push; `<version>` = `packages/agent-app/package.json` version):

```bash
pnpm run release:validate -- --tag v<version>
pnpm run release:pack -- --tag v<version>
```

## Fast iteration loop (while developing)

Do not run the full gate per edit. Iterate on one package:

```bash
pnpm --filter @mono-agent/<pkg> run build
pnpm --filter @mono-agent/<pkg> test            # or append: -- src/__tests__/<file>.test.ts --runInBand
pnpm --filter @mono-agent/<pkg> run typecheck
pnpm --filter @mono-agent/<pkg>... build        # trailing ... also builds its workspace dependencies
```

Single test file, directly:

```bash
pnpm --dir packages/<pkg> exec vitest run src/__tests__/<file>.test.ts
```

## Cross-package rebuild rule (stale-dist gotcha)

`pnpm test` / `pnpm typecheck` do NOT build first. Cross-package imports resolve
against each package's built `dist/` (tsconfig NodeNext, `exports` point at dist —
no src aliases). After editing package A, rebuild A **before** building, testing,
or typechecking any dependent B, or B silently runs against A's stale dist.
Intra-package vitest uses `src` via relative imports and is unaffected — a
package's own tests passing proves nothing about its dependents.

In worktrees this is worse: missing worktree dist falls through to the MAIN
repo's dist (see the `worktree-feature` skill).

## Gotchas

- The demo gate is chained into `pnpm run build` / `pnpm test` — demos are not optional extras; a demo break is a gate break.
- A failure may pre-exist on main. The normal non-bare `main` checkout is frozen
  for fleet deployment, not development. Never edit or `git stash` it; check
  main via a detached worktree instead:

```bash
git worktree add --detach /tmp/base-check origin/main
cd /tmp/base-check && pnpm install --frozen-lockfile && pnpm --filter @mono-agent/<pkg> test
git worktree remove /tmp/base-check
```

- `git diff --check` failures (trailing whitespace) fail CI — run it locally.
- `check:codex-discoverability` enforces skills/agents Codex parity: editing an
  `agents/*.md` template requires syncing its `agents/*.toml` companion (and vice
  versa) or the gate fails (`codex-agent-toml-missing` / `-orphan`).
- Do NOT run `check:architecture` in parallel with the website build:
  `website/scripts/sync-content.mjs` deletes and recreates the synced docs dir,
  and the two race (observed on goal #124). Run them sequentially.
- `pnpm --filter <pkg> exec mono-agent …` resolves the Homebrew/global binary,
  NOT your worktree build — so it silently verifies the wrong code. Invoke the
  worktree CLI explicitly: `node packages/agent-app/dist/cli.js …` (bit goals
  #122 and #139's executor).

## Report format

State exactly which commands you ran and their outcomes. "Green" claims without
command evidence are worthless; quote the failing test name and file on red.
