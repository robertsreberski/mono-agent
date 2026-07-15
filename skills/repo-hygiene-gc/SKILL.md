---
name: repo-hygiene-gc
description: Periodic branch/worktree garbage collection plus the post-merge cleanup protocol that keeps the repo from drowning in dead branches and worktrees. Use for branch/worktree cleanup, when asked to "clean up the repo", when either count climbs into double digits, or as a standing item at the end of a goal-loop wave.
---

# Repo hygiene GC

The frozen `main` deploy checkout stays put, but every feature spins up its own
branch + worktree under `~/.config/superpowers/worktrees/mono-agent/` (see
`worktree-feature`). Local worktrees are never reaped automatically, and remote
branches accumulated while `delete_branch_on_merge` was off. Goal-loop velocity
buries the repo fast: #167 verified a clean **2 branches / 3 worktrees**, and 8
days of continued waves regressed it to **47 branches / 50 worktrees**
(`git branch --list | wc -l` = 47, `git worktree list | wc -l` = 50). This is the
janitorial sweep `worktree-feature` doesn't own.

## Verify server-side auto-delete

Merged **remote** branches should auto-delete on merge. #292 enabled the setting;
verify it remains on, and restore it only if it has drifted:

```bash
gh api repos/robertsreberski/mono-agent --jq .delete_branch_on_merge   # => true
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

Prune registrations whose directories are already gone, then audit every live
worktree before removal. A worktree is removable only when it is clean and its
exact branch tip is the head of an API-confirmed merged PR. The proof block in
*Post-merge protocol* is the canonical removal path:

```bash
git worktree prune
git worktree list
git -C <path> status --porcelain
```

`git worktree list` shows the frozen `main` deploy checkout as its first row —
never remove that one; only sweep the feature worktrees under
`~/.config/superpowers/worktrees/mono-agent/`.

## Post-merge protocol (prevents regrowth)

This is the discipline that keeps the sweep from ever having 45 branches to
catch up on. After a PR merges, prove the exact PR state, branch name, and head
SHA before removing a clean worktree and force-deleting its squash-merged local
branch:

```bash
repo=robertsreberski/mono-agent
pr=<number>
branch=<branch>
worktree=~/.config/superpowers/worktrees/mono-agent/<name>
repo_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
proof="$(gh pr view "$pr" --repo "$repo" \
  --json state,mergedAt,headRefName,headRefOid \
  --jq 'select(.state == "MERGED" and .mergedAt != null) | [.headRefName, .headRefOid] | join(" ")')"
api_branch="${proof%% *}"
api_head="${proof#* }"
local_head="$(git -C "$repo_root" rev-parse "refs/heads/$branch")"

test "$api_branch" = "$branch" &&
test "$api_head" = "$local_head" &&
test -z "$(git -C "$worktree" status --porcelain)" &&
cd "$repo_root" &&
git worktree remove "$worktree" &&
git branch -D -- "$branch" &&
git worktree prune
```

Paired with the `delete_branch_on_merge` setting, remote and local both self-clean
per feature. (This same step is folded into `worktree-feature`'s "Ship" flow — the
bulk sweep here is the safety net for when it was skipped.)

## Historical squash-merge sweep

Inventory first; do not pipe a list of old branch names directly into
`git branch -D`. Branch names can be reused, and a merged PR with the same name
does not prove the current tip was merged. For each candidate, list its PRs and
select the one whose `headRefOid` exactly equals the current local or remote tip:

```bash
branch=<candidate>
gh pr list --repo robertsreberski/mono-agent --state all --head "$branch" \
  --limit 100 --json number,state,mergedAt,headRefName,headRefOid,url
git rev-parse "refs/heads/$branch"
git rev-parse "refs/remotes/origin/$branch"
```

Use that PR number with the canonical proof block above. If the remote branch
still exists after local cleanup, delete it only with a lease bound to the
API-confirmed head SHA, so a concurrently advanced branch is preserved:

```bash
git push --force-with-lease="refs/heads/$branch:$api_head" \
  origin ":refs/heads/$branch"
```

Keep every dirty worktree, branch without an exact merged-PR/head match, and
closed-unmerged or open PR branch. Record the survivor and its reason instead
of guessing.

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
  `--merged` reports them as unmerged and `git branch -d` refuses them. Use the
  exact API/branch/head proof above; never force-delete a bulk list of names.
- **A worktree's branch can't be deleted while the worktree exists** — `git branch -d`
  errors with the branch checked out elsewhere. Remove the worktree first, then the
  branch (the order in the post-merge protocol).
- **Prune before you trust the list.** A worktree dir deleted by hand still shows in
  `git worktree list` as a stale row until `git worktree prune` clears it — run prune
  before counting for the double-digit trigger.
