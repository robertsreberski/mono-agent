---
name: docs-sync
description: Keep docs/ (canonical) and the Astro Starlight website in sync with shipped changes — per-PR doc updates or a PR-range audit. Use when asked to "update the docs", "sync docs with recent PRs", "check the website builds", or after any user-facing feature lands.
---

# Docs sync

## Source-of-truth rule

`docs/` is canonical (in git, browsable on GitHub, source for the composer
skill). `website/src/content/docs` is **generated** by
`website/scripts/sync-content.mjs` — never edit it; a diff touching it is a bug.
Top-level `docs/superpowers/` and `docs/skills/` are excluded from the published
site.

## Doc surfaces checklist (per shipped feature)

- `docs/<area>/*.md` (channels, config, runtime, memory, tools, observability, …)
- `docs/reference/feature-registry.md` — the feature→config map; every new config key lands here
- `docs/reference/feature-matrix.md`, `docs/reference/recipes.md`
- `docs/playbooks/*` — 16 task-shaped playbooks; extend the closest one
- Package READMEs — 7 required sections, enforced by `check:architecture`; the
  `## Public API` section must stay in parity with `src/index.ts` (drift checks below)
- Root `README.md`, `PACKAGES.md`
- `demos/*/IDENTITY.example.md`, `demos/*/SOUL.example.md`, and any other
  `demos/*/*.example.md` — copy-paste seed templates that actively break a fresh
  agent when stale, and a `docs/`-only pass misses them. Add them to the checklist
  on every memory / tool-surface PR.
- `packages/agent-app/skills/mono-agent-composer/references/*.md` — the composer
  skill's knowledge base; fold it into the "after any user-facing feature lands"
  pass. It silently drifted out of the loop for ≥3 PRs (native-notify #98,
  per-trigger-model-effort, external-memory-backends #52), and because that
  `SKILL.md` tells composing agents never to read `feature-registry.md` or package
  source, these references are the single point of failure for "does the framework
  support X."
- Retired-surface mentions are policed by:

```bash
node scripts/check-consumer-docs-consistency.mjs
```

## Per-PR drift checks (grep before closing the pass)

Run these against the PR diff; each one caught a real doc regression.

**README `## Public API` ↔ `src/index.ts` parity.** When a diff touches
`packages/*/src/index.ts` (adds/removes an `export {…} from`), diff the touched
package's README `## Public API` section too and flag any new export missing from
it. As an occasional whole-package sweep, confirm each README-listed symbol still
exists (and is imported by ≥1 other workspace package or carries a
deprecated/experimental label):

```bash
# any line printed = README lists a symbol src/index.ts no longer exports
comm -23 \
  <(sed -n '/^## Public API/,/^## /p' packages/<pkg>/README.md | grep -oE '`[A-Za-z_][A-Za-z0-9_]*`' | tr -d '`' | sort -u) \
  <(grep -oE '[A-Za-z_][A-Za-z0-9_]*' packages/<pkg>/src/index.ts | sort -u)
```

Caught the observability README drift, the `*FieldGroup` staleness in 3 READMEs,
the missing `toCronJobs` bullet, and the dead memory search API.

**Rename ⇒ grep the old name across docs.** When a PR renames/removes an exported
symbol, grep the old name before closing the pass — README samples and docs prose
don't move with the code:

```bash
grep -rn '<old-name>' packages/*/README.md docs/
```

`telegramFieldGroup`/`slackFieldGroup` → `TELEGRAM_CONFIG_FIELDS`/`SLACK_CONFIG_FIELDS`
left the README samples stale.

**Behavior-prose drift on a new opt-in mode.** When a PR adds a new opt-in
mode/enum, grep the package README prose for a stale absolute claim ("does not …
X", "always Y, never Z") the new code just falsified. cron-adapter README line 87
"does not … queue overlapping jobs" survived the arrival of the new
`overlap:"queue"`.

**Cross-cutting operator tables.** When a PR introduces a new durable store, grep
its new root/store name across `docs/**/*.md` and patch any table/matrix that
enumerates "what does X reset/purge/survive" — not just the prose.
`docs/runtime/sessions-concurrency.md`'s boundary-rules table went silent on
v0.11.0 durable conversation-history.

**`config-reference.ts` ⇒ `feature-registry.md` row + prose page.** If a PR
touches `packages/agent-app/src/config-reference.ts`, grep the new `jsonPath`
against the registry and its prose page before calling the PR doc-complete:

```bash
comm -23 \
  <(grep -oE '"[a-z]+\.[a-zA-Z]+"' packages/agent-app/src/config-reference.ts | sort -u) \
  <(grep -oE '`[a-z]+\.[a-zA-Z]+`' docs/reference/feature-registry.md | tr -d '`' | sort -u)
```

Any left-only line is a config key with no registry row (would have caught the
F2/F3 misses).

## Build + verify

`website/` is its own pnpm workspace (isolated from the root; root `pnpm build`
and CI do NOT build it — this is a manual gate):

```bash
pnpm -C website install                    # first time or after dep changes
pnpm -C website build                      # sync-content + astro build + check-links
node website/scripts/sync-content.mjs      # sync only
node website/scripts/check-links.mjs       # link check only (needs dist/)
pnpm -C website preview -- --port 4329     # manual review
```

## PR-range audit recipe (the PR #110 pattern)

1. List the range: `gh pr list --state merged --base main --json number,title,mergedAt --limit 40`
2. For each PR, classify **user-facing** vs **internal-only** (say so explicitly —
   the #110 audit found 11/30 internal; don't invent docs for internal work).
3. For user-facing PRs, walk the checklist above and patch `docs/` file-by-file.
4. `pnpm -C website build` green (includes the link checker).
5. Work in a worktree, branch `docs/<topic>`, PR with `gh pr create --base main`.

## Gotchas

- Pin `astro@^5.18` + `@astrojs/starlight@^0.37` — starlight 0.38+ requires
  Astro 6 and breaks asides. Do not "helpfully" upgrade.
- In a worktree, website node_modules are absent: `pnpm -C website install` or
  `ln -sfn <main-repo>/website/node_modules website/node_modules`.
- Starlight only applies markdown features to files physically under
  `src/content/docs` — that's why sync copies instead of loading `../docs`.
- Keep README section headings byte-exact (`## Category`, `## Responsibility`,
  `## Install / Usage`, `## Public API`, `## Dependency Boundary`,
  `## What This Package Does Not Own`, `## Verification`) or the arch gate fails.
- **Website anti-rot has two known blind spots — the build won't catch them for you.**
  `website/scripts/check-links.mjs`'s doc comment claims a broader anti-rot mandate
  than it delivers: it does **not** catch orphaned Starlight asides, so eyeball
  asides on doc edits (adding an orphaned-aside check to the website CI remit is a
  pending follow-up). And fenced `ts` code blocks in `docs/playbooks/**` and
  `docs/programmatic/**` are **not** type-checked against the packages they demo —
  a stale F5 playbook slipped through this way; a lightweight `tsc --noEmit` over
  those fenced blocks is a follow-up, so verify playbook snippets against real
  package types by hand until it lands.
