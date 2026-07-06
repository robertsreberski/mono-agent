---
name: worktree-feature
description: Start isolated feature work in a git worktree, keep its dist fresh (worktree-dist gotcha), and open the PR from it. Use when starting any multi-commit feature/fix, when asked to "work in a worktree", or before executing an implementation plan.
---

# Worktree feature workflow

Why worktrees here: the main repo's built dist is LIVE — two launchd agents exec
`packages/agent-app/dist/cli.js` directly. Never destabilize the main working
tree and **never `git stash` WIP on it**.

> **Current state (2026-07):** the deploy checkout is a FROZEN bare tree
> (`core.bare=true`, `git status` fails there, the local `origin/main` ref may
> not resolve). Never build, test, or commit in it. ALL work happens in
> worktrees created from a fresh fetch + `FETCH_HEAD` (not the local
> `origin/main` ref):
>
> ```bash
> git fetch origin main
> git worktree add ~/.config/superpowers/worktrees/mono-agent/<name> -b <branch> FETCH_HEAD
> ```
>
> Current practice keeps worktrees under `~/.config/superpowers/worktrees/mono-agent/`.

## Create

```bash
cd "$(git rev-parse --show-toplevel)"
git worktree add .claude/worktrees/<name> -b <branch> origin/main
# or branch from current work: git worktree add .claude/worktrees/<name> -b <branch> HEAD
```

Branch naming in this repo: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `worktree-<topic>`.

## MANDATORY first step — dist baseline

Worktrees under `.claude/worktrees/` live INSIDE the main repo tree. When a
worktree package's `dist/` is absent, TypeScript/vitest module resolution walks
up `node_modules` and **falls through to the MAIN repo's built dist** — cross-
package typechecks/tests silently run against stale main-repo code (false
greens AND false reds; confirmed via `tsc --traceResolution`). So:

```bash
cd .claude/worktrees/<name>
pnpm install                 # if lockfile/deps changed; workspace links otherwise suffice
pnpm -r --sort run build     # worktree-local dist baseline that shadows the main repo
```

After every edit to package X, before verifying any dependent:

```bash
pnpm --filter @mono-agent/<X> run build
```

Intra-package vitest runs use `src` directly and are exempt — only CROSS-package
resolution hits this.

**Stale-dist rescue:** if a cross-package typecheck/build fails inexplicably in a
worktree, don't debug it in place — a poisoned dist can't be reasoned about.
Spin up a FRESH worktree and rebuild in dependency order
(`pnpm -r --sort run build`). Wave-1 goal #124 lost iterations to this and
recovered exactly this way (a "rescue worktree").

## Website inside a worktree

`website/` is its own pnpm workspace; either install fresh or symlink from main:

```bash
pnpm -C website install
# or:
ln -sfn "$(git rev-parse --show-toplevel)/website/node_modules" website/node_modules
```

## Ship

Verify with the `verify-green` skill first. Then:

```bash
git add -A && git commit -q -F - <<'EOF'
feat(<scope>): <summary>

<why + what, wrapped body paragraphs>
EOF
git push -u origin <branch>
gh pr create --base main --head <branch> --title "<title>" --body "<body>"
gh pr checks <n> --watch --interval 30
```

Commits are authored as `robertsreberski@gmail.com` (enforced by the local
`.githooks/pre-commit`; see AGENTS.local.md).

## Compare against base / cleanup

Check whether a failure pre-exists on main without touching your tree:

```bash
git worktree add --detach /tmp/<name>-base-check <commit>
```

When merged:

```bash
git worktree remove .claude/worktrees/<name>
git worktree prune
```
