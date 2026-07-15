# E3-repo-governance-hygiene — Repo governance, dev tooling & git hygiene

## 1 Verdict & maturity grade

**Grade: B-**

The dev-tooling surface itself (5 agent templates + 8 skills, each with a Claude `.md`/Codex `.toml` or `SKILL.md`/`openai.yaml` companion) is genuinely good: every file was read in full, cross-checked against the live filesystem, and `node scripts/check-codex-discoverability.mjs` passes clean today — the automated parity gate this repo built for itself works. `PACKAGES.md`, `README.md`, and `scripts/package-catalog.mjs` also agree with each other on the package count (16 core + 4 plugin extras + 1 alias = 21) down to the exact prose, guarded by `scripts/release/__tests__/package-count-drift.test.mjs`.

What drags the grade down is that this same "keep the story honest" discipline was not applied uniformly: the epic (#119) that this very audit exists to help close still states a Definition-of-Done line ("Package count ≤ 18 active") that was privately acknowledged as wrong 9 days ago and never corrected in the issue body itself; one of the five agent templates points implementers at a worktree location nobody uses and that contradicts its own sibling skill; a repo-hygiene goal (#167) that was completed and verified clean on 2026-07-07 has fully regressed by 2026-07-15 with zero automation in place to stop it happening again; and the root README — the first thing "a competent stranger" reads — has grown well past "lean and understandable" in several places. None of these are secrets or runtime correctness bugs, but they are exactly the class of finding this territory was scoped to catch, and several sit directly on the "honest ops" / "lean, understandable core" clauses of the v1 premise.

No live-instance component in this territory's scope, so no separate Framework-fit grade applies.

## 2 Findings

### F1 — P1 — Epic #119's DoD still states a package-count line that is definitionally false and was never corrected

`gh issue view 119` body, "v1 definition of done":
```
Package count ≤ 18 active, plugin seam documented with whatsapp as the worked example.
```
The shipped catalog (`scripts/package-catalog.mjs`, `PACKAGES.md:5`, `README.md:144`) has **21** publishable packages (16 core + 4 plugin-tier extras + 1 unscoped `create-mono-agent` alias). This was known and discussed mid-epic: the 2026-07-06 "Protocol v1.1" retro comment on #119 states:
```
Unsatisfiable Done-when → blocked, not improvisation. #125's '18 packages' was
wrong arithmetic (its merges could only reach 20).
```
— i.e. the number was corrected once, in a *comment*, to "20", and the count has since grown to 21 (PR #198 externalized more packages to the plugin tier) without the epic's own checklist text ever being edited to match either number. A stranger opening #119 today — precisely the audience this freeze audit is meant to leave with a clean, trustworthy record — reads a DoD line that is false on its face, with the correction buried in a mid-epic comment thread. This is the top-level instance of the pattern this whole territory was scoped to check ("package-count story... recommend the honest resolution").

### F2 — P1 — `agents/implementer.md` sends implementers to a worktree path nobody uses, which would nest work inside the frozen deploy tree

`agents/implementer.md:21`:
```
- In a worktree: `git worktree add .claude/worktrees/<name> -b <branch> origin/main`
```
But the actual, currently-practiced, and separately-documented convention is different. `skills/worktree-feature/SKILL.md:14-16`:
```
Current practice keeps worktrees under
`~/.config/superpowers/worktrees/mono-agent/`.
```
`git worktree list` on the live checkout confirms this is not a documentation nit: all 44 active feature/fix/release worktrees are rooted at `~/.config/superpowers/worktrees/mono-agent/…`; **zero** exist under `.claude/worktrees` (the directory is present but empty). The `.claude/worktrees/` path is excluded from `git status` only via a personal, uncommitted `.git/info/exclude` line (`**/.claude/worktrees/`), not the shared `.gitignore` — so this was never a real, shared convention, just a stale first draft. The same stale text is also baked into the epic's own protocol (`gh issue view 119` body, item 9: "Work in `.claude/worktrees/`"), so the drift is not confined to one file.

Why it matters beyond a broken link: `.claude/worktrees/<name>` is a path *inside* the main repository working tree — the exact checkout that `skills/fleet-deploy/SKILL.md` and `skills/worktree-feature/SKILL.md` both say must "never edit, test feature branches, commit, or stash WIP in" because it is live-deployed to the launchd fleet. A session that follows `agents/implementer.md` literally would nest a feature worktree inside the frozen deploy tree instead of the isolated location every other current document assumes.

### F3 — P2 — Git/worktree hygiene has fully regressed within 8 days of a verified clean state, with no automation to prevent recurrence

Goal #167 ("Repo hygiene: prune merged branches (~104), worktrees (~75), untracked demo leftovers") closed 2026-07-07 with this verified final state (its own closing checkpoint comment):
```
git branch            → goal/164-npx-shim, goal/168-fleet-green-check, main   (2 survivors justified)
git worktree list     → main checkout + the 2 active goal worktrees
```
As of HEAD `5f27a0ec` (2026-07-15, 8 days later), independently verified in this audit:
- `git branch --list | wc -l` = **47** (46 non-`main`); sampled 8 of them against `gh pr list --state all --head <branch>` and every one is already `MERGED` (e.g. `feat/effort-keyword-escalation`→PR #208 merged, `fix/goal-255-native-notify-reply`→PR #256 merged, `fix/a2a-dispatch-idempotency`→PR #249 merged) — i.e. zero unmerged work, exactly the shape #167 already proved once.
- `git branch -r | wc -l` = **84**; `gh pr list --state open` = **0 open PRs**; `gh pr list --state merged` = 170, `gh pr list --state closed` minus merged = 5 truly-closed-unmerged. Every remote branch maps to something already resolved.
- `git worktree list | wc -l` = **50** (49 non-`main`): 44 live under `~/.config/superpowers/worktrees/mono-agent/…` (all on already-merged branches per the above); 5 under `/private/tmp` — 2 already `prunable` (directory gone, just needs `git worktree prune`), 3 (`mono-v091-node22.*`, `mono-v091-node24.*`, `mono-v091-release.*`, dated Jul 14) are Node-22/24 and release-verification checkouts for the already-superseded v0.9.1 release cycle (current is v0.11.2).

Root cause: `gh api repos/robertsreberski/mono-agent --jq .delete_branch_on_merge` = **`false`** — the one-click GitHub setting that would auto-delete a branch on PR merge has never been enabled, and no skill or CI job performs a post-merge `git worktree remove` / `git branch -d`. `skills/worktree-feature/SKILL.md`'s "Ship" section stops at `gh pr create` / `gh pr checks --watch`; nothing in the documented workflow ever runs its own listed "Compare against base / cleanup" step unless a human remembers to. #167 was a one-time manual sweep, not a standing guarantee — and it visibly did not hold for even two weeks of continued goal-loop velocity (goals #185–#256 landed in that window).

### F4 — P2 — Root `README.md` (451 lines / 38 KB) no longer reads as the "lean, understandable" newcomer document the premise promises

The Quickstart section (meant to get a stranger from zero to a running agent) is interleaved with single, unbroken paragraphs of deep internal-mechanism detail that has no bearing on getting started. Examples:

`README.md:46` (one paragraph, secret handling mixed with OAuth-lock internals):
```
Selected secrets are entered masked and never shown in config, examples, review
output, or logs. Durable provider credentials already present in `.env` receive
the same protection. On POSIX the wizard preserves existing dotenv values/comments
and uses an external owner-only lock plus `0600` no-clobber promotion...
```
`README.md:93` (a single ~430-word paragraph spanning config scaffolding, launchd lease semantics, and trace identity in one block):
```
...The managed launcher copies and integrity-manifests the exact dependency
closure already executing—including configured channel and Supermemory plugin
packages—without running npm or lifecycle scripts; the complete source digest
prevents stale closure reuse. Launchd enters Node with only the explicit
non-secret operational allowlist, and the worker holds one canonical per-config
lifetime lease so HOME, path aliases, PID reuse, or a manual foreground start
cannot duplicate it...
```
`README.md:353-354` (Safety Model bullets that read as inode/permission-check implementation notes rather than a user-facing safety summary):
```
...promotion can prove owner-only permissions plus pathname no-clobber identity...
...it reports that mono-agent roots, deny-write globs, and network policy do not
apply to those attempts rather than presenting them as enforced.
```
This level of detail (HMAC key storage paths, inode/link-count identity checks, canonical-parent ownership rules) belongs in an internal design doc or a `docs/reference` page, not inline in the top-level README a newcomer is pointed at first. The premise's own "agents in seconds-to-minutes" and "a lean, understandable core" clauses are directly undercut by a Quickstart that requires wading through provider-lock POSIX semantics before reaching a runnable command.

### F5 — P3 — Two untracked, stale build-artifact directories clutter `packages/` on disk

`packages/mono-agent/` and `packages/memory-supermemory/` exist on disk (dist/ + node_modules only, no `package.json`) but are not, and never were, tracked in git:
```
$ git ls-files packages/mono-agent | wc -l
0
$ git ls-files packages/memory-supermemory | wc -l
0
```
`packages/mono-agent/` is dead output from the short-lived `packages/mono-agent` package added in PR #174 and renamed to `packages/create-mono-agent` in PR #175 (commit `615db0a5`) after npm blocked the bare `mono-agent` name. `packages/memory-supermemory/` is dead output from before PR #198 (`23d86b2d`, "Externalize Supermemory from the core app closure") moved that package to `extras/memory-supermemory` as a plugin-tier extra. Neither is picked up by `pnpm-workspace.yaml` (`packages/*` / `extras/*` globs require a `package.json`), so they are inert, but they are exactly the kind of stray, confusing directory the repo's own skills warn about elsewhere (stale-dist gotchas in `verify-green`/`worktree-feature`/`pi-upstream-recon`), and a newcomer running a plain `ls packages/` sees 19 directories where only 17 are real.

### F6 — P2 — The package-count drift guard does not cover `skills/release-lockstep/SKILL.md`'s own hardcoded package-count prose

`scripts/release/__tests__/package-count-drift.test.mjs` guards exactly three files' package-count prose against `scripts/package-catalog.mjs` drift: `website/README.md`, `PACKAGES.md`, and root `README.md` (`guardedPackageCountReferences`, lines 21-76). `skills/release-lockstep/SKILL.md:14-19` independently hardcodes the same kind of count prose:
```
**Lockstep set (2026-07, updated #198):** all **21 `publishable: true` packages**
in `scripts/package-catalog.mjs` release together: 16 `tier: "core"` packages,
the `create-mono-agent` alias under `packages/*`, and four plugin-tier extras
under `extras/*` (a2a-adapter, agent-orchestrator, memory-supermemory, and
whatsapp-adapter).
```
This is accurate today, but it is not in the guarded list, so the next time the catalog's tier split changes (as it already has once, per #198), this skill — read directly by a release-engineer subagent as its operating contract — can silently go stale with no test catching it. This is precisely the load-bearing-but-untested surface this territory was asked to hunt for, and it is the same failure mode as F1 (a corrected number that only lives in prose, not in an enforced check).

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hints |
| --- | --- | --- | --- |
| `packages/mono-agent/` (dist + node_modules only) | Leftover build output from the pre-rename `mono-agent` package (PR #174), superseded by `packages/create-mono-agent` (PR #175); never git-tracked | Delete locally (`rm -rf packages/mono-agent`) — purely a local housekeeping action, nothing to commit | `git ls-files packages/mono-agent` → empty; no `package.json`; `git log --oneline --all -- packages/mono-agent` shows only the #174/#175 rename commits |
| `packages/memory-supermemory/` (dist + node_modules only) | Leftover build output from before PR #198 moved the package to `extras/memory-supermemory` (plugin tier); never git-tracked | Delete locally (`rm -rf packages/memory-supermemory`) | `git ls-files packages/memory-supermemory` → empty; dist mtime (Jun 23) predates the #198 move (commit `23d86b2d`) |
| `.claude/worktrees/` (empty directory) | Stale first-draft convention superseded by `~/.config/superpowers/worktrees/mono-agent/`; not referenced by any currently-followed process; excluded only via a personal uncommitted `.git/info/exclude` entry | Remove the directory and the stale references in `agents/implementer.md` and the #119 epic body (see F2 / A2) | `ls -la .claude/worktrees` → empty; `git worktree list` shows zero worktrees under it; `git check-ignore -v .claude/worktrees` resolves to `.git/info/exclude`, not the committed `.gitignore` |

## 4 Deprecation & legacy

All deprecated/legacy surfaces found in scope are explicitly-kept backward-compatibility aliases, not abandoned code — none are removable now without a breaking change:

- **`--fallback-models` legacy CSV flag** (`README.md:56`, "The legacy CSV `--fallback-models` flag remains supported.") — load-bearing: kept alongside the new canonical `--fallback` flag for existing scripts/configs; no removal date stated.
- **`runtime.fallbackModels` legacy config key** (`README.md:93`, "Legacy `runtime.fallbackModels` configs continue to load and retain their historical global-effort inheritance.") — load-bearing back-compat for already-deployed configs; explicitly still functional, not merely tolerated.
- **`mono-agent recipes …` / `--recipe <id>`** (`README.md:117`, "still works as a deprecated alias — retired recipes map to the preset that replaced them... See `docs/reference/recipes.md`... for the full deprecation map.") — load-bearing alias onto the current presets system; a full deprecation map exists in docs, so this one is the most cleanly documented of the three.
- **Package deprecations via npm web UI** (`agents/release-engineer.md:56`, `skills/release-lockstep/SKILL.md:78`) — this is process guidance (the AutoProxxy-proxied CLI can't do it), not a deprecated code surface; both files agree with each other, no drift here.

None of these are stale references to surfaces that have actually been removed — all still function as documented. No action needed beyond what's already tracked in `docs/reference/recipes.md`.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
| --- | --- | --- | --- | --- | --- | --- |
| A1-1 | Correct epic #119's DoD package-count line to match reality (21, not ≤18), with a one-line rationale pointing at the #198 extras-tier decision | "Honest ops" — the freeze epic's own checklist must not be false; F1 | `gh issue edit 119` to rewrite the "Package count ≤ 18 active..." line, citing the corrected arithmetic already recorded in the 2026-07-06 retro comment | S | Epic body's DoD line matches `scripts/package-catalog.mjs`'s actual counts (21 = 16+4+1) | y |
| A1-2 | Fix `agents/implementer.md:21`'s worktree path from `.claude/worktrees/<name>` to `~/.config/superpowers/worktrees/mono-agent/<name>`; fix the same stale text in the #119 epic body (protocol item 9) | Dev-tooling accuracy is this territory's explicit charter; F2 | Edit the one line in `agents/implementer.md`; `gh issue edit 119` for the epic body; rerun `node scripts/check-codex-discoverability.mjs` | S | `implementer.md` and #119 body both reference `~/.config/superpowers/worktrees/mono-agent/`; discoverability check still passes | y |
| A1-3 | One-time verified branch/worktree sweep, repeating the #167 proof discipline: confirm each of the 46 non-`main` local branches and 44 `~/.config/superpowers` worktrees is squash-merged/clean before removal; `git worktree prune` for the 2 already-`prunable` `/private/tmp` entries; remove the 3 stale v0.9.1 release-verification worktrees under `/private/tmp` | #167 explicitly promised this state and it silently regressed within 8 days; recurring drift undermines "honest ops" for the frozen repo | `git branch --merged`/`gh pr list --head <branch>` proof per branch → `git branch -d`; `git -C <wt> status --porcelain` empty proof per worktree → `git worktree remove <wt>`; then `git worktree prune` | M | `git branch --list \| wc -l` and `git worktree list \| wc -l` both drop to a small, justified survivor set (mirroring #167's closing state); no unmerged work discarded | n |
| A1-4 | Enable `delete_branch_on_merge` on the GitHub repo, and matching remote-branch cleanup pass for the 83 already-resolved remote branches | Removes the root cause of F3 so the #167-style regression can't silently recur | `gh api -X PATCH repos/<owner>/mono-agent -f delete_branch_on_merge=true`; then a scripted `git push origin --delete <branch>` pass over branches already confirmed merged/closed via `gh pr list --state all --head <branch>` | S | `gh api repos/<owner>/mono-agent --jq .delete_branch_on_merge` reports `true`; remote branch count drops close to open-PR count (currently 0) | n |
| A1-5 | Add a "post-merge cleanup" step to `skills/worktree-feature/SKILL.md`'s "Ship" section (`git worktree remove` + `git branch -d` once a PR merges), so the workflow that creates worktrees also owns removing them | Prevents F3 from recurring a third time; closes the process gap goal #167 papered over once already | Add 3-4 lines under "Ship" in the SKILL.md documenting the exact commands, mirroring the "Compare against base / cleanup" section that already exists but isn't wired into the default flow | S | Updated `SKILL.md` read by a future implementer session results in the worktree/branch being removed as part of finishing, not left indefinitely | n |
| A1-6 | Trim `README.md`'s Quickstart of deep implementation-mechanism paragraphs (HMAC/lease/inode/permission internals at lines 42/44/46/48/93/95/353-354); move that detail to a linked `docs/reference` page | Premise clause "a lean, understandable core" / "agents in seconds-to-minutes" for a newcomer skimming the top-level README; F4 | Extract the internals prose into e.g. `docs/reference/onboarding-internals.md`, leave a one-line pointer in the README, keep only the runnable-command flow inline | M | A newcomer can read the Quickstart section top-to-bottom to a running agent without hitting a POSIX-permissions/HMAC digression; `pnpm -C website build` still green (link-check passes) | n |
| A1-7 | Delete the two untracked stale build-debris directories `packages/mono-agent/` and `packages/memory-supermemory/` from the local checkout | Removes confusing, purely-local clutter in `packages/`; F5 | `rm -rf packages/mono-agent packages/memory-supermemory` (local-only; nothing to commit, both are git-ignored) | S | `ls packages/` shows exactly the 17 git-tracked package directories | n |
| A1-8 | Add `skills/release-lockstep/SKILL.md`'s hardcoded package-count line to `scripts/release/__tests__/package-count-drift.test.mjs`'s `guardedPackageCountReferences` | Closes the exact untested-drift gap named in F6, preventing a second instance of F1's failure mode | Add a `{ filePath: "skills/release-lockstep/SKILL.md", pattern: /all \*\*(?<count>\d+)\.../, tier: ... }`-style entry (may need 2-3 entries for the "21 / 16 / four" trio) mirroring the existing README.md entries | S | `pnpm run release:test` fails the moment `skills/release-lockstep/SKILL.md`'s prose next drifts from `scripts/package-catalog.mjs` | n |

## 6 Skill-worthy flags

- **`worktree-feature` skill is missing its own "finish" step.** It documents how to create a worktree and open a PR, and separately documents "Compare against base / cleanup" (`git worktree remove` / `git worktree prune`), but nothing in the "Ship" flow triggers that cleanup once a PR actually merges — which is exactly why #167's verified-clean state (2 branches, 3 worktrees) regressed to 47 branches / 50 worktrees within 8 days of continued goal-loop velocity. Amendment: fold a mandatory post-merge cleanup step into "Ship" (`gh pr merge` confirmation → `git worktree remove <path>` → `git branch -d <branch>`), and pair it with enabling `delete_branch_on_merge` on the GitHub repo (currently `false`) so the remote side is automatic. Exact evidence: `gh api repos/robertsreberski/mono-agent --jq .delete_branch_on_merge` = `false`; #167 closing comment final state (`git branch` → 2 survivors, `git worktree list` → main + 2) vs. today's `git branch --list | wc -l` = 47, `git worktree list | wc -l` = 50.
- **Docs/dev-tooling drift needs the same automated guard the package-count story already has.** `scripts/release/__tests__/package-count-drift.test.mjs` proves this repo already knows how to guard prose-vs-source-of-truth drift (README.md/PACKAGES.md/website/README.md) — but the same discipline wasn't extended to `skills/release-lockstep/SKILL.md`'s identical hardcoded numbers, nor to any check that an `agents/*.md` template's file-path claims (e.g. "workshop worktrees live at X") match the currently-documented skill it's meant to complement. Amendment candidate: either extend `check-codex-discoverability` (or a new lightweight `scripts/check-dev-tooling-consistency.mjs`) to grep `agents/*.md` for path/convention strings that also appear in `skills/*/SKILL.md` and fail if they disagree — this would have caught F2 automatically, the same way `check-codex-discoverability` already catches missing `.toml`/`openai.yaml` companions.
- **Epic-level "Done when" corrections should edit the checklist, not just comment on it.** Protocol v1.1 amendment #4 (posted on #119 itself) already codifies "post `goal_status: blocked` naming the discrepancy + the corrected anchor" for individual goals — but the retro comment that corrected #125's package-count arithmetic never propagated back into #119's own top-level DoD text, which is the artifact a freeze audit (or any future stranger) actually reads first. Amendment candidate for the goal-loop protocol: when a correction to a Done-when anchor is recorded in a comment, the epic/goal issue **body** gets a matching edit (via `gh issue edit`) in the same breath, not just a comment thread reference.

## 7 Coverage note

Files read in full for this audit:

- `agents/README.md`
- `agents/adversarial-reviewer.md`, `agents/adversarial-reviewer.toml`
- `agents/docs-curator.md`, `agents/docs-curator.toml`
- `agents/implementer.md`, `agents/implementer.toml`
- `agents/live-smoke-operator.md`, `agents/live-smoke-operator.toml`
- `agents/release-engineer.md`, `agents/release-engineer.toml`
- `skills/README.md`
- `skills/docs-sync/SKILL.md`, `skills/docs-sync/agents/openai.yaml`
- `skills/fleet-deploy/SKILL.md`, `skills/fleet-deploy/agents/openai.yaml`
- `skills/live-smoke/SKILL.md`, `skills/live-smoke/agents/openai.yaml`
- `skills/new-package/SKILL.md`, `skills/new-package/agents/openai.yaml`
- `skills/pi-upstream-recon/SKILL.md`, `skills/pi-upstream-recon/agents/openai.yaml`
- `skills/release-lockstep/SKILL.md`, `skills/release-lockstep/agents/openai.yaml`
- `skills/verify-green/SKILL.md`, `skills/verify-green/agents/openai.yaml`
- `skills/worktree-feature/SKILL.md`, `skills/worktree-feature/agents/openai.yaml`
- `AGENTS.md`
- `PACKAGES.md`
- `README.md`
- `scripts/package-catalog.mjs`
- `scripts/release/__tests__/package-count-drift.test.mjs` (skimmed to judge coverage adequacy, per F6)
- `scripts/check-codex-discoverability.mjs` (skimmed to confirm what the automated skill/agent parity gate actually checks)
- `.git/info/exclude`, `.gitignore` (spot-checked for the `.claude/worktrees` exclusion mechanism)
- `.github/workflows/ci.yml`, `.github/workflows/npm-release.yml` (file listing / grep only, to confirm no branch-hygiene automation exists)
- `.githooks/pre-commit` (existence check only, referenced by `worktree-feature`)

Read-only commands used for the git-hygiene and GitHub-state evidence (none mutated repo state): `git branch --list`, `git branch -r`, `git branch --merged`/`--no-merged`, `git worktree list`, `git status --porcelain=v1 --ignored=matching`, `git ls-files`, `git log --oneline`, `git check-ignore -v`, `gh issue view 119/125/167`, `gh pr list` (open/closed/merged, and per-branch `--head` lookups), `gh api repos/robertsreberski/mono-agent`.

Not found / not applicable in scope: no `packages/mono-agent/package.json` or `packages/memory-supermemory/package.json` exist (confirmed dead, see §3); no additional `agents/*.toml` or `skills/*/agents/openai.yaml` files exist beyond the ten and eight enumerated above (confirmed via `find`).
