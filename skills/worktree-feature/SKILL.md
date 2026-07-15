---
name: worktree-feature
description: Start isolated feature work in a git worktree, keep its dist fresh (worktree-dist gotcha), and open the PR from it. Use when starting any multi-commit feature/fix, when asked to "work in a worktree", or before executing an implementation plan.
---

# Worktree feature workflow

Why worktrees here: the normal non-bare `main` checkout is the frozen deploy
tree, and its built dist is live across the launchd fleet. Never destabilize,
develop in, commit from, or `git stash` WIP in that checkout. All development
happens in isolated worktrees; the deploy checkout is updated and built only as
part of the fleet deployment workflow.

Current practice keeps worktrees under
`~/.config/superpowers/worktrees/mono-agent/`.

## Create

```bash
cd "$(git rev-parse --show-toplevel)"
git fetch origin main
git worktree add ~/.config/superpowers/worktrees/mono-agent/<name> -b <branch> origin/main
# or branch from current work:
git worktree add ~/.config/superpowers/worktrees/mono-agent/<name> -b <branch> HEAD
```

Branch naming in this repo: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `worktree-<topic>`.

## MANDATORY first step — dist baseline

When a worktree package's `dist/` is absent, TypeScript/vitest module resolution
can follow workspace links to stale built output — cross-package
typechecks/tests may silently run against the wrong code (false greens and false
reds; confirmed via `tsc --traceResolution`). So:

```bash
cd ~/.config/superpowers/worktrees/mono-agent/<name>
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

`website/` is its own pnpm workspace. Install its dependencies inside the
feature worktree so the website gate cannot resolve through another checkout:

```bash
pnpm -C website install
```

## Ship

**Before shipping — new durable state?** If this PR adds a new on-disk store
under `.mono-agent/` (session history, continuation ledger, memory index, …),
confirm an existing purge/reset/clear surface covers it too — a CLI command, the
`doctor`/`validate` status, and any docs boundary/reset table. A durable store
that nothing can clear and no boundary doc mentions is a merge blocker; v0.11.0
durable conversation-history shipped ahead of its boundary-rules table.

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

**After merge (mandatory), not optional.** The instant `gh pr merge` confirms
merged, clean up both sides — remove the worktree and delete the local branch
(the remote branch self-deletes only when `delete_branch_on_merge` is on; see
`repo-hygiene-gc`). Skipped per-feature cleanups are exactly how the repo
regressed from 2 branches / 3 worktrees to 47 branches / 50 worktrees. The
commands are under *Compare against base / cleanup* below.

## Compare against base / cleanup

Check whether a failure pre-exists on main without touching your tree:

```bash
git worktree add --detach /tmp/<name>-base-check <commit>
```

When merged (run immediately — this is the mandatory post-merge step):

```bash
git worktree remove ~/.config/superpowers/worktrees/mono-agent/<name>
git branch -d <branch>          # local branch; remote self-deletes only with delete_branch_on_merge on
git worktree prune
```

For a periodic *bulk* sweep of accumulated merged branches/worktrees (not just
this one), use the `repo-hygiene-gc` skill.
