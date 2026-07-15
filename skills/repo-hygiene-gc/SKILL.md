---
name: repo-hygiene-gc
description: Periodic branch/worktree garbage collection plus the post-merge cleanup protocol that keeps the repo from drowning in dead branches and worktrees. Use for branch/worktree cleanup, when asked to "clean up the repo", when either count climbs into double digits, or as a standing item at the end of a goal-loop wave.
---

# Repo hygiene GC

The frozen `main` deploy checkout stays put, but every feature spins up its own
branch + worktree under `~/.config/superpowers/worktrees/mono-agent/` (see
`worktree-feature`). Nothing reaps them automatically, and the remote never
self-cleans because `delete_branch_on_merge` is off. Goal-loop velocity buries
the repo fast: #167 verified a clean **2 branches / 3 worktrees**, and 8 days of
continued waves regressed it to **47 branches / 50 worktrees**
(`git branch --list | wc -l` = 47, `git worktree list | wc -l` = 50). This is the
janitorial sweep `worktree-feature` doesn't own.

## One-time: turn on server-side auto-delete

So merged **remote** branches auto-delete on merge. Confirm it is off, then flip it:

```bash
gh api repos/robertsreberski/mono-agent --jq .delete_branch_on_merge   # => false until fixed
gh api -X PATCH repos/robertsreberski/mono-agent -F delete_branch_on_merge=true
```

`-F` (typed field) sends a JSON boolean; `-f` would send the string `"true"`.
This only reaps the remote branch on merge — local branches and worktrees still
need the sweep below.

## Local branch sweep

List branches already merged into `main`, excluding `main`/current, and delete them:

```bash
git branch --merged main | grep -vE '^\*|(^|\s)main$' | xargs -r git branch -d
```

`git branch -d` is the safe delete — it refuses any branch not actually merged, so
this cannot drop live work.

## Worktree sweep

For each worktree whose branch is merged, remove it, then prune stale registrations:

```bash
git worktree list                       # audit
git worktree remove <path>              # per merged worktree
git worktree prune                      # drop registrations for dirs already gone
```

`git worktree list` shows the frozen `main` deploy checkout as its first row —
never remove that one; only sweep the feature worktrees under
`~/.config/superpowers/worktrees/mono-agent/`.

## Post-merge protocol (prevents regrowth)

This is the discipline that keeps the sweep from ever having 45 branches to catch
up on. After any `gh pr merge` confirms merged:

```bash
git worktree remove ~/.config/superpowers/worktrees/mono-agent/<name>
git branch -d <branch>
```

Paired with the `delete_branch_on_merge` setting, remote and local both self-clean
per feature. (This same step is folded into `worktree-feature`'s "Ship" flow — the
bulk sweep here is the safety net for when it was skipped.)

## Cadence

Run the full sweep whenever either count climbs into double digits, or as a
standing item at the end of a goal-loop wave:

```bash
git branch --list | wc -l
git worktree list | wc -l
```

## Gotchas

- **Squash-merged branches are invisible to `git branch --merged`.** PRs squashed
  into `main` land as a new commit whose SHA the branch never contained, so
  `--merged` reports them as unmerged and `git branch -d` refuses them — exactly how
  branches pile up. Catch them by their merged PR instead, then force-delete only
  those the API confirms merged:

```bash
gh pr list --state merged --limit 100 --json headRefName --jq '.[].headRefName' \
  | while read -r b; do git branch -D "$b" 2>/dev/null; done
```

  `git branch -D` is force delete — gate it on the merged-PR list above; never run
  it blind across branches.
- **A worktree's branch can't be deleted while the worktree exists** — `git branch -d`
  errors with the branch checked out elsewhere. Remove the worktree first, then the
  branch (the order in the post-merge protocol).
- **Prune before you trust the list.** A worktree dir deleted by hand still shows in
  `git worktree list` as a stale row until `git worktree prune` clears it — run prune
  before counting for the double-digit trigger.
