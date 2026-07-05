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
- Package READMEs — 7 required sections, enforced by `check:architecture`
- Root `README.md`, `PACKAGES.md`
- Retired-surface mentions are policed by:

```bash
node scripts/check-consumer-docs-consistency.mjs
```

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
